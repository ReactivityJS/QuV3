import { QuCrypto } from '@qu/core';
import { isEncryptedEnvelope, decryptEnvelope } from '@qu/services';
import { watchChildren } from '@qu/reactive';
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
 *
 * THIS IS ALSO NOW THE LIVE "CURRENT POSITION" CHANNEL, not just history -
 * `watchLatestPositions()` below. Geo Chase originally exchanged LIVE
 * positions over a separate, ephemeral WebRTC mesh (`mesh.js`) and only
 * ever wrote here for the persisted trail - two independent channels for
 * what is fundamentally the same data. That mesh depends on a direct P2P
 * connection actually forming between every pair of devices (ICE/NAT
 * traversal, TURN availability, browser quirks) - unreliable enough in
 * practice ("Position wird nicht zuverlässig übermittelt") to make the game
 * itself unplayable when it fails, with no fallback. The relay-backed store
 * every OTHER live thing in this app (chat messages, thread meta, presence)
 * already rides reliably has no such requirement - a write just needs to
 * reach the relay once, the same `subscribe(paths.spacePath(SPACE_ID))` this
 * app's own `client.js` already does at mount covers this nested `track/...`
 * path for free (it's a plain prefix), and `SyncEngine`'s own reconnect
 * catch-up means a temporarily offline player's positions simply arrive once
 * they're back, rather than being lost. `client.js` no longer creates a
 * WebRTC mesh for gameplay at all - `mesh.js` remains as a tested, reusable
 * building block for a future feature that genuinely wants P2P (e.g. voice),
 * just no longer this one's only path to a working game.
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
 * @param {import('@qu/identity').QuIdentityEngine} identity
 * @param {(path: string) => Promise<object|null>} [syncFetch] - Backfills a
 *   reader/sender profile this session hasn't synced yet, same convention
 *   every other Service's own internal `#getProfile()` uses (see
 *   `message-service.js`'s own constructor doc comment).
 * @returns {(actorPub: string) => Promise<object|null>}
 */
function buildGetProfile(identity, syncFetch) {
  return async (pub) => {
    const local = await identity.getProfile(pub);
    if (local || !syncFetch) return local;
    await syncFetch(`/store/actors/~${pub}/profile`).catch(() => {});
    return identity.getProfile(pub);
  };
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
  const getProfile = buildGetProfile(identity, syncFetch);
  const points = [];
  for (const { quBit } of entries) {
    if (quBit.val == null) continue;
    const val = await decryptPoint(quBit, identity, getProfile);
    if (val) points.push(val);
  }
  return points;
}

/**
 * The LIVE position feed - see this file's own top doc comment for why this
 * replaced the WebRTC mesh as Geo Chase's live channel. Watches each given
 * member's own track path directly (`watchChildren(..., {limit: 1, order:
 * 'desc'})` - the single newest point, `paths.js`-style "one item per path
 * under a shared parent" already sorted by the store's own write-time `ts`,
 * no need to fetch/decrypt a member's whole history just to find their
 * latest position), decrypts whichever point actually changed, and reports
 * the FULL current snapshot (every member's latest known position) on every
 * update - the same `players` shape `client.js`'s map renderers/player list
 * already expect, so no caller-side reshaping is needed at the call site
 * this replaces.
 * @param {import('@qu/core').QuStore} qu @param {import('@qu/identity').QuIdentityEngine} identity
 * @param {string|number} spaceId @param {string} gameId @param {string[]} memberPubs
 * @param {{syncFetch?: (path: string) => Promise<object|null>, onChange: (players: Array<{actorPub: string, position: object}>) => void}} options
 * @returns {() => void} Stop function - tears down every member's own watcher.
 */
export function watchLatestPositions(qu, identity, spaceId, gameId, memberPubs, { syncFetch = null, onChange }) {
  const threadId = gameThreadId(gameId);
  const getProfile = buildGetProfile(identity, syncFetch);
  const latest = new Map(); // actorPub -> decrypted position
  let stopped = false;

  function emit() {
    if (stopped) return;
    onChange([...latest].map(([actorPub, position]) => ({ actorPub, position })));
  }

  const unwatches = memberPubs.map((actorPub) =>
    watchChildren(
      qu,
      trackParentPath(spaceId, threadId, actorPub),
      (entries) => {
        const newest = entries[0]; // order: 'desc', limit: 1 below
        if (!newest || newest.quBit.val == null) return;
        decryptPoint(newest.quBit, identity, getProfile).then((val) => {
          if (stopped || !val) return;
          const current = latest.get(actorPub);
          if (current && current.ts >= val.ts) return; // an older/duplicate delivery racing a newer one already applied - never regress
          latest.set(actorPub, val);
          emit();
        });
      },
      { limit: 1, order: 'desc', syncFetch }
    )
  );

  return () => {
    stopped = true;
    for (const u of unwatches) u();
  };
}
