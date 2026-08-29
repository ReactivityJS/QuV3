import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, FlagService, FavoritesService, ProfileService, THREAD_PRESETS, ActorService, paths } from '@qu/services';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mountHeader } = await import('../src/header.js');
const { registerServiceWorker, applyUpdate, captureInstallPrompt } = await import('../src/pwa.js');

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
  const flags = new FlagService(qu, identity, list);
  const services = {
    messages: new MessageService(qu, identity, list, access),
    actors: new ActorService(identity),
    favorites: new FavoritesService(flags),
    profile: new ProfileService(qu, identity),
    assets: null,
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

function noopSubscribe() {}

/** Must be attached to document.body - outside-click detection only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function mockAppsFetch(apps = []) {
  return async (url) => {
    if (url === '/apps.json') return { ok: true, json: async () => apps };
    return { ok: false, json: async () => ({}) };
  };
}

async function waitForOwnName(container) {
  await waitFor(() => (container.querySelector('.qu-shell-user-name')?.textContent ?? '') !== '');
}

// ===== fakes for ./pwa.js's registerServiceWorker() - mirrors apps/shell/test/pwa.test.js's own =====
class FakeRegistration extends EventTarget {
  constructor() {
    super();
    this.installing = null;
    this.waiting = null;
  }
}
class FakeWorker extends EventTarget {
  constructor() {
    super();
    this.state = 'installing';
    this.posted = [];
  }
  postMessage(msg) { this.posted.push(msg); }
}
class FakeServiceWorkerContainer extends EventTarget {
  constructor(registration) {
    super();
    this.controller = {}; // a genuine update, not a first install - see registerServiceWorker()'s own doc comment
    this._registration = registration;
  }
  register() { return Promise.resolve(this._registration); }
}
function installFakeServiceWorker() {
  const registration = new FakeRegistration();
  const container = new FakeServiceWorkerContainer(registration);
  navigator.serviceWorker = container;
  return { registration, container };
}

/** Mirrors apps/shell/client.js's own wiring - registers BOTH pwa.js browser APIs and returns the `pwa` object mountHeader() expects, so tests can drive the exact same shape production code passes. */
function makePwa() {
  let updateRegistration = null;
  let updateAvailable = false;
  const updateListeners = new Set();
  registerServiceWorker({
    onUpdateAvailable: (registration) => {
      updateRegistration = registration;
      updateAvailable = true;
      for (const cb of updateListeners) cb();
    },
  });
  let installable = false;
  const installListeners = new Set();
  const { installApp } = captureInstallPrompt({
    onInstallable: () => {
      installable = true;
      for (const cb of installListeners) cb();
    },
  });
  return {
    getUpdateAvailable: () => updateAvailable,
    onUpdateAvailable: (cb) => updateListeners.add(cb),
    applyUpdate: () => applyUpdate(updateRegistration),
    getInstallable: () => installable,
    onInstallable: (cb) => installListeners.add(cb),
    installApp,
  };
}

test('renders the Home logo, Back/Forward buttons, and the notification bell', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    const home = container.querySelector('.qu-shell-home');
    assert.equal(home.getAttribute('href'), '#');
    assert.equal(home.querySelector('img').getAttribute('src'), '/logo.svg');
    assert.equal(container.querySelectorAll('.qu-shell-histbtn').length, 2);
    assert.equal(container.querySelector('.qu-shell-bell').getAttribute('href'), '#/notifications');
  } finally {
    stop();
  }
});

test('the App Navigation Points Slot sits right after Back/Forward (left); the App Action Slot stays next to the bell/avatar (right)', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    const classNames = [...container.querySelector('.qu-shell-header').children].map((el) => el.className);
    const navSlotIndex = classNames.indexOf('qu-shell-nav-slot');
    const spacerIndex = classNames.indexOf('qu-shell-header-spacer');
    const actionSlotIndex = classNames.indexOf('qu-shell-header-slot');
    const bellIndex = classNames.indexOf('qu-shell-bell');
    assert.ok(navSlotIndex > classNames.lastIndexOf('qu-shell-histbtn'), 'the Nav Points Slot must come after Back/Forward');
    assert.ok(navSlotIndex < spacerIndex, 'the Nav Points Slot must come before the spacer, so it stays left-aligned next to Back/Forward');
    assert.ok(spacerIndex < actionSlotIndex, 'the App Action Slot must come after the spacer');
    assert.ok(actionSlotIndex < bellIndex, 'the App Action Slot must stay next to the bell/avatar on the right');
  } finally {
    stop();
  }
});

