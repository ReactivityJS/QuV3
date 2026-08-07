import { unwrapAll } from './unwrap.js';
import { createFreshnessTracker, createMissGate } from './sync-freshness.js';

const MAX_MUTATE_RETRIES = 5;

/**
 * LIST SERVICE — the ONE list primitive, replacing QuV2's two independent,
 * differently-safe implementations of "a list of things" (its
 * `CollectionService` and `StarredService`) with two storage STRATEGIES
 * chosen by shape, not by caller. See docs/v3-technical-concept.md §4.2 for
 * the full rationale - short version: QuV2 had the same read-modify-write
 * pattern implemented twice, and one of the two copies had NO race
 * mitigation at all despite backing real user data (Favorites/Contacts).
 * Collapsing to one, hardened-once implementation is the point, not an
 * incidental cleanup.
 *
 * ## DERIVED lists — `listDerived()`
 *
 * For anything where every item ALREADY lives at its own path under one
 * shared parent (a thread's messages, an entity's public flags/reactions, a
 * thread's pins-as-per-message-markers). There is no index document at
 * all - `listDerived()` is exactly `QuStore.getChildren()` (one level deep,
 * `(ts,rel)`-ordered, cursor-paginated - see docs/v3-technical-concept.md
 * §1.2), and adding an item is just the OWNING Service's own `qu.put()` to
 * the item's own path - nothing to call here for that half. No
 * read-modify-write, no lock, no retry, because there is nothing shared to
 * race on: two actors adding two different items write two different
 * paths, full stop.
 *
 * ## CURATED lists — `listCurated()`/`addCurated()`/`removeCurated()`
 *
 * For a hand-picked, user-ordered selection of items that do NOT already
 * share one path prefix (Favorites references arbitrary app ids; Contacts
 * references arbitrary actor pubs) - an explicit `{$list: [path, ...]}`
 * index document, resolved to full QuBits on read via `@qu/engines`'
 * `CollectionEngine`. `addCurated()`/`removeCurated()` are
 * read-modify-write: read the current list, compute the new one, overwrite
 * unconditionally. Two calls for the SAME list that overlap - from the
 * same process (e.g. two rapid UI actions) or, worse, from two DIFFERENT
 * peers writing near-simultaneously - can each read the list BEFORE the
 * other's write lands, both compute a "new" list missing the other's
 * change, and whichever writes last simply overwrites the first's
 * addition/removal out of existence. Found by a real adversarial
 * multi-peer test (10 concurrent same-process `addCurated()` calls left
 * only 1 of 10 items; two peers concurrently adding different items each
 * ended up with only their own - see this file's own test suite for the
 * regression coverage). Mitigated two ways below, neither requiring a
 * server-side transaction (`QuStore` has none):
 *   - `#locks` serializes calls for the SAME list from THIS process -
 *     fully eliminates the same-process case, and reduces (but cannot
 *     eliminate) cross-peer contention.
 *   - `#mutateOnce()` re-reads after writing and retries (recomputing from
 *     the fresh state) if this call's OWN intended change didn't survive -
 *     converges correctly even when a genuinely concurrent peer's write
 *     raced and won, since each retry starts from the latest known state
 *     rather than the stale one that caused the conflict.
 */
export class ListService {
  #locks = new Map(); // listPath -> tail of the promise chain serializing addCurated()/removeCurated() for that list
  #backgroundRefresh;
  #alreadyAttemptedMiss;

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   backfills a CURATED list this session has never seen before (e.g. a
   *   shared link opened for the first time) AND background-refreshes one
   *   that already exists locally but might be stale (this session was
   *   offline while a peer added/removed an item - see sync-freshness.js).
   *   DERIVED lists don't need this - `QuStore.getChildren()`/sync's own
   *   reconnect catch-up (§3.2) already cover that case for them.
   * @param {() => number} [getGeneration] - See sync-freshness.js.
   */
  constructor(qu, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
    this.#alreadyAttemptedMiss = createMissGate(getGeneration);
  }

  // ===== derived lists =======================================================

  /**
   * No default `limit` - omitting it returns EVERY direct child, same as
   * `QuStore.getChildren()` itself. This matters for correctness, not just
   * convenience: a caller enumerating "every actor who flagged this" (see
   * `FlagService.getPublicFlags()`) would silently undercount past whatever
   * default cap this method picked on their behalf. A UI that wants a
   * bounded page (a chat's "last 50 messages") passes `limit` itself - that
   * default belongs to the caller that actually knows it wants pagination,
   * not to this generic primitive.
   * @param {string} parentPath - e.g. `paths.threadMessagesParentPath(spaceId, threadId)`.
   * @param {{limit?: number, order?: 'asc'|'desc', cursor?: string}} [options]
   * @returns {Promise<Array<{path: string, quBit: object, cursor: string}>>}
   *   Raw entries (NOT unwrapped) - see class doc comment for why.
   */
  async listDerived(parentPath, { limit, order = 'desc', cursor = null } = {}) {
    return this.qu.getChildren(parentPath, { sort: 'ts', order, limit, cursor });
  }

