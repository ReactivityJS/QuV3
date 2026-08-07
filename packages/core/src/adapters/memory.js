import { sortAndPaginateChildren } from './cursor.js';

/**
 * MEMORY STORE ADAPTER — pure in-RAM, non-persistent storage adapter.
 *
 * Backs the `/temp` mount (see docs/v3-technical-concept.md §1.2's mount
 * table: RAM-only, dies with the process, never synced). It also doubles as
 * the REFERENCE implementation of the `getChildren()` contract that §1.2
 * defines: the simplest possible CORRECT implementation, against which
 * later, more efficient adapters (`FsAdapter`, `IndexedDBAdapter`, both in
 * `@qu/runtime`) can be checked. "Mandatory correctness, optional
 * efficiency" is the rule this file exists to demonstrate concretely: it is
 * O(n) in the number of entries under a prefix, not indexed, but it can
 * never return a wrong answer.
 *
 * Storage: a single `Map<rel, quBit>`, keyed by the full relative path.
 * get()/getAll()/getChildren() all derive from that one Map - no separate
 * index structure, on purpose (an adapter is allowed to be simple as long
 * as it's correct).
 */
export class MemoryStoreAdapter {
  /** @type {Map<string, object>} rel -> QuBit */
  #entries = new Map();

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>} `quBit`, even if a logically newer value
   *   already stored won the ts-guard below and this write was skipped -
   *   same convention as `FsAdapter`'s `put()`.
   */
  async put(rel, quBit) {
    const current = this.#entries.get(rel);
    if (current && typeof current.ts === 'number' && typeof quBit.ts === 'number' && current.ts > quBit.ts) {
      return quBit; // a logically newer value is already stored - never overwrite it with an older one
    }
    this.#entries.set(rel, quBit);
    return quBit;
  }

  /**
   * @param {string} rel
   * @returns {Promise<object|null>}
   */
  async get(rel) {
    return this.#entries.get(rel) ?? null;
  }

  /**
   * Arbitrary-depth, UNSORTED prefix scan - same contract as
   * `FsAdapter`/`IndexedDBAdapter`'s `getAll()`: everything under
   * `relPrefix`, in whatever order the underlying storage happens to
   * iterate in. Used by sync's outbox replay / reciprocal catch-up, which
   * never needed order.
   * @param {string} relPrefix
   * @returns {Promise<Array<{rel: string, quBit: object}>>}
   */
  async getAll(relPrefix) {
    const prefix = relPrefix.endsWith('/') ? relPrefix : relPrefix + '/';
    const out = [];
    for (const [rel, quBit] of this.#entries) {
      if (rel === relPrefix || rel.startsWith(prefix)) out.push({ rel, quBit });
    }
    return out;
  }

  /**
   * ONE level of children under `parentRel` only (never deeper - a
   * candidate whose remainder after the parent prefix still contains a
   * slash is skipped, not descended into), `(ts, rel)`-ordered,
   * cursor-paginated via the shared `sortAndPaginateChildren()` helper. See
   * docs/v3-technical-concept.md §1.2 for the full `ChildQueryOptions`/
   * `ChildEntry` contract this implements.
   *
   * @param {string} parentRel
   * @param {{sort?: 'ts', order?: 'asc'|'desc', limit?: number, cursor?: string}} [options]
   * @returns {Promise<Array<{rel: string, quBit: object, cursor: string}>>}
   */
  async getChildren(parentRel, options = {}) {
    const prefix = parentRel.endsWith('/') ? parentRel : parentRel + '/';
    const candidates = [];
    for (const [rel, quBit] of this.#entries) {
      if (!rel.startsWith(prefix)) continue;
      const remainder = rel.slice(prefix.length);
      if (remainder === '' || remainder.includes('/')) continue; // not a direct child
      candidates.push({ rel, quBit });
    }
    return sortAndPaginateChildren(candidates, options);
  }
}
