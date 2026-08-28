import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, AssetEngine, CollectionEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import {
  ListService, AccessService, MessageService, ReactionService, PinService, PresenceService, ChatService,
  ActorService, ProfileService, DirectoryService, ContactsService, FlagService, AssetService, NotificationPrefsService, paths,
} from '@qu/services';
import { ExtensionPointHost } from '@qu/foundation';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, renderChatSettings, searchChat, resolveChatReference, renderSearchResult } = await import('../client.js');
const { mountAppTemplate } = await import('@qu/ui');

/** A minimal MediaRecorder test double - start()/pause()/resume()/stop(), stop() synchronously fires ondataavailable then onstop, matching real MediaRecorder's own event order closely enough for startRecording()'s own handler. pause()/resume() just track state (this file's own tests only assert on the DOM state the client itself derives, not on MediaRecorder.state). */
class FakeMediaRecorder {
  constructor() {
    this.mimeType = 'audio/webm';
    this.state = 'inactive';
  }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
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
    notificationPrefs: new NotificationPrefsService(qu, identity),
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
 * A test-only stand-in for the platform-owned `ctx.chrome` handle (Chrome
 * Inversion, `apps/shell/src/chrome.js`) - reuses `@qu/ui`'s own
 * `mountAppTemplate()`, the exact same `buildChrome()` building blocks the
 * real `chrome.js` itself reuses, so a test asserting on real chrome DOM
 * gets byte-identical rendering without importing `apps/shell`'s own
 * internals into a different app's test suite. Renders into `chromeRoot` -
 * a SEPARATE element from whatever `container` the app's own `mount()`
 * writes its business content into, mirroring the real architecture (the
 * platform's sidebar/footer are siblings of the app's own
 * `chrome.contentSlot`, not nested inside it). Copied from
 * `apps/forum/test/client.test.js`'s identical helper - most tests in this
 * file don't need this at all, `client.js`'s own `mount()` defaults
 * `ctx.chrome` to a harmless no-op when absent.
 */
function fakeChrome(chromeRoot) {
  let current = {};
  const stopTemplate = mountAppTemplate(chromeRoot, { render: () => {} });
  return {
    get current() { return current; },
    set(partial) {
      current = { ...current, ...partial };
      stopTemplate.update(current);
    },
  };
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

/**
 * Opens a message's "⋮" context menu (content.messageFooter's core.menu
 * segment) and returns its panel - see apps/forum/test/client.test.js's own
 * identical helper. Scoped to `.qu-chat-bubble-footer` (not a bare
 * `.qu-thread-ui-context-menu-trigger` query) because the composer's own
 * "+" action menu (content.composerActions) is built from the SAME
 * `@qu/thread-ui` `renderContextMenu()` and carries the identical trigger
 * class - an unscoped query can resolve to whichever one happens to exist
 * in the DOM first (the composer mounts synchronously, a message's footer
 * only after its own async render), not necessarily a message's.
 */
async function openMessageMenu(root) {
  const selector = '.qu-chat-bubble-footer .qu-thread-ui-context-menu-trigger';
  await waitFor(() => root.querySelector(selector) !== null);
  root.querySelector(selector).click();
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
    textarea.dispatchEvent(new window.Event('input', { bubbles: true })); // resolves the submit slot's mic<->send switch - see mountContentEditor()'s own doc comment
    const sendBtn = container.querySelector('.qu-content-editor-submit-slot button');
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

test('attaching a file via the composer\'s <qu-asset-upload> morphs the submit control to Send and posts with no caption required', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    // Waits for the room itself to be ready (not just the composer DOM to
    // exist) - same convention the "derives the SAME roomId" test above
    // uses, needed here because attaching a file does real, sometimes-slow
    // crypto work that can otherwise race ahead of roomReady under a loaded
    // full-suite run, leaving the click a silent no-op (the composer isn't
    // even constructed yet - see mountRoomView()'s own doc comment on why).
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const submitBtn = () => container.querySelector('.qu-content-editor-submit-slot button');
    await waitFor(() => submitBtn() !== null);
    assert.equal(submitBtn().textContent, '🎙️'); // no text, no attachment yet - mic

    const fileInput = container.querySelector('qu-asset-upload input[type=file]');
    const file = new File(['fake image bytes'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event('change'));
    // Real Ed25519/SHA-256 work under it - see apps/forum/test/client.test.js's
    // own identical timeout note on its attachment test.
    await waitFor(() => container.querySelector('.qu-content-ui-attachment-chip') !== null, { timeout: 5000 });
    assert.equal(submitBtn().textContent, '➤'); // an attachment alone is enough to morph to Send

    submitBtn().click(); // no caption typed at all
    await waitFor(() => container.querySelector('.qu-chat-bubble-attachment') !== null, { timeout: 5000 });

    const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(messages[0].body, '');
    assert.equal(messages[0].attachments[0].name, 'photo.png');
    assert.equal(container.querySelector('.qu-content-ui-attachment-chip'), null); // cleared on send
    // No stray empty bubble-text paragraph for the caption-less body.
    assert.equal(container.querySelector('.qu-chat-bubble-text'), null);
    assert.equal(submitBtn().textContent, '🎙️'); // back to mic once the attachment was sent and cleared
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

test('content.messageMenu (pins) / content.topicToolbar: the REAL apps/pins app pins a message via its menu item and shows it in the room\'s own pinned bar, live for a second independent mount; unpinning removes it', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'Pin this one' });

  const PINS_CLIENT_URL = new URL('../../pins/client.js', import.meta.url).href;
  const appsWithPins = [
    { name: 'chat', spaceId: CHAT_SPACE_ID },
    {
      name: 'pins', clientMainUrl: PINS_CLIENT_URL, contributes: [
        { point: 'content.messageMenu', export: 'pinMenuItem' },
        { point: 'content.topicToolbar', export: 'renderPinnedBar' },
      ],
    },
  ];

  const containerA = makeContainer();
  const containerB = makeContainer();
  const extensionPointsA = new ExtensionPointHost(appsWithPins);
  const extensionPointsB = new ExtensionPointHost(appsWithPins);
  const stopA = mount(containerA, {
    qu: alice.qu, services: alice.services, apps: appsWithPins, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub], extensionPoints: extensionPointsA,
  });
  const stopB = mount(containerB, {
    qu: alice.qu, services: alice.services, apps: appsWithPins, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub], extensionPoints: extensionPointsB,
  });
  try {
    let panelA = await openMessageMenu(containerA);
    const pinBtn = menuItemButton(panelA, 'Pin');
    assert.ok(pinBtn, 'expected a "Pin" menu item');
    pinBtn.click();

    // A second, independent mount of the SAME room sees it live too.
    await waitFor(() => containerB.querySelector('.qu-pins-bar') !== null);
    const pinnedRowText = containerB.querySelector('.qu-pins-bar-row-text');
    assert.match(pinnedRowText.textContent, /Pin this one/);
    // Clickable - a real permalink, built from chat's own room route, not a
    // plain unclickable snippet.
    assert.equal(pinnedRowText.tagName, 'A');
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(pinnedRowText.getAttribute('href'), `#/chat/${bob.myPub}/m/${messages[0].id}`);

    panelA = await openMessageMenu(containerA); // reopen - menu closed itself on the click above
    assert.ok(menuItemButton(panelA, 'Unpin'));

    containerB.querySelector('.qu-pins-bar-row button').click(); // unpin via the bar's own X
    await waitFor(() => containerB.querySelector('.qu-pins-bar') === null);
  } finally {
    stopA();
    stopB();
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
    textarea.dispatchEvent(new window.Event('input', { bubbles: true })); // resolves the submit slot's mic<->send switch - see mountContentEditor()'s own doc comment
    container.querySelector('.qu-content-editor-submit-slot button').click();

    await waitFor(() => [...container.querySelectorAll('.qu-chat-bubble-text')].some((el) => el.textContent.includes('my reply')));
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    const reply = messages.find((m) => m.body === 'my reply');
    assert.equal(reply.replyTo, original.id);
    // the reply banner cleared itself after sending
    const banner = container.querySelector('.qu-chat-reply-banner');
    assert.equal(banner.hidden, true);
    // Regression: .qu-chat-reply-banner's own `display: flex` rule used to
    // have no `[hidden]` override, so the empty banner stayed VISUALLY
    // rendered (a bare rounded left-accent stripe, looking like a stray "("
    // sitting on its own line above the composer) even with `hidden` set -
    // see this rule's own doc comment in the STYLE block above.
    assert.equal(window.getComputedStyle(banner).display, 'none');
  } finally {
    stop();
  }
});

