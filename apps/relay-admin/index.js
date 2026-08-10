/**
 * RELAY ADMIN — server-side half. Purely a UI app over the relay's already-
 * existing, already-signed-and-checked `POST /admin/settings` route (see
 * `@qu/relay`'s `admin-http.js`) - nothing to register here, but every
 * loadable package still needs a `main` module per its manifest (see
 * `@qu/foundation`'s manifest schema), so this stays a documented no-op
 * rather than pointing `main` at nothing. Deliberately no `label`/`icon`/
 * `navOrder` in `manifest.quapp` - unlike a normal app, this one is not
 * meant to show up in the general App List for every visitor; the shell
 * header's own user menu already links straight to `#/relay-admin`,
 * conditionally, only when the signed-in identity's pub is in this relay's
 * `adminPubs` (see `apps/shell/src/header.js`).
 */
export async function register(qu, manifest) {
  console.log(`[relay-admin] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
