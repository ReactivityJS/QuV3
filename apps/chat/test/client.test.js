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
const { mount, renderChatSettings, searchChat, resolveChatReference } = await import('../client.js');

/** A minimal MediaRecorder test double - start()/stop() only, stop() synchronously fires ondataavailable then onstop, matching real MediaRecorder's own event order closely enough for startRecording()'s own handler. */
class FakeMediaRecorder {
  constructor() {
    this.mimeType = 'audio/webm';
  }
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(['fake voice bytes'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}
function installVoiceMocks() {
  navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
  globalThis.MediaRecorder = FakeMediaRecorder;
}
function installGeolocationMock(coords = { latitude: 52.52, longitude: 13.405 }) {
  navigator.geolocation = { getCurrentPosition: (success) => success({ coords }) };
}

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

/**
 * Simulates the user's scroll position for mountRoomView()'s own
 * stuckToBottom listener. jsdom (this repo's test DOM) has no layout
 * engine - `scrollHeight`/`clientHeight` are fixed, getter-only 0s, so
 * `scrollTop` alone can never actually express "near the bottom" vs "far
 * from it" the way the real geometry check needs; both getters are
 * overridden here (configurable, so a later call can re-override them
 * again) to give the listener real numbers to compare.
 */
function simulateScroll(scrollEl, { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  Object.defineProperty(scrollEl, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: clientHeight, configurable: true });
  scrollEl.scrollTop = scrollTop;
  scrollEl.dispatchEvent(new window.Event('scroll'));
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
    const sendBtn = container.querySelector('.qu-chat-composer-action');
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

test('a first-ever DM from a non-contact shows up as a "message request" (not a silent room); Accept adds the contact and opens the room', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu); // alice needs bob's X key to encrypt both the message AND the dm-invite for him
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'hi, we\'ve never talked before' });

  // Bob and Alice are NOT contacts of each other yet - mirror the invite
  // mailbox (dm-invite reuses the SAME 'groups' invite thread group-invites
  // use - see ChatService's own doc comment), Alice's profile, and the room
  // thread itself into Bob's store, as if sync delivered all three.
  await mirrorProfileInto(alice, bob.qu);
  const inviteSpace = await bob.services.chat.myInviteSpace();
  await mirrorThreadInto(alice, bob.qu, inviteSpace, 'groups');
  await mirrorThreadInto(alice, bob.qu, CHAT_SPACE_ID, roomId);

  const bobContacts = await bob.services.contacts.listContacts();
  assert.deepEqual(bobContacts, []);

  const bobContainer = makeContainer();
  const stopBob = mount(bobContainer, { qu: bob.qu, services: bob.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => bobContainer.querySelector('.qu-chat-request-row') !== null);
    assert.match(bobContainer.querySelector('.qu-chat-requests-heading').textContent, /request/i);
    assert.match(bobContainer.querySelector('.qu-chat-request-name').textContent, /Alice/);
    // NOT rendered as an ordinary room row - a request is a decision, not
    // yet a conversation to click into.
    assert.equal(bobContainer.querySelector('.qu-chat-room-row'), null);

    bobContainer.querySelector('.qu-chat-request-actions button').click(); // Accept is always the first button
    // The hash is set LAST in the click handler, after addContact() has
    // already resolved - waiting on it (a plain sync check) is what proves
    // the whole handler ran, not just that it started. (An async predicate
    // here - `waitFor(async () => await isContact(...))` - would be the
    // documented waitFor() footgun: the check function itself is a truthy
    // Promise before it's ever awaited, so it'd resolve on the very first
    // poll, racing ahead of the click handler's own still-pending work.)
    await waitFor(() => window.location.hash !== '');
    assert.equal(window.location.hash, `#/chat/${alice.myPub}`);
    assert.equal(await bob.services.contacts.isContact(alice.myPub), true);
  } finally {
    stopBob();
  }
});

