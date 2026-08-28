/**
 * RELAY FEDERATION — server-side half. Purely a client-facing UI plugin (a
 * `userSettings.contributions` contribution, plus its own standalone
 * `#/relay-federation/invite/<url>` route - see client.js), nothing to
 * register here, but every loadable package still needs a `main` module per
 * its manifest (see `@qu/foundation`'s manifest schema) - same documented
 * no-op shape `apps/reactions/index.js` already uses for the same reason.
 * The actual relay-side federation mechanism this UI talks to
 * (`POST /federation/suggest`) lives in `packages/relay/src/http-router.js`
 * and `packages/relay/src/federation-manager.js`, not here.
 */
export async function register(qu, manifest) {
  console.log(`[relay-federation] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
