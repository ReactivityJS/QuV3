import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { paths, ProfileService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';
import { getStoredLocale, setLocale } from '@qu/i18n';

installDom();
// Node 22 ships a native global WebSocket - unlike a real browser missing
// one, this would let WebSocketClientTransport actually attempt a REAL TCP
// connection to ws://localhost/ (jsdom's configured origin), which nothing
// is listening on - a slow (multi-second) OS-level connect timeout per
// test, not a fast failure. These tests deliberately never exercise real
// sync (see apps/shell/client.js's own try/catch around connectToRelay())
// - hiding it here keeps that path fast and side-effect-free, exactly like
// a real browser missing WebSocket would.
delete globalThis.WebSocket;
// installDom() doesn't copy localStorage onto globalThis - a plain in-memory
// fake, needed once mount() starts reading/writing the identity-bound
// language/theme preference via @qu/i18n's/@qu/ui's device-local mechanisms.
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
})();
// @qu/ui's package root transitively evaluates components.js, which extends
// HTMLElement at module-load time - must come AFTER installDom(), same
// reason `mount` itself is loaded dynamically below (see @qu/ui/testing's
// own doc comment).
const { getStoredTheme, setStoredTheme } = await import('@qu/ui');
const { mount } = await import('../client.js');

function freshQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return qu;
}

/** Must be attached to document.body - <qu-list>/<qu-view> only fire connectedCallback() once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * A real Node dynamic `import()` of a `data:` URL works identically to a
 * real browser fetching a real bundle - no dependency-injection seam
 * needed in client.js just for tests, `app.clientMainUrl` IS the URL
 * `import()` is given either way.
 */
function dataUrlModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

function mockFetch({ relayPub = 'relay-pub-1', apps = [] } = {}) {
  return async (url) => {
    if (url === '/config.json') return { ok: true, json: async () => ({ relayPub }) };
    if (url === '/apps.json') return { ok: true, json: async () => apps };
    return { ok: false, json: async () => ({}) };
  };
}

/** Publishes a catalog entry directly, as @qu/relay's apps-catalog-store.js would - signed by relayKp. */
async function publishCatalogEntry(qu, relayKp, name, fields = {}) {
  await qu.put(paths.appCatalogEntryPath(name), { name, label: name, icon: '🧩', enabled: true, ...fields }, {
    signWith: relayKp.privateKey,
    writerPub: relayKp.publicKey,
  });
}

test('a fresh identity (no hasIdentity()) shows onboarding instead of mounting the shell', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  t.mock.method(globalThis, 'fetch', mockFetch());

  const container = makeContainer();
  mount(container, { qu, identity }); // deliberately not awaited - resolves only once onboarding completes
  await waitFor(() => container.querySelector('.qu-onboard-choices button') !== null);

  assert.equal(container.querySelectorAll('.qu-onboard-choices button').length, 2);
  assert.equal(await identity.hasIdentity(), false);
});

test('completing "create a new identity" onboarding stores the identity and mounts the shell (nav + home)', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  t.mock.method(globalThis, 'fetch', mockFetch());

  const container = makeContainer();
  const mountPromise = mount(container, { qu, identity });
  await waitFor(() => container.querySelector('.qu-onboard-choices button') !== null);

  container.querySelector('.qu-onboard-choices button').click(); // "Create a new identity"
  await waitFor(() => container.querySelector('.qu-onboard-mnemonic') !== null);
  container.querySelector('.qu-onboard label input[type=checkbox]').click();
  const continueBtn = [...container.querySelectorAll('.qu-onboard-row button')].find((b) => b.textContent === 'Continue');
  continueBtn.click();

  const stop = await mountPromise;
  try {
    assert.equal(await identity.hasIdentity(), true);
    await waitFor(() => container.querySelector('.qu-shell-placeholder') !== null);
    assert.match(container.querySelector('.qu-shell-placeholder').textContent, /Pick an app/);
  } finally {
    stop();
  }
});

test('an identity that already exists skips onboarding entirely', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  t.mock.method(globalThis, 'fetch', mockFetch());

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    assert.equal(container.querySelector('.qu-onboard'), null);
    assert.ok(container.querySelector('.qu-shell-placeholder'));
  } finally {
    stop();
  }
});

