/**
 * BOOKMARKS — server-side half. Purely a UI app (its own "My Bookmarks"
 * list, and a `content.messageActions` contribution rendered from WITHIN
 * whatever host app defines that point - currently `apps/forum` - see
 * client.js) - nothing to register here, but every loadable package still
 * needs a `main` module per its manifest (see @qu/foundation's manifest
 * schema), so this stays a documented no-op rather than pointing `main` at
 * nothing. `BookmarksService`'s private-flag storage needs no server-side
 * setup at all (self-encrypted under this identity's own actor path, same
 * as `FavoritesService`/`apps/app-list`'s own precedent).
 */
export async function register(qu, manifest) {
  console.log(`[bookmarks] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
