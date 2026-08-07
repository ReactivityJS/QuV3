import { QuCrypto } from '../crypto.js';

/**
 * Shared opaque cursor encoding for every adapter's `getChildren()`
 * implementation (see docs/v3-technical-concept.md §1.2's `ChildEntry`
 * contract). A cursor from one adapter is never compared against another's
 * (see `getChildren()`'s own contract - callers only ever pass back a
 * cursor they previously received), but there is no reason each adapter
 * should reinvent the same JSON+base64url encoding independently.
 * @param {{rel: string, quBit: {ts: number}}} entry
 * @returns {string}
 */
export function encodeChildCursor({ rel, quBit }) {
  return QuCrypto.toBase64Url(new TextEncoder().encode(JSON.stringify([quBit.ts, rel])));
}

/**
 * Sorts candidate entries by `(ts, rel)` - the tie-broken total order every
 * `getChildren()` implementation must produce - and returns them WITH their
 * cursor attached, sliced to the requested page. This is the "mandatory
 * correctness" half of the contract, factored out once: any adapter that
 * can only gather an UNORDERED list of direct-child candidates (a plain
 * directory listing, an unindexed in-memory scan, a naive prefix-range
 * cursor scan) hands that list to this function and gets a correct,
 * paginated result back for free.
 *
 * An adapter backed by real ordered storage (e.g. a future compound
 * `[parentPath, ts]` index) does NOT need this helper - it can produce the
 * same ordering natively, more cheaply. This function exists for the
 * adapters that can't yet, not as the only valid way to satisfy the
 * contract.
 * @param {Array<{rel: string, quBit: object}>} candidates - Unordered.
 * @param {{order?: 'asc'|'desc', cursor?: string, limit?: number}} [options]
 * @returns {Array<{rel: string, quBit: object, cursor: string}>}
 */
export function sortAndPaginateChildren(candidates, { order = 'desc', cursor, limit } = {}) {
  const sorted = [...candidates].sort((a, b) => {
    const cmp = a.quBit.ts - b.quBit.ts || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
    return order === 'asc' ? cmp : -cmp;
  });
  const withCursors = sorted.map((entry) => ({ ...entry, cursor: encodeChildCursor(entry) }));
  const startIndex = cursor ? withCursors.findIndex((e) => e.cursor === cursor) + 1 : 0;
  return limit != null ? withCursors.slice(startIndex, startIndex + limit) : withCursors.slice(startIndex);
}
