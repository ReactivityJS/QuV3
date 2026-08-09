import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, THREAD_PRESETS, ActorService, paths } from '@qu/services';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({}); // own X key must be resolvable - the notifications thread is reader-restricted to ITSELF

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const actors = new ActorService(identity);
  const services = { messages, actors };
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
async function seedNotification(services, myPub, { title, body, url = '#/forum', appId = 'forum' }) {
  const spaceId = paths.notificationsSpaceId(myPub);
  await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
  await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, { body, extra: { title, url, appId } });
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

test('an unread notification is highlighted, and opening the feed marks it read (the highlight is gone on the next mount)', async () => {
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

  // A fresh mount, after markRead() already ran above - no longer unread.
  const container2 = makeContainer();
  const stop2 = mount(container2, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container2.querySelector('.qu-notifications-item') !== null);
    assert.equal(container2.querySelector('.qu-notifications-item').classList.contains('qu-notifications-unread'), false);
  } finally {
    stop2();
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

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-notifications-empty') !== null);
  assert.doesNotThrow(() => stop());
});
