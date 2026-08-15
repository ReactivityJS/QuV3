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
  const state = { openedUrl: undefined };
  const self = {
    location: { origin, href: `${origin}/dist/sw.js` },
    addEventListener: (type, handler) => { listeners[type] = handler; },
    clients: {
      matchAll: async () => clientsList,
      openWindow: async (url) => { state.openedUrl = url; },
      claim: async () => {},
    },
    registration: { showNotification: async () => {} },
    skipWaiting: () => {},
  };
  const listeners = {};
  const code = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { self, console, URL });
  return { listeners, state };
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
