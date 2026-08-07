/**
 * SYNC FRESHNESS — the one place every Service's "local data might be
 * stale" gap gets closed, for every app built on top of these Services.
 *
 * THE PROBLEM: a `subscribe()` call only ever delivers writes made AFTER a
 * live connection exists - it has no concept of "catch me up on what I
 * missed" on its own (that's `@qu/sync`'s reconnect-catch-up job, a
 * separate mechanism - see docs/v3-technical-concept.md §3.2). Every
 * Service's own `syncFetch` backfill only fires when local data is
 * COMPLETELY ABSENT - which correctly handles "I've never seen this
 * before" (e.g. a shared link opened for the first time), but NOT "I've
 * seen this before, but was offline/closed while a peer changed it" - a
 * returning session with SOME locally cached data for a path never
 * re-checks it, no matter how stale it's become, because the `!local` gate
 * is never true again. That's the concrete bug behind "a chat message from
 * while I was offline never shows up even after reconnecting" - the room's
 * messages parent path already has SOME locally cached messages (from
 * before), so the backfill-on-miss code never runs again for it.
 *
 * THE FIX: refresh once per "generation" instead of once ever. A
 * generation (a monotonic counter bumped every time the connection to a
 * relay is (re-)established - see the future `@qu/sync`'s `SyncEngine.
 * getGeneration()`) marks the exact moments staleness can actually have
 * accumulated, no more. `backgroundRefresh(path)` is fire-and-forget
 * (never awaited by the caller, never blocks a read) - any correction it
 * turns up arrives through the SAME reactive pipeline a live sync write
 * already uses (`qu.onStorageChange` -> `watch()`), so every app already
 * watching the path it just read gets the correction for free, without
 * this layer knowing anything about UI. Errors (offline, timeout) are
 * swallowed - a failed background refresh must never surface as a
 * caller-visible failure; the local value already returned/rendered is
 * still the best available answer until (if ever) the refresh lands.
 */

/**
 * @param {(path: string) => Promise<object|null>} [syncFetch]
 * @param {() => number} [getGeneration]
 * @returns {(path: string) => void} `backgroundRefresh` - call after
 *   returning a value read from LOCAL storage (never before a blocking
 *   syncFetch-on-miss, which already IS a full refresh). A no-op if either
 *   dependency is missing (e.g. a server-side/relay QuStore with no single
 *   upstream peer - same fallback every caller already needs).
 */
export function createFreshnessTracker(syncFetch, getGeneration) {
  const refreshedAt = new Map(); // path -> generation it was last background-refreshed in

  return function backgroundRefresh(path) {
    if (!syncFetch || !getGeneration) return;
    const currentGeneration = getGeneration();
    if (refreshedAt.get(path) === currentGeneration) return; // already refreshed since the last (re)connect - nothing new to check yet
    refreshedAt.set(path, currentGeneration);
    syncFetch(path).catch(() => {});
  };
}

/**
 * Sibling to `createFreshnessTracker()` above, for the OTHER half of every
 * Service's existing "local miss -> blocking syncFetch-once" backfill: that
 * blocking fetch is correct to attempt on a genuine first look (a shared
 * link/thread opened for the first time - CONFIRMING "nothing there" is
 * itself useful information), but with no gating at all it re-runs a full
 * network round-trip on EVERY single call for as long as the path stays
 * locally empty - which, for something like an unreacted-to chat message,
 * is forever, every reload. `alreadyAttemptedMiss(path)` gives callers a
 * way to ask ONCE per generation and skip the repeat round-trips for the
 * rest of it, while still re-checking after every reconnect - the same
 * "local first, remote delta merged after" shape `backgroundRefresh`
 * already gives the "data exists but might be stale" case, applied to the
 * "confirmed absent so far" case instead.
 * @param {() => number} [getGeneration]
 * @returns {(path: string) => boolean} True if this exact path was already
 *   checked (successfully or not) since the last (re)connect - the caller
 *   should skip the blocking fetch and trust the current local (empty)
 *   read. Marks the path as attempted as a side effect, so call this right
 *   before deciding whether to fetch, not speculatively. Always false
 *   (never skips) when there's no generation concept at all - matches the
 *   unconditional-attempt behavior every caller would otherwise have.
 */
export function createMissGate(getGeneration) {
  const attemptedAt = new Map(); // path -> generation last attempted (and still missing) in

  return function alreadyAttemptedMiss(path) {
    if (!getGeneration) return false;
    const currentGeneration = getGeneration();
    if (attemptedAt.get(path) === currentGeneration) return true;
    attemptedAt.set(path, currentGeneration);
    return false;
  };
}
