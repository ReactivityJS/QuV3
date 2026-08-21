import { paths } from '@qu/services';

/**
 * GAME SERVICE — Geo Chase's own game lifecycle/roles/invites, layered
 * entirely on EXISTING generic primitives rather than a new bespoke ACL
 * shape:
 *
 *   - A game's config/state (`chasedPub`, `status`, `settings`, `members`)
 *     lives as a Thread's own meta document (`services.messages.
 *     createThread()`/`getConfig()`), NOT a `SharingService`-style Document.
 *     `createThread()` stores whatever extra fields a caller's config
 *     object carries alongside `writers`/`readers` verbatim (see that
 *     method's own doc comment) - so this game's own `chasedPub`/`status`/
 *     `settings`/`members` ride along for free, and `writers: [chasedPub]`
 *     means AccessEngine itself (not just this file's own logic) rejects
 *     any write from anyone but the chased player - same enforcement ToDo's
 *     own owner-only list-meta document already relies on.
 *
 *   - `members: [{actorPub, role: 'chased'|'chaser', addedAt}]` is
 *     DELIBERATELY the same shape `SharingService.roleOf()` already reads
 *     (`meta.members.find(...).role`) - not because "chased"/"chaser" are
 *     owner/editor/viewer roles (they're not; nothing here ever calls
 *     `canEdit()`/`canManage()`), but so `services.sharing.starIfMember()`/
 *     `listMine()`/`discoverPendingInvites()` all work UNCHANGED against a
 *     Geo Chase game exactly like they already do against a ToDo list or
 *     Calendar calendar - zero new sharing-service code needed, just this
 *     file's own `readGame()`/`inviteChaser()` producing a `SharingService`-
 *     shaped `members` array as a side effect of the real ACL (`readers`)
 *     update they also have to do.
 *
 *   - Invites use the SAME `invite-<pub>` "personal mailbox" thread
 *     convention every other app's own invite flow uses (ToDo/Calendar) -
 *     `discoverPendingInvites()`'s `resourceKey: 'gameId'` reads it back off
 *     that notification's own `extra` - but written DIRECTLY (see
 *     `notifyChaserInvite()` below) rather than via `services.messages.
 *     notify()`, which defaults to an ENCRYPTED, reader-restricted mailbox.
 *     `@qu/relay`'s push-delivery resolver can only ever read a message's
 *     own fields (to fill a `urlTemplate` placeholder like `{gameId}` -
 *     see `packages/relay/src/push-delivery.js`'s own doc comment) when
 *     they were never encrypted in the first place - an invite notice
 *     ("you were invited to a Geo Chase game") isn't sensitive enough to
 *     be worth losing a real deep link over, unlike this game's own
 *     position/settings data (still fully ACL-protected, see above).
 */

const FLAG_TYPE = 'geochase';
const ENTITY_KIND = 'game';

export const DEFAULT_SETTINGS = {
  // The chased player updates LESS often than chasers by default - a longer
  // interval means a real, live-battery-cost trade-off in their favor (see
  // client.js's own Wake Lock addition - it's already their screen staying
  // on that costs the most), while chasers - actively hunting - want a
  // tighter fix on each other. 3min/5min per this app's own explicit design
  // discussion, not the original pilot's placeholder few-second values.
  chasedIntervalMs: 3 * 60_000, // how often the CHASED device pushes its own position
  chaserIntervalMs: 5 * 60_000, // how often each CHASER device pushes its own position
  mapMode: 'plane', // 'plane' (abstract canvas) | 'osm' (a real interactive Leaflet+OpenStreetMap-tiles map)
  showRadius: true, // the chased player's speed-based "could be anywhere in here" circle
  assumedMinSpeedMps: 1.2, // see geometry.js's own possibleRadiusMeters() doc comment
  // Granular alert thresholds (both in meters, both user-configurable at
  // game creation - see client.js's own draft form) - see src/proximity.js's
  // own doc comment for how these two distinct, edge-triggered alerts work.
  proximityAlertMeters: 150, // "a chaser is getting close" - the outer warning ring
  catchRangeMeters: 20, // "close enough to actually tag them" - the inner ring; a chaser inside it may press the Catch button
};

