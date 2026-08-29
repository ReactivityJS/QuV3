import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine, CollectionEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { ListService, AccessService, MessageService, ChatService, ActorService, ProfileService, ContactsService, FlagService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

const CHAT_SPACE_ID = '39d30ff2-be01-4277-93a5-85d21b4ce096';
const APPS = [{ name: 'chat', spaceId: CHAT_SPACE_ID }];

function createQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu);
  return qu;
}

/** One identity's own store + Services - two independent stores for a two-party chat, same reasoning apps/chat's own tests use ("real sync would normally bridge these; tests bridge them explicitly via putSealed"). */
async function freshEnv(alias) {
  const qu = createQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  if (alias) await identity.publishMainProfile({ alias });
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const flags = new FlagService(qu, identity, list);
  const services = {
    actors: new ActorService(identity),
    profile: new ProfileService(qu, identity),
    messages,
    chat: new ChatService(messages, identity),
    contacts: new ContactsService(flags, identity),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/** Mirrors one thread's meta+messages (and the sender's profile) from one identity's store into another's, "as if sync had already delivered it" - same helper shape apps/chat/test/client.test.js already uses. */
async function mirrorThreadInto(fromQu, intoQu, spaceId, threadId) {
  const metaPath = paths.threadMetaPath(spaceId, threadId);
  const meta = await fromQu.get(metaPath);
  if (meta) await intoQu.putSealed(metaPath, meta);
  const entries = await fromQu.getChildren(paths.threadMessagesParentPath(spaceId, threadId));
  for (const { path, quBit } of entries) await intoQu.putSealed(path, quBit);
}

/** Mirrors just a profile - `MessageService.postMessage()` needs a reader's profile (for their X key) already resolvable locally before it can encrypt a message FOR them, same "as if sync had already delivered it" reasoning as `mirrorThreadInto()`. */
async function mirrorProfileInto(fromEnv, intoQu) {
  const path = actorPath(fromEnv.myPub, 'profile');
  const profile = await fromEnv.qu.get(path);
  if (profile) await intoQu.putSealed(path, profile);
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function fakeChrome() {
  const calls = [];
  return { set: (partial) => calls.push(partial), calls };
}

function navLabels(chrome) {
  return (chrome.calls.at(-1)?.navigation?.items ?? []).map((i) => i.id);
}

function mockFetchConfig(adminPubs = []) {
  return async (url) => {
    if (url === '/config.json') return new Response(JSON.stringify({ adminPubs }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('overview: a non-admin sees no "relay" nav item; shows own profile', async (t) => {
  const env = await freshEnv('Alice');
  t.mock.method(globalThis, 'fetch', mockFetchConfig([]));
  const chrome = fakeChrome();
  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: APPS, segments: ['data-manager'], chrome });
  try {
    await waitFor(() => container.textContent.includes('Alice'));
    assert.deepEqual(navLabels(chrome), ['overview', 'chats', 'browse']);
    assert.match(container.textContent, /Alice/);
    assert.match(container.textContent, new RegExp(env.myPub));
  } finally {
    stop?.();
  }
});

test('overview: an admin identity also sees the "relay" nav item', async (t) => {
  const env = await freshEnv('Bob');
  t.mock.method(globalThis, 'fetch', mockFetchConfig([env.myPub]));
  const chrome = fakeChrome();
  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: APPS, segments: ['data-manager'], chrome });
  try {
    await waitFor(() => navLabels(chrome).includes('relay'));
    assert.deepEqual(navLabels(chrome), ['overview', 'chats', 'browse', 'relay']);
  } finally {
    stop?.();
  }
});

test('relay view: a non-admin sees "not authorized", no admin controls', async (t) => {
  const env = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockFetchConfig([]));
  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: APPS, segments: ['data-manager', 'relay'] });
  try {
    await waitFor(() => container.textContent.length > 0);
    assert.match(container.textContent, /not.*admin|not authorized/i);
    assert.equal(container.querySelector('input'), null);
  } finally {
    stop?.();
  }
});

