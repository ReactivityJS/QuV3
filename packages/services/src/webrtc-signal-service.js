import { QuCrypto } from '@qu/core';
import { webrtcPairKey, webrtcOfferPath, webrtcAnswerPath, webrtcIceCandidatePath } from './paths.js';

const DEFAULT_CLEANUP_DELAY_MS = 5_000;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 20_000;

/**
 * WEBRTC SIGNAL SERVICE — bridges `@qu/webrtc`'s `WebRTCTransport` (a
 * general `Transport` implementation that knows nothing about paths,
 * Threads, or identity - see that package's own doc comment) to the
 * EXISTING relay-backed sync stack, which is what actually carries SDP
 * offers/answers/ICE candidates between two peers before their direct
 * WebRTC connection exists.
 *
 * Signals are written as ordinary signed QuBits under a Thread's own
 * `webrtc/<pairKey>` namespace (see `paths.js`) - the Thread already has a
 * fixed, known member list (`MessageService.createThread()`/
 * `THREAD_PRESETS`), so `connectPeer()`'s caller supplies `memberPubs` and
 * this service verifies every incoming signal's own verified `pub` against
 * it before acting on it. `AccessEngine` does NOT cover these paths (its
 * thread-path regex only recognizes `meta`/`msgs/...`, see
 * `@qu/engines`' `access-engine.js`) - this membership check is the only
 * real gate, by design, the same "never trust a path segment, always key
 * off the verified pub" discipline `ReactionService`/`PresenceService`
 * already document and rely on. No new relay message type or peer/room
 * primitive is needed - this rides the EXISTING Thread pub-sub, so it
 * inherits offline-tolerant delivery (outbox replay, reconnect catch-up)
 * for free.
 *
 * Cleanup: once `webrtcTransport.onPeerConnected()` fires for a pair, this
 * service tombstones (writes `null`, same convention `threadPinPath()`
 * uses - `QuStore` has no `delete()`) every signaling path it wrote for
 * that pair, after a short grace delay (a slow-to-apply trickled ICE
 * candidate must not be lost mid-flight). The same cleanup runs if
 * negotiation never completes within `negotiationTimeoutMs`, so a stale/
 * abandoned exchange doesn't sit in the relay's durable storage forever.
 */
