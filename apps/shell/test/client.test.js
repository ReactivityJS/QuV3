import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ProfileService, PresenceService } from '@qu/services';
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

/** jsdom's own document.visibilityState is a getter, not directly settable - see client.js's own onVisibilityChange() doc comment for what this drives (the session-wide presence heartbeat, ported here from apps/chat's own former per-room-view version). */
function setDocumentVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new window.Event('visibilitychange'));
}

function mockFetch({ relayPub = 'relay-pub-1', adminPubs = [], apps = [] } = {}) {
  return async (url) => {
    if (url === '/config.json') return { ok: true, json: async () => ({ relayPub, adminPubs }) };
    if (url === '/apps.json') return { ok: true, json: async () => apps };
    return { ok: false, json: async () => ({}) };
  };
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

test('mount() wires the fixed header with real Services and this relay\'s adminPubs (the Relay Admin link shows only for an admin)', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  t.mock.method(globalThis, 'fetch', mockFetch({ adminPubs: [myPub] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    await waitFor(() => container.querySelector('.qu-shell-header') !== null);
    container.querySelector('.qu-shell-user-btn').click();
    await waitFor(() => container.querySelector('a[href="#/relay-admin"]') !== null);
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
    await waitFor(() => container.querySelector('.qu-apptpl-content')?.textContent.startsWith('MOUNTED'));

    const text = container.querySelector('.qu-apptpl-content').textContent;
    for (const key of ['qu', 'identity', 'services', 'apps', 'segments', 'subscribe', 'syncFetch', 'extensionPoints', 'goBack']) {
      assert.ok(text.includes(key), `expected context key "${key}" in ${text}`);
    }
  } finally {
    stop();
  }
});

test('navigating to a route an admin has disabled (enabled: false) shows "app not found" instead of mounting it', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const clientMainUrl = dataUrlModule(`
    export function mount(container) {
      container.textContent = 'MOUNTED';
      return () => {};
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [{ name: 'testapp', clientMainUrl, enabled: false }] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/testapp';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-placeholder') !== null);
    assert.ok(!container.querySelector('.qu-apptpl-content')?.textContent.includes('MOUNTED'));
  } finally {
    stop();
  }
});

test('navigating to a contribute-only app (a clientMain with no mount() export) shows "app not found" instead of throwing', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const clientMainUrl = dataUrlModule(`
    export function renderSomething() {}
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [{ name: 'testapp', clientMainUrl }] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/testapp';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-shell-placeholder') !== null);
  } finally {
    stop();
  }
});

test('ctx.extensionPoints.renderSlot() actually dynamically imports a DIFFERENT catalog app\'s contributed export and mounts its DOM', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());

  const pluginUrl = dataUrlModule(`
    export function renderLike(container, payload) {
      const btn = document.createElement('button');
      btn.textContent = 'like:' + payload.id;
      container.appendChild(btn);
    }
  `);
  const hostUrl = dataUrlModule(`
    export async function mount(container, ctx) {
      await ctx.extensionPoints.renderSlot('content.actions', container, { id: 'msg1' });
      return () => {};
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({
    apps: [
      { name: 'host', clientMainUrl: hostUrl },
      { name: 'likes', clientMainUrl: pluginUrl, contributes: [{ point: 'content.actions', export: 'renderLike' }] },
    ],
  }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/host';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-apptpl-content button') !== null);
    assert.equal(container.querySelector('.qu-apptpl-content button').textContent, 'like:msg1');
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
    await waitFor(() => container.querySelector('.qu-apptpl-content')?.textContent === 'MOUNTED');

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

test('a re-navigation while a prior app\'s own mount() is still in flight stops that stale app the instant it does resolve, instead of leaking it as the tracked mounted app', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());

  let releaseSlowMount;
  window.__slowGate = new Promise((resolve) => { releaseSlowMount = resolve; });
  window.__slowMountStarted = false;
  window.__slowStopped = false;
  window.__fastStopped = false;
  // `mount()` itself signals it actually STARTED (not just that the
  // navigation was dispatched) before awaiting the controllable gate - the
  // second navigation below waits for exactly that, to land deterministically
  // in the race window renderRoute()'s FINAL check (right after `await
  // mod.mount(...)` resolves) exists to close, rather than an earlier one.
  // NOTE: this stale app's own mount() still briefly overwrites the shared
  // `screen` node's content once its gate releases - the navToken guard's
  // real, load-bearing guarantee is that its returned stop() gets called
  // (no leaked watches/subscriptions) and `stopMountedApp` never ends up
  // tracking it, NOT that the DOM can never show a one-frame flash of its
  // content - closing that fully would need each mount() to render into an
  // offscreen node first, a bigger change than this fix's scope.
  const slowUrl = dataUrlModule(`
    export async function mount(container) {
      window.__slowMountStarted = true;
      await window.__slowGate;
      container.textContent = 'SLOW MOUNTED';
      return () => { window.__slowStopped = true; };
    }
  `);
  const fastUrl = dataUrlModule(`
    export function mount(container) {
      container.textContent = 'FAST MOUNTED';
      return () => { window.__fastStopped = true; };
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [
    { name: 'slowapp', clientMainUrl: slowUrl },
    { name: 'fastapp', clientMainUrl: fastUrl },
  ] }));

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/slowapp';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => window.__slowMountStarted === true);

    // Re-navigate while slowapp's own mount() call is still pending on its
    // gate - the exact race renderRoute()'s navToken guard exists to close.
    window.location.hash = '#/fastapp';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-apptpl-content')?.textContent === 'FAST MOUNTED');

    // Now let the stale slowapp's mount() finally resolve - its own stop()
    // must be called immediately (no leaked watches/subscriptions), instead
    // of being left running forever or overwriting `stopMountedApp`.
    releaseSlowMount();
    await waitFor(() => window.__slowStopped === true);

    // `stopMountedApp` must still correctly be fastapp's own stop function,
    // not corrupted/overwritten by the stale slowapp resolving after it -
    // navigating away now must call fastapp's stop exactly once.
    window.location.hash = '';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => window.__fastStopped === true);
  } finally {
    stop();
    delete window.__slowGate;
    delete window.__slowMountStarted;
    delete window.__slowStopped;
    delete window.__fastStopped;
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

// ===== ctx.goBack() - real history when there is one, a fallback otherwise =====

test('ctx.goBack() uses real browser history.back() once there IS a prior in-app route (the normal case: navigating from A to B)', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const clientMainUrl = dataUrlModule(`
    export function mount(container, ctx) {
      window.__testGoBack = ctx.goBack;
      container.textContent = 'MOUNTED';
      return () => {};
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [{ name: 'testapp', clientMainUrl }] }));
  const historyBackCalls = t.mock.method(window.history, 'back', () => {});

  const container = makeContainer();
  // The boot-time renderRoute() (routeCount=1, whatever hash was set before
  // mount() - the home placeholder here) is itself the "prior route" this
  // test needs; THIS navigation to #/testapp is the second one.
  const stop = await mount(container, { qu, identity });
  try {
    window.location.hash = '#/testapp';
    window.dispatchEvent(new window.Event('hashchange'));
    await waitFor(() => container.querySelector('.qu-apptpl-content')?.textContent === 'MOUNTED');

    const hashBefore = window.location.hash;
    window.__testGoBack('#/fallback-should-not-be-used');
    assert.equal(historyBackCalls.mock.callCount(), 1);
    assert.equal(window.location.hash, hashBefore); // goBack() itself never touches the hash directly when using real history
  } finally {
    delete window.__testGoBack;
    stop();
  }
});