test('SWIPE-TO-REPLY: a horizontal drag past the threshold opens the reply banner, same as the "Reply" menu item', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'swipe me' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('swipe me'));
    const row = container.querySelector('.qu-chat-bubble-row');

    row.dispatchEvent(new window.TouchEvent('touchstart', { touches: [{ clientX: 20, clientY: 100 }] }));
    row.dispatchEvent(new window.TouchEvent('touchmove', { touches: [{ clientX: 90, clientY: 102 }] })); // clearly horizontal, dx=70 past SWIPE_REPLY_THRESHOLD_PX (56)
    assert.ok(row.classList.contains('qu-chat-bubble-row-swipe-armed'));
    row.dispatchEvent(new window.TouchEvent('touchend', { touches: [] }));

    await waitFor(() => container.querySelector('.qu-chat-reply-banner')?.hidden === false);
    assert.match(container.querySelector('.qu-chat-reply-banner').textContent, /Replying to You/);
    assert.equal(row.classList.contains('qu-chat-bubble-row-swipe-armed'), false); // reset() on touchend always clears the armed state too
  } finally {
    stop();
  }
});

test('SWIPE-TO-REPLY: a mostly-vertical drag never arms or replies - the messages list\'s own vertical scroll stays untouched', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'do not swipe me' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('do not swipe me'));
    const row = container.querySelector('.qu-chat-bubble-row');

    row.dispatchEvent(new window.TouchEvent('touchstart', { touches: [{ clientX: 20, clientY: 100 }] }));
    row.dispatchEvent(new window.TouchEvent('touchmove', { touches: [{ clientX: 25, clientY: 160 }] })); // mostly vertical
    row.dispatchEvent(new window.TouchEvent('touchend', { touches: [] }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(container.querySelector('.qu-chat-reply-banner').hidden, true);
    assert.equal(row.classList.contains('qu-chat-bubble-row-swipe-armed'), false);
  } finally {
    stop();
  }
});

test('SWIPE-TO-REPLY: a horizontal drag that never reaches the threshold snaps back without replying', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'just a little swipe' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('just a little swipe'));
    const row = container.querySelector('.qu-chat-bubble-row');

    row.dispatchEvent(new window.TouchEvent('touchstart', { touches: [{ clientX: 20, clientY: 100 }] }));
    row.dispatchEvent(new window.TouchEvent('touchmove', { touches: [{ clientX: 45, clientY: 101 }] })); // horizontal, dx=25, under the 56px threshold
    assert.equal(row.classList.contains('qu-chat-bubble-row-swipe-armed'), false);
    row.dispatchEvent(new window.TouchEvent('touchend', { touches: [] }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(container.querySelector('.qu-chat-reply-banner').hidden, true);
  } finally {
    stop();
  }
});

// ===== content.chatRoomMenu - the room header's own "⋮" menu =====

/** Opens the room header's own "⋮" menu (content.chatRoomMenu) - see openMessageMenu()'s own doc comment for why this needs its own scoped selector rather than a bare `.qu-thread-ui-context-menu-trigger` query. */
async function openRoomMenu(root) {
  const selector = '.qu-chat-header-menu-btn .qu-thread-ui-context-menu-trigger';
  await waitFor(() => root.querySelector(selector) !== null);
  root.querySelector(selector).click();
  await waitFor(() => root.querySelector('.qu-thread-ui-context-menu-panel') !== null);
  return root.querySelector('.qu-thread-ui-context-menu-panel');
}

/**
 * `waitFor()` (`@qu/ui/testing`) only ever calls its predicate SYNCHRONOUSLY
 * (`while (!check())` never awaits the result - see apps/notifications/
 * test/client.test.js's own identical note) - an async predicate's Promise
 * object is always truthy, so it resolves on the very first check regardless
 * of what it actually settles to. A real poll loop is needed for an
 * assertion that depends on an async write (here: the mute toggle's own
 * `savePrefs()`) having actually landed.
 */
async function waitForAsync(check, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitForAsync: condition never became true within ' + timeoutMs + 'ms');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('the room "⋮" menu\'s native "Mute notifications" item toggles this room\'s mutedThreads entry, and its own label flips accordingly', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');

    let panel = await openRoomMenu(container);
    assert.ok(menuItemButton(panel, 'Mute notifications'));
    menuItemButton(panel, 'Mute notifications').click();

    await waitForAsync(async () => (await alice.services.notificationPrefs.getOwnPrefs()).apps?.chat?.mutedThreads?.includes(roomId));

    panel = await openRoomMenu(container);
    assert.ok(menuItemButton(panel, 'Unmute notifications'));
    menuItemButton(panel, 'Unmute notifications').click();

    await waitForAsync(async () => !(await alice.services.notificationPrefs.getOwnPrefs()).apps?.chat?.mutedThreads?.includes(roomId));
  } finally {
    stop();
  }
});

test('muting a room shows a crossed-out bell in the room header immediately, and in the room-list row on the next render - no reload/remount needed', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    assert.equal(container.querySelector('.qu-chat-header-muted').hidden, true);

    const panel = await openRoomMenu(container);
    menuItemButton(panel, 'Mute notifications').click();
    await waitForAsync(async () => (await alice.services.notificationPrefs.getOwnPrefs()).apps?.chat?.mutedThreads?.includes(roomId));
    assert.equal(container.querySelector('.qu-chat-header-muted').hidden, false); // updated in place, no re-mount
  } finally {
    stop();
  }

  // Back to the room list - the same muted thread shows a bell on its row too.
  await alice.services.contacts.addContact(bob.myPub);
  const listContainer = makeContainer();
  const stopList = mount(listContainer, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => listContainer.querySelector('.qu-chat-room-row') !== null);
    const row = listContainer.querySelector('.qu-chat-room-row');
    assert.ok(row.querySelector('.qu-chat-room-muted'));
    assert.equal(row.querySelector('.qu-chat-room-muted').textContent, '🔕');
  } finally {
    stopList();
  }
});

