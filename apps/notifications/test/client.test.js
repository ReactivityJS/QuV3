import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, ChannelService, ProfileService, THREAD_PRESETS, ActorService, paths } from '@qu/services';
import { AccessEngine, ThreadEngine, CollectionEngine } from '@qu/engines';
import { ExtensionPointHost } from '@qu/foundation';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

// The REAL apps/forum/client.js (not a synthetic fake) - proves the rich
// rendering path end to end against actual production code, same "the REAL
// app" reasoning apps/search/test/client.test.js's own APPS catalog already
// establishes.
const FORUM_SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1'; // real UUID from apps/forum/manifest.quapp
const FORUM_CLIENT_URL = new URL('../../forum/client.js', import.meta.url).href;
const APPS = [
  { name: 'forum', label: 'Forum', spaceId: FORUM_SPACE_ID, clientMainUrl: FORUM_CLIENT_URL, contributes: [
    { point: 'content.search', export: 'searchForum' },
    { point: 'content.searchResultTemplate', export: 'renderSearchResult' },
    { point: 'content.resolveReference', export: 'resolveForumReference' },
  ] },
];

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu); // ChannelService's curated {$list} channel/topic documents need this to resolve on read
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({}); // own X key must be resolvable - the notifications thread is reader-restricted to ITSELF

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const actors = new ActorService(identity);
  const services = {
    messages,
    actors,
    profile: new ProfileService(qu, identity),
    channels: new ChannelService(qu, identity, list, access, messages),
  };
  const myPub = await actors.whoAmI();
  return { qu, identity, services, myPub };
}

function noopSubscribe() {}

/** Must be attached to document.body - reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** Simulates what `@qu/relay`'s `PushDeliveryService#writeInAppNotification()` does - a signed write into the owner's own notifications Thread. `THREAD_PRESETS.notifications()`'s `writers: '*'` means this identity itself may write into it too, exactly like any other writer. */
async function seedNotification(services, myPub, { title, body, url = '#/forum', appId = 'forum', ref }) {
  const spaceId = paths.notificationsSpaceId(myPub);
  await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
  await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, { body, extra: { title, url, appId, ...(ref ? { ref } : {}) } });
}

test('renders the empty state when there are no notifications yet', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-empty') !== null);
  } finally {
    stop();
  }
});

test('renders an existing notification\'s title/body and a click-through link to its url', async () => {
  const { qu, services, myPub } = await freshEnv();
  await seedNotification(services, myPub, { title: 'Mentions — Forum', body: '~abc123… sent a message', url: '#/forum' });

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-item') !== null);
    assert.equal(container.querySelector('.qu-notifications-item-title').textContent, 'Mentions — Forum');
    assert.equal(container.querySelector('.qu-notifications-item-body').textContent, '~abc123… sent a message');
    assert.equal(container.querySelector('.qu-notifications-item a').getAttribute('href'), '#/forum');
  } finally {
    stop();
  }
});

test('a notification arriving live (posted elsewhere in the SAME store) appears in an already-mounted view, no reload', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-empty') !== null);
    await seedNotification(services, myPub, { title: 'New posts — Forum', body: 'hi' });
    await waitFor(() => container.querySelector('.qu-notifications-item') !== null);
  } finally {
    stop();
  }
});

test('newest-first ordering', async () => {
  const { qu, services, myPub } = await freshEnv();
  await seedNotification(services, myPub, { title: 'First', body: 'a' });
  await seedNotification(services, myPub, { title: 'Second', body: 'b' });

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelectorAll('.qu-notifications-item').length === 2);
    const titles = [...container.querySelectorAll('.qu-notifications-item-title')].map((el) => el.textContent);
    assert.deepEqual(titles, ['Second', 'First']);
  } finally {
    stop();
  }
});

test('an unread notification is highlighted, and opening the feed marks it read - a fresh mount\'s default (unread-only) view then hides it entirely, "Show all" reveals it unhighlighted', async () => {
  const { qu, services, myPub } = await freshEnv();
  await seedNotification(services, myPub, { title: 'Mentions — Forum', body: 'hi' });
  const spaceId = paths.notificationsSpaceId(myPub);

  assert.equal(await services.messages.getLastReadAt(spaceId, paths.NOTIFICATIONS_THREAD_ID), 0);

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-item') !== null);
    assert.ok(container.querySelector('.qu-notifications-item').classList.contains('qu-notifications-unread'));
    // waitFor() only ever calls its predicate synchronously (see its own
    // implementation - `while (!check())` never awaits the result), so an
    // async predicate resolves as "true" on the FIRST call regardless of
    // what it actually settles to - a real poll loop is needed here to
    // genuinely wait for markRead()'s own write to land.
    for (let i = 0; i < 200; i++) {
      if ((await services.messages.getLastReadAt(spaceId, paths.NOTIFICATIONS_THREAD_ID)) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok((await services.messages.getLastReadAt(spaceId, paths.NOTIFICATIONS_THREAD_ID)) > 0, 'expected markRead() to have run by now');
  } finally {
    stop();
  }

  // A fresh mount, after markRead() already ran above - the ONLY notification
  // that exists is now read, so the default unread-only view hides it (see
  // this file's own "UNREAD-ONLY DEFAULT VIEW" doc comment) rather than
  // showing it unhighlighted.
  const container2 = makeContainer();
  const stop2 = mount(container2, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container2.querySelector('.qu-notifications-empty') !== null);
    assert.equal(container2.querySelector('.qu-notifications-item'), null);

    // "Show all" reveals it, unhighlighted (it's read).
    container2.querySelector('.qu-notifications-toggle').click();
    await waitFor(() => container2.querySelector('.qu-notifications-item') !== null);
    assert.equal(container2.querySelector('.qu-notifications-item').classList.contains('qu-notifications-unread'), false);
  } finally {
    stop2();
  }
});