export class WebRtcSignalService {
  #qu;
  #identity;
  #transport;
  #cleanupDelayMs;
  #negotiationTimeoutMs;
  /** @type {Map<string, {spaceId: string|number, threadId: string, remotePub: string, memberPubs: string[], selfPub: string, iceSeq: number, timeoutTimer: ReturnType<typeof setTimeout>|null}>} */
  #pairs = new Map();
  #unsubscribeOutgoing;
  #unsubscribeConnected;
  #unsubscribeStorage;

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('@qu/webrtc/transport').WebRTCTransport} webrtcTransport
   * @param {{cleanupDelayMs?: number, negotiationTimeoutMs?: number}} [options]
   */
  constructor(qu, identityEngine, webrtcTransport, { cleanupDelayMs = DEFAULT_CLEANUP_DELAY_MS, negotiationTimeoutMs = DEFAULT_NEGOTIATION_TIMEOUT_MS } = {}) {
    this.#qu = qu;
    this.#identity = identityEngine;
    this.#transport = webrtcTransport;
    this.#cleanupDelayMs = cleanupDelayMs;
    this.#negotiationTimeoutMs = negotiationTimeoutMs;

    this.#unsubscribeOutgoing = this.#transport.onOutgoingSignal((peerId, signal) => {
      this.#sendSignal(peerId, signal).catch((err) => console.error('[WebRtcSignalService] failed to send outgoing signal:', err));
    });
    this.#unsubscribeConnected = this.#transport.onPeerConnected((peerId) => this.#handleConnected(peerId));
    this.#unsubscribeStorage = this.#qu.onStorageChange(({ path, quBit }) => {
      this.#handleStorageChange(path, quBit).catch((err) => console.error('[WebRtcSignalService] failed to handle incoming signal:', err));
    });
  }

  /** @returns {Promise<string>} base64url pubkey of this identity's main key. */
  async #myActorPub() {
    const mainKey = await this.#identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /** @param {object} quBit @returns {string|null} base64url actor pubkey, or null if unsigned. */
  #actorPubOf(quBit) {
    return quBit?.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
  }

  /**
   * Starts (or resumes) a WebRTC handshake with `remotePub` over the given
   * Thread's signaling namespace. Safe to call from BOTH sides of a pair -
   * only the deterministic initiator (see `WebRTCTransport`'s own doc
   * comment) actually sends an offer; the other side just starts watching
   * and waiting for one.
   * @param {string|number} spaceId @param {string} threadId @param {string} remotePub
   * @param {string[]} memberPubs - The Thread's known member list, checked
   *   against every incoming signal's own verified `pub` before it's trusted.
   */
  async connectPeer(spaceId, threadId, remotePub, memberPubs) {
    const selfPub = await this.#myActorPub();
    const pairKey = webrtcPairKey(selfPub, remotePub);
    if (!this.#pairs.has(pairKey)) {
      this.#pairs.set(pairKey, { spaceId, threadId, remotePub, memberPubs, selfPub, iceSeq: 0, timeoutTimer: null });
      this.#armTimeout(pairKey);
    }
    this.#transport.addPeer(remotePub);
  }

  #armTimeout(pairKey) {
    const pair = this.#pairs.get(pairKey);
    if (!pair) return;
    pair.timeoutTimer = setTimeout(() => {
      this.#cleanup(pairKey).catch((err) => console.error('[WebRtcSignalService] cleanup after negotiation timeout failed:', err));
    }, this.#negotiationTimeoutMs);
  }

  async #handleConnected(peerId) {
    for (const [pairKey, pair] of this.#pairs) {
      if (pair.remotePub !== peerId) continue;
      if (pair.timeoutTimer) clearTimeout(pair.timeoutTimer);
      setTimeout(() => {
        this.#cleanup(pairKey).catch((err) => console.error('[WebRtcSignalService] post-connect cleanup failed:', err));
      }, this.#cleanupDelayMs);
    }
  }

  /** @param {string} remotePub @param {object} signal */
  async #sendSignal(remotePub, signal) {
    const selfPub = await this.#myActorPub();
    const pairKey = webrtcPairKey(selfPub, remotePub);
    const pair = this.#pairs.get(pairKey);
    if (!pair) return; // connectPeer() was never called for this pair - nothing to address it with
    const signKey = await this.#identity.getMainKey();
    const options = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    if (signal.type === 'offer') {
      await this.#qu.put(webrtcOfferPath(pair.spaceId, pair.threadId, pairKey), { sdp: signal.sdp, from: selfPub }, options);
    } else if (signal.type === 'answer') {
      await this.#qu.put(webrtcAnswerPath(pair.spaceId, pair.threadId, pairKey), { sdp: signal.sdp, from: selfPub }, options);
    } else if (signal.type === 'ice') {
      const seq = pair.iceSeq++;
      await this.#qu.put(webrtcIceCandidatePath(pair.spaceId, pair.threadId, pairKey, selfPub, seq), { candidate: signal.candidate, from: selfPub }, options);
    }
  }

  /**
   * @param {string} path @param {object} quBit
   * Fires on EVERY write to `#qu` (this identity's own included, see
   * `QuStore.onStorageChange()`'s own doc comment) - the `actorPub ===
   * pair.selfPub` check below is what stops this service from feeding its
   * own just-sent offer/answer/ICE candidate straight back into its own
   * `WebRTCTransport` as if it had arrived from the remote side.
   */
  async #handleStorageChange(path, quBit) {
    for (const [pairKey, pair] of this.#pairs) {
      const prefix = `/store/${pair.spaceId}/threads/${pair.threadId}/webrtc/${pairKey}/`;
      if (!path.startsWith(prefix)) continue;
      const actorPub = this.#actorPubOf(quBit);
      if (!actorPub || actorPub === pair.selfPub || !pair.memberPubs.includes(actorPub)) return;
      const rel = path.slice(prefix.length);
      const val = quBit.val;
      if (rel === 'offer' && val?.sdp) {
        this.#transport.handleIncomingSignal(pair.remotePub, { type: 'offer', sdp: val.sdp });
      } else if (rel === 'answer' && val?.sdp) {
        this.#transport.handleIncomingSignal(pair.remotePub, { type: 'answer', sdp: val.sdp });
      } else if (rel.startsWith('ice/') && val?.candidate) {
        this.#transport.handleIncomingSignal(pair.remotePub, { type: 'ice', candidate: val.candidate });
      }
      return;
    }
  }

  /** @param {string} pairKey */
  async #cleanup(pairKey) {
    const pair = this.#pairs.get(pairKey);
    if (!pair) return;
    if (pair.timeoutTimer) clearTimeout(pair.timeoutTimer);
    this.#pairs.delete(pairKey);
    const signKey = await this.#identity.getMainKey();
    const options = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    await this.#qu.put(webrtcOfferPath(pair.spaceId, pair.threadId, pairKey), null, options).catch(() => {});
    await this.#qu.put(webrtcAnswerPath(pair.spaceId, pair.threadId, pairKey), null, options).catch(() => {});
    for (let seq = 0; seq < pair.iceSeq; seq++) {
      await this.#qu.put(webrtcIceCandidatePath(pair.spaceId, pair.threadId, pairKey, pair.selfPub, seq), null, options).catch(() => {});
    }
  }

  /** Unsubscribes from the transport/storage-change hooks - call when tearing this service down. */
  close() {
    this.#unsubscribeOutgoing?.();
    this.#unsubscribeConnected?.();
    this.#unsubscribeStorage?.();
  }
}
