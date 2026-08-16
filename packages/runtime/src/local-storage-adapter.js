import { WebStorageAdapter } from './web-storage-adapter.js';

/**
 * LOCAL STORAGE ADAPTER — device-scoped, in-browser persistence via
 * `localStorage`: survives a reload AND a browser restart, scoped to this
 * origin/device (not synced across tabs the way a `BroadcastChannel` would
 * be, but every tab reads/writes the SAME underlying storage). One of the
 * pluggable `localAdapter` choices `@qu/webrtc`'s `WebRTCAdapter` accepts
 * for its state side (see that package's own doc comment / the plan's "Ein
 * Mount, zwei Zugriffsformen, ein pluggable Backend" section) - a lighter
 * weight alternative to `IndexedDBAdapter` for small amounts of data where
 * `IndexedDBAdapter`'s async, transactional machinery is more than needed.
 *
 * Only exported from `@qu/runtime/local-storage`, never from a package-root
 * `.` import - see `fs-adapter.js`'s doc comment for why this package has
 * no shared entry point. Assumes a global `localStorage` (a real browser, or
 * a test polyfill - see `test/web-storage-polyfill.js`) and must never be
 * imported anywhere that isn't one of those.
 */
export class LocalStorageAdapter extends WebStorageAdapter {
  /** @param {string} [namespace='qu-store'] */
  constructor(namespace = 'qu-store') {
    super(localStorage, namespace);
  }
}