test('the user menu shows Profile/Settings/App List links and no Relay Admin link for a non-admin', async (t) => {
  const { qu, services, myPub } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    container.querySelector('.qu-shell-user-btn').click();
    await waitFor(() => container.querySelector('.qu-shell-menu a') !== null);

    const hrefs = [...container.querySelectorAll('.qu-shell-menu a')].map((a) => a.getAttribute('href'));
    assert.ok(hrefs.includes(`#/~${myPub}`), 'expected a profile link');
    assert.ok(hrefs.includes(`#/~${myPub}/settings`), 'expected a settings link');
    assert.ok(hrefs.includes('#/app-list'), 'expected an app-list link');
    assert.ok(!hrefs.includes('#/relay-admin'), 'a non-admin must not see the relay-admin link');
    assert.ok(container.querySelector('.qu-shell-menu-empty'), 'expected the "no favorites" placeholder');
  } finally {
    stop();
  }
});

test('shows the Relay Admin link only when this identity\'s pub is in adminPubs', async (t) => {
  const { qu, services, myPub } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, adminPubs: [myPub], subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    container.querySelector('.qu-shell-user-btn').click();
    await waitFor(() => container.querySelector('a[href="#/relay-admin"]') !== null);
  } finally {
    stop();
  }
});

test('REGRESSION: opening the main menu never calls fetch() at all - it reads mountHeader()\'s own already-passed-in apps param, not a fresh /apps.json round-trip per open', async (t) => {
  const { qu, services } = await freshEnv();
  await services.favorites.add('notes');
  const fetchMock = t.mock.method(globalThis, 'fetch', mockAppsFetch([{ name: 'notes', label: 'Notes', icon: '📝' }]));
  const container = makeContainer();
  // Deliberately NOT passed via `apps:` here - if renderMenu() ever calls
  // fetch() again, this fixture's mocked '/apps.json' response would let a
  // regression slip back in unnoticed; leaving it unresolved keeps the
  // assertion honest either way (see the fetch-call-count assertion below,
  // the actual regression guard).
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    const callsBeforeOpen = fetchMock.mock.calls.length;
    container.querySelector('.qu-shell-user-btn').click();
    await waitFor(() => container.querySelector('.qu-shell-menu') !== null && !container.querySelector('.qu-shell-menu').hidden);
    assert.equal(fetchMock.mock.calls.length, callsBeforeOpen, 'opening the menu must never call fetch()');
  } finally {
    stop();
  }
});

test('favorited apps appear as quick links in the menu, resolved against the apps catalog, before the divider', async (t) => {
  const { qu, services } = await freshEnv();
  await services.favorites.add('notes');
  // The catalog comes from mountHeader()'s own `apps` param (the SAME
  // boot-time snapshot client.js already fetches once) - NOT a fresh
  // fetch('/apps.json') per menu open (see renderMenu()'s own doc comment
  // for the bug this fixed: an earlier version shadowed this param with a
  // same-named local variable and re-fetched over the network every time).
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, apps: [{ name: 'notes', label: 'Notes', icon: '📝' }] });
  try {
    await waitForOwnName(container);
    container.querySelector('.qu-shell-user-btn').click();
    await waitFor(() => container.querySelector('.qu-shell-menu a') !== null);

    const favLink = [...container.querySelectorAll('.qu-shell-menu a')].find((a) => a.getAttribute('href') === '#/notes');
    assert.ok(favLink, 'expected a favorite quick link to #/notes');
    assert.match(favLink.textContent, /Notes/);
    const divider = container.querySelector('.qu-shell-menu-divider');
    assert.ok(divider);
    assert.ok(favLink.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING, 'favorite links come before the divider');
    assert.equal(container.querySelector('.qu-shell-menu-empty'), null);
  } finally {
    stop();
  }
});

