import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { FavoritesService, FlagService, ListService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu); // the VIEWER's own identity - drives services.favorites
  await identity.importMnemonic(identity.generateMnemonic());
  const flags = new FlagService(qu, identity, new ListService(qu));
  const favorites = new FavoritesService(flags);

  const relayKp = await QuCrypto.generateKeypair(); // a DIFFERENT identity - simulates the relay's own signing key
  const relayPub = QuCrypto.toBase64Url(relayKp.publicKey);

  return { qu, services: { favorites }, relayKp, relayPub };
}

/** Writes a catalog entry directly, as @qu/relay's apps-catalog-store.js would - signed by relayKp unless a forger key is given. */
async function publishCatalogEntry(qu, relayKp, name, fields = {}) {
  const path = paths.appCatalogEntryPath(name);
  await qu.put(path, { name, label: name, icon: '🧩', navOrder: 0, enabled: true, ...fields }, {
    signWith: relayKp.privateKey,
    writerPub: relayKp.publicKey,
  });
}

function mockConfigFetch(relayPub) {
  return async (url) => {
    if (url === '/config.json') return { ok: true, json: async () => ({ relayPub }) };
    return { ok: false, json: async () => ({}) };
  };
}

/** Must be attached to document.body - <qu-list>/<qu-view> only fire connectedCallback() once actually part of the document, not just a detached node tree. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('passes a given syncFetch through to <qu-list>, called with the catalog\'s parent path', async (t) => {
  const { qu, services, relayKp, relayPub } = await freshEnv();
  await publishCatalogEntry(qu, relayKp, 'notes', { label: 'Notes' });
  t.mock.method(globalThis, 'fetch', mockConfigFetch(relayPub));
  const calls = [];
  const syncFetch = (prefix) => { calls.push(prefix); return Promise.resolve(); };

  const container = makeContainer();
  mount(container, { qu, services, syncFetch });
  await waitFor(() => container.querySelector('li') !== null);

  // At least once (possibly twice - <qu-list>'s own well-documented
  // double-mount for an attribute already present at parse time), always
  // with the catalog's own parent path.
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c) => c === paths.appCatalogParentPath()));
});

test('renders every enabled, relay-signed catalog entry', async (t) => {
  const { qu, services, relayKp, relayPub } = await freshEnv();
  await publishCatalogEntry(qu, relayKp, 'notes', { label: 'Notes', icon: '📝' });
  t.mock.method(globalThis, 'fetch', mockConfigFetch(relayPub));

  const container = makeContainer();
  mount(container, { qu, services });
  await waitFor(() => container.querySelector('li') !== null);

  assert.match(container.querySelector('.qu-app-list-link').textContent, /Notes/);
  assert.equal(container.querySelector('.qu-app-list-link').getAttribute('href'), '#/notes');
});

test('a catalog entry signed by someone OTHER than relayPub is never rendered', async (t) => {
  const { qu, services, relayPub } = await freshEnv();
  const forgerKp = await QuCrypto.generateKeypair();
  await publishCatalogEntry(qu, forgerKp, 'evil-app', { label: 'Evil App' });
  t.mock.method(globalThis, 'fetch', mockConfigFetch(relayPub));

  const container = makeContainer();
  mount(container, { qu, services });
  await new Promise((resolve) => setTimeout(resolve, 100)); // give it time to (not) render

  assert.equal(container.querySelectorAll('li').length, 0);
});

test('a disabled catalog entry (enabled: false) is not rendered', async (t) => {
  const { qu, services, relayKp, relayPub } = await freshEnv();
  await publishCatalogEntry(qu, relayKp, 'off', { label: 'Off', enabled: false });
  t.mock.method(globalThis, 'fetch', mockConfigFetch(relayPub));

  const container = makeContainer();
  mount(container, { qu, services });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(container.querySelectorAll('li').length, 0);
});

test('the list updates live when a new catalog entry is published', async (t) => {
  const { qu, services, relayKp, relayPub } = await freshEnv();
  t.mock.method(globalThis, 'fetch', mockConfigFetch(relayPub));

  const container = makeContainer();
  mount(container, { qu, services });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(container.querySelectorAll('li').length, 0);

  await publishCatalogEntry(qu, relayKp, 'notes', { label: 'Notes' });
  await waitFor(() => container.querySelector('li') !== null);
  assert.match(container.querySelector('.qu-app-list-link').textContent, /Notes/);
});

test('clicking the favorite toggle adds it, re-clicking removes it, and broadcasts qu:flag-changed', async (t) => {
  const { qu, services, relayKp, relayPub } = await freshEnv();
  await publishCatalogEntry(qu, relayKp, 'notes', { label: 'Notes' });
  t.mock.method(globalThis, 'fetch', mockConfigFetch(relayPub));

  const container = makeContainer();
  mount(container, { qu, services });
  await waitFor(() => container.querySelector('button') !== null);

  const events = [];
  window.addEventListener('qu:flag-changed', (e) => events.push(e.detail));

  const toggle = container.querySelector('button');
  await waitFor(() => toggle.textContent === '☆');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => toggle.textContent === '★');
  assert.equal(await services.favorites.isFavorite('notes'), true);
  assert.deepEqual(events, [{ flagType: 'favorite', entityKind: 'app', entityRef: 'notes', on: true }]);

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => toggle.textContent === '☆');
  assert.equal(await services.favorites.isFavorite('notes'), false);
});

test('an already-favorited app shows the active star on first render', async (t) => {
  const { qu, services, relayKp, relayPub } = await freshEnv();
  await publishCatalogEntry(qu, relayKp, 'notes', { label: 'Notes' });
  await services.favorites.add('notes');
  t.mock.method(globalThis, 'fetch', mockConfigFetch(relayPub));

  const container = makeContainer();
  mount(container, { qu, services });
  await waitFor(() => container.querySelector('button') !== null);
  await waitFor(() => container.querySelector('button').textContent === '★');
});

test('the returned stop function prevents a late-resolving /config.json from rendering into a torn-down container', async (t) => {
  const { qu, services } = await freshEnv();
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  const container = makeContainer();
  const stop = mount(container, { qu, services });
  stop();
  resolveFetch({ ok: true, json: async () => ({ relayPub: 'whatever' }) });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(container.querySelector('qu-list'), null); // stop() beat the fetch - the list never got built
});