// A finished game older than this fades out of the main list into a
// collapsed "Archive" section (client.js's own renderGameListPage()) -
// purely a client-side read-time filter, no schema/store change - see
// isArchivable() below and this app's own plan doc for why no real
// hard-delete/retention primitive exists anywhere else in this codebase to
// build on top of instead.
export const ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60_000; // 30 days

export function gameThreadId(gameId) { return `geochase-${gameId}`; }

/**
 * A finished game old enough to be folded into the collapsed "Archive"
 * section of the game list, rather than the main list - see
 * `ARCHIVE_AFTER_MS`'s own doc comment.
 * @param {object} meta
 * @returns {boolean}
 */
export function isArchivable(meta) {
  return meta.status === 'ended' && !!meta.endedAt && Date.now() - meta.endedAt > ARCHIVE_AFTER_MS;
}

/**
 * @param {object} services @param {string|number} spaceId
 * @param {string} gameId @param {Partial<typeof DEFAULT_SETTINGS>} [settingsOverride]
 * @returns {Promise<object>} The newly created game's own config.
 */
export async function createGame(services, spaceId, gameId, settingsOverride = {}) {
  const chasedPub = await services.actors.whoAmI();
  const config = await services.messages.createThread(spaceId, gameThreadId(gameId), {
    writers: [chasedPub],
    readers: [chasedPub],
    replyMode: 'flat',
    formatting: [],
    kind: 'geochase-game',
    gameId,
    chasedPub,
    members: [{ actorPub: chasedPub, role: 'chased', addedAt: Date.now() }],
    status: 'pending',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    caughtBy: null,
    startDistances: {},
    settings: { ...DEFAULT_SETTINGS, ...settingsOverride },
    createdAt: Date.now(),
  });
  await services.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, gameId, true, {});
  return config;
}

/**
 * Removes `gameId` from THIS identity's own `listMyGames()` - a soft,
 * per-user "delete" (mirrors `SharingService.unstar()`'s own convention, see
 * `sharing-service.js:234-236`): the game's own data (config, members,
 * track history) is untouched, and any OTHER member still sees it in their
 * own list. There is no hard-delete anywhere in this codebase to build a
 * "wipe it for everyone" version on top of (append-only signed/encrypted
 * QuBits, no `qu.delete()`) - see this app's own plan doc for the explicit
 * choice.
 * @param {object} services @param {string} gameId
 */
export async function archiveGame(services, gameId) {
  await services.sharing.unstar(FLAG_TYPE, ENTITY_KIND, gameId);
}

/** @returns {Promise<object|null>} The game's current config, or null if it doesn't exist (yet). */
export async function readGame(services, spaceId, gameId) {
  return services.messages.getConfig(spaceId, gameThreadId(gameId));
}

/**
 * Writes the chaser's own invite notification into their `invite-<pub>`
 * mailbox (same thread id/convention `services.messages.notify()` uses -
 * see this file's own top doc comment for why this one is hand-rolled
 * rather than calling that shared helper directly) - DELIBERATELY
 * UNENCRYPTED (`readers: '*'`), the only way `gameId` can ever reach
 * `@qu/relay`'s push-delivery resolver to fill `apps/geochase/manifest.
 * quapp`'s own `geochase-invite` pushAction's `urlTemplate:
 * '#/geochase/{gameId}'` - a private/encrypted thread's content is
 * genuinely opaque to the relay, by design (see push-delivery.js's own doc
 * comment), so an invite through `notify()`'s default encrypted mailbox
 * could only ever deep-link to the generic `#/geochase` app root, not the
 * specific running game. `mentions: [chaserPub]` is what makes this a
 * notification candidate on a PUBLIC thread at all (see
 * `PushDeliveryService.deliverThreadMessage()`'s own public-thread branch -
 * a public thread only notifies explicit mentions, never blanket "every
 * reader" the way a private one does, since there IS no restricted reader
 * list to enumerate).
 */
