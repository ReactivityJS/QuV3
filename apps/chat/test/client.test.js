import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, AssetEngine, CollectionEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import {
  ListService, AccessService, MessageService, ReactionService, PinService, PresenceService, ChatService,
  ActorService, ProfileService, DirectoryService, ContactsService, FlagService, AssetService, paths,
} from '@qu/services';
import { ExtensionPointHost } from '@qu/foundation';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, renderChatSettings } = await import('../client.js');

function createQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu);
  return qu;
}

// The real UUID committed in apps/chat/manifest.quapp - client.js reads its
// spaceId off the apps catalog (`ctx.apps`), never a literal.
const CHAT_SPACE_ID = '39d30ff2-be01-4277-93a5-85d21b4ce096';
const CHAT_APPS = [{ name: 'chat', spaceId: CHAT_SPACE_ID }];

/** One identity's full service set and OWN store - see apps/forum/test/client.test.js's own doc comment for why two identities always need two independent stores. */
async function freshEnv(alias) {
  const qu = createQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const flags = new FlagService(qu, identity, list);
  const services = {
    actors: new ActorService(identity),
    profile: new ProfileService(qu, identity),
    messages,
    reactions: new ReactionService(qu, identity, list),
    pins: new PinService(qu, identity, list),
    presence: new PresenceService(qu, identity),
    chat: new ChatService(messages, identity),
    assets: new AssetService(qu, new AssetEngine(qu), identity),
    directory: new DirectoryService(qu, identity, list),
    contacts: new ContactsService(flags, identity),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/** Copies a thread's meta+messages, and the sender's own profile, into a peer's store - "as if sync had already delivered it". */
async function mirrorThreadInto(fromEnv, intoQu, spaceId, threadId) {
  const metaPath = paths.threadMetaPath(spaceId, threadId);
  const meta = await fromEnv.qu.get(metaPath);
  if (meta) await intoQu.putSealed(metaPath, meta);
  const entries = await fromEnv.qu.getChildren(paths.threadMessagesParentPath(spaceId, threadId));
  for (const { path, quBit } of entries) await intoQu.putSealed(path, quBit);
  const profile = await fromEnv.qu.get(actorPath(fromEnv.myPub, 'profile'));
  if (profile) await intoQu.putSealed(actorPath(fromEnv.myPub, 'profile'), profile);
}

async function mirrorProfileInto(fromEnv, intoQu) {
  const profile = await fromEnv.qu.get(actorPath(fromEnv.myPub, 'profile'));
  if (profile) await intoQu.putSealed(actorPath(fromEnv.myPub, 'profile'), profile);
}

function noopSubscribe() {}

/** Must be attached to document.body - reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** Opens a message's "⋮" context menu (content.messageFooter's core.menu segment) and returns its panel - see apps/forum/test/client.test.js's own identical helper. */
async function openMessageMenu(root) {
  await waitFor(() => root.querySelector('.qu-thread-ui-context-menu-trigger') !== null);
  root.querySelector('.qu-thread-ui-context-menu-trigger').click();
  await waitFor(() => root.querySelector('.qu-thread-ui-context-menu-panel') !== null);
  return root.querySelector('.qu-thread-ui-context-menu-panel');
}

function menuItemButton(panel, label) {
  return [...panel.querySelectorAll('.qu-thread-ui-context-menu-item')].find((btn) => btn.textContent.includes(label));
}

test('room list renders the empty state with no contacts/groups yet', async () => {
  const a = await freshEnv('Ada');
  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-empty') !== null);
    assert.match(container.querySelector('.qu-chat-empty').textContent, /No chats yet/);
  } finally {
    stop();
  }
});

test('a 1:1 room derives the SAME roomId for both members, and messages round-trip encrypted', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu); // Alice needs Bob's X key to encrypt for him

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    assert.match(container.querySelector('.qu-chat-header-name').textContent, /Bob/);

    const textarea = container.querySelector('textarea');
    textarea.value = 'Hey Bob!';
    const sendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    sendBtn.click();

    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('Hey Bob!'));
    assert.equal(textarea.value, '');

    const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);
    const config = await alice.services.messages.getConfig(CHAT_SPACE_ID, roomId);
    assert.deepEqual([...config.readers].sort(), [alice.myPub, bob.myPub].sort());

    // Bob independently deriving the same room, after the message syncs to him.
    await mirrorProfileInto(alice, bob.qu);
    await mirrorThreadInto(alice, bob.qu, CHAT_SPACE_ID, roomId);
    const { messages } = await bob.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.deepEqual(messages.map((m) => m.body), ['Hey Bob!']);
  } finally {
    stop();
  }
});

test('editing OWN message updates its bubble text', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'origin' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('origin'));
    const panel = await openMessageMenu(container);
    menuItemButton(panel, 'Edit').click();
    await waitFor(() => container.querySelector('.qu-chat-edit-row textarea') !== null);
    const editArea = container.querySelector('.qu-chat-edit-row textarea');
    editArea.value = 'edited body';
    const saveBtn = [...container.querySelectorAll('.qu-chat-edit-row-buttons button')].find((b) => b.textContent === 'Save');
    saveBtn.click();

    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('edited body'));
  } finally {
    stop();
  }
});