// ===== unread-only default view + "Show all" toggle =====

test('by default, only UNREAD notifications render - a read one is hidden until "Show all" is clicked', async () => {
  const { qu, services, myPub } = await freshEnv();
  const spaceId = paths.notificationsSpaceId(myPub);
  await seedNotification(services, myPub, { title: 'Old, already read', body: 'a' });
  await services.messages.markRead(spaceId, paths.NOTIFICATIONS_THREAD_ID);
  await seedNotification(services, myPub, { title: 'New, unread', body: 'b' });

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-item') !== null);
    let titles = [...container.querySelectorAll('.qu-notifications-item-title')].map((el) => el.textContent);
    assert.deepEqual(titles, ['New, unread']);

    container.querySelector('.qu-notifications-toggle').click();
    await waitFor(() => container.querySelectorAll('.qu-notifications-item').length === 2);
    titles = [...container.querySelectorAll('.qu-notifications-item-title')].map((el) => el.textContent);
    assert.deepEqual(titles, ['New, unread', 'Old, already read']); // still newest-first
  } finally {
    stop();
  }
});

test('the toggle is hidden when there are no notifications at all, and its label flips between the two states', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-empty') !== null);
    assert.equal(container.querySelector('.qu-notifications-toggle').hidden, true);

    await seedNotification(services, myPub, { title: 'Hi', body: 'a' });
    await waitFor(() => container.querySelector('.qu-notifications-toggle').hidden === false);
    assert.equal(container.querySelector('.qu-notifications-toggle').textContent, 'Show all (incl. read)');

    container.querySelector('.qu-notifications-toggle').click();
    await waitFor(() => container.querySelector('.qu-notifications-toggle').textContent === 'Show unread only');
  } finally {
    stop();
  }
});

test('when every notification is read, the default (unread-only) view shows a distinct "no unread" empty state, not the generic empty state', async () => {
  const { qu, services, myPub } = await freshEnv();
  const spaceId = paths.notificationsSpaceId(myPub);
  await seedNotification(services, myPub, { title: 'Old', body: 'a' });
  await services.messages.markRead(spaceId, paths.NOTIFICATIONS_THREAD_ID);

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-empty') !== null);
    assert.equal(container.querySelector('.qu-notifications-empty').textContent, 'No unread notifications.');
  } finally {
    stop();
  }
});

test('subscribe() is called with the notifications space prefix', async () => {
  const { qu, services, myPub } = await freshEnv();
  const calls = [];
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: (prefix) => calls.push(prefix) });
  try {
    await waitFor(() => calls.length > 0);
    assert.deepEqual(calls, [paths.spacePath(paths.notificationsSpaceId(myPub))]);
  } finally {
    stop();
  }
});

// ===== rich rendering (content.resolveReference/content.searchResultTemplate) =====

test('a notification WITH a live ref to real content renders via the OWNING app\'s own template, not the generic one', async () => {
  const env = await freshEnv();
  const channel = await env.services.channels.createChannel(FORUM_SPACE_ID, { title: 'General' });
  const topic = await env.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Welcome' });
  const posted = await env.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'hello from forum' });

  await seedNotification(env.services, env.myPub, {
    title: 'Mentions — Forum', body: '~abc123… sent a message', appId: 'forum',
    ref: { spaceId: FORUM_SPACE_ID, threadId: topic._id, messageId: posted.id },
  });

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(APPS);
  const stop = mount(container, { qu: env.qu, services: env.services, subscribe: noopSubscribe, extensionPoints });
  try {
    await waitFor(() => container.querySelector('.qu-forum-search-result') !== null, { timeout: 4000 });
    // The rich template rendered INSTEAD of the generic one - no leftover generic title/body for this item.
    assert.equal(container.querySelector('.qu-notifications-item-title'), null);
    assert.match(container.querySelector('.qu-forum-search-result-snippet').textContent, /hello from forum/);
  } finally {
    stop();
  }
});

test('a notification WITH a ref that no longer resolves (deleted/unsynced content) falls back to the generic rendering', async () => {
  const env = await freshEnv();
  await seedNotification(env.services, env.myPub, {
    title: 'Mentions — Forum', body: '~abc123… sent a message', appId: 'forum',
    ref: { spaceId: FORUM_SPACE_ID, threadId: 'never-created-topic', messageId: 'never-posted' },
  });

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(APPS);
  const stop = mount(container, { qu: env.qu, services: env.services, subscribe: noopSubscribe, extensionPoints });
  try {
    await waitFor(() => container.querySelector('.qu-notifications-item-title') !== null, { timeout: 4000 });
    assert.equal(container.querySelector('.qu-notifications-item-title').textContent, 'Mentions — Forum');
    assert.equal(container.querySelector('.qu-forum-search-result'), null);
  } finally {
    stop();
  }
});

test('a notification with a ref but NO extensionPoints at all still renders generic - never throws', async () => {
  const env = await freshEnv();
  await seedNotification(env.services, env.myPub, {
    title: 'Mentions — Forum', body: 'hi', appId: 'forum',
    ref: { spaceId: FORUM_SPACE_ID, threadId: 'general', messageId: 'whatever' },
  });

  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, services: env.services, subscribe: noopSubscribe }); // no extensionPoints
  try {
    await waitFor(() => container.querySelector('.qu-notifications-item-title') !== null);
    assert.equal(container.querySelector('.qu-notifications-item-title').textContent, 'Mentions — Forum');
  } finally {
    stop();
  }
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-notifications-empty') !== null);
  assert.doesNotThrow(() => stop());
});
