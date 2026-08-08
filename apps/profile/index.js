/**
 * PROFILE — server-side half. Purely a UI app (edits this identity's own
 * profile document + directory visibility client-side, see client.js) -
 * nothing to register here, but every loadable package still needs a
 * `main` module per its manifest (see @qu/foundation's manifest schema),
 * so this stays a documented no-op rather than pointing `main` at nothing.
 */
export async function register(qu, manifest) {
  console.log(`[profile] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