test('createGroup() + posting renders in the group room view, and shows up in the OTHER member\'s room list once invited/synced', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await mirrorProfileInto(alice, bob.qu);

  const { groupId } = await alice.services.chat.createGroup(CHAT_SPACE_ID, { name: 'Team Rocket', memberPubs: [bob.myPub] });
  await alice.services.messages.postMessage(CHAT_SPACE_ID, groupId, { body: 'welcome!' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', 'g', groupId] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-header-name')?.textContent === 'Team Rocket');
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('welcome!'));
  } finally {
    stop();
  }

  // Mirror the invite (posted by Alice INTO Bob's own chat-invites-<bobPub>
  // mailbox - see ChatService.createGroup()'s own doc comment) + the group
  // thread itself into Bob's store, as if sync delivered both.
  const inviteSpace = await bob.services.chat.myInviteSpace();
  assert.equal(inviteSpace, `chat-invites-${bob.myPub}`);
  await mirrorThreadInto(alice, bob.qu, inviteSpace, 'groups');
  await mirrorThreadInto(alice, bob.qu, CHAT_SPACE_ID, groupId);

  const bobGroups = await bob.services.chat.listMyGroups();
  assert.deepEqual(bobGroups, [groupId]);

  const bobContainer = makeContainer();
  const stopBob = mount(bobContainer, { qu: bob.qu, services: bob.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => bobContainer.querySelector('.qu-chat-room-name')?.textContent === 'Team Rocket');
  } finally {
    stopBob();
  }
});

test('renderChatSettings() - the userSettings.contributions contributor - persists a per-user preference via private-storage', async () => {
  const alice = await freshEnv('Alice');
  const container = makeContainer();
  await renderChatSettings(container, { myPub: alice.myPub, services: alice.services });

  const aliasCheckbox = container.querySelector('input[type="checkbox"]');
  assert.equal(aliasCheckbox.checked, false);
  aliasCheckbox.checked = true;
  aliasCheckbox.dispatchEvent(new window.Event('change'));

  await waitFor(() => container.querySelector('.qu-chat-settings-status')?.hidden === false);
  const stored = await alice.qu.get(`/store/actors/~${alice.myPub}/private/chat-settings`);
  assert.equal(typeof stored.val, 'object'); // a self-encrypted envelope, not the plaintext - see private-storage.js
});

test('reuses apps/reactions\' REAL content.messageFooter extension point - no chat-specific reaction code', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'react to me' });

  const REACTIONS_CLIENT_URL = new URL('../../reactions/client.js', import.meta.url).href;
  const appsWithReactions = [
    { name: 'chat', spaceId: CHAT_SPACE_ID },
    { name: 'reactions', clientMainUrl: REACTIONS_CLIENT_URL, contributes: [{ point: 'content.messageFooter', export: 'renderReactionWidget' }] },
  ];

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(appsWithReactions);
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: appsWithReactions, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub], extensionPoints,
  });
  try {
    await waitFor(() => container.querySelector('qu-reactions-row') !== null);
  } finally {
    stop();
  }
});

test('the "Reply" menu item (native, any message) opens the reply banner and tags the next posted message\'s replyTo', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const original = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'origin' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('origin'));
    const panel = await openMessageMenu(container);
    menuItemButton(panel, 'Reply').click();
    await waitFor(() => container.querySelector('.qu-chat-reply-banner')?.hidden === false);
    assert.match(container.querySelector('.qu-chat-reply-banner').textContent, /Replying to You/);

    const textarea = container.querySelector('textarea');
    textarea.value = 'my reply';
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send').click();

    await waitFor(() => [...container.querySelectorAll('.qu-chat-bubble-text')].some((el) => el.textContent.includes('my reply')));
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    const reply = messages.find((m) => m.body === 'my reply');
    assert.equal(reply.replyTo, original.id);
    // the reply banner cleared itself after sending
    assert.equal(container.querySelector('.qu-chat-reply-banner').hidden, true);
  } finally {
    stop();
  }
});

test('the read-tick footer segment (own messages only): "Sent" (✓) with no read receipt yet', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'did you see this' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-footer')?.textContent.includes('✓'));
    assert.equal(container.querySelector('.qu-chat-bubble-footer').textContent.includes('✓✓'), false);
  } finally {
    stop();
  }
});

test('the read-tick footer segment reads "Read" (✓✓) when the peer\'s read receipt already covers the message at mount time', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'already read' });

  // Bob publishes a read receipt on his OWN store, then it "syncs" into
  // Alice's BEFORE the room view ever mounts - same putSealed() technique
  // every other cross-identity test in this file/apps/forum's own suite uses.
  await bob.services.presence.publishReadReceipt(CHAT_SPACE_ID, roomId, Date.now() + 1000);
  const receiptPath = paths.threadReadReceiptPath(CHAT_SPACE_ID, roomId, bob.myPub);
  await alice.qu.putSealed(receiptPath, await bob.qu.get(receiptPath));

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-footer')?.textContent.includes('✓✓'));
  } finally {
    stop();
  }
});

test('a message with no reply banner active posts with replyTo: null (not "undefined")', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    // Wait for the room to actually be ready (header name resolved), not
    // just for the textarea to exist - the composer is built synchronously,
    // well before ensureRoom()/roomReady resolve, and the send handler
    // silently no-ops until roomReady is true (see mountRoomView()'s own
    // "if (!roomReady) return;" guard).
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const textarea = container.querySelector('textarea');
    textarea.value = 'no reply';
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send').click();
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('no reply'));
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(messages.find((m) => m.body === 'no reply').replyTo, null);
  } finally {
    stop();
  }
});