test('the room "⋮" menu\'s native "Delete chat" item asks for confirmation, then hides the room from this identity\'s own room list and navigates back to it - the underlying thread is untouched (the other side keeps their own copy)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await alice.services.contacts.addContact(bob.myPub);
  const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');

    let confirmed = false;
    window.confirm = (msg) => { confirmed = true; assert.ok(msg.length > 0); return true; };

    const panel = await openRoomMenu(container);
    assert.ok(menuItemButton(panel, 'Delete chat'));
    menuItemButton(panel, 'Delete chat').click();

    await waitForAsync(async () => window.location.hash === '#/chat');
    assert.ok(confirmed);

    // The thread itself is still there (this is a local "hide", not a real delete).
    const config = await alice.services.messages.getConfig(CHAT_SPACE_ID, roomId);
    assert.ok(config);
  } finally {
    stop();
  }

  // The room list no longer shows it, even though Bob is still a contact.
  const listContainer = makeContainer();
  const stopList = mount(listContainer, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => listContainer.querySelector('.qu-chat-empty, .qu-chat-room-row') !== null);
    assert.equal(listContainer.querySelector('.qu-chat-room-row'), null);
  } finally {
    stopList();
  }
});

test('declining the "Delete chat" confirmation leaves the room in the list untouched', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await alice.services.contacts.addContact(bob.myPub);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    // Different from the previous test's own leftover hash, so an
    // (incorrect) navigation on decline is still detectable below.
    window.location.hash = '#/chat/' + bob.myPub;
    window.confirm = () => false;

    const panel = await openRoomMenu(container);
    menuItemButton(panel, 'Delete chat').click();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let any (unwanted) async work settle
    assert.equal(window.location.hash, '#/chat/' + bob.myPub);
  } finally {
    stop();
  }

  const listContainer = makeContainer();
  const stopList = mount(listContainer, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => listContainer.querySelector('.qu-chat-room-row') !== null);
    assert.ok(listContainer.querySelector('.qu-chat-room-row'));
  } finally {
    stopList();
  }
});

test('the room "⋮" menu merges native items with whatever a plugin app contributes to content.chatRoomMenu, passing contactPub for a 1:1 room and null for a group', async () => {
  const { resetSeenPayloads, getSeenPayloads } = await import('./fake-chat-room-menu-plugin.js');
  resetSeenPayloads();

  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const FAKE_PLUGIN_CLIENT_URL = new URL('./fake-chat-room-menu-plugin.js', import.meta.url).href;
  const appsWithPlugin = [
    { name: 'chat', spaceId: CHAT_SPACE_ID },
    {
      name: 'fake-plugin', clientMainUrl: FAKE_PLUGIN_CLIENT_URL,
      contributes: [{ point: 'content.chatRoomMenu', export: 'renderFakeCallItem' }],
    },
  ];

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(appsWithPlugin);
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: appsWithPlugin, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub], extensionPoints,
  });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const panel = await openRoomMenu(container);
    assert.ok(menuItemButton(panel, 'Mute notifications')); // native item still present
    assert.ok(menuItemButton(panel, 'Fake Call')); // the plugin's own contribution

    const [payload] = getSeenPayloads();
    assert.equal(payload.contactPub, bob.myPub); // a 1:1 room passes the real contact pub
    assert.equal(payload.spaceId, CHAT_SPACE_ID);
  } finally {
    stop();
  }
});

test('a GROUP room passes contactPub: null to content.chatRoomMenu - a group has no single "the contact" to call', async () => {
  const { resetSeenPayloads, getSeenPayloads } = await import('./fake-chat-room-menu-plugin.js');
  resetSeenPayloads();

  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const { groupId } = await alice.services.chat.createGroup(CHAT_SPACE_ID, { name: 'Group A', memberPubs: [alice.myPub, bob.myPub] });

  const FAKE_PLUGIN_CLIENT_URL = new URL('./fake-chat-room-menu-plugin.js', import.meta.url).href;
  const appsWithPlugin = [
    { name: 'chat', spaceId: CHAT_SPACE_ID },
    {
      name: 'fake-plugin', clientMainUrl: FAKE_PLUGIN_CLIENT_URL,
      contributes: [{ point: 'content.chatRoomMenu', export: 'renderFakeCallItem' }],
    },
  ];

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(appsWithPlugin);
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: appsWithPlugin, subscribe: noopSubscribe,
    segments: ['chat', 'g', groupId], extensionPoints,
  });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    await openRoomMenu(container);
    const [payload] = getSeenPayloads();
    assert.equal(payload.contactPub, null);
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

test('clicking the read (✓✓) tick reveals a popover with WHEN it was read, and clicking again hides it', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'when did you read this' });

  await bob.services.presence.publishReadReceipt(CHAT_SPACE_ID, roomId, Date.now() + 1000);
  const receiptPath = paths.threadReadReceiptPath(CHAT_SPACE_ID, roomId, bob.myPub);
  await alice.qu.putSealed(receiptPath, await bob.qu.get(receiptPath));

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('[data-segment="core.readReceipt"]')?.textContent.includes('✓✓'));
    const tick = container.querySelector('[data-segment="core.readReceipt"]');
    assert.equal(container.querySelector('.qu-chat-bubble-tick-popover'), null);

    tick.click();
    await waitFor(() => container.querySelector('.qu-chat-bubble-tick-popover'));
    assert.ok(container.querySelector('.qu-chat-bubble-tick-popover').textContent.length > 0);

    tick.click(); // same tick again - toggles the popover closed
    assert.equal(container.querySelector('.qu-chat-bubble-tick-popover'), null);
  } finally {
    stop();
  }
});

test('TYPING INDICATOR: a DM peer typing shows "typing…" instead of online/last-seen', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);

  // Bob is typing, mirrored into Alice's store BEFORE her room view even
  // mounts - same putSealed() technique the read-receipt tests above
  // already use. See PresenceService.setPresence()'s own "typing" doc
  // comment.
  await bob.services.presence.setPresence(CHAT_SPACE_ID, roomId, 'online', { typing: true });
  const presencePath = paths.threadPresencePath(CHAT_SPACE_ID, roomId, bob.myPub);
  await alice.qu.putSealed(presencePath, await bob.qu.get(presencePath));

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-header-status')?.textContent === 'typing…');
  } finally {
    stop();
  }
});

test('TYPING INDICATOR: a DM peer who is online but NOT typing still shows the plain "online" status (regression guard)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);

  await bob.services.presence.setPresence(CHAT_SPACE_ID, roomId, 'online');
  const presencePath = paths.threadPresencePath(CHAT_SPACE_ID, roomId, bob.myPub);
  await alice.qu.putSealed(presencePath, await bob.qu.get(presencePath));

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-header-status')?.textContent === 'online');
  } finally {
    stop();
  }
});

test('TYPING INDICATOR: in a group, a typing member\'s name replaces the "N online" summary', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await mirrorProfileInto(alice, bob.qu);
  const { groupId } = await alice.services.chat.createGroup(CHAT_SPACE_ID, { name: 'Team Rocket', memberPubs: [bob.myPub] });

  await bob.services.presence.setPresence(CHAT_SPACE_ID, groupId, 'online', { typing: true });
  const presencePath = paths.threadPresencePath(CHAT_SPACE_ID, groupId, bob.myPub);
  await alice.qu.putSealed(presencePath, await bob.qu.get(presencePath));

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', 'g', groupId] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-header-status')?.textContent === 'Bob typing…');
  } finally {
    stop();
  }
});

