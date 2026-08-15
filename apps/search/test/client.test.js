import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, AssetEngine, CollectionEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import {
  ListService, AccessService, MessageService, ChannelService, ChatService,
  ActorService, ProfileService, ContactsService, FlagService, AssetService,
} from '@qu/services';
import { ExtensionPointHost } from '@qu/foundation';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, renderHeaderSearch } = await import('../client.js');

// The REAL apps/forum and apps/chat client.js (not synthetic fakes) - proves
// the content.search/content.searchResultTemplate contract end to end
// against actual production code, same "the REAL app" reasoning
// apps/forum/test/client.test.js's own BOOKMARKS_CLIENT_URL etc. already
// establish.
const FORUM_SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1'; // real UUID from apps/forum/manifest.quapp
const CHAT_SPACE_ID = '39d30ff2-be01-4277-93a5-85d21b4ce096'; // real UUID from apps/chat/manifest.quapp
const FORUM_CLIENT_URL = new URL('../../forum/client.js', import.meta.url).href;
const CHAT_CLIENT_URL = new URL('../../chat/client.js', import.meta.url).href;
const APPS = [
  { name: 'forum', label: 'Forum', spaceId: FORUM_SPACE_ID, clientMainUrl: FORUM_CLIENT_URL, contributes: [
    { point: 'content.search', export: 'searchForum' },
    { point: 'content.searchResultTemplate', export: 'renderSearchResult' },
  ] },
  { name: 'chat', label: 'Chat', spaceId: CHAT_SPACE_ID, clientMainUrl: CHAT_CLIENT_URL, contributes: [
    { point: 'content.search', export: 'searchChat' },
    { point: 'content.searchResultTemplate', export: 'renderSearchResult' },
  ] },
];

function createQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu);
  return qu;
}

async function freshEnv() {
  const qu = createQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias: 'me' });
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const flags = new FlagService(qu, identity, list);
  const services = {
    actors: new ActorService(identity),
    profile: new ProfileService(qu, identity),
    messages,
    channels: new ChannelService(qu, identity, list, access, messages),
    contacts: new ContactsService(flags, identity),
    chat: new ChatService(messages, identity),
    assets: new AssetService(qu, new AssetEngine(qu), identity),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/** A second, independent identity, with its published profile mirrored into `env`'s own store - same "as if sync had already delivered it" `putSealed()` technique apps/forum/test/client.test.js's own `mirrorThreadInto()` uses, just for one profile document instead of a whole thread. Needed because Chat's `readers: [myPub, peerPub]` DM room genuinely encrypts for the peer's real X key. */
async function addRealPeer(env, alias) {
  const peerQu = createQu();
  const peerIdentity = new QuIdentityEngine(peerQu);
  await peerIdentity.importMnemonic(peerIdentity.generateMnemonic());
  await peerIdentity.publishMainProfile({ alias });
  const peerPub = await new ActorService(peerIdentity).whoAmI();
  const profileBit = await peerQu.get(actorPath(peerPub, 'profile'));
  await env.qu.putSealed(actorPath(peerPub, 'profile'), profileBit);
  await env.services.contacts.addContact(peerPub, {});
  return peerPub;
}

/** Seeds one forum topic (with a matching message) and one chat DM (with a matching message) in the SAME identity's store. */
async function seedContent(env) {
  const channel = await env.services.channels.createChannel(FORUM_SPACE_ID, { title: 'General' });
  const topic = await env.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Welcome' });
  await env.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'the quokka says hello to everyone' });

  const peerPub = await addRealPeer(env, 'peer');
  const roomId = await env.services.chat.ensureRoom(CHAT_SPACE_ID, peerPub);
  await env.services.messages.postMessage(CHAT_SPACE_ID, roomId, { body: 'check this out: https://example.com/quokka' });

  return { channel, topic, peerPub, roomId };
}

function noopSubscribe() {}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ===== tabs (no query typed yet - synchronous, no content.search fan-out needed) =====

