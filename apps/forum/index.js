/**
 * FORUM — the first real app in the V3 monorepo, and the concrete proof
 * that `@qu/loader` + `@qu/relay`'s app-loading pipeline (manifest.quapp ->
 * discoverLocalPackages() -> QuLoader.loadLocal() -> register()) works
 * against something genuinely useful, not a synthetic test fixture.
 *
 * This file is the SERVER-SIDE half only - the browser half is `./client.js`
 * (see that file's own doc comment for the UI itself: channels, topics,
 * message list, reactions, pins, composing/editing). `THREAD_ID`/
 * `GENERAL_CHANNEL_ID` are deliberately NOT imported by `client.js` even
 * though they're exported here - redeclared locally there so the client
 * bundle never pulls in this server-only `register()`/`@qu/services`'
 * `THREAD_PRESETS`/`ChannelService` import path, keeping the two bundles
 * genuinely independent. `SPACE_ID`, however, is NOT a local constant
 * anymore on either side - it comes from `manifest.spaceId` (a fixed UUID
 * committed in `manifest.quapp`, see `@qu/foundation`'s manifest schema doc
 * comment for why a space id must be a UUID, never the app's human-readable
 * name/label): server-side `register()` reads it off the `manifest` param
 * it's already handed, `client.js` reads it off its own entry in the apps
 * catalog (`ctx.apps`), which `apps-catalog.js` now publishes alongside
 * `name`/`label`.
 *
 * `register()` ensures the original flat public thread from before Channels/
 * Topics existed - idempotent (see `@qu/services`' `MessageService.
 * createThread()` doc comment: a second call is a safe no-op returning the
 * existing config unchanged) - AND, since this round's redesign, a real
 * "General" Channel + "General" Topic wrapping that SAME thread (same id,
 * no data migration, nothing re-created) so any message posted before this
 * round stays exactly where a visitor would now expect to find it - the
 * Channel/Topic layer is purely additive over what already existed, never a
 * destructive rewrite. `ChannelService.createChannel()`/`createTopic()`
 * themselves aren't naturally idempotent (each call mints a fresh random
 * id) - this uses `getChannel()`/`listTopics()` checks first, matching the
 * same "check before create" idempotence every other one-time relay-boot
 * seed in this codebase already needs.
 */
import { THREAD_PRESETS, paths } from '@qu/services';

export const THREAD_ID = 'general';
export const GENERAL_CHANNEL_ID = 'general-channel';

/**
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/foundation').Manifest} manifest
 * @param {import('@qu/foundation').Registry} registry
 */
export async function register(qu, manifest, registry) {
  if (!manifest.spaceId) throw new Error('[forum] manifest.quapp is missing "spaceId" - a fixed UUID is required, see @qu/foundation manifest.js');
  const messages = registry.getService('message-service');
  await messages.createThread(manifest.spaceId, THREAD_ID, THREAD_PRESETS.forum());

  const channels = registry.getService('channel-service');
  let channel = await channels.getChannel(manifest.spaceId, GENERAL_CHANNEL_ID);
  if (!channel) {
    channel = await channels.createChannel(manifest.spaceId, { channelId: GENERAL_CHANNEL_ID, title: 'General', description: 'The original public board.' });
  }
  const existingTopics = await channels.listTopics(manifest.spaceId, GENERAL_CHANNEL_ID);
  if (!existingTopics.some((t) => t._id === THREAD_ID)) {
    // A Topic normally gets a FRESH random id and its OWN freshly created
    // thread (see `createTopic()`) - this is the one deliberate exception,
    // wiring the topic doc directly to the THREAD_ID/thread that already
    // existed before Channels/Topics did, instead of minting a new one.
    const topicDoc = { _id: THREAD_ID, title: 'General', channelId: GENERAL_CHANNEL_ID, author: channel.createdBy, createdAt: channel.createdAt };
    await qu.put(paths.documentPath(manifest.spaceId, THREAD_ID), topicDoc);
    const list = registry.getService('list-service');
    await list.addCurated(paths.listPath(manifest.spaceId, `topics-${GENERAL_CHANNEL_ID}`), paths.documentPath(manifest.spaceId, THREAD_ID));
  }

  console.log(`[forum] registered (${manifest.name}@${manifest.version}) - ensured the public "${manifest.spaceId}/${THREAD_ID}" thread, its "General" channel, and its "General" topic exist`);
}