test('TYPING INDICATOR: typing in the composer publishes it; clearing the draft (or sending) publishes "stopped" right away, not after the idle timer', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const presencePath = paths.threadPresencePath(CHAT_SPACE_ID, roomId, alice.myPub);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    const textarea = container.querySelector('textarea');

    textarea.value = 'hi bob';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(async () => (await alice.qu.get(presencePath))?.val?.typing === true);

    textarea.value = '';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(async () => (await alice.qu.get(presencePath))?.val?.typing === false);
  } finally {
    stop();
  }
});

test('clicking the sent-only (✓) tick does nothing - no read time to reveal yet', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'not read yet' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('[data-segment="core.readReceipt"]')?.textContent.includes('✓'));
    container.querySelector('[data-segment="core.readReceipt"]').click();
    assert.equal(container.querySelector('.qu-chat-bubble-tick-popover'), null);
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
    // just for the textarea to exist - the composer is only constructed
    // once memberPubs/roomReady resolve (see mountRoomView()'s own doc
    // comment on why).
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const textarea = container.querySelector('textarea');
    textarea.value = 'no reply';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    container.querySelector('.qu-content-editor-submit-slot button').click();
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('no reply'));
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(messages.find((m) => m.body === 'no reply').replyTo, null);
  } finally {
    stop();
  }
});

test('the composer submit control morphs between mic (empty) and send (has text)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const submitBtn = () => container.querySelector('.qu-content-editor-submit-slot button');
    await waitFor(() => submitBtn() !== null);
    const textarea = container.querySelector('textarea');
    assert.equal(submitBtn().textContent, '🎙️');

    textarea.value = 'hello';
    textarea.dispatchEvent(new window.Event('input'));
    assert.equal(submitBtn().textContent, '➤');

    textarea.value = '';
    textarea.dispatchEvent(new window.Event('input'));
    assert.equal(submitBtn().textContent, '🎙️');
  } finally {
    stop();
  }
});

test('recording a voice message goes through start -> finish -> PREVIEW -> send, uploading it as an audio attachment and rendering as a native <qu-asset> - the pause/resume/discard state machine itself is covered by packages/content-ui/test/voice-extension.test.js', async () => {
  installVoiceMocks();
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const submitBtn = () => container.querySelector('.qu-content-editor-submit-slot button');
    await waitFor(() => submitBtn() !== null);
    assert.equal(submitBtn().textContent, '🎙️');
    assert.equal(container.querySelector('.qu-content-ui-voice-recorder'), null);

    submitBtn().click(); // start recording
    await waitFor(() => container.querySelector('.qu-content-ui-voice-recorder') !== null);

    container.querySelector('.qu-content-ui-voice-recorder button[title="Finish recording"]').click();
    // Finishing lands in PREVIEW, not an immediate send - a real playback
    // player appears, nothing has been posted yet.
    await waitFor(() => container.querySelector('.qu-content-ui-voice-preview').hidden === false);
    const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);
    assert.equal((await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId)).messages.length, 0);

    container.querySelector('.qu-content-ui-voice-recorder button[title="Send"]').click();

    await waitFor(() => container.querySelector('.qu-chat-bubble-attachment') !== null);
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, ''); // no separate "voice" flag/placeholder text anymore - see isVoiceMessage()'s own doc comment
    assert.equal(messages[0].attachments.length, 1);
    assert.ok(messages[0].attachments[0].mime.startsWith('audio/'));
    // no redundant placeholder text line next to the player
    assert.equal(container.querySelector('.qu-chat-bubble-text'), null);
    // back to the normal composer, ready for the next message
    assert.equal(container.querySelector('.qu-content-ui-voice-recorder'), null);
    assert.equal(submitBtn().textContent, '🎙️');
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
    // Location sharing is now locationExtension()'s own leading-slot trigger
    // (an icon in the composer's leading action row, not a menu item) - it
    // CONTRIBUTES the position and waits for the user's own explicit Send
    // (a deliberate improvement over this app's own earlier immediate-send
    // behavior - see that extension's own doc comment), rather than posting
    // the instant a position resolves.
    const locationBtn = () => [...container.querySelectorAll('.qu-content-editor-leading .qu-slot-resolver-item')].find((btn) => btn.title === 'Share my location');
    await waitFor(() => locationBtn() !== undefined);
    locationBtn().click();

    await waitFor(() => container.querySelector('.qu-content-ui-location-chip') !== null);
    container.querySelector('.qu-content-editor-submit-slot button').click();

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

test('the composer textarea starts at ONE visual line (rows=1) - regression: an un-sized <textarea> defaults to the UA\'s own rows=2', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    await waitFor(() => container.querySelector('.qu-content-editor-input-wrap textarea') !== null);
    assert.equal(container.querySelector('.qu-content-editor-input-wrap textarea').rows, 1);
  } finally {
    stop();
  }
});

test('the composer\'s leading action slot includes Attach/Share location natively, plus any plugin-contributed content.composerActions item', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  // A duck-typed stub (not a real ExtensionPointHost) - this point has no
  // real contributing app yet, this only proves the HOOK itself works, the
  // same way this file's own "content.messageMenu: without extensionPoints"
  // sibling test proves the native-only path.
  const seen = [];
  const extensionPoints = {
    order: null,
    collect: async (point, payload) => {
      seen.push({ point, payload });
      return [{ id: 'gallery.pick', label: 'Pick from Gallery', icon: '🖼️', onClick: () => {} }];
    },
  };
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub], extensionPoints,
  });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    // Native Attach/Location register 2 leading items (voice no longer
    // registers a leading action - see voice-extension.js's own doc comment,
    // it's submit-slot-only now); the plugin's own content.composerActions
    // item is a 3rd, arriving async (see composerActionsExtension()'s own
    // doc comment) - with the Presentation Resolver's default
    // 'inline-then-menu' threshold (2), only the first 2 ever render inline;
    // the plugin item collapses into a "More" menu.
    await waitFor(() => container.querySelectorAll('.qu-content-editor-leading .qu-slot-resolver-item').length === 2);
    const inlineItems = [...container.querySelectorAll('.qu-content-editor-leading .qu-slot-resolver-item')];
    assert.deepEqual(inlineItems.map((btn) => btn.textContent), ['📎', '📍']);

    const moreBtn = () => container.querySelector('.qu-content-editor-leading .qu-thread-ui-context-menu-trigger');
    await waitFor(() => moreBtn() !== null);
    moreBtn().click();
    await waitFor(() => container.querySelector('.qu-thread-ui-context-menu-panel') !== null);
    const panel = container.querySelector('.qu-thread-ui-context-menu-panel');
    await waitFor(() => panel.querySelectorAll('.qu-thread-ui-context-menu-item').length === 1);
    const menuItems = [...panel.querySelectorAll('.qu-thread-ui-context-menu-item')].map((btn) => btn.textContent);
    assert.deepEqual(menuItems, ['🖼️Pick from Gallery']);

    const composerActionsCalls = seen.filter((call) => call.point === 'content.composerActions');
    assert.equal(composerActionsCalls.length, 1);
    assert.equal(composerActionsCalls[0].payload.spaceId, CHAT_SPACE_ID);
  } finally {
    stop();
  }
});