test('the nav renders one entry per trusted, enabled catalog entry, live', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const relayKp = await QuCrypto.generateKeypair();
  const relayPub = QuCrypto.toBase64Url(relayKp.publicKey);
  await publishCatalogEntry(qu, relayKp, 'notes', { label: 'Notes' });
  t.mock.method(globalThis, 'fetch', mockFetch({ relayPub }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    await waitFor(() => container.querySelector('.qu-shell-nav a') !== null);
    assert.match(container.querySelector('.qu-shell-nav a').textContent, /Notes/);
    assert.equal(container.querySelector('.qu-shell-nav a').getAttribute('href'), '#/notes');
  } finally {
    stop();
  }
});

test('navigating to a known route dynamically imports and mounts the target app with the full context', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const clientMainUrl = dataUrlModule(`
    export function mount(container, ctx) {
      container.textContent = 'MOUNTED:' + Object.keys(ctx).sort().join(',');
      return () => { container.textContent = 'STOPPED'; };
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [{ name: 'testapp', clientMainUrl }] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/testapp';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-screen')?.textContent.startsWith('MOUNTED'));

    const text = container.querySelector('.qu-shell-screen').textContent;
    for (const key of ['qu', 'identity', 'services', 'apps', 'segments', 'subscribe', 'syncFetch']) {
      assert.ok(text.includes(key), `expected context key "${key}" in ${text}`);
    }
  } finally {
    stop();
  }
});

test('navigating away from a mounted app calls its own returned stop function', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const clientMainUrl = dataUrlModule(`
    export function mount(container) {
      container.textContent = 'MOUNTED';
      return () => { container.textContent = 'STOPPED'; };
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [{ name: 'testapp', clientMainUrl }] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/testapp';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-screen')?.textContent === 'MOUNTED');

    window.location.hash = '';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-placeholder') !== null);
    // The target app's own stop() ran (set textContent to STOPPED) BEFORE
    // renderRoute() cleared the screen for the new route - if it hadn't run
    // at all, nothing distinguishes this from a leaked mount.
  } finally {
    stop();
  }
});

test('an unknown appId renders a graceful "not found" placeholder, not a crash', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/nonexistent-app';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-placeholder') !== null);
    assert.match(container.querySelector('.qu-shell-placeholder').textContent, /not found/i);
  } finally {
    stop();
  }
});

test('#/~<pub> dispatches to the "profile" catalog entry, with segments passed through unchanged', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const clientMainUrl = dataUrlModule(`
    export function mount(container, ctx) {
      container.textContent = 'PROFILE:' + JSON.stringify(ctx.segments);
      return () => {};
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [{ name: 'profile', clientMainUrl }] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/~someactorpub';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-screen')?.textContent.startsWith('PROFILE'));
    assert.equal(container.querySelector('.qu-shell-screen').textContent, 'PROFILE:["~someactorpub"]');
  } finally {
    stop();
  }
});

test('#/~<pub> falls back to the same "app not found" placeholder when "profile" isn\'t in the catalog', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [] })); // no "profile" entry at all

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/~someactorpub';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-placeholder') !== null);
    assert.match(container.querySelector('.qu-shell-placeholder').textContent, /not found/i);
  } finally {
    stop();
  }
});

test('boot applies this identity\'s own preferredLocale/preferredTheme to the device-local mechanisms', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await new ProfileService(qu, identity).saveProfile({ alias: 'Ada', preferredLocale: 'de', preferredTheme: 'ocean' });
  setLocale(null);
  setStoredTheme(null);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    assert.equal(getStoredLocale(), 'de');
    assert.equal(getStoredTheme(), 'ocean');
  } finally {
    stop();
    setLocale(null);
    setStoredTheme(null);
  }
});

test('boot leaves the device-local mechanisms untouched when no preference was ever set', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  setLocale(null);
  setStoredTheme(null);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    assert.equal(getStoredLocale(), null);
    assert.equal(getStoredTheme(), null);
  } finally {
    stop();
  }
});

test('the returned stop function tears down cleanly - hashchange listener removed, no error thrown', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  assert.doesNotThrow(() => stop());

  // A hashchange after stop() must not throw or try to render into a torn-down screen.
  assert.doesNotThrow(() => {
    window.location.hash = '#/whatever';
    window.dispatchEvent(new window.Event('hashchange'));
  });
});