async function notifyChaserInvite(spaceId, services, chaserPub, gameId, chasedPub) {
  const threadId = `invite-${chaserPub}`;
  await services.messages.createThread(spaceId, threadId, { writers: '*', readers: '*', replyMode: 'flat', formatting: [] });
  await services.messages.postMessage(spaceId, threadId, { body: 'geochase-invite', extra: { gameId, chasedPub, mentions: [chaserPub] } });
}

/**
 * Invites `chaserPub` - grows BOTH `members` (role introspection, see this
 * file's own top doc comment) and `readers` (the actual encryption ACL) in
 * one write, then pushes a personal-mailbox notification (see
 * `notifyChaserInvite()` above) so their own `discoverInvites()` (and, per
 * the existing pushActions convention, a real push notification straight to
 * this specific game) picks it up even before they open Geo Chase at all.
 * CHASED-ONLY in practice - `writers: [chasedPub]` means AccessEngine
 * rejects this write outright from anyone else, this function has no
 * additional guard of its own.
 * @param {import('@qu/core').QuStore} qu @param {import('@qu/identity').QuIdentityEngine} identity @param {object} services
 * @param {string|number} spaceId @param {string} gameId @param {string} chaserPub
 * @returns {Promise<object>} The updated config.
 */
export async function inviteChaser(qu, identity, services, spaceId, gameId, chaserPub) {
  const threadId = gameThreadId(gameId);
  const config = await services.messages.getConfig(spaceId, threadId);
  if (!config) throw new Error(`geochase: no game "${gameId}" in space "${spaceId}"`);
  if (config.members.some((m) => m.actorPub === chaserPub)) return config;

  const updated = {
    ...config,
    members: [...config.members, { actorPub: chaserPub, role: 'chaser', addedAt: Date.now() }],
    readers: [...config.readers, chaserPub],
  };
  await writeThreadMeta(qu, identity, services, spaceId, threadId, updated);
  await notifyChaserInvite(spaceId, services, chaserPub, gameId, config.chasedPub);
  return updated;
}

/**
 * Patches `status`/`settings` (a shallow merge into the existing `settings`
 * object, so a caller only passing `{mapMode: 'osm'}` doesn't clobber the
 * other settings fields) and/or `caughtBy`. CHASED-ONLY, same ACL enforcement
 * as `inviteChaser()` - `writers: [chasedPub]` means `AccessEngine` itself
 * rejects this write from any chaser. In practice that means a chaser whose
 * own proximity check (`src/proximity.js`) reaches catch range only ever
 * shows them an informational "you're within catch range" state (see
 * client.js's own Catch button) - only the CHASED player's own device
 * actually ends the game as caught, e.g. after being tagged in person and
 * confirming it themselves. This keeps the same single-writer ACL model the
 * rest of this file already relies on, rather than inventing a second,
 * cross-actor write path just for this one field.
 *
 * `startedAt` is set once, the moment the chased player starts the chase
 * (`status: 'active'`) - `endedAt`/`durationMs` are then derived
 * automatically the moment `status: 'ended'` is ever reached (whether from an
 * explicit `endedAt` or just `status`), never by the caller computing them
 * itself - this is what req. 5's "duration of the game until the catch" is
 * built from, without a second write.
 *
 * `startDistances` (shallow-merged into the existing map, never replaced
 * wholesale) records, once per chaser, the great-circle distance between
 * them and the chased player AT THE MOMENT that chaser's position was first
 * seen after the chase started - only ever written by the CHASED player's
 * own device (the one live view that both computes it, via
 * `src/geometry.js`'s `haversineMeters()`, and holds write access), the
 * instant it notices a chaser it doesn't have a starting distance for yet
 * (see client.js's own `updateLiveView()`). Never overwritten afterward, so
 * it stays a true "how big a head start did they have" figure for later
 * review, not a live distance readout (the player list already shows that).
 * @param {import('@qu/core').QuStore} qu @param {import('@qu/identity').QuIdentityEngine} identity @param {object} services
 * @param {string|number} spaceId @param {string} gameId
 * @param {{status?: 'pending'|'active'|'ended', settings?: Partial<typeof DEFAULT_SETTINGS>, caughtBy?: string, startDistances?: Record<string, number>}} patch
 */