test('a message body URL is auto-linked AND gets a <qu-link-preview url="..."> right after the text - only the FIRST of several links', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'see https://example.com/a and also https://example.com/b' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text a') !== null);
    const links = [...container.querySelectorAll('.qu-chat-bubble-text a')];
    assert.equal(links.length, 2);
    assert.equal(links[0].href, 'https://example.com/a');
    assert.equal(links[0].rel, 'noopener noreferrer');

    const previews = container.querySelectorAll('qu-link-preview');
    assert.equal(previews.length, 1); // only the first link, not one per link
    assert.equal(previews[0].getAttribute('url'), 'https://example.com/a');
  } finally {
    stop();
  }
});

test('a message body with no URL gets no <qu-link-preview> at all', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'no links here' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('no links here'));
    assert.equal(container.querySelector('qu-link-preview'), null);
  } finally {
    stop();
  }
});

test('a message body renders real markdown (bold/italic) via formattedHtml - THREAD_PRESETS.chat() now includes markdown formatting', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: '**bold** and *italic*' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text strong') !== null);
    assert.equal(container.querySelector('.qu-chat-bubble-text strong').textContent, 'bold');
    assert.equal(container.querySelector('.qu-chat-bubble-text em').textContent, 'italic');
  } finally {
    stop();
  }
});

test('a mention of a profile-published identity renders as their CURRENT alias, not a truncated pubkey - a genuinely new feature for Chat this round', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu); // Alice's own store already needs Bob's profile/X key to encrypt for him - the same copy resolves his mention alias
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: `hey @${bob.myPub}` });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('a.qu-mention') !== null);
    await waitFor(() => container.querySelector('a.qu-mention').textContent === '@Bob');
    assert.equal(container.querySelector('a.qu-mention').getAttribute('href'), `#/~${bob.myPub}`);
  } finally {
    stop();
  }
});

test('a mention with no resolvable profile falls back to the truncated-pubkey display, unchanged', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const strangerPub = 'z'.repeat(20); // no profile ever published for this token - nobody can resolve an alias for it
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: `hey @${strangerPub}` });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('a.qu-mention') !== null);
    // Give the async resolveAuthor()/formatActorLabel() pass a real chance to run before asserting it made no change.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(container.querySelector('a.qu-mention').textContent, /^@~/);
  } finally {
    stop();
  }
});

test('MESSAGE GROUPING: consecutive messages from the same author collapse into one visual burst - the author-name label shows only on the first of a run and the row gets a tighter ".qu-chat-bubble-row-grouped" margin, but switching author always starts a fresh, ungrouped row', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await mirrorProfileInto(alice, bob.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);

  // showAliasIn1to1 - a 1:1 room only shows the author-name label at all
  // once this per-identity setting (renderChatSettings()) is on, same
  // toggle the settings test above drives.
  const settingsContainer = makeContainer();
  await renderChatSettings(settingsContainer, { myPub: alice.myPub, services: alice.services });
  const aliasCheckbox = settingsContainer.querySelector('input[type="checkbox"]');
  aliasCheckbox.checked = true;
  aliasCheckbox.dispatchEvent(new window.Event('change'));
  await waitFor(() => settingsContainer.querySelector('.qu-chat-settings-status')?.hidden === false);

  // Bob posts twice in a row (own store, mirrored in - the standard
  // cross-identity technique this file's own tests already use), then
  // Alice replies, then Bob posts once more - real wall-clock ts order,
  // no clock mocking needed.
  const bobRoomId = await bob.services.chat.ensureRoom(CHAT_SPACE_ID, alice.myPub);
  assert.equal(bobRoomId, roomId);
  await bob.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'first from bob' });
  await bob.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'second from bob, right after' });
  await mirrorThreadInto(bob, alice.qu, CHAT_SPACE_ID, roomId);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'now alice replies' });
  await bob.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'bob again' });
  await mirrorThreadInto(bob, alice.qu, CHAT_SPACE_ID, roomId);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelectorAll('.qu-chat-bubble-row').length === 4);
    const rows = [...container.querySelectorAll('.qu-chat-bubble-row')];

    assert.equal(rows[0].classList.contains('qu-chat-bubble-row-grouped'), false);
    assert.ok(rows[0].querySelector('.qu-chat-bubble-author'), 'first message of a run shows the author label');
    // A small avatar rides along with the name (renderAvatarOrAsset(),
    // the SAME helper the room list/header already use) - not just plain text.
    assert.ok(rows[0].querySelector('.qu-chat-bubble-author .qu-avatar'), 'the author label also shows a small avatar, not just text');

    assert.equal(rows[1].classList.contains('qu-chat-bubble-row-grouped'), true, 'same author, right after -> grouped');
    assert.equal(rows[1].querySelector('.qu-chat-bubble-author'), null, 'a grouped follow-up never repeats the author label');

    assert.equal(rows[2].classList.contains('qu-chat-bubble-row-grouped'), false, 'a different author (Alice, replying) always breaks the group');

    assert.equal(rows[3].classList.contains('qu-chat-bubble-row-grouped'), false, 'switching back to Bob after Alice also starts a fresh row');
    assert.ok(rows[3].querySelector('.qu-chat-bubble-author'), 'and shows the author label again');
  } finally {
    stop();
  }
});

test('COMPACT MODE: the "compactMode" chat setting toggles a ".qu-chat-compact" class on the room view, tightening the message list without changing its content', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'hello' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('hello'));
    assert.equal(container.querySelector('.qu-chat-room-view').classList.contains('qu-chat-compact'), false);

    const settingsContainer = makeContainer();
    await renderChatSettings(settingsContainer, { myPub: alice.myPub, services: alice.services });
    const compactCheckbox = [...settingsContainer.querySelectorAll('input[type="checkbox"]')][1]; // alias, THEN compact - renderChatSettings()'s own field order
    compactCheckbox.checked = true;
    compactCheckbox.dispatchEvent(new window.Event('change'));
    await waitFor(() => settingsContainer.querySelector('.qu-chat-settings-status')?.hidden === false);

    // Nothing pushes the setting change into an already-open room - the
    // NEXT render (a real message list update) is what re-applies it, same
    // as chatSettings.ownColor/showAliasIn1to1 already work.
    await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'triggers a re-render' });
    await waitFor(() => container.querySelector('.qu-chat-room-view').classList.contains('qu-chat-compact'));
  } finally {
    stop();
  }
});

test('two files attached in sequence both ride along on one message.attachments[] - the "clean schema" plural-attachment adoption', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const fileInput = () => container.querySelector('qu-asset-upload input[type=file]');

    const file1 = new File(['fake image bytes 1'], 'photo1.png', { type: 'image/png' });
    Object.defineProperty(fileInput(), 'files', { value: [file1], configurable: true });
    fileInput().dispatchEvent(new window.Event('change'));
    await waitFor(() => container.querySelectorAll('.qu-content-ui-attachment-chip').length === 1, { timeout: 5000 });

    const file2 = new File(['fake image bytes 2'], 'photo2.png', { type: 'image/png' });
    Object.defineProperty(fileInput(), 'files', { value: [file2], configurable: true });
    fileInput().dispatchEvent(new window.Event('change'));
    await waitFor(() => container.querySelectorAll('.qu-content-ui-attachment-chip').length === 2, { timeout: 5000 });

    container.querySelector('.qu-content-editor-submit-slot button').click();

    // Two IMAGE attachments on one message render as an album grid, not two
    // stacked previews - see renderMessageText()'s own "ALBUM GRID" doc
    // comment.
    await waitFor(() => container.querySelectorAll('.qu-chat-bubble-attachment-grid qu-asset').length === 2, { timeout: 5000 });
    const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);
    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId);
    assert.equal(messages[0].attachments.length, 2);
    assert.deepEqual(messages[0].attachments.map((a) => a.name).sort(), ['photo1.png', 'photo2.png']);
  } finally {
    stop();
  }
});

