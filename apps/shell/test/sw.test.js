import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * `apps/shell/sw.js` runs in a separate ServiceWorkerGlobalScope, served
 * completely unbundled (see that file's own doc comment) - no `export`,
 * just top-level `self.addEventListener(...)` calls. Loaded here via `vm`
 * against a minimal mocked `self`, capturing whatever handlers it
 * registers - the same "load the real file, stub only the platform globals
 * it touches" approach as this app's own service-worker-adjacent tests.
 */
function loadServiceWorker({ clientsList = [], origin = 'https://example.test' } = {}) {
  const state = { openedUrl: undefined, shownNotifications: [] };
  const self = {
    location: { origin, href: `${origin}/dist/sw.js` },
    addEventListener: (type, handler) => { listeners[type] = handler; },
    clients: {
      matchAll: async () => clientsList,
      openWindow: async (url) => { state.openedUrl = url; },
      claim: async () => {},
    },
    registration: {
      showNotification: async (title, options) => { state.shownNotifications.push({ title, options }); },
    },
    skipWaiting: () => {},
  };
  const listeners = {};
  const code = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { self, console, URL });
  return { listeners, state };
}

/** `push`'s own handler is the same `waitUntil(...)`-only shape as `notificationclick`'s - see `fireNotificationClick()`'s own doc comment. */
async function firePush(listeners, payload) {
  let waited;
  listeners.push({ data: { json: () => payload }, waitUntil: (p) => { waited = p; } });
  await waited;
}

/**
 * `notificationclick`'s own handler is SYNCHRONOUS (it calls `event.
 * waitUntil(somePromise)`, itself returning `undefined`) - awaiting the
 * handler call directly awaits nothing. This captures whatever promise it
 * hands to `waitUntil()` and awaits THAT instead, exactly how a real
 * browser's own ExtendableEvent keeps the worker alive until it settles.
 */
async function fireNotificationClick(listeners, notification) {
  let waited;
  listeners.notificationclick({ notification, waitUntil: (p) => { waited = p; } });
  await waited;
}

test('notificationclick with no open tab: opens an ABSOLUTE url (site origin + the notification\'s hash), not the bare hash resolved against the service worker\'s own script location (regression: used to land on the SW source file)', async () => {
  const { listeners, state } = loadServiceWorker({ clientsList: [] });
  const notification = { close: () => {}, data: { url: '#/forum/t/abc/m/def' } };
  await fireNotificationClick(listeners, notification);
  assert.equal(state.openedUrl, 'https://example.test/#/forum/t/abc/m/def');
});

test('notificationclick with an already-open tab: focuses and navigates it to the same absolute url, without opening a second window', async () => {
  const navigated = {};
  const client = {
    url: 'https://example.test/',
    focus: async () => {},
    navigate: async (url) => { navigated.url = url; },
  };
  const { listeners, state } = loadServiceWorker({ clientsList: [client] });
  const notification = { close: () => {}, data: { url: '#/chat/g/room1' } };
  await fireNotificationClick(listeners, notification);
  assert.equal(navigated.url, 'https://example.test/#/chat/g/room1');
  assert.equal(state.openedUrl, undefined);
});

test('notificationclick falls back to "/" when the notification carries no url at all', async () => {
  const { listeners, state } = loadServiceWorker({ clientsList: [] });
  const notification = { close: () => {}, data: undefined };
  await fireNotificationClick(listeners, notification);
  assert.equal(state.openedUrl, 'https://example.test/');
});

test('push with an "actions" payload (e.g. Phone\'s incoming-call Accept/Decline) shows a notification with platform-shaped {action, title} buttons, stashing the real per-button urls in data.actions', async () => {
  const { listeners, state } = loadServiceWorker();
  await firePush(listeners, {
    title: 'Incoming call',
    body: 'peer-a is calling',
    url: '#/phone',
    actions: [
      { action: 'accept', title: 'Annehmen', url: '#/phone/peer-a/accept' },
      { action: 'decline', title: 'Ablehnen', url: '#/phone/peer-a/decline' },
    ],
  });

  assert.equal(state.shownNotifications.length, 1);
  const { title, options } = state.shownNotifications[0];
  assert.equal(title, 'Incoming call');
  // JSON round-trip: `options.actions`/`options.data.actions` (or parts of
  // them) are built with `Array.prototype.map()`/object literals evaluated
  // INSIDE the vm context sw.js runs in (see `loadServiceWorker()`'s own
  // doc comment) - a different realm's `Array`/`Object` than this test
  // file's own, which `assert.deepStrictEqual` (imported as `deepEqual`
  // from `node:assert/strict`) treats as a mismatch despite identical
  // structure ("same structure but are not reference-equal"). Round-
  // tripping through JSON strips the realm, comparing plain data only -
  // exactly what these assertions actually care about.
  assert.deepEqual(JSON.parse(JSON.stringify(options.actions)), [{ action: 'accept', title: 'Annehmen' }, { action: 'decline', title: 'Ablehnen' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(options.data.actions)), [
    { action: 'accept', title: 'Annehmen', url: '#/phone/peer-a/accept' },
    { action: 'decline', title: 'Ablehnen', url: '#/phone/peer-a/decline' },
  ]);
});

test('push with no "actions" field shows a notification with an empty actions array, same as before this existed', async () => {
  const { listeners, state } = loadServiceWorker();
  await firePush(listeners, { title: 'New message', body: 'hi', url: '#/chat' });

  const { options } = state.shownNotifications[0];
  assert.equal(options.actions.length, 0);
  assert.equal(options.data.actions.length, 0);
});

test('notificationclick with event.action set to a known button id navigates to THAT button\'s own url, not the notification\'s default url', async () => {
  const { listeners, state } = loadServiceWorker({ clientsList: [] });
  const notification = {
    close: () => {},
    data: {
      url: '#/phone',
      actions: [
        { action: 'accept', title: 'Annehmen', url: '#/phone/peer-a/accept' },
        { action: 'decline', title: 'Ablehnen', url: '#/phone/peer-a/decline' },
      ],
    },
  };
  let waited;
  listeners.notificationclick({ notification, action: 'decline', waitUntil: (p) => { waited = p; } });
  await waited;
  assert.equal(state.openedUrl, 'https://example.test/#/phone/peer-a/decline');
});

test('notificationclick with event.action === "" (the notification BODY was clicked, not a button) falls back to the default url, ignoring data.actions', async () => {
  const { listeners, state } = loadServiceWorker({ clientsList: [] });
  const notification = {
    close: () => {},
    data: {
      url: '#/phone',
      actions: [{ action: 'accept', title: 'Annehmen', url: '#/phone/peer-a/accept' }],
    },
  };
  let waited;
  listeners.notificationclick({ notification, action: '', waitUntil: (p) => { waited = p; } });
  await waited;
  assert.equal(state.openedUrl, 'https://example.test/#/phone');
});