test('declining a message request dismisses it (does not add a contact, does not resurface after re-render)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'hello stranger' });

  await mirrorProfileInto(alice, bob.qu);
  const inviteSpace = await bob.services.chat.myInviteSpace();
  await mirrorThreadInto(alice, bob.qu, inviteSpace, 'groups');
  await mirrorThreadInto(alice, bob.qu, CHAT_SPACE_ID, roomId);

  const bobContainer = makeContainer();
  const stopBob = mount(bobContainer, { qu: bob.qu, services: bob.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => bobContainer.querySelector('.qu-chat-request-row') !== null);
    const [, declineBtn] = bobContainer.querySelectorAll('.qu-chat-request-actions button');
    declineBtn.click();

    await waitFor(() => bobContainer.querySelector('.qu-chat-request-row') === null);
    assert.equal(await bob.services.contacts.isContact(alice.myPub), false);
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
    container.querySelector('.qu-chat-composer-action').click();

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

test('the read-tick updates to "Read" (✓✓) LIVE when the peer\'s receipt arrives AFTER mount - not just at initial render', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'read me later' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-footer')?.textContent.includes('✓'));
    assert.equal(container.querySelector('.qu-chat-bubble-footer').textContent.includes('✓✓'), false);

    // Bob reads it and publishes his receipt only NOW, well after Alice's
    // room view already mounted and rendered its first ("Sent") tick - then
    // it "syncs" into Alice's store the same putSealed() way every other
    // cross-identity test here does, with NOTHING else re-triggering a
    // render (no new message, no re-mount). Read receipts live under
    // threadReadReceiptsParentPath(), a SIBLING of the messages parent path
    // mountRoomView() already watches - without its own watchChildren() on
    // that parent too, this receipt would land in Alice's local store but
    // the tick would silently stay frozen on "Sent" forever.
    await bob.services.presence.publishReadReceipt(CHAT_SPACE_ID, roomId, Date.now() + 1000);
    const receiptPath = paths.threadReadReceiptPath(CHAT_SPACE_ID, roomId, bob.myPub);
    await alice.qu.putSealed(receiptPath, await bob.qu.get(receiptPath));

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
    container.querySelector('.qu-chat-composer-action').click();
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('no reply'));
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(messages.find((m) => m.body === 'no reply').replyTo, null);
  } finally {
    stop();
  }
});

test('the composer action button morphs between mic (empty) and send (has text)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const actionBtn = container.querySelector('.qu-chat-composer-action');
    const textarea = container.querySelector('textarea');
    assert.equal(actionBtn.textContent, '🎙️');

    textarea.value = 'hello';
    textarea.dispatchEvent(new window.Event('input'));
    assert.equal(actionBtn.textContent, '➤');

    textarea.value = '';
    textarea.dispatchEvent(new window.Event('input'));
    assert.equal(actionBtn.textContent, '🎙️');
  } finally {
    stop();
  }
});

test('recording a voice message (mocked MediaRecorder) uploads it as an attachment and posts extra.voice: true, rendered as a native <qu-asset>', async () => {
  installVoiceMocks();
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const actionBtn = container.querySelector('.qu-chat-composer-action');
    assert.equal(actionBtn.textContent, '🎙️');

    actionBtn.click(); // start recording
    await waitFor(() => actionBtn.textContent === '⏹');
    actionBtn.click(); // stop -> FakeMediaRecorder.stop() synchronously fires ondataavailable+onstop

    await waitFor(() => container.querySelector('.qu-chat-bubble-attachment') !== null);
    const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].voice, true);
    assert.ok(messages[0].attachment?.assetId);
    // no redundant placeholder text line next to the player - see renderMessageText()'s own doc comment
    assert.equal(container.querySelector('.qu-chat-bubble-text'), null);
  } finally {
    stop();
  }
});

test('sharing location posts a message with extra.location, rendered as an OpenStreetMap link + coordinates', async () => {
  installGeolocationMock({ latitude: 52.52, longitude: 13.405 });
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    container.querySelector('.qu-chat-tool-btn').click(); // the ONLY .qu-chat-tool-btn is the location button - attachUpload is a <qu-asset-upload>, not this class

    await waitFor(() => container.querySelector('.qu-chat-bubble-location') !== null);
    const link = container.querySelector('.qu-chat-bubble-location a');
    assert.match(link.href, /openstreetmap\.org.*mlat=52\.52.*mlon=13\.405/);
    assert.match(container.querySelector('.qu-chat-bubble-location-coords').textContent, /52\.52000, 13\.40500/);

    const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.deepEqual(messages[0].location, { lat: 52.52, lng: 13.405 });
  } finally {
    stop();
  }
});

test('a message\'s timestamp IS its permalink - #/chat/<peer>/m/<id> for a 1:1 room, #/chat/g/<groupId>/m/<id> for a group', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const posted = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'link me' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('link me'));
    const link = container.querySelector('.qu-chat-bubble-timestamp-link');
    assert.equal(link.getAttribute('href'), `#/chat/${bob.myPub}/m/${posted.id}`);
    // the row itself carries the same id, so the link's own target is a real, addressable DOM anchor
    assert.equal(container.querySelector(`#m-${posted.id}`), link.closest('.qu-chat-bubble-row'));
  } finally {
    stop();
  }

  const { groupId } = await alice.services.chat.createGroup(CHAT_SPACE_ID, { name: 'Team Rocket', memberPubs: [bob.myPub] });
  const groupPosted = await alice.services.messages.postMessage(CHAT_SPACE_ID, groupId, { body: 'group link me' });
  const groupContainer = makeContainer();
  const stopGroup = mount(groupContainer, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', 'g', groupId] });
  try {
    await waitFor(() => groupContainer.querySelector('.qu-chat-bubble-text')?.textContent.includes('group link me'));
    const link = groupContainer.querySelector('.qu-chat-bubble-timestamp-link');
    assert.equal(link.getAttribute('href'), `#/chat/g/${groupId}/m/${groupPosted.id}`);
  } finally {
    stopGroup();
  }
});

