import WebSocketImpl from 'ws';
import { Transport, WebSocketClientTransport } from '@qu/sync';
import { createLogger } from '@qu/log';

const log = createLogger('FederationTransport');

/**
 * FEDERATION TRANSPORT — aggregates one OUTBOUND `WebSocketClientTransport`
 * per configured federation peer behind a single `@qu/sync` `Transport`
 * interface, so ONE `SyncEngine` (see `relay.js`'s `federationSync`) can
 * address every dialed peer relay through the same `sendTo(peerId, ...)`/
 * `onMessage()` surface it already uses for a single upstream relay.
 *
 * `WebSocketClientTransport` (see its own doc comment) hard-codes "exactly
 * one remote peer" as its whole model - `sendTo()` there just calls
 * `send()`, because a single-connection client transport only ever HAS one
 * peer. Relay federation needs N simultaneous outbound peers, so this class
 * exists purely to hold N of those, unmodified, behind one facade - not to
 * replace or reimplement anything WebSocketClientTransport already does
 * (queueing, auto-reconnect with backoff+jitter, ...).
 *
 * `peerId` here is CHOSEN BY US (an opaque, locally-generated id per
 * configured peer - see `addPeer()`), not the peer relay's own cryptographic
 * identity (`relayId` - see `FederationManager`, which owns the
 * peerId->relayId mapping). This matches the same "peerId is a
 * connection-level detail, not an identity claim" pattern `SyncEngine`'s own
 * `subscribe()` doc comment already establishes for inbound connections.
 */
export class FederationTransport extends Transport {
  #peers = new Map(); // peerId -> WebSocketClientTransport
  #callbacks = [];
  #peerId = `federation-${Math.random().toString(36).slice(2)}`;

  /**
   * @returns {string} A stable id for this SIDE of every federation link -
   *   never used to address a specific configured peer (see `sendTo()`),
   *   just satisfies `Transport`'s own contract.
   */
  getPeerId() {
    return this.#peerId;
  }

  /**
   * No-op: each per-peer `WebSocketClientTransport` connects independently,
   * driven by `FederationManager.reconcile()`/`addPeer()`, not by a single
   * "connect the whole federation at once" call - there is no single
   * connection this method could establish.
   */
  async connect() {}

  /**
   * @param {string} peerId - Locally chosen, stable for this peer's config
   *   lifetime (see `FederationManager`, which generates and remembers it).
   * @param {string} url
   * @param {{maxReconnectDelayMs?: number}} [options]
   * @returns {WebSocketClientTransport} The underlying transport, so
   *   `FederationManager` can register its own `onReconnect()`/
   *   `onReconnectAttempt()` directly on it - `FederationTransport` itself
   *   deliberately does NOT implement `Transport`'s optional `onReconnect`
   *   member: `SyncEngine`'s own `onReconnect()` wiring (see its
   *   constructor) fires ONE callback with no way to know WHICH of
   *   potentially many peers just reconnected, so blindly resubscribing
   *   EVERY `#mySubscriptions` entry to EVERY peer on ANY one peer's
   *   reconnect would be wrong. `FederationManager` re-subscribes only the
   *   ONE peer that actually reconnected, using this returned instance's own
   *   `onReconnect()` directly.
   */
  addPeer(peerId, url, options = {}) {
    if (this.#peers.has(peerId)) this.removePeer(peerId);
    const transport = new WebSocketClientTransport(url, { WebSocketImpl, ...options });
    transport.onMessage(({ data }) => {
      for (const cb of this.#callbacks) cb({ data, peerId });
    });
    this.#peers.set(peerId, transport);
    log.debug(`added federation peer ${peerId} -> ${url}`);
    return transport;
  }

  /** @param {string} peerId @returns {WebSocketClientTransport|null} */
  getPeer(peerId) {
    return this.#peers.get(peerId) ?? null;
  }

  /** @param {string} peerId */
  removePeer(peerId) {
    this.#peers.get(peerId)?.close();
    this.#peers.delete(peerId);
    log.debug(`removed federation peer ${peerId}`);
  }

  /** @returns {string[]} Every currently CONFIGURED peer (not necessarily connected - see FederationManager's own status tracking for that). */
  peerIds() {
    return [...this.#peers.keys()];
  }

  /** Broadcasts to every configured peer. */
  send(data) {
    for (const transport of this.#peers.values()) transport.send(data);
  }

  /** @param {string} peerId @param {object} data */
  sendTo(peerId, data) {
    this.#peers.get(peerId)?.send(data);
  }

  onMessage(callback) {
    this.#callbacks.push(callback);
  }

  /** Closes every configured peer connection and forgets them - used when the relay itself shuts down. */
  closeAll() {
    for (const transport of this.#peers.values()) transport.close();
    this.#peers.clear();
  }

  /**
   * TELEMETRY - each per-peer entry here is a genuine `WebSocketClientTransport`
   * (see `addPeer()`), which already tracks its OWN byte/rate counters (see
   * that class's `getBytesIn()`/`getCurrentRateIn()` doc comments) - this
   * just sums them across every currently-configured federation peer, so
   * `@qu/relay`'s `traffic-stats.js` has one number for "outbound federation
   * traffic" instead of needing to enumerate peers itself.
   * @returns {{bytesIn: number, bytesOut: number, rateIn: number, rateOut: number}}
   */
  getAggregateStats() {
    const stats = { bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0 };
    for (const transport of this.#peers.values()) {
      stats.bytesIn += transport.getBytesIn();
      stats.bytesOut += transport.getBytesOut();
      stats.rateIn += transport.getCurrentRateIn();
      stats.rateOut += transport.getCurrentRateOut();
    }
    return stats;
  }
}
