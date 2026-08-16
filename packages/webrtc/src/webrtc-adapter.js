import { QuEvents } from '@qu/core/events';

/**
 * WEBRTC ADAPTER — one `QuAdapter`, two zugriffsformen on the same mount
 * (see the plan's "Ein Mount, zwei Zugriffsformen, ein pluggable Backend"
 * section). Possible because `QuStore.on()`/`.emit()` resolve a path through
 * `QuMount.resolve()` exactly like `put()`/`get()` do (`store.js:429-439`) -
 * a mount was never actually tied to one idiom, this is just the first
 * adapter in this codebase to use both.
 *
 *   - STATE side (`put`/`get`/`getAll`/`getChildren`): pure delegation to an
 *     injected `localAdapter` - any `QuAdapter`-conformant local backend
 *     (`MemoryStoreAdapter` by default; a `SessionStorageAdapter`/
 *     `LocalStorageAdapter`/`IndexedDBAdapter` if the caller wants a write
 *     here to survive a reload). This adapter has NO ts-guard or replication
 *     logic of its own - `localAdapter.put()` supplies the ts-guard (e.g.
 *     `MemoryStoreAdapter`'s own), and a `SyncEngine` sitting on the SAME
 *     `QuStore` (listening to `onStorageChange()`) is what actually
 *     replicates a write to connected peers over `webrtcTransport` - this
 *     class doesn't need to know that's happening.
 *   - EVENT side (`on`/`emit`): a separate, purely in-memory `QuEvents` bus,
 *     independent of `localAdapter` - mirrors `@qu/core`'s `VolatileAdapter`
 *     exactly (nothing retained, "whoever's listening right now gets it"),
 *     except `emit()` ALSO puts the payload on the wire via
 *     `webrtcTransport`, and incoming wire messages get fed back into the
 *     same local bus. For signals that never need to be looked up later
 *     (call ringing/answered/hung-up, a file-transfer chunk announcement).
 *
 * KNOWN, HARMLESS CONSEQUENCE of sharing one `webrtcTransport` between this
 * adapter's event side and a mesh `SyncEngine`'s state replication (both
 * register their own `onMessage()` on the SAME transport, see `@qu/webrtc`'s
 * own doc comment on why one Transport can back more than one consumer): a
 * `SyncEngine` sitting on the same transport logs `"unknown message type
 * 'rtc-event'"` for every event this adapter sends/receives, and vice versa
 * this adapter silently ignores every `'sync'`/`'subscribe'`/... message
 * `SyncEngine` sends. Neither side's own protocol is affected - each simply
 * ignores what it doesn't recognize - but expect that log line if both are
 * wired to the same transport (see `apps/geochase/src/mesh.js` for exactly
 * this pairing).
 */
export class WebRTCAdapter {
  #localAdapter;
  #transport;
  #bus = new QuEvents();

  /**
   * @param {{localAdapter: object, webrtcTransport: import('./webrtc-transport.js').WebRTCTransport}} options
   */
  constructor({ localAdapter, webrtcTransport }) {
    this.#localAdapter = localAdapter;
    this.#transport = webrtcTransport;
    this.#transport.onMessage(({ data, peerId }) => {
      if (!data || data.type !== 'rtc-event' || typeof data.path !== 'string') return;
      this.#bus.emit(data.path, { ...data.payload, fromPeerId: peerId });
    });
  }

  // ===== state side - delegates to localAdapter ==========================

  /** @param {string} rel @param {object} quBit @returns {Promise<object>} */
  async put(rel, quBit) {
    return this.#localAdapter.put(rel, quBit);
  }

  /** @param {string} rel @returns {Promise<object|null>} */
  async get(rel) {
    return this.#localAdapter.get(rel);
  }

  /** @param {string} relPrefix @returns {Promise<Array<{rel: string, quBit: object}>>} */
  async getAll(relPrefix) {
    return this.#localAdapter.getAll(relPrefix);
  }

  /**
   * @param {string} parentRel
   * @param {{sort?: 'ts', order?: 'asc'|'desc', limit?: number, cursor?: string}} [options]
   * @returns {Promise<Array<{rel: string, quBit: object, cursor: string}>>}
   */
  async getChildren(parentRel, options) {
    return this.#localAdapter.getChildren(parentRel, options);
  }

  // ===== event side - pass-through, network-backed VolatileAdapter =======

  /**
   * @param {string} path @param {Function} handler @param {{order?: number}} [options]
   * @returns {() => void} Unsubscribe function.
   */
  on(path, handler, options) {
    return this.#bus.on(path, handler, options);
  }

  /**
   * Addressing convention: `/peer/<pub>/...` goes to exactly that peer
   * (`webrtcTransport.sendTo`), anything else broadcasts to every currently
   * connected peer (`webrtcTransport.send`). Also fires locally (same
   * `VolatileAdapter` convention: the emitter is free to also listen to its
   * own event, e.g. to drive its own "calling..." UI state).
   * @param {string} rel @param {*} payload
   * @returns {Promise<void>}
   */
  async emit(rel, payload) {
    const message = { type: 'rtc-event', path: rel, payload };
    const peerMatch = rel.match(/^\/peer\/([^/]+)(\/.*)?$/);
    if (peerMatch) {
      this.#transport.sendTo(peerMatch[1], message);
    } else {
      this.#transport.send(message);
    }
    await this.#bus.emit(rel, payload);
  }
}
