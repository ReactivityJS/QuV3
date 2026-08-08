/**
 * WATCH — turns QuStore's write notifications into a "subscribe to one
 * path's current value" primitive, the thing every reactive UI actually
 * needs. Qu Core's `onStorageChange()` (see @qu/core/store.js) already
 * gives us a fault-isolated notify bus for every write in the whole store -
 * all that's missing for UI purposes is "only tell me about ONE path, and
 * tell me the current value immediately, not just future changes". That's
 * `watch()`.
 *
 * Every delivery - initial AND live - goes through `qu.get(path)`, never
 * the raw QuBit off the notify event. That's deliberate, not just "the
 * simplest option": `qu.get()` runs QuStore's full GET pipeline (see
 * @qu/core/store.js), which is where engine-level resolution happens. The
 * notify event only carries the value as it was WRITTEN - using it directly
 * could mean a live view showing correctly resolved data on first render,
 * then snapping to a raw, unresolved shape on the very next change. Treating
 * the notify event as nothing more than a "something changed, go re-read"
 * trigger avoids that inconsistency entirely, at the cost of one extra read
 * per relevant write - cheap against every adapter this repo ships.
 *
 * `watchChildren()` (below) is the derived-list counterpart: this file used
 * to claim "no second, broader watch-a-prefix primitive" was needed, on the
 * reasoning that a list is always ONE document whose value is an array. That
 * was wrong for HALF of @qu/services' own `ListService` design (§4.2): a
 * DERIVED list (thread messages, directory entries, reactions, ...) has NO
 * single document to watch at all - every item is its own sibling QuBit
 * under a shared parent, and `watch(qu, parentPath, ...)` would just watch a
 * path nothing is ever written to directly. `@qu/ui`'s `<qu-list>` needs
 * both shapes to actually be useful for the majority of real Qu data, which
 * is derived, not curated.
 */

/**
 * Calls `callback(value)` once with the current value at `path` (or `null`
 * if nothing is stored there yet), then again every time something writes
 * to that exact path.
 *
 * @param {import('@qu/core').QuStore} qu
 * @param {string} path
 * @param {(value: *) => void} callback
 * @param {{initial?: boolean, syncFetch?: (path: string) => Promise<object|null>}} [options] -
 *   `initial: false` skips the immediate current-value call, delivering
 *   only future changes. `syncFetch` (typically `(path) => sync.fetch(path)`,
 *   see @qu/sync): if given, fired once when `watch()` is first attached to
 *   ask a peer for this path's CURRENT value, not just the initial LOCAL
 *   one above. Without this, watching a path only ever shows what's already
 *   on disk plus whatever a broad `subscribe()` happens to push AFTER this
 *   moment (see SyncEngine's own doc comment: subscribing only delivers
 *   FUTURE writes) - a value a peer wrote before this session subscribed,
 *   or while this session was offline/hadn't opened this exact view yet,
 *   would otherwise sit unnoticed until something UNRELATED happens to
 *   trigger a re-read of the same path. No second code path needed to
 *   apply the result: whatever `syncFetch` finds is written through the
 *   normal sync pipeline (`SyncEngine.fetch()` -> `qu.putSealed()`, see
 *   sync-engine.js), which fires the SAME `onStorageChange` notify this
 *   function already listens to below - a fresher value simply triggers
 *   the ordinary refetch. Fire-and-forget: a slow/failing peer request
 *   must never delay or break the local `initial` delivery above.
 * @returns {() => void} Unsubscribe function.
 */
export function watch(qu, path, callback, { initial = true, syncFetch = null } = {}) {
  // `qu.get(path)` races the next write to the same path by design - two
  // overlapping re-fetches can resolve in EITHER order. Tracking the
  // highest `ts` delivered so far and dropping anything older prevents
  // that race from ever showing a stale value AFTER a fresher one already
  // rendered.
  let latestTs = -Infinity;

  async function refetch() {
    const quBit = await qu.get(path);
    const ts = quBit?.ts ?? 0;
    if (ts < latestTs) return;
    latestTs = ts;
    callback(quBit?.val ?? null);
  }

  const off = qu.onStorageChange(({ path: writtenPath }) => {
    if (writtenPath === path) refetch();
  });

  if (initial) refetch();
  if (syncFetch) syncFetch(path).catch(() => {});

  return off;
}

/**
 * Calls `callback(entries)` once with the CURRENT direct children of
 * `parentPath` (`qu.getChildren()` - see @qu/core/store.js, same `(ts,rel)`
 * ordering/pagination contract @qu/services' `ListService.listDerived()`
 * already uses), then again every time something writes to `parentPath`
 * ITSELF or to any path directly under it - not a full subtree watch, same
 * "one level deep" scope `getChildren()` itself has.
 *
 * @param {import('@qu/core').QuStore} qu
 * @param {string} parentPath
 * @param {(entries: Array<{path: string, quBit: object, cursor: string}>) => void} callback
 * @param {{initial?: boolean, syncFetch?: (path: string) => Promise<object|null>, limit?: number, order?: 'asc'|'desc', cursor?: string}} [options] -
 *   Same `initial`/`syncFetch` meaning as `watch()` above. `limit`/`order`/
 *   `cursor` pass straight through to `qu.getChildren()` - no default
 *   `limit` (mirrors `ListService.listDerived()`'s own reasoning: silently
 *   capping a caller's list is a correctness bug, not a convenience,
 *   belongs to whichever caller actually wants pagination).
 * @returns {() => void} Unsubscribe function.
 */
export function watchChildren(qu, parentPath, callback, { initial = true, syncFetch = null, limit, order = 'desc', cursor = null } = {}) {
  // getChildren() has no single `ts` to compare across an overlapping
  // refetch pair the way watch() does (it returns a whole array) - a
  // monotonic call counter is the array-shaped equivalent of the same
  // guard: drop a refetch's result the moment a NEWER refetch has already
  // started, so an overlapping pair can never resolve out of order and
  // show a stale array after a fresher one already rendered.
  let latestCall = 0;

  async function refetch() {
    const callId = ++latestCall;
    const entries = await qu.getChildren(parentPath, { sort: 'ts', order, limit, cursor });
    if (callId !== latestCall) return;
    callback(entries);
  }

  const off = qu.onStorageChange(({ path: writtenPath }) => {
    if (writtenPath === parentPath) { refetch(); return; }
    if (!writtenPath.startsWith(`${parentPath}/`)) return;
    // A write deeper than a DIRECT child (e.g. a grandchild) can never
    // change what getChildren() itself returns for this parent - same
    // "one level deep" scope that primitive already has. Refetching for it
    // anyway would just be a wasted read on every unrelated nested write.
    const rest = writtenPath.slice(parentPath.length + 1);
    if (rest.includes('/')) return;
    refetch();
  });

  if (initial) refetch();
  if (syncFetch) syncFetch(parentPath).catch(() => {});

  return off;
}