test('the menu closes on Escape and on an outside click', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);

    container.querySelector('.qu-shell-user-btn').click();
    assert.equal(container.querySelector('.qu-shell-menu').hidden, false);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(container.querySelector('.qu-shell-menu').hidden, true);

    container.querySelector('.qu-shell-user-btn').click();
    assert.equal(container.querySelector('.qu-shell-menu').hidden, false);
    document.body.click(); // outside the menu
    assert.equal(container.querySelector('.qu-shell-menu').hidden, true);
  } finally {
    stop();
  }
});

test('the notification bell badge reflects unread notifications, live', async (t) => {
  const { qu, services, myPub } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-shell-badge').hidden === true);

    const spaceId = paths.notificationsSpaceId(myPub);
    await services.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(myPub));
    await services.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, { body: 'hi' });

    await waitFor(() => container.querySelector('.qu-shell-badge').hidden === false);
    assert.equal(container.querySelector('.qu-shell-badge').textContent, '1');
  } finally {
    stop();
  }
});

test('subscribe() is called with the notifications space prefix', async (t) => {
  const { qu, services, myPub } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const calls = [];
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: (prefix) => calls.push(prefix) });
  try {
    await waitFor(() => calls.length > 0);
    assert.deepEqual(calls, [paths.spacePath(paths.notificationsSpaceId(myPub))]);
  } finally {
    stop();
  }
});

test('the own alias/avatar shown in the header updates live when the profile changes, no reload needed', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    const nameSlot = container.querySelector('.qu-shell-user-name');
    assert.notEqual(nameSlot.textContent, 'Ada');

    await services.profile.saveProfile({ alias: 'Ada' });

    await waitFor(() => nameSlot.textContent === 'Ada');
    assert.match(container.querySelector('.qu-shell-user-btn').title, /^Ada — /);
  } finally {
    stop();
  }
});

test('the returned stop function tears down cleanly - no error thrown', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  await waitForOwnName(container);
  assert.doesNotThrow(() => stop());
});

// ===== shell.headerAction slot (search icon, or any future header contribution) =====

const HEADER_PLUGIN_URL = new URL('./fixtures/header-search-plugin.js', import.meta.url).href;

test('shell.headerAction: a contributor mounts once, reflecting the CURRENT route context', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  window.location.hash = '#/forum/t/abc123';
  const apps = [{ name: 'search', clientMainUrl: HEADER_PLUGIN_URL, contributes: [{ point: 'shell.headerAction', export: 'renderHeaderSearch' }] }];
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, apps });
  try {
    await waitFor(() => container.querySelector('[data-test-header-action]') !== null);
    assert.equal(container.querySelector('[data-test-header-action]').textContent, 'search:forum:forum,t,abc123');
  } finally {
    stop();
    window.location.hash = '';
  }
});

test('shell.headerAction: a contributor updates live on hashchange, without remounting', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  window.location.hash = '#/forum';
  const apps = [{ name: 'search', clientMainUrl: HEADER_PLUGIN_URL, contributes: [{ point: 'shell.headerAction', export: 'renderHeaderSearch' }] }];
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, apps });
  try {
    await waitFor(() => container.querySelector('[data-test-header-action]') !== null);
    const link = container.querySelector('[data-test-header-action]');
    assert.equal(link.textContent, 'search:forum:forum');

    window.location.hash = '#/chat/somepeer';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => link.textContent === 'search:chat:chat,somepeer');
    // Still the SAME element - a route change updates the existing contribution in place, no re-render/re-import.
    assert.equal(container.querySelector('[data-test-header-action]'), link);
  } finally {
    stop();
    window.location.hash = '';
  }
});

test('shell.headerAction: no apps catalog (default []) renders no contribution, no error', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    assert.equal(container.querySelector('[data-test-header-action]'), null);
  } finally {
    stop();
  }
});

const PAYLOAD_PLUGIN_URL = new URL('./fixtures/header-payload-plugin.js', import.meta.url).href;

