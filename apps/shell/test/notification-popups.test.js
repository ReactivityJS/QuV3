import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, ActorService, THREAD_PRESETS, paths } from '@qu/services';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mountNotificationPopups } = await import('../src/notification-popups.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({});

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const services = { messages, actors: new ActorService(identity) };
  const myPub = await services.actors.whoAmI();
  return { qu, services, myPub };
}

function noopSubscribe() {}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('a notification posted AFTER mount pops a toast with a generic "open" action linking to its url', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: 'peer-a is calling',
      extra: { title: 'Incoming call', url: '#/phone/peer-a/accept' },
    });

    await waitFor(() => container.querySelector('.qu-toast') !== null);
    const toast = container.querySelector('.qu-toast');
    assert.equal(toast.querySelector('.qu-toast-title').textContent, 'Incoming call');
    assert.equal(toast.querySelector('.qu-toast-body').textContent, 'peer-a is calling');
    const action = toast.querySelector('.qu-toast-actions a');
    assert.equal(action.getAttribute('href'), '#/phone/peer-a/accept');
  } finally {
    stop();
  }
});

test('an explicit "actions" array on the notification is used verbatim instead of the generic "open" fallback', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: 'peer-a is calling',
      extra: {
        title: 'Incoming call',
        url: '#/phone',
        actions: [
          { label: 'Annehmen', href: '#/phone/peer-a/accept' },
          { label: 'Ablehnen', href: '#/phone/peer-a/decline', primary: false },
        ],
      },
    });

    await waitFor(() => container.querySelector('.qu-toast') !== null);
    const links = [...container.querySelectorAll('.qu-toast-actions a')];
    assert.deepEqual(links.map((a) => a.textContent), ['Annehmen', 'Ablehnen']);
    assert.deepEqual(links.map((a) => a.getAttribute('href')), ['#/phone/peer-a/accept', '#/phone/peer-a/decline']);
  } finally {
    stop();
  }
});

test('backlog notifications from BEFORE this session started do not pop a toast (badge-only, per the session-watermark doc comment)', async () => {
  const { qu, services, myPub } = await freshEnv();
  const spaceId = paths.notificationsSpaceId(myPub);
  await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
  await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
    body: 'old notification',
    extra: { title: 'Old', url: '#/somewhere' },
  });

  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    // Give the watcher's initial async resolution a chance to run - there's
    // no positive "settled" signal to await, so a short real delay is the
    // only way to assert an absence like this.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(container.querySelector('.qu-toast'), null);
  } finally {
    stop();
  }
});

test('stop() removes the toast host - no further toasts, even if more notifications land', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  const spaceId = paths.notificationsSpaceId(myPub);
  await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
  await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, { body: 'first', extra: { title: 'First' } });
  await waitFor(() => container.querySelector('.qu-toast') !== null);

  stop();
  assert.equal(container.querySelector('.qu-toast-host'), null);

  await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, { body: 'second', extra: { title: 'Second' } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(container.querySelector('.qu-toast'), null);
});
