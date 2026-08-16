import { QuCrypto } from '@qu/core';
import { webrtcPairKey, webrtcOfferPath, webrtcAnswerPath, webrtcIceCandidatePath, webrtcDeclinePath } from './paths.js';

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
 * abandoned exchange doesn't sit in the relay's durable storage forever -
 * or immediately once a `declineCall()` (see below) is observed. A timeout
 * ALSO fires `onTimeout()` (below), so a consumer (e.g. `apps/phone`) can
 * show a visible "couldn't connect" state instead of silently hanging - the
 * exact gap a symmetric-NAT/no-TURN failure used to fall into unnoticed.
 *
 * CALLER-INITIATED CALLS (`apps/phone`): `connectPeer()`'s deterministic
 * initiator tie-break (see `WebRTCTransport`'s own doc comment) is right for
 * a mesh where every peer eventually connects to every other one (Geochase),
 * but wrong for "the caller always starts the call" - the caller could just
 * as easily land on the passive/answerer role depending on how the two
 * pubkeys happen to compare, and then nobody would ever send an offer.
 * `connectPeer()`'s `initiator` option overrides the tie-break explicitly
 * for exactly this case. `declineCall()`/`onDeclined()` add a THIRD signal
 * type (alongside offer/answer/ICE) for a callee to reject a call before any
 * `RTCPeerConnection` activity ever starts - not a `WebRTCTransport`-level
 * concept (it's not an SDP/ICE signal, `WebRTCTransport` never sees it),
 * purely a `WebRtcSignalService`-level one.
 */
export class WebRtcSignalService {
  #qu;
  #identity;
  #transport;
  #cleanupDelayMs;
  #negotiationTimeoutMs;
  /** @type {Map<string, {spaceId: string|number, threadId: string, remotePub: string, memberPubs: string[], selfPub: string, iceSeq: number, timeoutTimer: ReturnType<typeof setTimeout>|null}>} */
  #pairs = new Map();
  #declinedCallbacks = [];
  #timeoutCallbacks = [];
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
   * by default only the deterministic initiator (see `WebRTCTransport`'s own
   * doc comment) actually sends an offer, the other side just starts
   * watching and waiting for one.
   * @param {string|number} spaceId @param {string} threadId @param {string} remotePub
   * @param {string[]} memberPubs - The Thread's known member list, checked
   *   against every incoming signal's own verified `pub` before it's trusted.
   * @param {{initiator?: boolean, localStream?: MediaStream}} [options] -
   *   `initiator`: explicit override for the deterministic tie-break - e.g.
   *   a Phone app's caller always passes `{initiator: true}` (it started the
   *   call, regardless of how the two pubkeys compare), the callee passes
   *   `{initiator: false}` once it accepts. Passed straight through to
   *   `WebRTCTransport.addPeer()`. `localStream`: local camera/mic tracks
   *   for a call - see `WebRTCTransport.addPeer()`'s own doc comment for why
   *   these must be supplied here, at connection start, not attached later.
   */
  async connectPeer(spaceId, threadId, remotePub, memberPubs, { initiator, localStream } = {}) {
    const selfPub = await this.#myActorPub();
    const pairKey = webrtcPairKey(selfPub, remotePub);
    if (!this.#pairs.has(pairKey)) {
      this.#pairs.set(pairKey, { spaceId, threadId, remotePub, memberPubs, selfPub, iceSeq: 0, timeoutTimer: null });
      this.#armTimeout(pairKey);
    }
    this.#transport.addPeer(remotePub, { initiator, localStream });
  }

  /**
   * Rejects an incoming call BEFORE any `RTCPeerConnection` negotiation ever
   * starts - deliberately does NOT require `connectPeer()` to have been
   * called first (a callee declining straight from a push notification, per
   * `apps/phone`'s design, may never open the app's own call view at all).
   * Writes a signed tombstone-shaped QuBit the caller's own `onDeclined()`
   * listener picks up via the same `#handleStorageChange()` this class
   * already runs for offer/answer/ICE.
   * @param {string|number} spaceId @param {string} threadId @param {string} remotePub
   */
  async declineCall(spaceId, threadId, remotePub) {
    const selfPub = await this.#myActorPub();
    const pairKey = webrtcPairKey(selfPub, remotePub);
    const signKey = await this.#identity.getMainKey();
    await this.#qu.put(
      webrtcDeclinePath(spaceId, threadId, pairKey),
      { declined: true, from: selfPub },
      { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey }
    );
  }

  /**
   * Registers a callback fired when the OTHER side of a pair this instance
   * called `connectPeer()` for calls `declineCall()`. Only meaningful for a
   * pair actually registered via `connectPeer()` (the caller side) - see
   * `declineCall()`'s own doc comment for why the callee side has no
   * matching requirement.
   * @param {(remotePub: string) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onDeclined(callback) {
    this.#declinedCallbacks.push(callback);
    return () => {
      const idx = this.#declinedCallbacks.indexOf(callback);
      if (idx !== -1) this.#declinedCallbacks.splice(idx, 1);
    };
  }

  /**
   * Registers a callback fired when a pair this instance called
   * `connectPeer()` for never reaches `onPeerConnected` within
   * `negotiationTimeoutMs` - e.g. no usable ICE candidate pair exists at all
   * (a classic symmetric-NAT/no-TURN failure - see this plan's own "Bugfix:
   * Keine WebRTC-Verbindung zwischen Smartphone und Desktop" section) or the
   * other side simply never answers. Without this, a stuck negotiation was
   * previously silent - `#armTimeout()` only ever tombstoned the signaling
   * paths, with no way for a caller (e.g. `apps/phone`'s own UI) to learn
   * the attempt is over and show a visible failure instead of hanging on
   * "Calling…" forever. Never fires for a pair that DID connect in time -
   * `#handleConnected()` clears `timeoutTimer` before this can run.
   * @param {(remotePub: string) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onTimeout(callback) {
    this.#timeoutCallbacks.push(callback);
    return () => {
      const idx = this.#timeoutCallbacks.indexOf(callback);
      if (idx !== -1) this.#timeoutCallbacks.splice(idx, 1);
    };
  }

  #armTimeout(pairKey) {
    const pair = this.#pairs.get(pairKey);
    if (!pair) return;
    pair.timeoutTimer = setTimeout(() => {
      for (const cb of this.#timeoutCallbacks) cb(pair.remotePub);
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
      } else if (rel === 'declined' && val?.declined) {
        for (const cb of this.#declinedCallbacks) cb(pair.remotePub);
        this.#cleanup(pairKey).catch((err) => console.error('[WebRtcSignalService] cleanup after decline failed:', err));
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
    await this.#qu.put(webrtcDeclinePath(pair.spaceId, pair.threadId, pairKey), null, options).catch(() => {});
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