test('shell.headerAction: the payload carries getContext/onContextChange/services/qu/subscribe/syncFetch/syncStats (a CONDITIONAL contributor, e.g. Calendar\'s "+ New event", needs services to resolve its own data)', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const apps = [{ name: 'probe', clientMainUrl: PAYLOAD_PLUGIN_URL, contributes: [{ point: 'shell.headerAction', export: 'renderHeaderPayloadProbe' }] }];
  const container = makeContainer();
  const syncFetch = async () => {};
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, syncFetch, apps });
  try {
    await waitFor(() => container.querySelector('[data-test-payload-probe]') !== null);
    assert.equal(
      container.querySelector('[data-test-payload-probe]').textContent,
      'getContext,onContextChange,qu,services,subscribe,syncFetch,syncStats',
    );
  } finally {
    stop();
  }
});

// ===== shell.headerNavPoints slot (Calendar/Chat/ToDo's "+"/Forum's dropdown) =====

test('shell.headerNavPoints: a contributor mounts once, reflecting the CURRENT route context', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  window.location.hash = '#/forum/t/abc123';
  const apps = [{ name: 'search', clientMainUrl: HEADER_PLUGIN_URL, contributes: [{ point: 'shell.headerNavPoints', export: 'renderHeaderSearch' }] }];
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, apps });
  try {
    await waitFor(() => container.querySelector('[data-test-header-action]') !== null);
    assert.equal(container.querySelector('[data-test-header-action]').textContent, 'search:forum:forum,t,abc123');
    // Lives in the LEFT slot (next to Back/Forward), not the right-side shell.headerAction slot.
    assert.ok(container.querySelector('.qu-shell-nav-slot [data-test-header-action]'));
    assert.equal(container.querySelector('.qu-shell-header-slot [data-test-header-action]'), null);
  } finally {
    stop();
    window.location.hash = '';
  }
});

test('shell.headerNavPoints: no apps catalog (default []) renders no contribution, no error', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    assert.equal(container.querySelector('[data-test-header-action]'), null);
  } finally {
    stop();
  }
});

test('shell.headerAction and shell.headerNavPoints are independent - a contributor to one does not appear in the other', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const apps = [{ name: 'search', clientMainUrl: HEADER_PLUGIN_URL, contributes: [{ point: 'shell.headerAction', export: 'renderHeaderSearch' }] }];
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, apps });
  try {
    await waitFor(() => container.querySelector('[data-test-header-action]') !== null);
    assert.ok(container.querySelector('.qu-shell-header-slot [data-test-header-action]'));
    assert.equal(container.querySelector('.qu-shell-nav-slot [data-test-header-action]'), null);
  } finally {
    stop();
  }
});

test('.qu-shell-user has min-width: 0 so it can shrink/ellipsis instead of pushing the bell/App Action Slot off-screen on narrow viewports', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    const css = document.getElementById('qu-shell-header-style').textContent;
    const rule = css.match(/\.qu-shell-user\s*\{[^}]*\}/)[0];
    assert.match(rule, /min-width:\s*0/, 'the .qu-shell-user flex item must set min-width: 0 to allow it to shrink below its content size');
  } finally {
    stop();
  }
});

// ===== PWA update icon + menu entries (./pwa.js, folded into the header instead of a separate bar) =====
// `mountHeader()` no longer calls ./pwa.js itself - it renders whatever `pwa` (built the SAME way
// apps/shell/client.js builds it, see makePwa() above) tells it, so every test here builds one explicitly.

test('the update icon stays hidden until a genuine update is available, then clicking it applies it', async (t) => {
  const { registration } = installFakeServiceWorker();
  t.after(() => { delete navigator.serviceWorker; });
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, pwa: makePwa() });
  try {
    await waitForOwnName(container);
    const updateBtn = container.querySelector('.qu-shell-update-btn');
    assert.equal(updateBtn.hidden, true);

    const worker = new FakeWorker();
    registration.installing = worker;
    registration.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    registration.waiting = worker; // a real browser promotes an installed worker to .waiting itself
    worker.dispatchEvent(new Event('statechange'));
    await waitFor(() => updateBtn.hidden === false);
    assert.match(updateBtn.title, /update/i);

    updateBtn.click();
    assert.deepEqual(worker.posted, [{ type: 'SKIP_WAITING' }]);
  } finally {
    stop();
  }
});

