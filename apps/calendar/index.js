import { paths } from '@qu/services';

const SPACE_ID = 'ff73365b-144a-4285-8e98-ac7f9928a95f'; // this app's own manifest.spaceId - see client.js's own copy of this constant

/**
 * CALENDAR — server-side half. `client.js` owns essentially everything
 * (there is no calendar-specific storage to bootstrap - every calendar is
 * created lazily by whoever first uses the app), except for ONE real
 * server-side concern: routing calendar/event notifications to the RIGHT
 * one of this app's three `pushActions` (see manifest.quapp).
 *
 * ALL calendars share this ONE fixed app space (same "one space, many
 * independently-owned rooms/threads" shape `apps/chat` already uses for its
 * rooms - see that app's own manifest `spaceId` + `client.js`'s own doc
 * comment) rather than QuV2's per-calendar `calendar-<id>` space. That
 * earlier shape needed a bespoke relay.js regex
 * (`spaceId.match(/^calendar-(.+)$/)`) to route pushes at all; `@qu/relay`'s
 * `createManifestNotificationResolver()` only ever matches a message's
 * `spaceId` against a loaded app's OWN, single, fixed `manifest.spaceId` -
 * it has no concept of a per-instance dynamic space. Collapsing every
 * calendar into this app's one space means that manifest-driven resolver
 * already recognizes every calendar/event thread correctly, with zero
 * `packages/relay` changes - each calendar/event is just a differently
 * PREFIXED thread id inside the one space instead, exactly like a chat room
 * is a differently-derived thread id inside chat's own one space.
 *
 * The one gap that leaves: the manifest resolver's DEFAULT function-name
 * pick (`mention ? 'mention' : 'create'`) can only ever land on the FIRST
 * `pushActions` entry of the matching `type` - fine for `invite` (this
 * app's only `type: 'create'` entry a private `invite-<actorPub>` mail
 * thread ever needs), but `eventChange` (`type: 'update'`, a calendar's
 * `activity-<calId>` thread) and `guestInvite` (also `type: 'create'`, a
 * per-event `guest-<eventId>-<actorPub>` mail thread - genuinely
 * indistinguishable from `invite-<actorPub>` by type alone) both need a
 * MORE specific answer than the default type-based match can give.
 *
 * `registry.hooks.on('notify.threadCandidates', ...)` (`@qu/relay`'s
 * `PushDeliveryService`, see its own doc comment's "WHO GETS NOTIFIED IS
 * ALSO EXTENSIBLE" section) is exactly the documented, real (not
 * hypothetical) extension point for this: a handler may hand an ALREADY-
 * discovered candidate (this app's own thread readers, found by
 * PushDeliveryService's own generic private-thread logic - never
 * duplicated here) a more specific `functionName`, which the manifest
 * resolver then matches against `pushActions[].id` DIRECTLY instead of
 * falling back to its coarse type-based guess. `invite-<actorPub>` threads
 * are deliberately left alone here (return `[]`) - the default 'create'-type
 * match already lands correctly on `invite`, this app's first such entry.
 */
export async function register(qu, manifest, registry) {
  registry?.hooks.on('notify.threadCandidates', async ({ qu: hookQu, spaceId, threadId }) => {
    if (spaceId !== SPACE_ID) return [];
    let functionName = null;
    if (threadId.startsWith('activity-')) functionName = 'eventChange';
    else if (threadId.startsWith('guest-')) functionName = 'guestInvite';
    else return []; // invite-<actorPub> - the default type-based match already resolves this correctly

    const configBit = await hookQu.get(paths.threadMetaPath(spaceId, threadId));
    const readers = Array.isArray(configBit?.val?.readers) ? configBit.val.readers : [];
    return readers.map((actorPub) => ({ actorPub, functionName }));
  });

  console.log(`[calendar] registered (${manifest.name}@${manifest.version}) - notify.threadCandidates hook wired, see index.js`);
}