test('an attachment sent through the new composer is genuinely built with real readerPubs - not the stale, empty array a closure-capture bug would silently upload public with', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  // Deliberately NOT mirroring Bob's profile into Alice's own store here -
  // `AssetService.upload()`'s encryption step (`resolveReaderXKeys()`)
  // fails CLOSED with a specific, distinguishing error ("no published
  // profile") when given a non-empty `readerPubs` list containing a pub it
  // can't resolve. If the composer were (bug) constructed with a stale,
  // empty `readerPubs: []` - the exact risk `mountRoomView()`'s own doc
  // comment on this - `resolveReaderXKeys()` is never even called (its own
  // `if (readerPubs.length)` guard short-circuits), and the upload would
  // silently SUCCEED, uploading Bob's own would-be-private photo public.
  // Seeing this specific failure is the proof `readerPubs` was genuinely
  // `[alice.myPub, bob.myPub]` at upload time, not `[]`.
  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    const fileInput = container.querySelector('qu-asset-upload input[type=file]');
    const file = new File(['secret photo bytes'], 'secret.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event('change'));

    await waitFor(() => container.querySelector('.qu-asset-upload-error') !== null, { timeout: 5000 });
    assert.match(container.querySelector('.qu-asset-upload-error').textContent, /no published profile/);
    // Nothing was silently sent public - no chip, no message.
    assert.equal(container.querySelector('.qu-content-ui-attachment-chip'), null);
    const roomId = await ChatService.roomId([alice.myPub, bob.myPub]);
    assert.equal((await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId)).messages.length, 0);
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

test('content.messageMenu: "Copy text"/"Copy link" copy the message body and an ABSOLUTE permalink (not a bare hash) to the clipboard', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const posted = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'copy me please' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  const written = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { written.push(text); } } }, configurable: true });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('copy me please'));
    let panel = await openMessageMenu(container);
    menuItemButton(panel, 'Copy text').click();
    await waitFor(() => written.length === 1);
    assert.equal(written[0], 'copy me please');

    panel = await openMessageMenu(container);
    menuItemButton(panel, 'Copy link').click();
    await waitFor(() => written.length === 2);
    assert.equal(written[1], `http://localhost/#/chat/${bob.myPub}/m/${posted.id}`); // absolute, not the bare hash
  } finally {
    stop();
    Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  }
});

test('a reply quote is a real link to its parent message\'s own permalink, not just a text snippet - regression: it used to be a plain, unclickable <div>', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const original = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'the original message' });
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'a reply', replyTo: original.id });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-reply') !== null);
    const quote = container.querySelector('.qu-chat-bubble-reply');
    assert.equal(quote.tagName, 'A');
    assert.equal(quote.getAttribute('href'), `#/chat/${bob.myPub}/m/${original.id}`);
    assert.equal(quote.textContent, 'the original message');
  } finally {
    stop();
  }
});

test('a reply quote still links correctly even when its parent message isn\'t locally resolved (e.g. paginated out) - falls back to a generic label, not a broken/missing link', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const unresolvedParentId = 'not-actually-loaded';
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'a reply to something unresolved', replyTo: unresolvedParentId });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-reply') !== null);
    const quote = container.querySelector('.qu-chat-bubble-reply');
    assert.equal(quote.getAttribute('href'), `#/chat/${bob.myPub}/m/${unresolvedParentId}`);
    assert.equal(quote.textContent, 'Original message');
  } finally {
    stop();
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

test('landing on a message permalink shows the persistent scroll-to-bottom button (not just when a new message arrives)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const target = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'find me' });
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'later one' });

  const container = makeContainer();
  const stop = mount(container, {
    qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe,
    segments: ['chat', bob.myPub, 'm', target.id],
  });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-row-highlight') !== null);
    assert.equal(container.querySelector('.qu-chat-scroll-bottom-btn').hidden, false);
    assert.equal(container.querySelector('.qu-chat-scroll-bottom-btn').classList.contains('qu-chat-scroll-bottom-btn-unseen'), false);
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

test('a new message from someone else while NOT at the bottom does not scroll or rebuild the view - marks the persistent scroll-to-bottom button as unseen instead', async () => {
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
    assert.equal(container.querySelector('.qu-chat-scroll-bottom-btn').hidden, true);

    const scroll = container.querySelector('.qu-chat-messages-scroll');
    simulateScroll(scroll, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }); // release stuckToBottom
    assert.equal(container.querySelector('.qu-chat-scroll-bottom-btn').hidden, false); // persistent button appears just from scrolling up, no new message needed
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    // Bob posts on HIS OWN store, then "syncs" into Alice's - the standard
    // cross-identity technique this file's own tests already use.
    await mirrorProfileInto(alice, bob.qu);
    const bobRoomId = await bob.services.chat.ensureRoom(CHAT_SPACE_ID, alice.myPub);
    assert.equal(bobRoomId, roomId);
    await bob.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'second, from bob' });
    await mirrorThreadInto(bob, alice.qu, CHAT_SPACE_ID, roomId);

    await waitFor(() => container.querySelector('.qu-chat-scroll-bottom-btn')?.classList.contains('qu-chat-scroll-bottom-btn-unseen'));
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
    assert.equal(container.querySelector('.qu-chat-scroll-bottom-btn').hidden, true);
    await waitFor(() => scrollToCalls.length > 0);
    assert.equal(scrollToCalls.at(-1).behavior, 'smooth');
  } finally {
    stop();
  }
});

test('a visual-viewport resize (mobile keyboard opening, or a browser chrome collapse/expand) re-snaps to the bottom while stuck to it - regression: the ResizeObserver above only watches content height, never the scroll CONTAINER\'s own available height, so a keyboard opening left the newest message(s) scrolled out of view with nothing correcting it', async () => {
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
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    // jsdom (this repo's test DOM) has no `window.visualViewport` at all -
    // exercises the mountRoomView() fallback (`window.visualViewport ??
    // window`) the same way a real browser without it would.
    window.dispatchEvent(new window.Event('resize'));

    await waitFor(() => scrollToCalls.length > 0);
    assert.equal(scrollToCalls.at(-1).behavior, 'auto'); // instant, not smooth - a correction, not a user-visible "scroll to bottom" action
  } finally {
    stop();
  }
});

test('clicking the persistent scroll-to-bottom button scrolls to the bottom and hides it', async () => {
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
    await waitFor(() => container.querySelector('.qu-chat-scroll-bottom-btn')?.hidden === false);

    container.querySelector('.qu-chat-scroll-bottom-btn').click();
    assert.equal(container.querySelector('.qu-chat-scroll-bottom-btn').hidden, true);
    assert.equal(scrollToCalls.at(-1).behavior, 'smooth');
  } finally {
    stop();
  }
});