test('landing on a message permalink route (#/chat/<peer>/m/<id>) scrolls to and highlights that message only', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'first' });
  const target = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'second' });
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'third' });

  const container = makeContainer();
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub, 'm', target.id],
  });
  try {
    await waitFor(() => container.querySelectorAll('.qu-chat-bubble-row').length === 3);
    const rows = [...container.querySelectorAll('.qu-chat-bubble-row')];
    const highlighted = rows.filter((row) => row.classList.contains('qu-chat-bubble-row-highlight'));
    assert.equal(highlighted.length, 1);
    assert.equal(highlighted[0].id, `m-${target.id}`);
  } finally {
    stop();
  }
});

test('landing on a permalink scrolls the target to the TOP of the view (block: "start"), not the center', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const target = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'find me' });

  // scrollIntoView() is called DURING renderMessages(), on a row that
  // doesn't exist until mount-time render - spied at the shared prototype
  // level (keyed by class), same technique @qu/thread-ui's own popup tests
  // already use for the identical "element doesn't exist until a click/
  // render happens inside the code under test" situation.
  const original = window.HTMLElement.prototype.scrollIntoView;
  const calls = [];
  window.HTMLElement.prototype.scrollIntoView = function (opts) {
    if (this.classList.contains('qu-chat-bubble-row')) calls.push(opts);
  };
  const container = makeContainer();
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub, 'm', target.id],
  });
  try {
    await waitFor(() => calls.length > 0);
    assert.equal(calls[0].block, 'start');
  } finally {
    window.HTMLElement.prototype.scrollIntoView = original;
    stop();
  }
});

test('scrolling back down to the bottom after a permalink releases the anchor from the URL (a later reload lands on the latest message, not the old one)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const target = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'old one' });

  const container = makeContainer();
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub, 'm', target.id],
  });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-row-highlight') !== null);

    const scroll = container.querySelector('.qu-chat-messages-scroll');
    simulateScroll(scroll, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 }); // "at the bottom"

    assert.equal(window.location.hash, `#/chat/${bob.myPub}`);
  } finally {
    stop();
  }
});

test('a new message from someone else while NOT at the bottom does not scroll or rebuild the view - shows the "new message" banner instead', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'first' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('first'));
    const firstRow = container.querySelector('.qu-chat-bubble-row');
    assert.ok(firstRow);
    assert.equal(container.querySelector('.qu-chat-new-message-banner').hidden, true);

    const scroll = container.querySelector('.qu-chat-messages-scroll');
    simulateScroll(scroll, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }); // release stuckToBottom
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    // Bob posts on HIS OWN store, then "syncs" into Alice's - the standard
    // cross-identity technique this file's own tests already use.
    await mirrorProfileInto(alice, bob.qu);
    const bobRoomId = await bob.services.chat.ensureRoom(CHAT_SPACE_ID, alice.myPub);
    assert.equal(bobRoomId, roomId);
    await bob.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'second, from bob' });
    await mirrorThreadInto(bob, alice.qu, CHAT_SPACE_ID, roomId);

    await waitFor(() => container.querySelector('.qu-chat-new-message-banner')?.hidden === false);
    assert.equal(scrollToCalls.length, 0); // never auto-scrolled away from what the user was reading
    // INCREMENTAL APPEND, not a full rebuild - the FIRST row's own DOM node
    // is the exact same element reference as before, never torn down.
    assert.equal(container.querySelector('.qu-chat-bubble-row'), firstRow);
    assert.equal(container.querySelectorAll('.qu-chat-bubble-row').length, 2);
  } finally {
    stop();
  }
});

test('a new message from someone else while AT the bottom scrolls smoothly to it, via incremental append (not a full rebuild)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'first' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('first'));
    const firstRow = container.querySelector('.qu-chat-bubble-row');

    const scroll = container.querySelector('.qu-chat-messages-scroll');
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    await mirrorProfileInto(alice, bob.qu);
    const bobRoomId = await bob.services.chat.ensureRoom(CHAT_SPACE_ID, alice.myPub);
    await bob.services.messages.postMessage(CHAT_SPACE_ID, bobRoomId, { body: 'second, from bob' });
    await mirrorThreadInto(bob, alice.qu, CHAT_SPACE_ID, roomId);

    await waitFor(() => container.querySelectorAll('.qu-chat-bubble-row').length === 2);
    assert.equal(container.querySelector('.qu-chat-bubble-row'), firstRow); // incremental append, first row untouched
    assert.equal(container.querySelector('.qu-chat-new-message-banner').hidden, true);
    await waitFor(() => scrollToCalls.length > 0);
    assert.equal(scrollToCalls.at(-1).behavior, 'smooth');
  } finally {
    stop();
  }
});

