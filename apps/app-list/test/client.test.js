import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { FavoritesService, StarredService, FlagService, ListService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

async function freshServices() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const flags = new FlagService(qu, identity, new StarredService(qu, identity), new ListService(qu));
  const favorites = new FavoritesService(flags);
  return { favorites };
}

function fakeFetch(body, { ok = true } = {}) {
  return async () => ({ ok, json: async () => body });
}

test('renders every mountable app from /apps.json, sorted by navOrder', async (t) => {
  const { favorites } = await freshServices();
  t.mock.method(globalThis, 'fetch', fakeFetch([
    { name: 'b', label: 'Bravo', navOrder: 2, clientMainUrl: '/apps/b/dist/client.js' },
    { name: 'a', label: 'Alpha', navOrder: 1, clientMainUrl: '/apps/a/dist/client.js' },
  ]));
  const container = document.createElement('div');
  mount(container, { services: { favorites } });
  await waitFor(() => container.querySelectorAll('a').length > 0);

  const links = [...container.querySelectorAll('a')].map((a) => a.textContent);
  assert.deepEqual(links, ['Alpha', 'Bravo']);
});

test('an app with no clientMainUrl (server-only) is omitted', async (t) => {
  const { favorites } = await freshServices();
  t.mock.method(globalThis, 'fetch', fakeFetch([
    { name: 'forum', label: 'Forum', clientMainUrl: null },
    { name: 'notes', label: 'Notes', clientMainUrl: '/apps/notes/dist/client.js' },
  ]));
  const container = document.createElement('div');
  mount(container, { services: { favorites } });
  await waitFor(() => container.querySelectorAll('a').length > 0);

  const links = [...container.querySelectorAll('a')].map((a) => a.textContent);
  assert.deepEqual(links, ['Notes']);
});

test('a disabled app (enabled: false) is omitted', async (t) => {
  const { favorites } = await freshServices();
  t.mock.method(globalThis, 'fetch', fakeFetch([
    { name: 'notes', label: 'Notes', enabled: false, clientMainUrl: '/apps/notes/dist/client.js' },
  ]));
  const container = document.createElement('div');
  mount(container, { services: { favorites } });
  await waitFor(() => container.textContent.length > 0);

  assert.equal(container.querySelectorAll('a').length, 0);
  assert.match(container.textContent, /No mountable apps/);
});

test('a failed /apps.json fetch renders the empty state instead of throwing', async (t) => {
  const { favorites } = await freshServices();
  t.mock.method(globalThis, 'fetch', fakeFetch([], { ok: false }));
  const container = document.createElement('div');
  mount(container, { services: { favorites } });
  await waitFor(() => container.textContent.length > 0);

  assert.match(container.textContent, /No mountable apps/);
});

test('clicking the favorite toggle adds it, re-clicking removes it, and broadcasts qu:flag-changed', async (t) => {
  const { favorites } = await freshServices();
  t.mock.method(globalThis, 'fetch', fakeFetch([
    { name: 'notes', label: 'Notes', clientMainUrl: '/apps/notes/dist/client.js' },
  ]));
  const container = document.createElement('div');
  mount(container, { services: { favorites } });
  await waitFor(() => container.querySelector('button') !== null);

  const events = [];
  window.addEventListener('qu:flag-changed', (e) => events.push(e.detail));

  const toggle = container.querySelector('button');
  assert.equal(toggle.textContent, '☆');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => toggle.textContent === '★');
  assert.deepEqual(await favorites.list(), ['notes']);
  assert.deepEqual(events, [{ flagType: 'favorite', entityKind: 'app', entityRef: 'notes', on: true }]);

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => toggle.textContent === '☆');
  assert.deepEqual(await favorites.list(), []);
});

test('a previously favorited app shows the active star on first render', async (t) => {
  const { favorites } = await freshServices();
  await favorites.add('notes');
  t.mock.method(globalThis, 'fetch', fakeFetch([
    { name: 'notes', label: 'Notes', clientMainUrl: '/apps/notes/dist/client.js' },
  ]));
  const container = document.createElement('div');
  mount(container, { services: { favorites } });
  await waitFor(() => container.querySelector('button') !== null);

  assert.equal(container.querySelector('button').textContent, '★');
});

test('the returned stop function prevents a late-resolving fetch from rendering into a torn-down container', async () => {
  const { favorites } = await freshServices();
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  const container = document.createElement('div');
  const stop = mount(container, { services: { favorites } });
  stop();
  resolveFetch({ ok: true, json: async () => [{ name: 'notes', label: 'Notes', clientMainUrl: '/x' }] });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(container.children.length, 0);
});