test('mount(): scope tabs reflect the route, the matching one is marked active, hrefs preserve context', async () => {
  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost([]);
  const stop = mount(container, {
    services: { actors: { whoAmI: async () => 'me' } },
    apps: [{ name: 'forum', label: 'Forum' }],
    segments: ['search', 'subpage', 'forum', 't', 'general'],
    extensionPoints,
  });
  try {
    const tabs = [...container.querySelectorAll('.qu-search-tab')];
    assert.equal(tabs.length, 3);
    assert.equal(tabs[0].textContent, 'Everywhere');
    assert.equal(tabs[0].getAttribute('href'), '#/search/global/forum/t/general');
    assert.equal(tabs[1].textContent, 'In Forum');
    assert.equal(tabs[1].getAttribute('href'), '#/search/app/forum/t/general');
    assert.equal(tabs[2].textContent, 'Here');
    assert.equal(tabs[2].getAttribute('href'), '#/search/subpage/forum/t/general');
    assert.ok(tabs[2].classList.contains('qu-search-tab-active'));
    assert.ok(!tabs[0].classList.contains('qu-search-tab-active'));
  } finally {
    stop();
  }
});

test('mount(): with no context app at all, only the Global tab renders', async () => {
  const container = makeContainer();
  const stop = mount(container, {
    services: { actors: { whoAmI: async () => 'me' } },
    apps: [],
    segments: ['search'],
    extensionPoints: new ExtensionPointHost([]),
  });
  try {
    const tabs = [...container.querySelectorAll('.qu-search-tab')];
    assert.equal(tabs.length, 1);
    assert.ok(tabs[0].classList.contains('qu-search-tab-active'));
  } finally {
    stop();
  }
});

test('mount(): an empty query shows the "type to search" hint, no fan-out call made', async () => {
  const container = makeContainer();
  const stop = mount(container, {
    services: { actors: { whoAmI: async () => 'me' } },
    apps: [],
    segments: ['search'],
    extensionPoints: new ExtensionPointHost([]),
  });
  try {
    assert.equal(container.querySelector('.qu-search-hint').textContent, 'Type to search.');
  } finally {
    stop();
  }
});

// ===== real fan-out against apps/forum + apps/chat =====

test('global scope: collects real results from BOTH Forum and Chat, newest first, each rendered by its OWN app', async () => {
  const env = await freshEnv();
  await seedContent(env);

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(APPS);
  const stop = mount(container, {
    services: env.services, qu: env.qu, apps: APPS, segments: ['search', 'global'], extensionPoints,
  });
  try {
    const input = container.querySelector('.qu-search-input');
    input.value = 'quokka';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => container.querySelectorAll('.qu-forum-search-result, .qu-chat-search-result').length === 2, { timeout: 4000 });

    assert.equal(container.querySelectorAll('.qu-forum-search-result').length, 1);
    assert.equal(container.querySelectorAll('.qu-chat-search-result').length, 1);
    // Chat's message was posted AFTER Forum's - newest first.
    const rows = [...container.querySelectorAll('.qu-search-results > div')];
    assert.ok(rows[0].querySelector('.qu-chat-search-result'), 'expected the newer chat result first');
    assert.ok(rows[1].querySelector('.qu-forum-search-result'), 'expected the older forum result second');
  } finally {
    stop();
  }
});

test('app scope with {onlyAppId}: only the targeted app\'s contributor runs, even though another app also matches', async () => {
  const env = await freshEnv();
  await seedContent(env);

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(APPS);
  const stop = mount(container, {
    services: env.services, qu: env.qu, apps: APPS, segments: ['search', 'app', 'forum'], extensionPoints,
  });
  try {
    const input = container.querySelector('.qu-search-input');
    input.value = 'quokka';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => container.querySelector('.qu-forum-search-result') !== null, { timeout: 4000 });

    assert.equal(container.querySelectorAll('.qu-forum-search-result').length, 1);
    assert.equal(container.querySelectorAll('.qu-chat-search-result').length, 0, 'Chat\'s own matching message must NOT appear - scope was "app: forum"');
  } finally {
    stop();
  }
});