test('a resize-triggered "stay at bottom" correction is never falsely undone by its own scroll event catching up mid-content-growth (regression: an attachment growing messagesRoot across MULTIPLE steps - e.g. a large image resolving its real size well after an initial placeholder - could race the native \'scroll\' event for our OWN correction, read as "the user scrolled away", and permanently strand the newest message off-screen with no further correction ever attempted) - ported from apps/forum/client.js\'s own identical fix/test', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'first' });

  // jsdom (this repo's test DOM) has no ResizeObserver at all - a minimal
  // fake, installed just for this test, lets it manually drive the exact
  // callback a real browser would invoke on each layout step.
  let roInstance = null;
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; roInstance = this; }
    observe() {}
    disconnect() {}
  }
  const originalRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-bubble-text')?.textContent.includes('first'));
    assert.ok(roInstance, 'expected the client to have constructed a ResizeObserver');
    const scroll = container.querySelector('.qu-chat-messages-scroll');
    // Emulates a real browser's own clamping - jsdom's plain scrollTop
    // property doesn't clamp on its own.
    scroll.scrollTo = (opts) => { scroll.scrollTop = Math.max(0, Math.min(opts.top, scroll.scrollHeight - scroll.clientHeight)); };
    Object.defineProperty(scroll, 'clientHeight', { value: 519, configurable: true });

    // STEP 1: an attachment is still mid-decode - content is 548px tall.
    Object.defineProperty(scroll, 'scrollHeight', { value: 548, configurable: true });
    roInstance.cb();
    assert.equal(scroll.scrollTop, 29); // clamped: 548 - 519

    // STEP 2: content grows FURTHER (868px) before the native 'scroll'
    // event for step 1's own correction ever gets a chance to fire.
    // scrollTop is untouched (still 29, a stale echo of step 1).
    Object.defineProperty(scroll, 'scrollHeight', { value: 868, configurable: true });
    scroll.dispatchEvent(new window.Event('scroll'));

    assert.equal(
      container.querySelector('.qu-chat-scroll-bottom-btn').hidden, true,
      'must still be considered "at the bottom" - the button must not appear just because content grew underneath a not-yet-corrected view'
    );

    // STEP 3: the NEXT ResizeObserver firing picks up exactly where step 1 left off.
    roInstance.cb();
    assert.equal(scroll.scrollTop, 349); // clamped: 868 - 519
    assert.equal(container.querySelector('.qu-chat-scroll-bottom-btn').hidden, true);
  } finally {
    stop();
    globalThis.ResizeObserver = originalRO;
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
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    container.querySelector('.qu-content-editor-submit-slot button').click();

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
    body: '', extra: { attachments: [{ assetId: 'a1', mime: 'image/png', name: 'photo.png', size: 100 }] },
  });

  // No query at all - an empty string, matching what apps/search/client.js
  // sends when the input is blank but a type chip is active.
  const results = await searchChat({ services: alice.services, apps: CHAT_APPS, myPub: alice.myPub, query: '', types: ['image'], scope: 'subpage', segments: ['chat', bob.myPub] });
  assert.equal(results.length, 1);
  assert.equal(results[0].href, `#/chat/${bob.myPub}/m/${withImage.id}`);
  assert.equal(results[0].contentType, 'image');
});

test('searchChat(): a voice message classifies as "audio", not the generic "file" (regression: audio used to fall through to "file", losing the type)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, {
    body: '', extra: { attachments: [{ assetId: 'v1', mime: 'audio/webm', name: 'voice.webm', size: 500 }] },
  });

  const results = await searchChat({ services: alice.services, apps: CHAT_APPS, myPub: alice.myPub, query: '', types: ['audio'], scope: 'subpage', segments: ['chat', bob.myPub] });
  assert.equal(results.length, 1);
  assert.equal(results[0].contentType, 'audio');
});

test('renderSearchResult(): an image/video/audio/file result renders a real <qu-asset> preview (not just text) - AS SUCH, per that attachment\'s own MIME, using entry.spaceId/entry.attachment (regression: every result used to render as plain meta+snippet text regardless of contentType)', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const withImage = await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, {
    body: 'a caption', extra: { attachments: [{ assetId: 'img1', mime: 'image/png', name: 'photo.png', size: 100 }] },
  });

  const [entry] = await searchChat({ services: alice.services, apps: CHAT_APPS, myPub: alice.myPub, query: '', types: ['image'], scope: 'subpage', segments: ['chat', bob.myPub] });
  assert.equal(entry.spaceId, CHAT_SPACE_ID);
  assert.equal(entry.attachment.assetId, 'img1');

  const row = document.createElement('div');
  row.assetService = alice.services.assets; // <qu-asset>'s own ancestor-walk requirement - a real caller (apps/search/client.js) sets this once on its own top-level mount container
  await renderSearchResult(row, { entry, services: alice.services });

  const assetEl = row.querySelector('qu-asset');
  assert.ok(assetEl, 'expected a real <qu-asset> element, not just plain text');
  assert.equal(assetEl.getAttribute('space-id'), CHAT_SPACE_ID);
  assert.equal(assetEl.getAttribute('asset-id'), 'img1');
  const link = row.querySelector('.qu-chat-search-result-link');
  assert.ok(link);
  assert.equal(link.getAttribute('href'), `#/chat/${bob.myPub}/m/${withImage.id}`);
  assert.equal(link.contains(assetEl), false);
});

test('the room view uses the fixed-layout structure: no bespoke back link (the shell header\'s Back/Forward already covers it), and the message list wrapped in a scrollable container', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', bob.myPub] });
  try {
    await waitFor(() => (container.querySelector('.qu-chat-header-name')?.textContent ?? '') !== '');
    assert.ok(container.querySelector('.qu-chat-room-view'));
    assert.equal(container.querySelector('.qu-chat-header-back'), null);
    // the message list lives INSIDE the scrollable wrapper, not directly under roomView
    assert.ok(container.querySelector('.qu-chat-messages-scroll'));
    assert.ok(container.querySelector('.qu-chat-messages-scroll .qu-chat-header') === null); // header is a SIBLING, not inside the scroll area
  } finally {
    stop();
  }
});