  // ===== curated lists ========================================================

  /**
   * @param {string} listPath - e.g. `paths.listPath(spaceId, listId)`.
   * @param {string[]} itemPaths - Qu paths of the items to include.
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  async createCurated(listPath, itemPaths, options = {}) {
    await this.qu.put(listPath, { $list: [...itemPaths] }, options);
  }

  /**
   * @param {string} listPath
   * @returns {Promise<Array<*>|null>} The resolved, unwrapped items, or
   *   `null` if the list doesn't exist ANYWHERE (locally or, once
   *   backfilled, on the network either).
   */
  async listCurated(listPath) {
    const quBit = await this.qu.get(listPath);
    if (quBit) {
      this.#backgroundRefresh(listPath);
      return unwrapAll(quBit.val);
    }
    if (!this.syncFetch || this.#alreadyAttemptedMiss(listPath)) return null;
    await this.syncFetch(listPath).catch(() => {});
    const retried = await this.qu.get(listPath);
    return retried ? unwrapAll(retried.val) : null;
  }

  /**
   * Appends an item path to an existing (or not-yet-existing) curated list.
   * @param {string} listPath @param {string} itemPath @param {object} [options]
   * @returns {Promise<void>}
   */
  async addCurated(listPath, itemPath, options = {}) {
    return this.#mutate(listPath, itemPath, true, options);
  }

  /**
   * Removes an item path from a curated list (a no-op if it wasn't
   * present, or the list doesn't exist yet).
   * @param {string} listPath @param {string} itemPath @param {object} [options]
   * @returns {Promise<void>}
   */
  async removeCurated(listPath, itemPath, options = {}) {
    return this.#mutate(listPath, itemPath, false, options);
  }

  /** Serializes same-process calls for `listPath` - see class doc comment. */
  #mutate(listPath, itemPath, isAdd, options) {
    const previousTail = this.#locks.get(listPath) ?? Promise.resolve();
    const thisRun = previousTail.then(
      () => this.#mutateOnce(listPath, itemPath, isAdd, options),
      () => this.#mutateOnce(listPath, itemPath, isAdd, options)
    );
    this.#locks.set(listPath, thisRun);
    thisRun.finally(() => {
      if (this.#locks.get(listPath) === thisRun) this.#locks.delete(listPath);
    });
    return thisRun;
  }

  async #mutateOnce(listPath, itemPath, isAdd, options, attempt = 0) {
    const current = await this.listCuratedRawPaths(listPath);
    const alreadyDesired = isAdd ? current.includes(itemPath) : !current.includes(itemPath);
    if (alreadyDesired) return;

    const next = isAdd ? [...current, itemPath] : current.filter((p) => p !== itemPath);
    await this.createCurated(listPath, next, options);

    if (attempt >= MAX_MUTATE_RETRIES) return; // give up - a pathologically hot list stays best-effort past this many rounds
    const after = await this.listCuratedRawPaths(listPath);
    const survived = isAdd ? after.includes(itemPath) : !after.includes(itemPath);
    if (!survived) {
      // A concurrent writer's put() (from another peer, or another process
      // entirely) landed after ours and didn't include our change - retry
      // from the FRESH state rather than the stale read that caused the
      // conflict, so this call's own intent still lands.
      return this.#mutateOnce(listPath, itemPath, isAdd, options, attempt + 1);
    }
  }

  /**
   * Reads the RAW (unresolved) list of item paths, bypassing
   * `CollectionEngine`'s read-time `$ref`/`$list` resolution -
   * `addCurated()`/`removeCurated()` need the original paths to rewrite the
   * list, not the resolved values `listCurated()` returns. Also PUBLIC for
   * callers that need to correlate a `listCurated()` result containing
   * `null` gaps (an item whose own document hasn't synced to this device
   * yet) back to the individual path that's missing.
   * @param {string} listPath
   * @returns {Promise<string[]>}
   */
  async listCuratedRawPaths(listPath) {
    const { adapter, rel } = this.qu.resolveMount(listPath);
    let raw = await adapter.get(rel);
    if (raw) {
      this.#backgroundRefresh(listPath);
    } else if (this.syncFetch && !this.#alreadyAttemptedMiss(listPath)) {
      await this.syncFetch(listPath).catch(() => {});
      raw = await adapter.get(rel);
    }
    return raw?.val?.$list ?? [];
  }
}