test('type filter chips: selecting "Links" excludes a plain-text match and keeps a link match', async () => {
  const env = await freshEnv();
  await seedContent(env);

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(APPS);
  const stop = mount(container, {
    services: env.services, qu: env.qu, apps: APPS, segments: ['search', 'global'], extensionPoints,
  });
  try {
    const input = container.querySelector('.qu-search-input');
    input.value = 'quokka';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => container.querySelectorAll('.qu-forum-search-result, .qu-chat-search-result').length === 2, { timeout: 4000 });

    const linkChip = [...container.querySelectorAll('.qu-search-chip')].find((c) => c.textContent === 'Links');
    linkChip.click();
    await waitFor(() => container.querySelectorAll('.qu-forum-search-result, .qu-chat-search-result').length === 1, { timeout: 4000 });

    assert.equal(container.querySelectorAll('.qu-chat-search-result').length, 1, 'the chat message contains a real link');
    assert.equal(container.querySelectorAll('.qu-forum-search-result').length, 0, 'the forum message is plain text, no link');
  } finally {
    stop();
  }
});

test('an image result renders a real <qu-asset> preview end to end, not just plain text (regression: every result used to render as plain meta+snippet text regardless of type)', async () => {
  const env = await freshEnv();
  const channel = await env.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Pics' });
  const topic = await env.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Pics topic' });
  await env.services.messages.postMessage(FORUM_SPACE_ID, topic._id, {
    body: '', extra: { attachment: { assetId: 'search-img-1', mime: 'image/png', name: 'photo.png', size: 100 } },
  });

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(APPS);
  const stop = mount(container, {
    services: env.services, qu: env.qu, apps: APPS, segments: ['search', 'global'], extensionPoints,
  });
  try {
    const imageChip = [...container.querySelectorAll('.qu-search-chip')].find((c) => c.textContent === 'Images');
    imageChip.click();
    await waitFor(() => container.querySelector('qu-asset') !== null, { timeout: 4000 });

    const assetEl = container.querySelector('qu-asset');
    assert.equal(assetEl.getAttribute('space-id'), FORUM_SPACE_ID);
    assert.equal(assetEl.getAttribute('asset-id'), 'search-img-1');
    // The link (navigates to the message) never wraps the asset preview -
    // see apps/forum/client.js's own renderSearchResult() doc comment.
    const link = container.querySelector('.qu-forum-search-result-link');
    assert.equal(link.contains(assetEl), false);
  } finally {
    stop();
  }
});

test('a query matching nothing shows the "no results" hint', async () => {
  const env = await freshEnv();
  await seedContent(env);

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(APPS);
  const stop = mount(container, {
    services: env.services, qu: env.qu, apps: APPS, segments: ['search', 'global'], extensionPoints,
  });
  try {
    const input = container.querySelector('.qu-search-input');
    input.value = 'zzz-nothing-matches-zzz';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => container.querySelector('.qu-search-hint')?.textContent === 'No results.', { timeout: 4000 });
  } finally {
    stop();
  }
});

// ===== renderHeaderSearch() - the shell.headerAction contributor =====

test('renderHeaderSearch(): builds an app-scoped href from the current route, dropping the app\'s own id from segments', () => {
  const container = document.createElement('div');
  renderHeaderSearch(container, { getContext: () => ({ appId: 'forum', segments: ['forum', 't', 'general'] }), onContextChange: () => {} });
  assert.equal(container.querySelector('a').getAttribute('href'), '#/search/app/forum/t/general');
});

test('renderHeaderSearch(): no current app - falls back to global', () => {
  const container = document.createElement('div');
  renderHeaderSearch(container, { getContext: () => ({ appId: null, segments: [] }), onContextChange: () => {} });
  assert.equal(container.querySelector('a').getAttribute('href'), '#/search/global');
});

test('renderHeaderSearch(): already on the search app itself - falls back to global rather than linking to itself', () => {
  const container = document.createElement('div');
  renderHeaderSearch(container, { getContext: () => ({ appId: 'search', segments: ['search', 'global'] }), onContextChange: () => {} });
  assert.equal(container.querySelector('a').getAttribute('href'), '#/search/global');
});

test('renderHeaderSearch(): registers an onContextChange listener that updates the href live', () => {
  const container = document.createElement('div');
  let context = { appId: 'forum', segments: ['forum'] };
  let listener = null;
  renderHeaderSearch(container, { getContext: () => context, onContextChange: (cb) => { listener = cb; } });
  assert.equal(container.querySelector('a').getAttribute('href'), '#/search/app/forum');

  context = { appId: 'chat', segments: ['chat', 'somepeer'] };
  listener();
  assert.equal(container.querySelector('a').getAttribute('href'), '#/search/app/chat/somepeer');
});
