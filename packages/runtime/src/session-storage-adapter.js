import { WebStorageAdapter } from './web-storage-adapter.js';

/**
 * SESSION STORAGE ADAPTER — tab-scoped, in-browser persistence via
 * `sessionStorage`: survives a reload of the SAME tab, but not a new tab or
 * the browser closing. The middle ground between `MemoryStoreAdapter`
 * (`@qu/core`, dies on refresh) and `LocalStorageAdapter`/`IndexedDBAdapter`
 * (this package, survive across tabs/restarts) - one of the pluggable
 * `localAdapter` choices `@qu/webrtc`'s `WebRTCAdapter` accepts for its
 * state side (see that package's own doc comment / the plan's "Ein Mount,
 * zwei Zugriffsformen, ein pluggable Backend" section), for data that
 * should outlive an accidental reload but has no reason to outlive the tab
 * (e.g. an in-progress P2P file transfer's already-received chunks).
 *
 * Only exported from `@qu/runtime/session-storage`, never from a
 * package-root `.` import - see `fs-adapter.js`'s doc comment for why this
 * package has no shared entry point. Assumes a global `sessionStorage` (a
 * real browser, or a test polyfill - see `test/web-storage-polyfill.js`) and
 * must never be imported anywhere that isn't one of those.
 */
export class SessionStorageAdapter extends WebStorageAdapter {
  /** @param {string} [namespace='qu-store'] */
  constructor(namespace = 'qu-store') {
    super(sessionStorage, namespace);
  }
}