test('clicking the "new message" banner scrolls to the bottom and hides it', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'first' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('first'));
    const scroll = container.querySelector('.qu-chat-messages-scroll');
    simulateScroll(scroll, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    await mirrorProfileInto(alice, bob.qu);
    const bobRoomId = await bob.services.chat.ensureRoom(CHAT_SPACE_ID, alice.myPub);
    await bob.services.messages.postMessage(CHAT_SPACE_ID, bobRoomId, { body: 'second, from bob' });
    await mirrorThreadInto(bob, alice.qu, CHAT_SPACE_ID, roomId);
    await waitFor(() => container.querySelector('.qu-chat-new-message-banner')?.hidden === false);

    container.querySelector('.qu-chat-new-message-banner').click();
    assert.equal(container.querySelector('.qu-chat-new-message-banner').hidden, true);
    assert.equal(scrollToCalls.at(-1).behavior, 'smooth');
  } finally {
    stop();
  }
});

test('sending a message always scrolls the view to the bottom, even if the user had scrolled away from it (stuckToBottom released)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const scroll = container.querySelector('.qu-chat-messages-scroll');
    // Simulate the user having scrolled away from the bottom (releasing
    // stuckToBottom) - jsdom reports scrollHeight/clientHeight as 0, so the
    // "am I near the bottom" check (see mountRoomView()'s own scroll
    // listener) reads as NOT near the bottom once scrollTop is nonzero.
    scroll.scrollTop = 500;
    scroll.dispatchEvent(new window.Event('scroll'));

    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    const textarea = container.querySelector('textarea');
    textarea.value = 'catch up to this';
    container.querySelector('.qu-chat-composer-action').click();

    await waitFor(() => scrollToCalls.length > 0);
    assert.equal(scrollToCalls.at(-1).behavior, 'smooth');
  } finally {
    stop();
  }
});

test('searchChat() and resolveChatReference() both link straight to the specific message, not just the room', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const posted = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'findable text' });

  // scope: 'global'/'app' only walks services.contacts.listContacts() + listMyGroups()
  // (see searchChat()'s own doc comment) - alice never added bob as a contact here,
  // only ensureRoom()'d a DM with him, so 'subpage' (searching THIS room directly,
  // via the route's own segments) is the scope that actually covers it.
  const results = await searchChat({ services: alice.services, apps: CHAT_APPS, myPub: alice.myPub, query: 'findable', types: null, scope: 'subpage', segments: ['chat', bob.myPub] });
  assert.equal(results.length, 1);
  assert.equal(results[0].href, `#/chat/${bob.myPub}/m/${posted.id}`);

  const resolved = await resolveChatReference({ services: alice.services, myPub: alice.myPub, spaceId: CHAT_SPACE_ID, threadId: roomId, messageId: posted.id });
  assert.equal(resolved.href, `#/chat/${bob.myPub}/m/${posted.id}`);
});

test('searchChat(): a TYPE filter with no text query returns every locally-available match of that type, not just body-text hits', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'just a normal text message' });
  // An image attachment's own body is never descriptive text a query could
  // match - exactly the case a type-only filter needs to cover.
  const withImage = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, {
    body: '', extra: { attachment: { assetId: 'a1', mime: 'image/png', name: 'photo.png', size: 100 } },
  });

  // No query at all - an empty string, matching what apps/search/client.js
  // sends when the input is blank but a type chip is active.
  const results = await searchChat({ services: alice.services, apps: CHAT_APPS, myPub: alice.myPub, query: '', types: ['image'], scope: 'subpage', segments: ['chat', bob.myPub] });
  assert.equal(results.length, 1);
  assert.equal(results[0].href, `#/chat/${bob.myPub}/m/${withImage.id}`);
  assert.equal(results[0].contentType, 'image');
});

test('the room view uses the fixed-layout structure: a back link in the header, and the message list wrapped in a scrollable container', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    assert.ok(container.querySelector('.qu-chat-room-view'));
    const backLink = container.querySelector('.qu-chat-header-back');
    assert.equal(backLink.getAttribute('href'), '#/chat');
    // the message list lives INSIDE the scrollable wrapper, not directly under roomView
    assert.ok(container.querySelector('.qu-chat-messages-scroll'));
    assert.ok(container.querySelector('.qu-chat-messages-scroll .qu-chat-header') === null); // header is a SIBLING, not inside the scroll area
  } finally {
    stop();
  }
});
