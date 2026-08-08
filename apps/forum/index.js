/**
 * FORUM — the first real app in the V3 monorepo, and the concrete proof
 * that `@qu/loader` + `@qu/relay`'s app-loading pipeline (manifest.quapp ->
 * discoverLocalPackages() -> QuLoader.loadLocal() -> register()) works
 * against something genuinely useful, not a synthetic test fixture.
 *
 * This file is the SERVER-SIDE half only - the browser half is `./client.js`
 * (see that file's own doc comment for the UI itself: message list,
 * reactions, pins, composing/editing). `SPACE_ID`/`THREAD_ID` are
 * deliberately NOT imported by `client.js` even though they're exported
 * here - they're redeclared locally there so the client bundle never pulls
 * in this server-only `register()`/`@qu/services`' `THREAD_PRESETS` import
 * path, keeping the two bundles genuinely independent.
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