export async function updateGame(qu, identity, services, spaceId, gameId, { status, settings, caughtBy, startDistances } = {}) {
  const threadId = gameThreadId(gameId);
  const config = await services.messages.getConfig(spaceId, threadId);
  if (!config) throw new Error(`geochase: no game "${gameId}" in space "${spaceId}"`);
  const nextStatus = status ?? config.status;
  const startedAt = nextStatus === 'active' && !config.startedAt ? Date.now() : config.startedAt ?? null;
  const justEnded = nextStatus === 'ended' && config.status !== 'ended';
  const endedAt = justEnded ? Date.now() : config.endedAt ?? null;
  const durationMs = justEnded && startedAt ? endedAt - startedAt : config.durationMs ?? null;
  const updated = {
    ...config,
    status: nextStatus,
    settings: settings ? { ...config.settings, ...settings } : config.settings,
    startedAt,
    endedAt,
    durationMs,
    caughtBy: caughtBy ?? config.caughtBy ?? null,
    // NEW keys only - an existing entry is never overwritten (see this
    // function's own `startDistances` doc comment above): `startDistances`
    // spread FIRST, so a caller re-reporting an already-recorded chaser
    // (e.g. a stale duplicate "first sighting" tick) can't clobber the true
    // original value.
    startDistances: startDistances ? { ...startDistances, ...(config.startDistances ?? {}) } : (config.startDistances ?? {}),
  };
  await writeThreadMeta(qu, identity, services, spaceId, threadId, updated);
  return updated;
}

/**
 * SIGNED, NEVER ENCRYPTED - same convention `MessageService.addReader()`/
 * `removeReader()` already establish for thread META (as opposed to message
 * BODIES, which the same restricted-readers thread DOES encrypt): a
 * thread's own config (who's in it, its own extra fields here - gameId/
 * chasedPub/status/settings/members) isn't considered sensitive the way
 * message content is. Using `services.access.writeOptionsFor()` here (built
 * for restricted DOCUMENTS, which ARE fully encrypted) would silently
 * encrypt this meta update instead of just signing it - caught by this
 * file's own tests asserting the returned/re-read config is still a plain
 * object, not a `{iv, ct, to}` envelope.
 * @param {import('@qu/core').QuStore} qu @param {import('@qu/identity').QuIdentityEngine} identity @param {object} services
 * @param {string|number} spaceId @param {string} threadId @param {object} updated
 */
async function writeThreadMeta(qu, identity, services, spaceId, threadId, updated) {
  const signKey = await identity.getMainKey();
  await qu.put(paths.threadMetaPath(spaceId, threadId), updated, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  await services.access.protect(spaceId, 'threads', threadId, { writers: updated.writers, readers: updated.readers }, { includeSelfAsWriter: false });
}

/** @returns {Promise<Array<{id: string, starredAt: number}>>} Every game (chased or invited-as-chaser) this identity has starred. */
export async function listMyGames(services) {
  return services.sharing.listMine(FLAG_TYPE, ENTITY_KIND);
}

/** Scans this identity's own invite mailbox for `geochase-invite` notifications and stars any game it's still a real member of - call once per mount, mirrors apps/todo's/apps/calendar's own `discoverPendingInvites()` guard. */
export async function discoverInvites(services, spaceId) {
  await services.sharing.discoverPendingInvites(spaceId, {
    flagType: FLAG_TYPE,
    entityKind: ENTITY_KIND,
    resourceKey: 'gameId',
    fetchMeta: (gameId) => readGame(services, spaceId, gameId),
  });
}