test('the update icon never appears for the very first service worker install (no controller yet) - only a genuine update', async (t) => {
  const registration = new FakeRegistration();
  const container2 = new FakeServiceWorkerContainer(registration);
  container2.controller = null; // no controller at boot - a first install, not an update
  navigator.serviceWorker = container2;
  t.after(() => { delete navigator.serviceWorker; });
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, pwa: makePwa() });
  try {
    await waitForOwnName(container);
    const worker = new FakeWorker();
    registration.installing = worker;
    registration.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    worker.dispatchEvent(new Event('statechange'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(container.querySelector('.qu-shell-update-btn').hidden, true);
  } finally {
    stop();
  }
});

test('an update already available BEFORE the header mounts still shows the icon immediately (no missed event)', async (t) => {
  const { registration } = installFakeServiceWorker();
  t.after(() => { delete navigator.serviceWorker; });
  const pwa = makePwa(); // registers + starts listening, same as apps/shell/client.js does before mountHeader() ever runs
  const worker = new FakeWorker();
  registration.installing = worker;
  registration.dispatchEvent(new Event('updatefound'));
  worker.state = 'installed';
  registration.waiting = worker;
  worker.dispatchEvent(new Event('statechange'));
  await waitFor(() => pwa.getUpdateAvailable() === true);

  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, pwa });
  try {
    await waitForOwnName(container);
    assert.equal(container.querySelector('.qu-shell-update-btn').hidden, false);
  } finally {
    stop();
  }
});

test('no pwa option at all - update icon and install menu entry both stay absent/hidden, no throw', async (t) => {
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitForOwnName(container);
    assert.equal(container.querySelector('.qu-shell-update-btn').hidden, true);
  } finally {
    stop();
  }
});

test('the "Install app" and "Apply update" menu entries are absent until applicable, appear under their own divider, and work', async (t) => {
  const { registration } = installFakeServiceWorker();
  t.after(() => { delete navigator.serviceWorker; });
  const { qu, services } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockAppsFetch());
  const container = makeContainer();
  const pwa = makePwa();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe, pwa });
  try {
    await waitForOwnName(container);
    container.querySelector('.qu-shell-user-btn').click();
    await waitFor(() => container.querySelector('.qu-shell-menu a') !== null);
    assert.equal([...container.querySelectorAll('.qu-shell-menu-item')].length, 0, 'neither entry, nor their divider, should exist yet');
    container.querySelector('.qu-shell-user-btn').click(); // close

    const event = new window.Event('beforeinstallprompt', { cancelable: true });
    let prompted = false;
    event.prompt = () => { prompted = true; };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);

    const worker = new FakeWorker();
    registration.installing = worker;
    registration.dispatchEvent(new Event('updatefound'));
    worker.state = 'installed';
    registration.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
    await waitFor(() => pwa.getInstallable() === true && pwa.getUpdateAvailable() === true);

    container.querySelector('.qu-shell-user-btn').click(); // reopen
    await waitFor(() => container.querySelector('.qu-shell-menu a') !== null);
    const items = [...container.querySelectorAll('.qu-shell-menu-item')];
    const installBtn = items.find((b) => /install/i.test(b.textContent));
    const applyUpdateBtn = items.find((b) => b !== installBtn);
    assert.ok(installBtn, 'expected an "Install app" entry once installable');
    assert.ok(applyUpdateBtn, 'expected an "Apply update" entry once an update is pending');
    // Both sit after a divider that separates them from Profile/Settings/App List.
    const dividers = [...container.querySelectorAll('.qu-shell-menu-divider')];
    assert.equal(dividers.length, 2, 'expected the usual favorites divider PLUS a second one before this group');

    applyUpdateBtn.click();
    assert.deepEqual(worker.posted, [{ type: 'SKIP_WAITING' }]);

    installBtn.click();
    await waitFor(() => prompted === true);
    // Install is one-shot - gone on the next open; the update entry stays (still pending).
    container.querySelector('.qu-shell-user-btn').click();
    container.querySelector('.qu-shell-user-btn').click();
    await waitFor(() => container.querySelector('.qu-shell-menu a') !== null);
    const itemsAfter = [...container.querySelectorAll('.qu-shell-menu-item')];
    assert.equal(itemsAfter.some((b) => /install/i.test(b.textContent)), false);
    assert.equal(itemsAfter.some((b) => b.textContent.includes(applyUpdateBtn.textContent)), true);
  } finally {
    stop();
  }
});
