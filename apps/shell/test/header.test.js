import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, FlagService, FavoritesService, ProfileService, THREAD_PRESETS, ActorService, paths } from '@qu/services';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mountHeader } = await import('../src/header.js');

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

test('favorited apps appear as quick links in the menu, resolved against the apps catalog, before the divider', async (t) => {
  const { qu, services } = await freshEnv();
  await services.favorites.add('notes');
  t.mock.method(globalThis, 'fetch', mockAppsFetch([{ name: 'notes', label: 'Notes', icon: '📝' }]));
  const container = makeContainer();
  const stop = mountHeader(container, { qu, services, subscribe: noopSubscribe });
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
