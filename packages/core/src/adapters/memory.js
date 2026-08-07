import { QuCrypto } from '../crypto.js';

/**
 * MEMORY STORE ADAPTER — pure in-RAM, non-persistent storage adapter.
 *
 * Backs the `/temp` mount (see docs/v3-technical-concept.md §1.2's mount
 * table: RAM-only, dies with the process, never synced). It also doubles as
 * the REFERENCE implementation of the `getChildren()` contract that §1.2
 * defines: the simplest possible CORRECT implementation, against which
 * later, more efficient adapters (FsAdapter, IndexedDBAdapter - both in
 * later packages) can be checked. "Mandatory correctness, optional
 * efficiency" is the rule this file exists to demonstrate concretely: it is
 * O(n) in the number of entries under a prefix, not indexed, but it can
 * never return a wrong answer.
 *
 * Storage: a single `Map<rel, quBit>`, keyed by the full relative path.
 * get()/getAll()/getChildren() all derive from that one Map - no separate
 * index structure, on purpose (an adapter is allowed to be simple as long
 * as it's correct - see the `getChildren()` doc comment below).
 */
export class MemoryStoreAdapter {
  /** @type {Map<string, object>} rel -> QuBit */
  #entries = new Map();

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>} `quBit`, even if a logically newer value
   *   already stored won the ts-guard below and this write was skipped -
   *   same convention as FsAdapter's `put()`.
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
   * FsAdapter/IndexedDBAdapter's getAll(): everything under `relPrefix`, in
   * whatever order the underlying storage happens to iterate in. Used by
   * sync's outbox replay / reciprocal catch-up, which never needed order.
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
   * cursor-paginated. See docs/v3-technical-concept.md §1.2 for the full
   * `ChildQueryOptions`/`ChildEntry` contract this implements.
   *
   * @param {string} parentRel
   * @param {{sort?: 'ts', order?: 'asc'|'desc', limit?: number, cursor?: string}} [options]
   * @returns {Promise<Array<{rel: string, quBit: object, cursor: string}>>}
   */
  async getChildren(parentRel, { order = 'desc', limit, cursor } = {}) {
    const prefix = parentRel.endsWith('/') ? parentRel : parentRel + '/';
    const direct = [];
    for (const [rel, quBit] of this.#entries) {
      if (!rel.startsWith(prefix)) continue;
      const remainder = rel.slice(prefix.length);
      if (remainder === '' || remainder.includes('/')) continue; // not a direct child
      direct.push({ rel, quBit });
    }

    // (ts, rel) tuple order - ts alone is not enough: two entries can
    // legitimately share the same ts (see §1.2's "cursor design" note on
    // why ts-only pagination has a real tie-break correctness gap).
    direct.sort((a, b) => {
      const cmp = a.quBit.ts - b.quBit.ts || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
      return order === 'asc' ? cmp : -cmp;
    });

    const withCursors = direct.map((entry) => ({ ...entry, cursor: encodeCursor(entry) }));
    const startIndex = cursor ? withCursors.findIndex((e) => e.cursor === cursor) + 1 : 0;
    return limit != null ? withCursors.slice(startIndex, startIndex + limit) : withCursors.slice(startIndex);
  }
}

/**
 * Opaque "resume after this entry" token encoding the full `(ts, rel)`
 * tie-broken order as a JSON tuple, base64url-encoded. JSON (rather than a
 * hand-rolled delimited string) sidesteps any question of which separator
 * character is safe to use - `rel` is an arbitrary string and must never
 * constrain what a caller is allowed to name a path segment. Callers must
 * never construct or parse this themselves, only pass back a token they
 * previously received from a `ChildEntry`.
 * @param {{rel: string, quBit: object}} entry
 * @returns {string}
 */
function encodeCursor({ rel, quBit }) {
  const tuple = [quBit.ts, rel];
  return QuCrypto.toBase64Url(new TextEncoder().encode(JSON.stringify(tuple)));
}
