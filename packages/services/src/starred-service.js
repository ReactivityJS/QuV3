import { QuCrypto } from '@qu/core';
import { getPrivate, putPrivate } from './private-storage.js';
import { createFreshnessTracker } from './sync-freshness.js';
import { starredPath } from './paths.js';

const MAX_MUTATE_RETRIES = 5;

/**
 * STARRED SERVICE — a generic, per-identity "list of things I've marked",
 * private (self-encrypted, see private-storage.js) and namespaced.
 *
 * This is the one mechanism `FlagService`'s PRIVATE mode builds on for
 * Favorites (starred apps) and Contacts (starred people) - but it is not
 * just an implementation detail of Flags: any Service wanting its own
 * private "my X" list (a future Calendar's "my favorited calendars",
 * Todo's "my pinned items") uses this directly, with its own namespace. It
 * is the same kind of general-purpose, reusable primitive `ListService` is,
 * one layer more specific: "a private list I fully own."
 *
 * NOT built on `ListService`, on purpose: `ListService`'s curated mode
 * stores `{$list: [path, ...]}` REFERENCES to items that live at their own
 * paths elsewhere. A starred item (`{id, starredAt, ...data}`) has no
 * separate QuBit to reference - it only exists as an entry in THIS list.
 * Modeling it as a reference to nothing would be a shape mismatch, not a
 * simplification. What IS reused is the PATTERN: `#mutate()`/`#mutateOnce()`
 * below mirror `ListService.addCurated()`/`removeCurated()`'s lock+retry
 * shape exactly, adapted for an inline array of objects (keyed by `.id`)
 * instead of an array of path strings - the same proven fix for the same
 * class of read-modify-write race, applied to a genuinely different storage
 * shape rather than forced through machinery built for a different one.
 *
 * This closes a real gap found while designing this for V3: QuV2's
 * `StarredService` had NO race mitigation at all (a plain read-modify-write,
 * with its own doc comment accepting the risk as "a low-stakes preference
 * list") despite backing real user data (Favorites, Contacts) that every
 * `FlagService`-based private flag now also depends on.
 */
export class StarredService {
  #locks = new Map(); // namespace -> tail of the promise chain serializing star()/unstar() for THIS identity's copy of that namespace
  #backgroundRefresh;

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   backfills a starred list this session has never seen locally (e.g.
   *   right after a cross-device identity import) AND background-refreshes
   *   one that's already local but might be stale (see sync-freshness.js).
   *   Without this, every app built on this Service silently stays empty
   *   forever on a freshly imported identity, no matter how long it waited.
   * @param {() => number} [getGeneration] - See sync-freshness.js.
   */
  constructor(qu, identityEngine, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /** @param {string} namespace @returns {Promise<Array<object>>} */
  async #readList(namespace) {
    const path = starredPath(await this.#myActorPub(), namespace);
    const local = await this.qu.get(path);
    if (local) {
      this.#backgroundRefresh(path);
    } else if (this.syncFetch) {
      await this.syncFetch(path).catch(() => {});
    }
    return (await getPrivate(this.qu, this.identity, path)) ?? [];
  }

  /**
   * Stars an item (idempotent - starring an already-starred item just
   * returns the unchanged list).
   * @param {string} namespace - e.g. "favorite:app", "favorite:user".
   * @param {string} itemId
   * @param {object} [data] - Extra fields to store alongside the item.
   * @returns {Promise<Array<{id: string, starredAt: number}>>} The updated list.
   */
  async star(namespace, itemId, data = {}) {
    return this.#mutate(namespace, itemId, true, data);
  }

  /**
   * @param {string} namespace @param {string} itemId
   * @returns {Promise<Array<object>>} The updated list.
   */
  async unstar(namespace, itemId) {
    return this.#mutate(namespace, itemId, false, {});
  }

  /** @param {string} namespace @returns {Promise<Array<object>>} */
  async list(namespace) {
    return this.#readList(namespace);
  }

  /** @param {string} namespace @param {string} itemId @returns {Promise<boolean>} */
  async isStarred(namespace, itemId) {
    return (await this.list(namespace)).some((item) => item.id === itemId);
  }

  /** Serializes same-process calls for `namespace` - see class doc comment. */
  #mutate(namespace, itemId, isAdd, data) {
    const previousTail = this.#locks.get(namespace) ?? Promise.resolve();
    const thisRun = previousTail.then(
      () => this.#mutateOnce(namespace, itemId, isAdd, data),
      () => this.#mutateOnce(namespace, itemId, isAdd, data)
    );
    this.#locks.set(namespace, thisRun);
    thisRun.finally(() => {
      if (this.#locks.get(namespace) === thisRun) this.#locks.delete(namespace);
    });
    return thisRun;
  }

  async #mutateOnce(namespace, itemId, isAdd, data, attempt = 0) {
    const current = await this.#readList(namespace);
    const exists = current.some((item) => item.id === itemId);
    if (isAdd ? exists : !exists) return current; // already the desired state

    const updated = isAdd
      ? [...current, { id: itemId, starredAt: Date.now(), ...data }]
      : current.filter((item) => item.id !== itemId);
    const path = starredPath(await this.#myActorPub(), namespace);
    await putPrivate(this.qu, this.identity, path, updated);

    if (attempt >= MAX_MUTATE_RETRIES) return updated; // give up - a pathologically hot list stays best-effort past this many rounds
    const after = await this.#readList(namespace);
    const survived = isAdd ? after.some((item) => item.id === itemId) : !after.some((item) => item.id === itemId);
    if (!survived) {
      // A concurrent writer (another tab/device using the SAME identity)
      // landed after ours and didn't include our change - retry from the
      // FRESH state rather than the stale read that caused the conflict.
      return this.#mutateOnce(namespace, itemId, isAdd, data, attempt + 1);
    }
    return after;
  }
}
