import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
// @qu/ui's package root transitively evaluates components.js, which extends
// HTMLElement at module-load time - must come AFTER installDom(), same
// reason every other app's test in this repo dynamically imports its own
// client.js/src modules instead of a static top-level import.
const { registerServiceWorker, applyUpdate, captureInstallPrompt } = await import('../src/pwa.js');

/**
 * Node 22's own built-in `navigator` global (added for fetch/URL spec
 * parity - see `apps/shell/src/onboarding.js`'s own `navigator.clipboard`
 * use, the established precedent for referencing bare `navigator` in this
 * codebase) has no `serviceWorker` property of its own - tests attach a
 * fake directly onto it, and remove it again afterward so one test's fake
 * container never leaks into the next.
 */
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
    this.controller = null;
    this._registration = registration;
  }
  register() { return Promise.resolve(this._registration); }
}

function installFakeServiceWorker(registration) {
  const container = new FakeServiceWorkerContainer(registration);
  navigator.serviceWorker = container;
  return container;
}

test.afterEach(() => {
  delete navigator.serviceWorker;
});

test('registerServiceWorker() does nothing when the browser has no navigator.serviceWorker', () => {
  assert.doesNotThrow(() => registerServiceWorker({ onUpdateAvailable: () => assert.fail('should never fire') }));
});

test('the very first install (no existing controller) never fires onUpdateAvailable', async () => {
  const registration = new FakeRegistration();
  installFakeServiceWorker(registration);
  let fired = false;
  registerServiceWorker({ onUpdateAvailable: () => { fired = true; } });
  await new Promise((r) => setTimeout(r, 10));

  registration.installing = new FakeWorker();
  registration.dispatchEvent(new Event('updatefound'));
  registration.installing.state = 'installed';
  registration.installing.dispatchEvent(new Event('statechange'));

  assert.equal(fired, false);
});

test('a genuine update (a controller already exists) fires onUpdateAvailable with the registration', async () => {
  const registration = new FakeRegistration();
  const container = installFakeServiceWorker(registration);
  container.controller = {}; // this page is already controlled - NOT a first install
  let received = null;
  registerServiceWorker({ onUpdateAvailable: (reg) => { received = reg; } });
  await new Promise((r) => setTimeout(r, 10));

  registration.installing = new FakeWorker();
  registration.dispatchEvent(new Event('updatefound'));
  registration.installing.state = 'installed';
  registration.installing.dispatchEvent(new Event('statechange'));

  assert.equal(received, registration);
});

test('a worker already sitting in .waiting from an earlier load is surfaced immediately, no updatefound needed', async () => {
  const registration = new FakeRegistration();
  const container = installFakeServiceWorker(registration);
  container.controller = {};
  registration.waiting = new FakeWorker();
  let received = null;
  registerServiceWorker({ onUpdateAvailable: (reg) => { received = reg; } });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(received, registration);
});

test('applyUpdate() posts SKIP_WAITING to the waiting worker, and tolerates no registration at all', () => {
  const registration = new FakeRegistration();
  registration.waiting = new FakeWorker();
  applyUpdate(registration);
  assert.deepEqual(registration.waiting.posted, [{ type: 'SKIP_WAITING' }]);

  assert.doesNotThrow(() => applyUpdate(null));
  assert.doesNotThrow(() => applyUpdate(registration)); // no .waiting this time - already applied
});

test('controllerchange reloads the page exactly once, even if it fires twice - for a GENUINE update (a controller already existed at boot)', async () => {
  const registration = new FakeRegistration();
  const container = installFakeServiceWorker(registration);
  container.controller = {}; // this page was already controlled - a real update handoff, not a first claim
  // jsdom's real Location.reload is entirely locked down (neither
  // reassignable nor redefinable, so neither a plain assignment nor
  // node:test's Object.defineProperty-based t.mock.method can touch it) -
  // swap the bare `window` global pwa.js resolves at CALL time for a
  // minimal stub instead, restored right after.
  const realWindow = globalThis.window;
  let calls = 0;
  globalThis.window = { location: { reload: () => { calls += 1; } } };
  try {
    registerServiceWorker({});
    await new Promise((r) => setTimeout(r, 10));

    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));

    assert.equal(calls, 1);
  } finally {
    globalThis.window = realWindow;
  }
});

test('controllerchange from the very FIRST ever service worker claim (no controller at boot) never reloads', async () => {
  // Regression test: `Clients.claim()` (sw.js's own `activate` handler)
  // fires `controllerchange` even the very first time a page goes from
  // "no controller" to "controlled" - confirmed live, this used to trigger
  // an unconditional, surprise `location.reload()` moments after every
  // fresh onboarding, with no code update having actually happened. If
  // that landed while the page was ALREADY reloading for an unrelated
  // reason (e.g. apps/profile's own theme "Reload now"), the boot sequence
  // could restart before it ever finished, surfacing as a page that
  // appears to hang.
  const registration = new FakeRegistration();
  const container = installFakeServiceWorker(registration);
  // container.controller stays null - no controller at boot, a first claim.
  const realWindow = globalThis.window;
  let calls = 0;
  globalThis.window = { location: { reload: () => { calls += 1; } } };
  try {
    registerServiceWorker({});
    await new Promise((r) => setTimeout(r, 10));

    container.dispatchEvent(new Event('controllerchange'));

    assert.equal(calls, 0);
  } finally {
    globalThis.window = realWindow;
  }
});

test('captureInstallPrompt() captures beforeinstallprompt, installApp() shows it and resolves the outcome', async () => {
  let notified = false;
  const { installApp } = captureInstallPrompt({ onInstallable: () => { notified = true; } });

  const event = new window.Event('beforeinstallprompt', { cancelable: true });
  let prompted = false;
  event.prompt = () => { prompted = true; };
  event.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(event);

  assert.equal(notified, true);
  const accepted = await installApp();
  assert.equal(prompted, true);
  assert.equal(accepted, true);
});

test('installApp() resolves to false when no prompt was ever captured', async () => {
  const { installApp } = captureInstallPrompt({});
  assert.equal(await installApp(), false);
});

test('installApp() is one-shot - a second call after the prompt was already used resolves to false', async () => {
  const { installApp } = captureInstallPrompt({});
  const event = new window.Event('beforeinstallprompt', { cancelable: true });
  event.prompt = () => {};
  event.userChoice = Promise.resolve({ outcome: 'dismissed' });
  window.dispatchEvent(event);

  await installApp();
  assert.equal(await installApp(), false);
});