test('chats: lists a 1:1 room (via a Contact) and a group room, correctly labeled', async (t) => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  await mirrorProfileInto(alice, bob.qu);
  t.mock.method(globalThis, 'fetch', mockFetchConfig([]));

  // 1:1: Alice adds Bob as a contact and opens a room with him.
  await alice.services.contacts.addContact(bob.myPub, {});
  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'hi bob' });

  // Group: Bob creates a group and invites Alice - `ChatService.createGroup()`
  // deliberately never self-invites its OWN creator (see that method's own
  // doc comment: `memberPubs` are "the OTHER members"), so `listMyGroups()`
  // only ever finds a group through a real invite from someone else, mirrored
  // in here the same "as if sync had already delivered it" way every other
  // cross-identity fixture in this file already uses.
  const { groupId } = await bob.services.chat.createGroup(CHAT_SPACE_ID, { name: 'Team', memberPubs: [alice.myPub] });
  await bob.services.messages.postMessage(CHAT_SPACE_ID, groupId, { body: 'hi team' });
  await mirrorThreadInto(bob.qu, alice.qu, CHAT_SPACE_ID, groupId);
  await mirrorThreadInto(bob.qu, alice.qu, `chat-invites-${alice.myPub}`, 'groups');

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, identity: alice.identity, services: alice.services, apps: APPS, segments: ['data-manager', 'chats'] });
  try {
    await waitFor(() => container.querySelectorAll('.qu-dm-list-item').length >= 2);
    const names = [...container.querySelectorAll('.qu-dm-list-item-name')].map((el) => el.textContent);
    assert.ok(names.includes('Bob'));
    assert.ok(names.includes('Team'));
    const badges = [...container.querySelectorAll('.qu-dm-badge')].map((el) => el.textContent);
    assert.equal(badges.length, 2);
  } finally {
    stop?.();
  }
});

test('chat detail: exports full message history as downloadable JSON', async (t) => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  t.mock.method(globalThis, 'fetch', mockFetchConfig([]));

  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'first' });
  await alice.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'second' });

  let capturedBlob = null;
  t.mock.method(URL, 'createObjectURL', (blob) => { capturedBlob = blob; return 'blob:fake'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, identity: alice.identity, services: alice.services, apps: APPS, segments: ['data-manager', 'chats', CHAT_SPACE_ID, roomId] });
  try {
    await waitFor(() => /2 messages|2 Nachrichten/.test(container.textContent));
    const exportBtn = [...container.querySelectorAll('button')].find((b) => /export/i.test(b.textContent));
    exportBtn.click();
    await waitFor(() => capturedBlob !== null);
    const text = await capturedBlob.text();
    const data = JSON.parse(text);
    assert.equal(data.kind, 'chat');
    assert.equal(data.spaceId, CHAT_SPACE_ID);
    assert.equal(data.threadId, roomId);
    assert.equal(data.messages.length, 2);
    assert.deepEqual(data.messages.map((m) => m.body), ['first', 'second']);
  } finally {
    stop?.();
  }
});

