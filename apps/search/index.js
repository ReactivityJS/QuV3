/**
 * SEARCH — server-side half. Purely a UI app (its own results page, plus a
 * `shell.headerAction` contribution rendered from WITHIN the shell header -
 * see client.js) - nothing to register here, but every loadable package
 * still needs a `main` module per its manifest (see @qu/foundation's
 * manifest schema), same documented no-op `apps/bookmarks/index.js` already
 * establishes. This app owns no storage of its own: `content.search` is a
 * QUERY-time fan-out into whichever apps already store the content (see
 * client.js's own doc comment) - nothing to seed, migrate, or register.
 */
export async function register(qu, manifest) {
  console.log(`[search] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
