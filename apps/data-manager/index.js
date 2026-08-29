/**
 * DATA MANAGER — server-side half. Purely a UI app: every read/write it does
 * goes through already-existing, already-authorized surfaces (the normal
 * client-side Services catalog for "my own data", `@qu/relay`'s already-
 * signature-gated `/admin/data/list`/`/admin/data/import` for the relay-wide
 * admin view - see `packages/relay/src/admin-http.js`) - nothing to register
 * here, but every loadable package still needs a `main` module per its
 * manifest (see `@qu/foundation`'s manifest schema), so this stays a
 * documented no-op rather than pointing `main` at nothing, same convention
 * `apps/relay-admin/index.js`/`apps/forum/index.js` already established.
 * See `client.js`'s own top doc comment for the actual design.
 */
export async function register(qu, manifest) {
  console.log(`[data-manager] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
