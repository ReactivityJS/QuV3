/**
 * DEBUG — server-side half. Purely a client-facing UI plugin (a
 * `shell.headerAction` badge + a `userSettings.contributions` section - see
 * client.js), nothing to register here, but every loadable package still
 * needs a `main` module per its manifest (see `@qu/foundation`'s manifest
 * schema) - same documented no-op shape `apps/reactions/index.js` already
 * uses for the same reason.
 */
export async function register(qu, manifest) {
  console.log(`[debug] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
