import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { mountWakeLock } = await import('../src/wake-lock.js');

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

/** A fake Screen Wake Lock API - request() resolves to a sentinel whose own release() is tracked, and whose 'release' listener this fake fires when release() is called (matching the real API: the browser also fires it on an OS-triggered auto-release, but this fake only needs the explicit-call path any test here exercises). */
function fakeWakeLock({ rejects = false } = {}) {
  const requests = [];
  const sentinels = [];
  const api = {
    request: async (type) => {
      requests.push(type);
      if (rejects) throw new Error('not allowed');
      const listeners = [];
      const sentinel = {
        released: false,
        release: async () => {
          sentinel.released = true;
          listeners.forEach((cb) => cb());
        },
        addEventListener: (event, cb) => { if (event === 'release') listeners.push(cb); },
      };
      sentinels.push(sentinel);
      return sentinel;
    },
  };
  api.requests = requests;
  api.sentinels = sentinels;
  return api;
}

test('mountWakeLock() requests a screen wake lock immediately when the page is visible', async () => {
  setVisibility('visible');
  const wakeLock = fakeWakeLock();
  const release = mountWakeLock({ wakeLock });
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(wakeLock.requests, ['screen']);
  release();
});

test('mountWakeLock() does NOT request a lock while the page starts hidden', async () => {
  setVisibility('hidden');
  const wakeLock = fakeWakeLock();
  const release = mountWakeLock({ wakeLock });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(wakeLock.requests.length, 0);
  release();
});

test('mountWakeLock() re-acquires on visibilitychange once the page becomes visible again', async () => {
  setVisibility('hidden');
  const wakeLock = fakeWakeLock();
  const release = mountWakeLock({ wakeLock });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wakeLock.requests.length, 0);

  setVisibility('visible');
  document.dispatchEvent(new window.Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(wakeLock.requests, ['screen']);
  release();
});

test('mountWakeLock(): the browser auto-releasing the sentinel (tab hidden) means a later visibilitychange re-requests, not a no-op', async () => {
  setVisibility('visible');
  const wakeLock = fakeWakeLock();
  const release = mountWakeLock({ wakeLock });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wakeLock.requests.length, 1);

  // Simulate the OS/browser auto-releasing the sentinel when the tab went
  // hidden (this module has no control over that - see its own doc comment).
  await wakeLock.sentinels[0].release();

  setVisibility('visible');
  document.dispatchEvent(new window.Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(wakeLock.requests.length, 2); // acquired again, not stuck thinking it still holds the old (now-released) sentinel
  release();
});

test('mountWakeLock(): an unsupported/missing navigator.wakeLock is a silent no-op, never throws', async () => {
  setVisibility('visible');
  assert.doesNotThrow(() => mountWakeLock({ wakeLock: undefined })());
});

test('mountWakeLock(): a rejected request() (permission denied) is swallowed silently', async () => {
  setVisibility('visible');
  const wakeLock = fakeWakeLock({ rejects: true });
  assert.doesNotThrow(() => {
    const release = mountWakeLock({ wakeLock });
    release();
  });
});

test('release() releases the held sentinel and stops listening for visibilitychange', async () => {
  setVisibility('visible');
  const wakeLock = fakeWakeLock();
  const release = mountWakeLock({ wakeLock });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wakeLock.sentinels[0].released, false);

  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wakeLock.sentinels[0].released, true);

  // A visibilitychange firing after release() must NOT re-acquire - this mount is done.
  document.dispatchEvent(new window.Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wakeLock.requests.length, 1); // still just the original acquire, nothing after release()
});

test('release() is idempotent - calling it twice does not throw or double-release', async () => {
  setVisibility('visible');
  const wakeLock = fakeWakeLock();
  const release = mountWakeLock({ wakeLock });
  await new Promise((r) => setTimeout(r, 0));

  release();
  assert.doesNotThrow(() => release());
});
