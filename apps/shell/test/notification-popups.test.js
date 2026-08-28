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

test('an explicit "actions" array uses the REAL push-delivery.js shape ({action, title, url}) - accept stays a link, decline becomes a signaling button, not a second link', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const collectCalls = [];
  const extensionPoints = { collect: async (point, payload) => { collectCalls.push({ point, payload }); return []; } };
  const stop = mountNotificationPopups(container, { qu, services, extensionPoints, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: 'peer-a is calling',
      extra: {
        title: 'Incoming call',
        url: '#/phone',
        // Exactly what createManifestNotificationResolver() (packages/relay/
        // src/push-delivery.js) actually produces - the shape mismatch
        // between THIS and toast.js's own {label, href} contract was the
        // real, shipped bug (see notification-popups.js's own doc comment).
        actions: [
          { action: 'accept', title: 'Annehmen', url: '#/phone/peer-a/accept' },
          { action: 'decline', title: 'Ablehnen', url: '#/phone/peer-a/decline' },
        ],
      },
    });

    await waitFor(() => container.querySelector('.qu-toast') !== null);
    const toast = container.querySelector('.qu-toast');
    const [acceptEl, declineEl] = toast.querySelectorAll('.qu-toast-actions > *');

    assert.equal(acceptEl.tagName, 'A');
    assert.equal(acceptEl.getAttribute('href'), '#/phone/peer-a/accept');
    assert.equal(acceptEl.textContent, '📞 Annehmen');
    assert.ok(acceptEl.classList.contains('qu-toast-action-positive'));

    assert.equal(declineEl.tagName, 'BUTTON'); // no href - clicking must never navigate
    assert.equal(declineEl.textContent, '📵 Ablehnen');
    assert.ok(declineEl.classList.contains('qu-toast-action-danger'));

    declineEl.click();
    assert.equal(collectCalls.length, 1);
    assert.equal(collectCalls[0].point, 'content.notificationAction');
    assert.equal(collectCalls[0].payload.actionId, 'decline');
    assert.equal(collectCalls[0].payload.url, '#/phone/peer-a/decline');
    assert.equal(container.querySelector('.qu-toast'), null); // the click also closes the toast, same as any other action
  } finally {
    stop();
  }
});

test('an unknown action id (neither accept nor decline) falls back to a plain href link, same as the generic "open" fallback', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: 'x',
      extra: { title: 'Future notification', url: '#/somewhere', actions: [{ action: 'snooze', title: 'Snooze', url: '#/somewhere/snooze' }] },
    });

    await waitFor(() => container.querySelector('.qu-toast') !== null);
    const el = container.querySelector('.qu-toast-actions > *');
    assert.equal(el.tagName, 'A');
    assert.equal(el.getAttribute('href'), '#/somewhere/snooze');
    assert.equal(el.textContent, 'Snooze');
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

/** Restores document.visibilityState to jsdom's own default after a test overrides it. */
function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

test('FOREGROUND SUPPRESSION: no toast when the tab is visible AND the current hash is already the notification\'s own room', async () => {
  const { qu, services, myPub } = await freshEnv();
  setVisibility('visible');
  window.location.hash = '#/chat/peer-a';
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: 'hi', extra: { title: 'New message', url: '#/chat/peer-a/m/msg1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(container.querySelector('.qu-toast'), null);
  } finally {
    stop();
    setVisibility('visible');
  }
});

test('FOREGROUND SUPPRESSION: still pops a toast when the tab is HIDDEN, even for the currently-open room', async () => {
  const { qu, services, myPub } = await freshEnv();
  setVisibility('hidden');
  window.location.hash = '#/chat/peer-a';
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: 'hi', extra: { title: 'New message', url: '#/chat/peer-a/m/msg1' },
    });
    await waitFor(() => container.querySelector('.qu-toast') !== null);
  } finally {
    stop();
    setVisibility('visible');
  }
});

test('FOREGROUND SUPPRESSION: still pops a toast when visible but a DIFFERENT room is open', async () => {
  const { qu, services, myPub } = await freshEnv();
  setVisibility('visible');
  window.location.hash = '#/chat/peer-b'; // a different conversation than the notification below
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: 'hi', extra: { title: 'New message', url: '#/chat/peer-a/m/msg1' },
    });
    await waitFor(() => container.querySelector('.qu-toast') !== null);
  } finally {
    stop();
    setVisibility('visible');
  }
});

test('FOREGROUND SUPPRESSION: a notification with no "url" at all can never be matched against the current room - always pops', async () => {
  const { qu, services, myPub } = await freshEnv();
  setVisibility('visible');
  window.location.hash = '#/chat/peer-a';
  const container = makeContainer();
  const stop = mountNotificationPopups(container, { qu, services, subscribe: noopSubscribe });
  try {
    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, { body: 'hi', extra: { title: 'No url' } });
    await waitFor(() => container.querySelector('.qu-toast') !== null);
  } finally {
    stop();
    setVisibility('visible');
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
