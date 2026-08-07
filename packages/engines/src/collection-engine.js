/**
 * COLLECTION ENGINE — resolves `$ref` and `$list` pointers on read.
 *
 * A value stored anywhere may contain:
 *   - `{ $ref: "/store/other/path" }` - resolved to the full QuBit at that path.
 *   - `{ $list: ["/store/a", "/store/b", ...] }` - resolved to an array of
 *     the full QuBits at those paths (fetched concurrently).
 *
 * This is what turns Qu into something that can represent "a collection of
 * things" without QuStore itself ever knowing what a collection is -
 * `$ref`/`$list` are just a value shape, interpreted here, one layer up.
 *
 * SCOPE, per docs/v3-technical-concept.md §4.2: this Engine backs
 * `@qu/services`' `ListService`'s **curated** lists only (an explicit,
 * user-ordered index document - Favorites, Contacts, and anything else that
 * references items NOT colocated under one shared path prefix). `ListService`'s
 * **derived** lists (thread messages, public flags, reactions, pins - every
 * item already lives at its own path under a shared parent) never touch
 * `$ref`/`$list` at all; they use `QuStore.getChildren()` directly and never
 * involve this Engine. Both existed as one undifferentiated mechanism before
 * that split - this Engine's job narrowed, but its own logic didn't need to
 * change to reflect that.
 *
 * Registered with `segment: null` (global) because a reference can appear
 * under any path, not just ones containing a specific keyword - unlike
 * DocumentEngine/AssetEngine, there's no fixed segment to index on. The
 * check itself is a couple of property lookups, cheap enough to run on
 * every read.
 *
 * `QuStore.get()` always threads this Engine's return value through as the
 * final result (see @qu/core/store.js) - resolution genuinely takes effect,
 * not just runs and gets discarded.
 */
export class CollectionEngine {
  /** @param {import('@qu/core').QuStore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: null,
      order: 20,
      get: async ({ result }) => {
        if (!result || typeof result !== 'object' || !result.val || typeof result.val !== 'object') {
          return result;
        }
        const value = result.val;

        if (typeof value.$ref === 'string') {
          return this.qu.get(value.$ref);
        }
        if (Array.isArray(value.$list)) {
          const items = await Promise.all(value.$list.map((path) => this.qu.get(path)));
          return { ...result, val: items };
        }
        return result;
      },
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }
}
