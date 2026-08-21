import { QuCrypto } from '@qu/core';
import { isEncryptedEnvelope, decryptEnvelope } from '@qu/services';
import { gameThreadId } from './game-service.js';

/**
 * TRACK SERVICE — persists each player's own location history ("Streckenverlauf",
 * req. 5/6/7/8) as one QuBit per ping, a sibling namespace of the game's own
 * thread (`track/<actorPub>/<pointId>`, alongside `meta`/`msgs`/`webrtc/...` -
 * same "one item per path under a shared parent, enumerate via getChildren()"
 * shape `paths.js`'s own `threadMessagePath()`/`webrtcIceCandidatePath()`
 * already establish for high-frequency per-item data - see that file's own
 * doc comment on why this is the right shape for something written every few
 * minutes for a whole game's duration, unlike a single growing array field
 * that a Calendar-style whole-document rewrite would have to touch on every
 * single ping).
 *
 * ENCRYPTED, NOT JUST SIGNED — deliberately the OPPOSITE convention from the
 * game's own thread META (`game-service.js`'s `writeThreadMeta()`, signed
 * only): a location history is real, precise PII, unlike membership/settings/
 * duration. `services.access.writeOptionsFor(spaceId, 'threads', threadId)`
 * reuses the SAME ACL entry `writeThreadMeta()` already maintains via
 * `services.access.protect(spaceId, 'threads', threadId, {writers, readers})`
 * (grown on every `inviteChaser()`) - so every current game member, and only
 * them, can decrypt a track point, with zero new ACL machinery. Per
 * `AccessService.writeOptionsFor()`'s own GOTCHA doc comment, restricted
 * `readers` encryption is only safe for `kind: 'threads'` today (the only
 * kind with a decrypt-aware reader, `MessageService`/here) - exactly what
 * this is.
 *
 * NOT RETROACTIVE, same caveat `MessageService.addReader()`/`removeReader()`
 * already document for message bodies: a track point recorded BEFORE a
 * chaser was invited stays encrypted for the reader set at write time, never
 * re-keyed after the fact.
 */

let localSeq = 0;
/** A monotonically-increasing-enough id for one ping - timestamp collisions within the same ms are still disambiguated by the trailing counter. */
function nextPointId() {
  return `${Date.now().toString(36)}-${(localSeq++).toString(36)}`;
}

function trackParentPath(spaceId, threadId, actorPub) {
  return `/store/${spaceId}/threads/${threadId}/track/${actorPub}`;
}
function trackPointPath(spaceId, threadId, actorPub, pointId) {
  return `${trackParentPath(spaceId, threadId, actorPub)}/${pointId}`;
}

/**
 * Records one location ping for the CALLING identity - always writes under
 * their own pubkey (there is no cross-actor write here, mirroring
 * `mesh.js`'s own `putPosition()`).
 * @param {import('@qu/core').QuStore} qu @param {import('@qu/identity').QuIdentityEngine} identity @param {object} services
 * @param {string|number} spaceId @param {string} gameId
 * @param {{lat: number, lng: number, heading?: number, speed?: number, ts?: number}} point
 * @returns {Promise<string>} The written point's own id.
 */
export async function recordTrackPoint(qu, identity, services, spaceId, gameId, point) {
  const threadId = gameThreadId(gameId);
  const signKey = await identity.getMainKey();
  const actorPub = QuCrypto.toBase64Url(signKey.publicKey);
  const writeOptions = await services.access.writeOptionsFor(spaceId, 'threads', threadId);
  const pointId = nextPointId();
  await qu.put(
    trackPointPath(spaceId, threadId, actorPub, pointId),
    { lat: point.lat, lng: point.lng, heading: point.heading ?? null, speed: point.speed ?? null, ts: point.ts ?? Date.now() },
    writeOptions
  );
  return pointId;
}

/**
 * @param {(actorPub: string) => Promise<object|null>} getProfile
 */
async function decryptPoint(quBit, identity, getProfile) {
  if (!isEncryptedEnvelope(quBit.val)) return quBit.val; // a pre-encryption point, or this identity's own (never encrypted FOR itself, see resolveReaderXKeys' own reader-list semantics) - defensive, not the expected common case
  return decryptEnvelope(quBit, identity, getProfile);
}

/**
 * @param {import('@qu/core').QuStore} qu @param {import('@qu/identity').QuIdentityEngine} identity @param {object} services
 * @param {string|number} spaceId @param {string} gameId @param {string} actorPub - whose track to read.
 * @param {{limit?: number, syncFetch?: (path: string) => Promise<object|null>}} [options]
 * @returns {Promise<Array<{lat: number, lng: number, heading: number|null, speed: number|null, ts: number}>>}
 *   Oldest first - ready to feed straight into a map renderer's own path/polyline.
 */
export async function listTrackPoints(qu, identity, services, spaceId, gameId, actorPub, { limit, syncFetch = null } = {}) {
  const threadId = gameThreadId(gameId);
  const parentPath = trackParentPath(spaceId, threadId, actorPub);
  if (syncFetch) await syncFetch(parentPath).catch(() => {});
  const entries = await qu.getChildren(parentPath, { sort: 'ts', order: 'asc', limit });
  const getProfile = async (pub) => {
    const local = await identity.getProfile(pub);
    if (local || !syncFetch) return local;
    await syncFetch(`/store/actors/~${pub}/profile`).catch(() => {});
    return identity.getProfile(pub);
  };
  const points = [];
  for (const { quBit } of entries) {
    if (quBit.val == null) continue;
    const val = await decryptPoint(quBit, identity, getProfile);
    if (val) points.push(val);
  }
  return points;
}
