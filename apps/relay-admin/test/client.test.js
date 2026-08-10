import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ActorService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const services = { actors: new ActorService(identity) };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

const DEFAULT_SETTINGS = {
  defaultLocale: 'en',
  rateLimits: { maxMessagesPerMinute: 0 },
  disabledApps: [],
  flagTypes: [{ id: 'favorite', label: 'Favorite', icon: '⭐', mode: 'private', entityKinds: ['app', 'user'] }],
  channels: { allowMemberCreate: true, allowMemberRestricted: false },
};

const APPS = [
  { name: 'forum', label: 'Forum', icon: '💬' },
  { name: 'reactions', label: 'reactions', icon: '🧩' },
];

test('a non-admin identity sees "not authorized", no form', async (t) => {
  const env = await freshEnv();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [], settings: DEFAULT_SETTINGS }), { status: 200 }));

  const container = makeContainer();
  const stop = await mount(container, { identity: env.identity, services: env.services, apps: APPS });
  try {
    await waitFor(() => container.textContent.includes('not authorized') || container.textContent.includes('not a configured admin'));
    assert.equal(container.querySelector('form'), null);
  } finally {
    stop?.();
  }
});

test('an admin identity sees the settings form, pre-populated from /config.json', async (t) => {
  const env = await freshEnv();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    adminPubs: [env.myPub],
    settings: { ...DEFAULT_SETTINGS, defaultLocale: 'de', rateLimits: { maxMessagesPerMinute: 30 }, disabledApps: ['reactions'], channels: { allowMemberCreate: false, allowMemberRestricted: true } },
  }), { status: 200 }));

  const container = makeContainer();
  const stop = await mount(container, { identity: env.identity, services: env.services, apps: APPS });
  try {
    await waitFor(() => container.querySelector('form') !== null);
    assert.equal(container.querySelector('select').value, 'de');
    assert.equal(container.querySelector('input[type="number"]').value, '30');

    const appCheckboxes = [...container.querySelectorAll('.qu-relay-admin-apps-list input[type="checkbox"]')];
    const forumCheckbox = appCheckboxes[[...container.querySelectorAll('.qu-relay-admin-apps-list label')].findIndex((l) => l.textContent.includes('forum'))];
    const reactionsCheckbox = appCheckboxes[[...container.querySelectorAll('.qu-relay-admin-apps-list label')].findIndex((l) => l.textContent.includes('reactions'))];
    assert.equal(forumCheckbox.checked, true);
    assert.equal(reactionsCheckbox.checked, false); // in disabledApps

    const channelCheckboxes = [...container.querySelectorAll('form > section:nth-of-type(3) input[type="checkbox"]')];
    assert.equal(channelCheckboxes[0].checked, false); // allowMemberCreate
    assert.equal(channelCheckboxes[1].checked, true); // allowMemberRestricted

    assert.match(container.querySelector('.qu-relay-admin-flagtypes').textContent, /Favorite/);
  } finally {
    stop?.();
  }
});

test('saving posts a REAL, independently-verifiable Ed25519 signature over the exact settings payload to POST /admin/settings', async (t) => {
  const env = await freshEnv();
  let capturedBody = null;

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/config.json') {
      return new Response(JSON.stringify({ adminPubs: [env.myPub], settings: DEFAULT_SETTINGS }), { status: 200 });
    }
    if (url === '/admin/settings') {
      capturedBody = JSON.parse(init.body);
      // Mirror admin-http.js's own AdminHttp#verifyAdmin() verification exactly.
      const verified = await QuCrypto.verify(
        new TextEncoder().encode(JSON.stringify(capturedBody.settings)),
        QuCrypto.fromBase64Url(capturedBody.signature),
        QuCrypto.fromBase64Url(capturedBody.actorPub)
      );
      return new Response(JSON.stringify(verified ? { ...capturedBody.settings } : { error: 'signature does not verify' }), { status: verified ? 200 : 403 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const container = makeContainer();
  const stop = await mount(container, { identity: env.identity, services: env.services, apps: APPS });
  try {
    await waitFor(() => container.querySelector('form') !== null);
    container.querySelector('select').value = 'de';
    container.querySelectorAll('.qu-relay-admin-apps-list input[type="checkbox"]')[1].checked = false; // uncheck reactions
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => capturedBody !== null);
    assert.equal(capturedBody.actorPub, env.myPub);
    assert.equal(capturedBody.settings.defaultLocale, 'de');
    assert.deepEqual(capturedBody.settings.disabledApps, ['reactions']);

    await waitFor(() => container.querySelector('.qu-relay-admin-status')?.hidden === false);
    assert.match(container.querySelector('.qu-relay-admin-status').textContent, /Saved/);
    assert.equal(container.querySelector('.qu-relay-admin-status').classList.contains('qu-relay-admin-status-error'), false);
  } finally {
    stop?.();
  }
});

test('a rejected save (e.g. signature mismatch server-side) shows the error, not a silent success', async (t) => {
  const env = await freshEnv();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/config.json') return new Response(JSON.stringify({ adminPubs: [env.myPub], settings: DEFAULT_SETTINGS }), { status: 200 });
    return new Response(JSON.stringify({ error: 'signature does not verify' }), { status: 403 });
  });

  const container = makeContainer();
  const stop = await mount(container, { identity: env.identity, services: env.services, apps: APPS });
  try {
    await waitFor(() => container.querySelector('form') !== null);
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => container.querySelector('.qu-relay-admin-status')?.hidden === false);
    assert.match(container.querySelector('.qu-relay-admin-status').textContent, /signature does not verify/);
    assert.equal(container.querySelector('.qu-relay-admin-status').classList.contains('qu-relay-admin-status-error'), true);
  } finally {
    stop?.();
  }
});
