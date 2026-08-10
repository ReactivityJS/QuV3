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
  chat: { allowMemberCreateGroup: true },
};

const APPS = [
  { name: 'forum', label: 'Forum', icon: '💬' },
  { name: 'reactions', label: 'reactions', icon: '🧩', contributes: [{ point: 'content.messageFooter', export: 'renderReactionWidget' }] },
  { name: 'pins', label: 'pins', icon: '📌', contributes: [{ point: 'content.messageMenu', export: 'pinMenuItem' }] },
];

/** section:nth-of-type - order-section index depends on how many sections come before it (see mount()'s own form.append() order). */
const FOOTER_ORDER_SECTION = 'form > section:nth-of-type(5)';
const MENU_ORDER_SECTION = 'form > section:nth-of-type(6)';

function orderRowLabels(section) {
  return [...section.querySelectorAll('.qu-relay-admin-order-row')].map((row) => row.querySelector('span').textContent);
}

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
    settings: { ...DEFAULT_SETTINGS, defaultLocale: 'de', rateLimits: { maxMessagesPerMinute: 30 }, disabledApps: ['reactions'], channels: { allowMemberCreate: false, allowMemberRestricted: true }, chat: { allowMemberCreateGroup: false } },
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

    const chatCheckboxes = [...container.querySelectorAll('form > section:nth-of-type(4) input[type="checkbox"]')];
    assert.equal(chatCheckboxes[0].checked, false); // allowMemberCreateGroup

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
    const appLabels = [...container.querySelectorAll('.qu-relay-admin-apps-list label')];
    appLabels[appLabels.findIndex((l) => l.textContent.includes('reactions'))].querySelector('input').checked = false;
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => capturedBody !== null);
    assert.equal(capturedBody.actorPub, env.myPub);
    assert.equal(capturedBody.settings.defaultLocale, 'de');
    assert.deepEqual(capturedBody.settings.disabledApps, ['reactions']);
    assert.deepEqual(capturedBody.settings.chat, { allowMemberCreateGroup: true }); // untouched - the form's own default

    await waitFor(() => container.querySelector('.qu-relay-admin-status')?.hidden === false);
    assert.match(container.querySelector('.qu-relay-admin-status').textContent, /Saved/);
    assert.equal(container.querySelector('.qu-relay-admin-status').classList.contains('qu-relay-admin-status-error'), false);
  } finally {
    stop?.();
  }
});

test('message row/menu order sections render every native item + catalog contributor, in the built-in DEFAULT order when unconfigured', async (t) => {
  const env = await freshEnv();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [env.myPub], settings: DEFAULT_SETTINGS }), { status: 200 }));

  const container = makeContainer();
  const stop = await mount(container, { identity: env.identity, services: env.services, apps: APPS });
  try {
    await waitFor(() => container.querySelector(FOOTER_ORDER_SECTION) !== null);
    // defaultOrder: reactions:0, core.menu:10, core.timestamp:20, core.readReceipt:30
    assert.deepEqual(orderRowLabels(container.querySelector(FOOTER_ORDER_SECTION)), [
      '🧩 reactions', '⋮ Context menu', 'Timestamp', 'Read tick (chat)',
    ]);
    // defaultOrder: edit:0, reply:5, pin:10, bookmark:20 - "bookmark" isn't
    // in APPS at all here, so it never appears (nothing contributes it).
    assert.deepEqual(orderRowLabels(container.querySelector(MENU_ORDER_SECTION)), [
      'Edit', 'Reply (chat)', '📌 pins',
    ]);
  } finally {
    stop?.();
  }
});

test('message row order: a previously-configured extensionOrder is honored, with a newly-appeared id appended at the end', async (t) => {
  const env = await freshEnv();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    adminPubs: [env.myPub],
    // core.readReceipt intentionally omitted - proves it still shows up, appended.
    settings: { ...DEFAULT_SETTINGS, extensionOrder: { 'content.messageFooter': ['core.timestamp', 'reactions', 'core.menu'] } },
  }), { status: 200 }));

  const container = makeContainer();
  const stop = await mount(container, { identity: env.identity, services: env.services, apps: APPS });
  try {
    await waitFor(() => container.querySelector(FOOTER_ORDER_SECTION) !== null);
    assert.deepEqual(orderRowLabels(container.querySelector(FOOTER_ORDER_SECTION)), [
      'Timestamp', '🧩 reactions', '⋮ Context menu', 'Read tick (chat)',
    ]);
  } finally {
    stop?.();
  }
});

test('message row order: the ▼/▲ buttons reorder items, disabled at the respective end, and the new order is what gets saved', async (t) => {
  const env = await freshEnv();
  let capturedBody = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/config.json') return new Response(JSON.stringify({ adminPubs: [env.myPub], settings: DEFAULT_SETTINGS }), { status: 200 });
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ...capturedBody.settings }), { status: 200 });
  });

  const container = makeContainer();
  const stop = await mount(container, { identity: env.identity, services: env.services, apps: APPS });
  try {
    await waitFor(() => container.querySelector(FOOTER_ORDER_SECTION) !== null);
    const footerSection = container.querySelector(FOOTER_ORDER_SECTION);
    let rows = footerSection.querySelectorAll('.qu-relay-admin-order-row');
    assert.equal(rows[0].querySelectorAll('button')[0].disabled, true); // can't move the first item up
    assert.equal(rows[3].querySelectorAll('button')[1].disabled, true); // can't move the last item down

    // Move "reactions" (row 0) down once - swaps with "core.menu".
    rows[0].querySelectorAll('button')[1].click(); // ▼
    assert.deepEqual(orderRowLabels(footerSection), ['⋮ Context menu', '🧩 reactions', 'Timestamp', 'Read tick (chat)']);

    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => capturedBody !== null);
    assert.deepEqual(capturedBody.settings.extensionOrder['content.messageFooter'], ['core.menu', 'reactions', 'core.timestamp', 'core.readReceipt']);
    assert.deepEqual(capturedBody.settings.extensionOrder['content.messageMenu'], ['edit', 'reply', 'pins']); // untouched point still included, per the "replace the whole map" contract
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
