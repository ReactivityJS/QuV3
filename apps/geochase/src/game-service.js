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
 *   - Invites are the SAME `services.messages.notify()` "personal mailbox"
 *     push every other app's own invite flow uses (ToDo/Calendar) -
 *     `discoverPendingInvites()`'s `resourceKey: 'gameId'` reads it back off
 *     that notification's own `extra`.
 */

const FLAG_TYPE = 'geochase';
const ENTITY_KIND = 'game';

export const DEFAULT_SETTINGS = {
  chasedIntervalMs: 5_000, // how often the CHASED device pushes its own position
  chaserIntervalMs: 3_000, // how often each CHASER device pushes its own position
  mapMode: 'plane', // 'plane' (abstract canvas) | 'osm' (+ an OpenStreetMap embed)
  showRadius: true, // the chased player's speed-based "could be anywhere in here" circle
  assumedMinSpeedMps: 1.2, // see geometry.js's own possibleRadiusMeters() doc comment
};

export function gameThreadId(gameId) { return `geochase-${gameId}`; }

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
    settings: { ...DEFAULT_SETTINGS, ...settingsOverride },
    createdAt: Date.now(),
  });
  await services.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, gameId, true, {});
  return config;
}

/** @returns {Promise<object|null>} The game's current config, or null if it doesn't exist (yet). */
export async function readGame(services, spaceId, gameId) {
  return services.messages.getConfig(spaceId, gameThreadId(gameId));
}

/**
 * Invites `chaserPub` - grows BOTH `members` (role introspection, see this
 * file's own top doc comment) and `readers` (the actual encryption ACL) in
 * one write, then pushes a personal-mailbox notification so their own
 * `discoverInvites()` (and, per the existing pushActions convention, a real
 * push notification) picks it up even before they open Geo Chase at all.
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
  await services.messages.notify(spaceId, chaserPub, 'geochase-invite', { gameId, chasedPub: config.chasedPub });
  return updated;
}

/**
 * Patches `status` and/or `settings` (a shallow merge into the existing
 * `settings` object, so a caller only passing `{mapMode: 'osm'}` doesn't
 * clobber the other settings fields). CHASED-only, same ACL enforcement as
 * `inviteChaser()`.
 * @param {import('@qu/core').QuStore} qu @param {import('@qu/identity').QuIdentityEngine} identity @param {object} services
 * @param {string|number} spaceId @param {string} gameId
 * @param {{status?: 'pending'|'active'|'ended', settings?: Partial<typeof DEFAULT_SETTINGS>}} patch
 */
export async function updateGame(qu, identity, services, spaceId, gameId, { status, settings } = {}) {
  const threadId = gameThreadId(gameId);
  const config = await services.messages.getConfig(spaceId, threadId);
  if (!config) throw new Error(`geochase: no game "${gameId}" in space "${spaceId}"`);
  const updated = {
    ...config,
    status: status ?? config.status,
    settings: settings ? { ...config.settings, ...settings } : config.settings,
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
