/**
 * FORUM — the first real app in the V3 monorepo, and the concrete proof
 * that `@qu/loader` + `@qu/relay`'s app-loading pipeline (manifest.quapp ->
 * discoverLocalPackages() -> QuLoader.loadLocal() -> register()) works
 * against something genuinely useful, not a synthetic test fixture.
 *
 * SERVER-SIDE HALF ONLY, deliberately: this manifest has no `clientMain`.
 * V3 has no browser UI framework yet (`@qu/reactive`/`@qu/ui`, the packages
 * QuV2's own `apps/forum/client.js` depended on, per its own boot()
 * decision `apps/todo`'s equivalent doc comment makes the same call for) -
 * building one just so this app could have a UI would be exactly the
 * "build the general thing before its real need exists" complexity this
 * codebase's own principles (docs/v3-technical-concept.md §0) warn
 * against. `buildAppsCatalog()` (see `@qu/relay`'s `apps-catalog.js`)
 * already correctly omits an app with no `clientMain` from `/apps.json`'s
 * "things a shell should mount" list - this app is real infrastructure
 * today, not a placeholder waiting on a UI half.
 *
 * `register()` ensures the shared public forum thread exists - idempotent
 * (see `@qu/services`' `MessageService.createThread()` doc comment: a
 * second call is a safe no-op returning the existing config unchanged), so
 * this can run unconditionally on every relay boot without ever resetting
 * an already-populated forum back to empty.
 */
import { THREAD_PRESETS } from '@qu/services';

export const SPACE_ID = 'forum';
export const THREAD_ID = 'general';

/**
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/foundation').Manifest} manifest
 * @param {import('@qu/foundation').Registry} registry
 */
export async function register(qu, manifest, registry) {
  const messages = registry.getService('message-service');
  await messages.createThread(SPACE_ID, THREAD_ID, THREAD_PRESETS.forum());
  console.log(`[forum] registered (${manifest.name}@${manifest.version}) - ensured the public "${SPACE_ID}/${THREAD_ID}" thread exists`);
}
