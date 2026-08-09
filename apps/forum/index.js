/**
 * FORUM — the first real app in the V3 monorepo, and the concrete proof
 * that `@qu/loader` + `@qu/relay`'s app-loading pipeline (manifest.quapp ->
 * discoverLocalPackages() -> QuLoader.loadLocal() -> register()) works
 * against something genuinely useful, not a synthetic test fixture.
 *
 * This file is the SERVER-SIDE half only - the browser half is `./client.js`
 * (see that file's own doc comment for the UI itself: message list,
 * reactions, pins, composing/editing). `THREAD_ID` is deliberately NOT
 * imported by `client.js` even though it's exported here - it's redeclared
 * locally there so the client bundle never pulls in this server-only
 * `register()`/`@qu/services`' `THREAD_PRESETS` import path, keeping the two
 * bundles genuinely independent. `SPACE_ID`, however, is NOT a local
 * constant anymore on either side - it comes from `manifest.spaceId` (a
 * fixed UUID committed in `manifest.quapp`, see `@qu/foundation`'s manifest
 * schema doc comment for why a space id must be a UUID, never the app's
 * human-readable name/label): server-side `register()` reads it off the
 * `manifest` param it's already handed, `client.js` reads it off its own
 * entry in the apps catalog (`ctx.apps`), which `apps-catalog.js` now
 * publishes alongside `name`/`label`.
 *
 * `register()` ensures the shared public forum thread exists - idempotent
 * (see `@qu/services`' `MessageService.createThread()` doc comment: a
 * second call is a safe no-op returning the existing config unchanged), so
 * this can run unconditionally on every relay boot without ever resetting
 * an already-populated forum back to empty.
 */
import { THREAD_PRESETS } from '@qu/services';

export const THREAD_ID = 'general';

/**
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/foundation').Manifest} manifest
 * @param {import('@qu/foundation').Registry} registry
 */
export async function register(qu, manifest, registry) {
  if (!manifest.spaceId) throw new Error('[forum] manifest.quapp is missing "spaceId" - a fixed UUID is required, see @qu/foundation manifest.js');
  const messages = registry.getService('message-service');
  await messages.createThread(manifest.spaceId, THREAD_ID, THREAD_PRESETS.forum());
  console.log(`[forum] registered (${manifest.name}@${manifest.version}) - ensured the public "${manifest.spaceId}/${THREAD_ID}" thread exists`);
}