test('ctx.goBack() falls back to the given hash (no history.back()) when THIS is the very first route this session ever rendered - e.g. a fresh tab opened directly at an OS push notification\'s Accept link', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const clientMainUrl = dataUrlModule(`
    export function mount(container, ctx) {
      window.__testGoBack = ctx.goBack;
      container.textContent = 'MOUNTED';
      return () => {};
    }
  `);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [{ name: 'testapp', clientMainUrl }] }));
  const historyBackCalls = t.mock.method(window.history, 'back', () => {});

  // Set the hash BEFORE mount() - the app mounts as part of the very first
  // (boot-time) renderRoute() call, with nothing rendered before it this
  // session (simulates a brand new window/tab whose history starts here).
  window.location.hash = '#/testapp';
  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    await waitFor(() => container.querySelector('.qu-apptpl-content')?.textContent === 'MOUNTED');

    window.__testGoBack('#/fallback-route');
    assert.equal(historyBackCalls.mock.callCount(), 0);
    assert.equal(window.location.hash, '#/fallback-route');
  } finally {
    delete window.__testGoBack;
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
    await waitFor(() => container.querySelector('.qu-apptpl-content')?.textContent.startsWith('PROFILE'));
    assert.equal(container.querySelector('.qu-apptpl-content').textContent, 'PROFILE:["~someactorpub"]');
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

test('PUSH ONLY WHILE VISIBLE: backgrounding the tab immediately publishes "offline" (closes the gap PresenceTracker.isRecentlyOnline() otherwise leaves for a merely-backgrounded, not closed, session - see client.js\'s own onVisibilityChange() doc comment); returning to the foreground resumes "online" - ported from apps/chat\'s own former per-room-view test now that the heartbeat is session-wide', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [] }));
  const presence = new PresenceService(qu, identity); // a separate instance reading the SAME store - same "fresh instance, same store" convention presence-service.test.js's own read-receipt test already uses

  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    await waitFor(async () => (await presence.getUserPresence(myPub))?.status === 'online');

    setDocumentVisibility('hidden');
    await waitFor(async () => (await presence.getUserPresence(myPub))?.status === 'offline');

    setDocumentVisibility('visible');
    await waitFor(async () => (await presence.getUserPresence(myPub))?.status === 'online');
  } finally {
    stop();
    setDocumentVisibility('visible');
  }
});

test('PUSH ONLY WHILE VISIBLE: booting while the tab is ALREADY hidden never starts the heartbeat at all - no "online" is ever published', async (t) => {
  const qu = freshQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  t.mock.method(globalThis, 'fetch', mockFetch({ apps: [] }));
  const presence = new PresenceService(qu, identity);

  setDocumentVisibility('hidden');
  const container = makeContainer();
  const stop = await mount(container, { qu, identity });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await presence.getUserPresence(myPub), null);
  } finally {
    stop();
    setDocumentVisibility('visible');
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