test('the new-group form has no bespoke back link either - just the shell header\'s Back/Forward', async () => {
  const { qu, services } = await freshEnv('Alice');
  const container = makeContainer();
  const stop = mount(container, { qu, services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', 'new-group'] });
  try {
    await waitFor(() => container.querySelector('.qu-chat-new-group-form') !== null);
    assert.equal(container.querySelector('a.qu-subpage-back'), null);
  } finally {
    stop();
  }
});

// ===== ctx.chrome (Chrome Inversion, see docs/app-navigation-standard.md Rule 5a) =====

test('the room list\'s primaryAction ("+ New group") links to #/chat/new-group, and the desktop sidebar ALSO gets a (desktop-only) room list, while the mobile footer stays fab-only', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await alice.services.contacts.addContact(bob.myPub);

  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'], chrome });
  try {
    await waitFor(() => chromeRoot.querySelector('a.qu-apptpl-fab') !== null);
    const fab = chromeRoot.querySelector('a.qu-apptpl-fab');
    assert.equal(fab.getAttribute('href'), '#/chat/new-group');
    assert.equal(fab.title, 'New chat group');
    const desktopPrimary = chromeRoot.querySelector('a.qu-apptpl-primary-desktop');
    assert.equal(desktopPrimary.getAttribute('href'), '#/chat/new-group');

    // The desktop sidebar ALSO shows the room list now (feedback: it felt
    // inconsistent that only an open room got one) - none marked active,
    // since no specific room is open here.
    await waitFor(() => chromeRoot.querySelector('.qu-apptpl-sidebar .qu-apptpl-list a') !== null);
    assert.equal(chromeRoot.querySelector('.qu-apptpl-sidebar .qu-apptpl-list a').textContent, '👤Bob');
    assert.equal(chromeRoot.querySelector('.qu-apptpl-sidebar .qu-apptpl-item-active'), null);

    // But the mobile footer stays fab-only - the room list is ALREADY the
    // page's own full-width content there, so a pill duplicating it would
    // be pointless (feedback: "keep rooms on the start page, not a pill").
    const footer = chromeRoot.querySelector('.qu-apptpl-footer');
    assert.equal(footer.classList.contains('qu-apptpl-footer--fab-only'), true);
    assert.equal(footer.querySelector('.qu-apptpl-pill'), null);
  } finally {
    stop();
  }
});

test('the room list shows a small cover-image thumbnail next to the text preview when the last message is a photo (Telegram/WhatsApp-style "📷 Photo" + thumbnail), but never for a text-only last message', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  const carol = await freshEnv('Carol');
  await mirrorProfileInto(bob, alice.qu);
  await mirrorProfileInto(carol, alice.qu);
  await alice.services.contacts.addContact(bob.myPub);
  await alice.services.contacts.addContact(carol.myPub);

  const bobRoomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, bobRoomId, {
    body: '', extra: { attachments: [{ assetId: 'photo1', mime: 'image/png', name: 'photo.png', size: 100 }] },
  });
  const carolRoomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, carol.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, carolRoomId, { body: 'just text, no attachment' });

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'] });
  try {
    await waitFor(() => container.querySelectorAll('.qu-chat-room-row').length === 2);

    const bobRow = container.querySelector(`a[href="#/chat/${bob.myPub}"]`);
    const thumb = bobRow.querySelector('.qu-chat-room-thumb qu-asset');
    assert.ok(thumb, 'expected a room-list thumbnail for a photo last-message');
    assert.equal(thumb.getAttribute('space-id'), CHAT_SPACE_ID);
    assert.equal(thumb.getAttribute('asset-id'), 'photo1');
    assert.equal(thumb.getAttribute('kind'), 'image');

    const carolRow = container.querySelector(`a[href="#/chat/${carol.myPub}"]`);
    assert.equal(carolRow.querySelector('.qu-chat-room-thumb'), null, 'a text-only last message must not grow a thumbnail');
  } finally {
    stop();
  }
});

test('an open room\'s navigation sidebar lists every room (1:1 + group), the current one active, on desktop only - no primaryAction and no mobile footer at all', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await mirrorProfileInto(alice, bob.qu);
  // Bob's own DM-with-Alice room (ChatService's own "creator never sees
  // their own created group" quirk - see the "createGroup() + posting..."
  // test above - means BOB, the invited member, is the side whose room
  // list can show both a 1:1 AND a group at once here, not Alice).
  await bob.services.contacts.addContact(alice.myPub);
  const { groupId } = await alice.services.chat.createGroup(CHAT_SPACE_ID, { name: 'Team Rocket', memberPubs: [bob.myPub] });
  const inviteSpace = await bob.services.chat.myInviteSpace();
  await mirrorThreadInto(alice, bob.qu, inviteSpace, 'groups');
  await mirrorThreadInto(alice, bob.qu, CHAT_SPACE_ID, groupId);

  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const container = makeContainer();
  const stop = mount(container, { qu: bob.qu, services: bob.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', 'g', groupId], chrome });
  try {
    await waitFor(() => chromeRoot.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a').length === 2);
    const links = [...chromeRoot.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')];
    assert.deepEqual(links.map((a) => a.textContent).sort(), ['👤Alice', '👥Team Rocket']);
    assert.equal(links.map((a) => a.getAttribute('href')).includes(`#/chat/${alice.myPub}`), true);
    assert.equal(links.map((a) => a.getAttribute('href')).includes(`#/chat/g/${groupId}`), true);
    const activeLink = chromeRoot.querySelector('.qu-apptpl-sidebar .qu-apptpl-item-active');
    assert.equal(activeLink.getAttribute('href'), `#/chat/g/${groupId}`); // the currently open room, not the DM

    // No "+ New group" anywhere inside an open room (feedback: rarely
    // needed once already inside a room) - neither the desktop sidebar
    // button nor a mobile FAB.
    assert.equal(chromeRoot.querySelector('.qu-apptpl-primary-desktop'), null);
    assert.equal(chromeRoot.querySelector('a.qu-apptpl-fab'), null);
    // And with no primaryAction AND a desktop-only navigation, there's
    // nothing left for the mobile footer to show at all (feedback: it
    // duplicated the room's own composer bar right above it).
    assert.equal(chromeRoot.querySelector('.qu-apptpl-footer'), null);
  } finally {
    stop();
  }
});

test('the sidebar\'s filter input matches a group room by a PARTICIPANT\'s name too, not just the group\'s own label - a DM room only needs its own label, since that already IS the other participant\'s name', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await mirrorProfileInto(alice, bob.qu);
  await bob.services.contacts.addContact(alice.myPub);
  const { groupId } = await alice.services.chat.createGroup(CHAT_SPACE_ID, { name: 'Team Rocket', memberPubs: [bob.myPub] });
  const inviteSpace = await bob.services.chat.myInviteSpace();
  await mirrorThreadInto(alice, bob.qu, inviteSpace, 'groups');
  await mirrorThreadInto(alice, bob.qu, CHAT_SPACE_ID, groupId);

  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const container = makeContainer();
  const stop = mount(container, { qu: bob.qu, services: bob.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat'], chrome });
  try {
    await waitFor(() => chromeRoot.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a').length === 2);
    const input = chromeRoot.querySelector('.qu-apptpl-sidebar .qu-apptpl-filter');
    assert.ok(input);
    const visibleLabels = () => [...chromeRoot.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list li')].filter((li) => !li.hidden).map((li) => li.textContent);

    // Searching a participant's name matches BOTH the DM with that person
    // (its own label already IS their name) AND the group they're in (via
    // `searchText`, not its own label "Team Rocket") - the whole point of
    // this feature.
    input.value = 'alice';
    input.dispatchEvent(new window.Event('input'));
    assert.deepEqual(visibleLabels().sort(), ['👤Alice', '👥Team Rocket']);

    // The group's own label still works too, on its own (no participant
    // name involved), and this time does NOT also match the DM.
    input.value = 'rocket';
    input.dispatchEvent(new window.Event('input'));
    assert.deepEqual(visibleLabels(), ['👥Team Rocket']);
  } finally {
    stop();
  }
});

test('the room view\'s navigation still populates (for switching AWAY) even when the current group no longer resolves', async () => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await alice.services.contacts.addContact(bob.myPub);

  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, services: alice.services, apps: CHAT_APPS, subscribe: noopSubscribe, segments: ['chat', 'g', 'does-not-exist'], chrome });
  try {
    await waitFor(() => container.textContent.includes('This group doesn\'t exist, or you\'re not a member.'));
    await waitFor(() => chromeRoot.querySelector('.qu-apptpl-sidebar .qu-apptpl-list a') !== null);
    assert.equal(chromeRoot.querySelector('.qu-apptpl-sidebar .qu-apptpl-list a').getAttribute('href'), `#/chat/${bob.myPub}`);
    assert.equal(chromeRoot.querySelector('.qu-apptpl-footer'), null); // still no mobile footer, even in this edge case
  } finally {
    stop();
  }
});
