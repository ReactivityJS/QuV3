/**
 * WAKE LOCK — the shared "keep the screen on while this view is active"
 * trick (the Screen Wake Lock API), first needed by `apps/geochase` (a
 * chase is worthless if the phone locks mid-run and geolocation/the map
 * stop updating), written here in `@qu/ui` rather than inline in that app
 * so any other app that needs the same thing (e.g. `apps/phone` during an
 * active call) can reuse it unchanged - the whole point of it being
 * "central", not a one-off.
 *
 * A wake lock sentinel is AUTOMATICALLY RELEASED by the browser whenever
 * the tab/PWA goes into the background (`document.visibilityState !==
 * 'visible'`) - there is no way to prevent that, by design (a hidden tab
 * has no business keeping the screen on). This module's own job is
 * RE-ACQUIRING it the moment the tab becomes visible again, so a user who
 * briefly checks a notification and comes back doesn't have to manually
 * re-trigger anything - `mountWakeLock()` wires a `visibilitychange`
 * listener for exactly that.
 *
 * Silently a no-op wherever unsupported (no `navigator.wakeLock`, an
 * insecure/non-HTTPS context, or the browser simply refuses the request) -
 * never throws, this is a battery-life nicety, not a feature the rest of
 * an app should ever depend on being active.
 */

/**
 * @param {{wakeLock?: {request: (type: 'screen') => Promise<{release: () => Promise<void>, addEventListener: (event: string, cb: () => void) => void}>}}} [options] -
 *   `wakeLock` defaults to `navigator.wakeLock` - injectable for tests (and
 *   for any environment that only ever has a fake/polyfilled one).
 * @returns {() => void} Release function - call on unmount. Idempotent.
 */
export function mountWakeLock({ wakeLock = (typeof navigator !== 'undefined' ? navigator.wakeLock : undefined) } = {}) {
  let sentinel = null;
  let released = false;

  async function acquire() {
    if (released || sentinel || !wakeLock || document.visibilityState !== 'visible') return;
    try {
      const newSentinel = await wakeLock.request('screen');
      if (released) {
        // release() was called while the request was still in flight -
        // don't leave a sentinel dangling that nothing will ever release.
        newSentinel.release().catch(() => {});
        return;
      }
      sentinel = newSentinel;
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      // Unsupported, permission denied, or the page lost visibility again
      // between the check above and the request resolving - see this
      // file's own top doc comment on why this stays silent either way;
      // the next visibilitychange (if any) simply tries again.
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') acquire();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  acquire();

  return function release() {
    if (released) return;
    released = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    sentinel?.release().catch(() => {});
    sentinel = null;
  };
}