test('chat detail: importing a file only re-posts messages authored by me, skips the rest', async (t) => {
  const alice = await freshEnv('Alice');
  const bob = await freshEnv('Bob');
  await mirrorProfileInto(bob, alice.qu);
  t.mock.method(globalThis, 'fetch', mockFetchConfig([]));

  const roomId = await alice.services.chat.ensureRoom(CHAT_SPACE_ID, bob.myPub);
  const importFile = {
    kind: 'chat', spaceId: CHAT_SPACE_ID, threadId: roomId,
    messages: [
      { author: alice.myPub, body: 'mine, restore me', ts: 111 },
      { author: bob.myPub, body: 'not mine, must be skipped', ts: 222 },
    ],
  };

  const container = makeContainer();
  const stop = mount(container, { qu: alice.qu, identity: alice.identity, services: alice.services, apps: APPS, segments: ['data-manager', 'chats', CHAT_SPACE_ID, roomId] });
  try {
    await waitFor(() => container.querySelector('input[type="file"]') !== null);
    const input = container.querySelector('input[type="file"]');
    const fakeFile = { text: async () => JSON.stringify(importFile) };
    Object.defineProperty(input, 'files', { value: [fakeFile], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    await waitFor(() => /Imported 1, skipped 1|1 importiert, 1 übersprungen/.test(container.textContent));

    const { messages } = await alice.services.messages.listMessages(CHAT_SPACE_ID, roomId, { order: 'asc' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, 'mine, restore me');
    assert.equal(messages[0].author, alice.myPub);
  } finally {
    stop?.();
  }
});

test('browse: recursively lists locally-known QuBits under a path via QuStore.getChildren()', async (t) => {
  const env = await freshEnv('Carol');
  t.mock.method(globalThis, 'fetch', mockFetchConfig([]));

  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: APPS, segments: ['data-manager', 'browse'] });
  try {
    await waitFor(() => container.querySelector('input[type="text"]') !== null);
    const pathInput = container.querySelector('input[type="text"]');
    assert.equal(pathInput.value, `/store/actors/~${env.myPub}`);
    // Browse loads automatically on mount (see renderBrowse()'s own trailing
    // `await load()`) - no click needed to see the initial result.
    await waitFor(() => container.querySelectorAll('.qu-dm-entry').length > 0);
    const paths_ = [...container.querySelectorAll('.qu-dm-entry-path')].map((el) => el.textContent);
    assert.ok(paths_.some((p) => p.endsWith('/profile')));

    // Clicking "Load" again re-runs the same walk without duplicating rows.
    const loadBtn = [...container.querySelectorAll('button')].find((b) => /load|laden/i.test(b.textContent));
    loadBtn.click();
    await waitFor(() => !loadBtn.disabled);
    assert.equal(container.querySelectorAll('.qu-dm-entry').length, paths_.length);
  } finally {
    stop?.();
  }
});

test('relay view: an admin can list, then export, entries via the existing signed /admin/data/list route', async (t) => {
  const env = await freshEnv('Dave');
  const entries = [{ path: '/store/actors/~x/profile', value: { val: { alias: 'x' } } }];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/config.json') return new Response(JSON.stringify({ adminPubs: [env.myPub] }), { status: 200 });
    if (url === '/admin/data/list') {
      const body = JSON.parse(init.body);
      const verified = await QuCrypto.verify(
        new TextEncoder().encode(JSON.stringify(body.query)),
        QuCrypto.fromBase64Url(body.signature),
        QuCrypto.fromBase64Url(body.actorPub)
      );
      assert.equal(verified, true);
      return new Response(JSON.stringify({ entries, total: 1, hasMore: false }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  let capturedBlob = null;
  t.mock.method(URL, 'createObjectURL', (blob) => { capturedBlob = blob; return 'blob:fake'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});

  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: APPS, segments: ['data-manager', 'relay'] });
  try {
    await waitFor(() => container.querySelectorAll('.qu-dm-entry').length > 0);
    assert.match(container.querySelector('.qu-dm-entry-path').textContent, /\/store\/actors\/~x\/profile/);

    const exportBtn = [...container.querySelectorAll('button')].find((b) => /export/i.test(b.textContent));
    exportBtn.click();
    await waitFor(() => capturedBlob !== null);
    const data = JSON.parse(await capturedBlob.text());
    assert.deepEqual(data.entries, entries);
  } finally {
    stop?.();
  }
});

test('relay view: import signs the entries payload and posts it to /admin/data/import', async (t) => {
  const env = await freshEnv('Erin');
  let capturedBody = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/config.json') return new Response(JSON.stringify({ adminPubs: [env.myPub] }), { status: 200 });
    if (url === '/admin/data/list') return new Response(JSON.stringify({ entries: [], total: 0, hasMore: false }), { status: 200 });
    if (url === '/admin/data/import') {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ imported: 1, skipped: 0, total: 1 }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: APPS, segments: ['data-manager', 'relay'] });
  try {
    await waitFor(() => container.querySelector('input[type="file"]') !== null);
    const input = container.querySelector('input[type="file"]');
    const entries = [{ path: '/store/foo', value: { val: 1 } }];
    const fakeFile = { text: async () => JSON.stringify({ entries }) };
    Object.defineProperty(input, 'files', { value: [fakeFile], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    await waitFor(() => capturedBody !== null);
    assert.equal(capturedBody.actorPub, env.myPub);
    assert.deepEqual(capturedBody.entries, entries);
    const verified = await QuCrypto.verify(
      new TextEncoder().encode(JSON.stringify(capturedBody.entries)),
      QuCrypto.fromBase64Url(capturedBody.signature),
      QuCrypto.fromBase64Url(capturedBody.actorPub)
    );
    assert.equal(verified, true);
    await waitFor(() => /Imported 1, skipped 0|1 importiert, 0 übersprungen/.test(container.textContent));
  } finally {
    stop?.();
  }
});
