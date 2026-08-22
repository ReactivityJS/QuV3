/**
 * FORUM — the first real app in the V3 monorepo, and the concrete proof
 * that `@qu/loader` + `@qu/relay`'s app-loading pipeline (manifest.quapp ->
 * discoverLocalPackages() -> QuLoader.loadLocal() -> register()) works
 * against something genuinely useful, not a synthetic test fixture.
 *
 * This file is the SERVER-SIDE half only - the browser half is `./client.js`
 * (see that file's own doc comment for the UI itself: channels, topics,
 * comment list, reactions, pins, composing/editing). `SPACE_ID` is NOT a
 * local constant on either side - it comes from `manifest.spaceId` (a fixed
 * UUID committed in `manifest.quapp`, see `@qu/foundation`'s manifest schema
 * doc comment for why a space id must be a UUID, never the app's
 * human-readable name/label): server-side `register()` reads it off the
 * `manifest` param it's already handed, `client.js` reads it off its own
 * entry in the apps catalog (`ctx.apps`), which `apps-catalog.js` now
 * publishes alongside `name`/`label`.
 *
 * QUNIVERSE V4 (Forum-migration round, docs/v4-concept.md §9/§10):
 * `register()` ensures a "General" Channel + "General" Topic exist, both
 * idempotently (`getChannel()`/`listTopics()` checks first, matching the
 * same "check before create" idempotence every other one-time relay-boot
 * seed in this codebase already needs - `ChannelService.createChannel()`/
 * `createTopic()` themselves aren't naturally idempotent, each call mints a
 * fresh random id). SIMPLER than its pre-V4 shape on purpose: there is no
 * deployed production Forum data on this branch to preserve, so this is a
 * clean rebuild via `ChannelService`'s normal Entity+Commentable path, not a
 * live data migration - a real deployment carrying real Forum history would
 * need its own real migration plan, explicitly out of scope here.
 */
export const GENERAL_CHANNEL_ID = 'general-channel';
const GENERAL_TOPIC_TITLE = 'Welcome';

/**
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/foundation').Manifest} manifest
 * @param {import('@qu/foundation').Registry} registry
 */
export async function register(qu, manifest, registry) {
  if (!manifest.spaceId) throw new Error('[forum] manifest.quapp is missing "spaceId" - a fixed UUID is required, see @qu/foundation manifest.js');
  const channels = registry.getService('channel-service');

  let channel = await channels.getChannel(manifest.spaceId, GENERAL_CHANNEL_ID);
  if (!channel) {
    channel = await channels.createChannel(manifest.spaceId, { channelId: GENERAL_CHANNEL_ID, title: 'General', description: 'The original public board.' });
  }

  const existingTopics = await channels.listTopics(manifest.spaceId, GENERAL_CHANNEL_ID);
  if (existingTopics.length === 0) {
    await channels.createTopic(manifest.spaceId, GENERAL_CHANNEL_ID, {
      title: GENERAL_TOPIC_TITLE,
      content: { text: 'Welcome to the forum! Say hello.' },
    });
  }

  console.log(`[forum] registered (${manifest.name}@${manifest.version}) - ensured the "General" channel and its opening topic exist`);
}
