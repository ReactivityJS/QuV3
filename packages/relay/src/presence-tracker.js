/**
 * PRESENCE TRACKER — "is this actor still visibly connected" for push
 * suppression (see `push-delivery.js`'s use of this). Deliberately a plain
 * time window, not a live "is this exact peerId's socket still open" check
 * - the transport already tears the connection down promptly on a real
 * disconnect, so a stale entry ages out on its own within this window
 * either way, and tracking peerId liveness on top would be meaningfully
 * more bookkeeping for a case this window already covers.
 *
 * Populated passively by `SyncEngine`'s `onPeerIdentified` callback (see
 * `relay.js`'s composition), not written to directly anywhere else - "an
 * actor was just seen" falls out of whatever traffic they already generate
 * (a posted message, a thread-presence heartbeat, ...), never a dedicated
 * "I'm online" signal.
 */
export class PresenceTracker {
  /** @type {Map<string, number>} actorPub -> lastSeenAt(ms), insertion-ordered for the eviction loop below */
  #lastSeenByActor = new Map();

  /**
   * @param {{freshMs?: number, maxEntries?: number}} [options]
   *   `freshMs` (default 60s): an actor last seen within this window is
   *   treated as "still online enough that a web push would be redundant" -
   *   they'll see the in-app notification (never suppressed) the moment
   *   they're back.
   *   `maxEntries` (default 2000): bounded the same way `@qu/identity`'s own
   *   key/attestation caches are - a long-running relay must not grow this
   *   map forever as distinct actors pass through over its lifetime.
   */
  constructor({ freshMs = 60_000, maxEntries = 2000 } = {}) {
    this.freshMs = freshMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Records that `actorPub` was just seen.
   * @param {string} actorPub
   */
  recordSeen(actorPub) {
    this.#lastSeenByActor.delete(actorPub); // re-insert to move it to the end - relied on by the eviction loop below, which needs Map's insertion order
    this.#lastSeenByActor.set(actorPub, Date.now());
    while (this.#lastSeenByActor.size > this.maxEntries) {
      this.#lastSeenByActor.delete(this.#lastSeenByActor.keys().next().value);
    }
  }

  /** @param {string} actorPub @returns {boolean} */
  isRecentlyOnline(actorPub) {
    const lastSeenAt = this.#lastSeenByActor.get(actorPub);
    return typeof lastSeenAt === 'number' && Date.now() - lastSeenAt < this.freshMs;
  }
}
