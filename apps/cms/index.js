/**
 * CMS — server-side half. Purely a UI app over `@qu/services`' generic
 * `EntityService`/`AccessService` (the `'page'`/`'cms-template'` EntityTypes,
 * see `packages/services/src/entity-types.js`) - nothing to register here,
 * but every loadable package still needs a `main` module per its manifest
 * (see `@qu/foundation`'s manifest schema), so this stays a documented no-op
 * rather than pointing `main` at nothing.
 *
 * Deliberately does NOT seed a default "Home" page into the global space
 * (this manifest's own `spaceId`) on boot - an empty global/personal space
 * just shows a friendly "no pages yet" state in `client.js` instead. Every
 * save (create OR update) in the global space re-`protect()`s it against the
 * CURRENT `adminPubs` list, so the first real admin to touch it establishes
 * the correct ACL then, with no timing dependency on this file knowing
 * `adminPubs` at relay-boot time.
 */
export async function register(qu, manifest) {
  console.log(`[cms] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
