import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { SyncEngine } from '@qu/sync';
import { WebRTCTransport } from '@qu/webrtc/transport';
import { WebRTCAdapter } from '@qu/webrtc/adapter';
import { THREAD_PRESETS, WebRtcSignalService } from '@qu/services';
import { watchChildren } from '@qu/reactive';
import { createLogger } from '@qu/log';

const log = createLogger('geochase:mesh');

/**
 * GEOCHASE MESH — this pilot's own composition wiring for the WebRTC-as-
 * app-feature foundation (see the plan's "Ein Mount, zwei Zugriffsformen,
 * ein pluggable Backend" / "Persistenz & Re-Sync für private Direktkanäle"
 * sections): a SECOND, independent `QuStore` (`p2pQu`) mounts a `p2p` mount
 * backed by `@qu/webrtc`'s `WebRTCAdapter` - state side (`put`/`get`/
 * `getChildren`) for player positions, backed by a plain `MemoryStoreAdapter`
 * (positions don't need to survive a reload - a fresh WebRTC handshake would
 * be required after one regardless); event side (`on`/`emit`) available for
 * lightweight game-lifecycle signals (e.g. "game started"), demonstrated in
 * this pilot's own tests even though the UI itself only needs the state
 * side. A second `SyncEngine` (deliberately no `publishAllTo` - a
 * `subscribe()`-based MESH of however many players are in this game, not a
 * client-relay star) replicates that mount over the SAME `WebRTCTransport`
 * to every connected peer.
 *
 * Deliberately a SEPARATE `QuStore` from the app's main, relay-synced `qu`:
 * `QuStore.onStorageChange()` is global across every mount on ONE instance,
 * so putting `p2p` on the SAME `qu` the shell's relay-facing `SyncEngine`
 * already watches would silently forward every position update to the relay
 * too - exactly the "no relay routing/storage" property this feature exists
 * to avoid. See the plan's "Architektur-Entscheidung im Überblick" section.
 *
 * Signaling (SDP/ICE) rides the EXISTING relay-backed `qu`/
 * `services.messages` Thread, via `WebRtcSignalService` - entirely separate
 * machinery from the mesh `SyncEngine` above, on purpose.
 *
 * @param {{qu: import('@qu/core').QuStore, identity: import('@qu/identity').QuIdentityEngine, services: object, spaceId: string, threadId: string, gameId: string, iceServers?: Array<object>}} options
 */
export async function createGeochaseMesh({ qu, identity, services, spaceId, threadId, gameId, iceServers } = {}) {
  const mainKey = await identity.getMainKey();
  const selfPub = QuCrypto.toBase64Url(mainKey.publicKey);

  const p2pQu = new QuStore();
  const localAdapter = new MemoryStoreAdapter();
  const webrtcTransport = new WebRTCTransport({ selfPeerId: selfPub, iceServers });
  const webrtcAdapter = new WebRTCAdapter({ localAdapter, webrtcTransport });
  p2pQu.mount('p2p', webrtcAdapter);

  // No `publishAllTo` - see this file's own top doc comment. `subscribe()`
  // is what makes this a genuine N-peer mesh rather than a star.
  const meshSync = new SyncEngine(p2pQu, webrtcTransport);
  const signalService = new WebRtcSignalService(qu, identity, webrtcTransport);

  const playersPrefix = `/p2p/geochase/${gameId}/players`;

  webrtcTransport.onPeerConnected((peerId) => {
    log.info(`connected to peer "${peerId}" - subscribing and requesting catch-up`);
    meshSync.subscribe(playersPrefix, peerId);
    // RECIPROCAL CATCH-UP - `subscribe()` only ever delivers FUTURE writes
    // (see `SyncEngine`'s own doc comment), so a player who joins after
    // others are already moving needs this to see where they currently are.
    meshSync.fetchPrefix(playersPrefix, peerId).catch((err) => log.warn(`fetchPrefix catch-up from "${peerId}" failed:`, err.message));
  });

  /**
   * Ensures a Thread exists for this game's signaling (a fixed member list,
   * the same `MessageService.createThread()` any other app uses) and starts
   * (or resumes) the WebRTC handshake with `remotePub`. Safe to call from
   * every participant, in any order - see `WebRtcSignalService.connectPeer()`'s
   * own doc comment for why only the deterministic initiator actually sends
   * an offer.
   * @param {string} remotePub @param {string[]} memberPubs
   */
  async function connectToPeer(remotePub, memberPubs) {
    await services.messages.createThread(spaceId, threadId, THREAD_PRESETS.chat(memberPubs));
    await signalService.connectPeer(spaceId, threadId, remotePub, memberPubs);
  }

  /**
   * Writes this identity's own current position - locally into `localAdapter`
   * AND, via the mesh `SyncEngine`'s `onStorageChange` listener, out to every
   * subscribed peer. `MemoryStoreAdapter.put()`'s own ts-guard is already the
   * entire "only keep the latest position" policy - no separate TTL/expiry
   * mechanism is needed (see `listPlayers()`'s own doc comment for how
   * staleness is instead handled on READ).
   * @param {{lat: number, lng: number, heading?: number, speed?: number}} position
   */
  async function putPosition(position) {
    const signKey = await identity.getMainKey();
    const actorPub = QuCrypto.toBase64Url(signKey.publicKey);
    await p2pQu.put(`${playersPrefix}/${actorPub}`, { ...position, ts: Date.now() }, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /** @param {Array<{path: string, quBit: object}>} entries @returns {Array<{actorPub: string, position: object}>} */
  function toPlayers(entries) {
    return entries.filter((e) => e.quBit.val != null).map((e) => ({ actorPub: e.path.split('/').pop(), position: e.quBit.val }));
  }

  /** @returns {Promise<Array<{actorPub: string, position: object}>>} Every currently known player, most-recently-updated first. */
  async function listPlayers() {
    return toPlayers(await p2pQu.getChildren(playersPrefix, { order: 'desc' }));
  }

  /**
   * Live view of every player's position - re-fires whenever any player
   * (including this identity) writes a new one. No staleness/TTL filtering
   * here on purpose: a "has this player gone quiet?" decision belongs to the
   * caller (mirrors `PresenceService.getPresence()`'s own `staleAfterMs`
   * convention), not baked into the mesh itself.
   * @param {(players: Array<{actorPub: string, position: object}>) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  function watchPlayers(callback) {
    return watchChildren(p2pQu, playersPrefix, (entries) => callback(toPlayers(entries)));
  }

  function close() {
    signalService.close();
  }

  return { p2pQu, webrtcTransport, meshSync, signalService, selfPub, connectToPeer, putPosition, listPlayers, watchPlayers, close };
}
