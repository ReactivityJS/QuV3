import { QuCrypto } from '@qu/core';
import { WebRTCTransport } from '@qu/webrtc/transport';
import { ChatService, THREAD_PRESETS, WebRtcSignalService } from '@qu/services';
import { createLogger } from '@qu/log';

const log = createLogger('phone:call');

/**
 * Realistic ring duration, not `@qu/webrtc`'s 20s default (meant for a
 * near-instant data-channel handshake, see `WebRtcSignalService`'s own doc
 * comment) - a callee may take 15-30s to notice and accept.
 */
const NEGOTIATION_TIMEOUT_MS = 45_000;

/**
 * PHONE CALL — this app's composition wiring, the thin, media-only
 * counterpart to `apps/geochase/src/mesh.js`. Unlike Geochase, a call needs
 * no `QuStore`/`WebRTCAdapter`/`SyncEngine` at all - just the raw
 * `WebRTCTransport` with local camera/mic tracks attached, and
 * `WebRtcSignalService` for signaling (SDP/ICE) over the existing
 * relay-backed Thread, exactly as Geochase uses it, just with an explicit
 * `initiator` role instead of the deterministic tie-break (a caller always
 * wants to BE the initiator, regardless of how the two pubkeys compare -
 * see `WebRtcSignalService.connectPeer()`'s own doc comment) and a much
 * longer `negotiationTimeoutMs` (a real ring, not a background data-channel
 * reconnect).
 *
 * The signaling Thread is NOT the two contacts' actual chat room - it's a
 * dedicated one, deterministically derived the SAME way
 * (`ChatService.roomId()`, reused as-is, not reinvented) but under this
 * app's OWN `spaceId`, so WebRTC signaling QuBits never show up in the
 * chat history. `THREAD_PRESETS.chat(memberPubs)` (encrypted, `readers` a
 * fixed 2-member array) - NOT `readers: '*'` - is load-bearing, not just a
 * privacy nicety: `packages/relay/src/push-delivery.js`'s own
 * `deliverThreadMessage()` only notifies "every other reader" for an
 * `Array.isArray(config.readers)` (private) thread; a `readers: '*'`
 * (public) thread only notifies explicit `@mentions`, which the one-line
 * announcement message below never has - using `readers: '*'` here once
 * silently broke incoming-call notifications entirely (no error, no log,
 * `deliverThreadMessage()`'s own candidate list was just empty - see this
 * plan's own "Bugfix: Eingehende Anrufe klingeln nicht durch" section for
 * the full incident). The raw offer/answer/ICE QuBits `WebRtcSignalService`
 * itself writes to this same thread stay unencrypted regardless (a
 * separate, deliberate scope decision from the original WebRTC plan, see
 * that service's own doc comment) - only the ordinary `postMessage()`
 * below rides the thread's own encrypted-private-list config.
 *
 * @param {{qu: import('@qu/core').QuStore, identity: import('@qu/identity').QuIdentityEngine, services: object, spaceId: string, remotePub: string, iceServers?: Array<object>, initiator: boolean, mode?: 'audio'|'video', subscribe?: (prefix: string) => void, syncFetch?: (prefix: string) => Promise<*>, onTrack?: (stream: MediaStream) => void, onPeerConnected?: () => void, onDeclined?: () => void, onTimeout?: () => void, negotiationTimeoutMs?: number}} options
 *   `negotiationTimeoutMs` overrides the module's own realistic-ring-duration
 *   default (below) - exposed mainly for tests that need `onTimeout` to fire
 *   quickly, mirroring `WebRtcSignalService`'s own constructor option.
 *   `mode` - see `requestLocalMedia()`'s own doc comment; defaults to
 *   `'audio'` for BOTH roles (a call is an audio call by default, video is
 *   opt-in either up front via `client.js`'s own `/video` route, or mid-call
 *   via the returned `upgradeToVideo()` - see that function's own doc
 *   comment). The two sides don't need to agree: nothing stops one side
 *   sending video while the other stays audio-only, same as any real
 *   video-calling app.
 *   `subscribe`/`syncFetch` - THIS identity's own `ctx.subscribe`/
 *   `ctx.syncFetch` (see `apps/shell/client.js`'s composition root),
 *   threaded straight through to `WebRtcSignalService` - without these, an
 *   offer/answer/ICE candidate this call writes never actually reaches the
 *   OTHER side's local store at all (see that service's own constructor
 *   doc comment for the full "signal never arrives" bug this fixes).
 * @returns {Promise<{selfPub: string, localStream: MediaStream, toggleAudio: (enabled: boolean) => void, toggleVideo: (enabled: boolean) => void, upgradeToVideo: () => Promise<void>, hangUp: () => void}>}
 */
export async function createPhoneCall({ qu, identity, services, spaceId, remotePub, iceServers, initiator, mode = 'audio', subscribe, syncFetch, onTrack, onPeerConnected, onDeclined, onTimeout, negotiationTimeoutMs = NEGOTIATION_TIMEOUT_MS } = {}) {
  const mainKey = await identity.getMainKey();
  const selfPub = QuCrypto.toBase64Url(mainKey.publicKey);
  const memberPubs = [selfPub, remotePub];
  const threadId = await ChatService.roomId(memberPubs);

  await services.messages.createThread(spaceId, threadId, THREAD_PRESETS.chat(memberPubs));

  // Deliberately BEFORE the announcement postMessage() below, not after -
  // `requestLocalMedia()` throwing (denied/unsupported) must still mean
  // "never touched the network at all" (see requestLocalMedia()'s own doc
  // comment and this file's own tests) - a failed call shouldn't have
  // already notified the other side it was even attempted.
  const localStream = await requestLocalMedia(mode);

  // A real, ordinary `postMessage()` (not a raw WebRTC signaling QuBit) -
  // this is what actually TRIGGERS the relay's existing `PushDeliveryService.
  // deliverThreadMessage()` for the callee (see `packages/relay/src/
  // push-delivery.js`'s own `incomingCall` doc comment) - a bare offer/ICE
  // write further down (via `signalService.connectPeer()`) is invisible to
  // that mechanism, which only ever watches `MessageService.postMessage()`
  // writes. Caller-only: the callee's own `connectPeer({initiator: false})`
  // call below must never re-trigger a second "incoming call" notice about
  // its own answer. Body content is irrelevant - `resolveNotification()`'s
  // own generic title/body wording never reflects the real message content
  // anyway (see that file's own class doc comment).
  //
  // Deliberately swallowed on failure (e.g. `remotePub` never published a
  // profile, so `postMessage()`'s encryption step can't resolve their
  // X25519 key - see `THREAD_PRESETS.chat()`'s own note above on why this
  // thread is encrypted at all) - a failed "ring" announcement must never
  // block the actual call: `signalService.connectPeer()` below establishes
  // the real WebRTC connection over unencrypted signaling regardless, same
  // as it always has. The callee simply doesn't get the push/toast nudge in
  // that edge case, same known, already-accepted gap `apps/chat`'s own
  // `sendTextMessage()` has for the identical scenario - see this plan's own
  // "Bugfix" section for why this is caught here instead of left unhandled.
  if (initiator) {
    try {
      await services.messages.postMessage(spaceId, threadId, { body: '📞' });
    } catch (err) {
      log.warn('failed to post incoming-call announcement (call still proceeds):', err.message);
    }
  }

  const webrtcTransport = new WebRTCTransport({ selfPeerId: selfPub, iceServers });
  const signalService = new WebRtcSignalService(qu, identity, webrtcTransport, { negotiationTimeoutMs, subscribe, syncFetch });

  const unsubTrack = webrtcTransport.onTrack((peerId, stream) => {
    if (peerId === remotePub) onTrack?.(stream);
  });
  const unsubConnected = webrtcTransport.onPeerConnected((peerId) => {
    if (peerId === remotePub) onPeerConnected?.();
  });
  const unsubDeclined = signalService.onDeclined((peerId) => {
    if (peerId === remotePub) onDeclined?.();
  });
  // See WebRtcSignalService.onTimeout()'s own doc comment - fires when this
  // pair never connects within NEGOTIATION_TIMEOUT_MS (e.g. no usable ICE
  // candidate pair at all, a classic symmetric-NAT/no-TURN failure). Without
  // this, `client.js` had no way to ever leave its "Calling…"/"Ringing…"
  // state - see this plan's own "Bugfix: Keine WebRTC-Verbindung..." section.
  const unsubTimeout = signalService.onTimeout((peerId) => {
    if (peerId === remotePub) onTimeout?.();
  });

  await signalService.connectPeer(spaceId, threadId, remotePub, memberPubs, { initiator, localStream });

  function toggleAudio(enabled) {
    for (const track of localStream.getAudioTracks()) track.enabled = enabled;
  }

  function toggleVideo(enabled) {
    for (const track of localStream.getVideoTracks()) track.enabled = enabled;
  }

  /**
   * Adds a video track to THIS call, mid-call, via a real WebRTC
   * renegotiation (`WebRTCTransport.addTrackToPeer()` - see that method's
   * own doc comment for the mechanics) - the "Video optional zuschaltbar"
   * counterpart to `mode: 'audio'` being the default. A no-op if a video
   * track already exists (from `mode: 'video'` at call start, or an
   * earlier `upgradeToVideo()` call) - `toggleVideo()` is what turns an
   * EXISTING track on/off, this is only for adding one that never existed.
   * @throws {Error} With a `code` of `'unsupported'` or `'denied'`, same shape as `requestLocalMedia()`'s own errors.
   */
  async function upgradeToVideo() {
    if (localStream.getVideoTracks().length > 0) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('getUserMedia() is not available in this browser');
      err.code = 'unsupported';
      throw err;
    }
    let videoStream;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (cause) {
      log.warn('upgradeToVideo(): getUserMedia() failed:', cause.message);
      const err = new Error('camera access was denied or unavailable');
      err.code = 'denied';
      err.cause = cause;
      throw err;
    }
    const [videoTrack] = videoStream.getVideoTracks();
    localStream.addTrack(videoTrack); // mutates the SAME MediaStream object - an existing <video srcObject=localStream> picks it up automatically
    await webrtcTransport.addTrackToPeer(remotePub, videoTrack, localStream);
  }

  function hangUp() {
    for (const track of localStream.getTracks()) track.stop(); // camera light off
    webrtcTransport.removePeer(remotePub);
    unsubTrack();
    unsubConnected();
    unsubDeclined();
    unsubTimeout();
    signalService.close();
  }

  return { selfPub, localStream, toggleAudio, toggleVideo, upgradeToVideo, hangUp };
}

/**
 * Rejects an incoming call BEFORE any camera/mic access or `RTCPeerConnection`
 * activity - deliberately lightweight (no `getUserMedia()`, no full
 * `createPhoneCall()`), since declining should work straight from a
 * notification click without ever mounting the active-call view. See
 * `WebRtcSignalService.declineCall()`'s own doc comment.
 * @param {{qu: import('@qu/core').QuStore, identity: import('@qu/identity').QuIdentityEngine, spaceId: string, remotePub: string, iceServers?: Array<object>}} options
 */
export async function declinePhoneCall({ qu, identity, spaceId, remotePub, iceServers }) {
  const mainKey = await identity.getMainKey();
  const selfPub = QuCrypto.toBase64Url(mainKey.publicKey);
  const threadId = await ChatService.roomId([selfPub, remotePub]);
  const webrtcTransport = new WebRTCTransport({ selfPeerId: selfPub, iceServers });
  const signalService = new WebRtcSignalService(qu, identity, webrtcTransport);
  await signalService.declineCall(spaceId, threadId, remotePub);
  signalService.close();
}

/**
 * Feature-detection + try/catch, same convention `apps/chat`'s voice-message
 * `getUserMedia()` call already uses - but a VISIBLE failure here, not a
 * silent no-op: a failed voice note is a minor inconvenience, a failed call
 * is the entire point of this app not working.
 *
 * `mode: 'audio'` never asks for the camera at ALL (not just "video track
 * disabled after the fact") - a real audio-only call shouldn't turn on the
 * camera hardware/indicator light for even a moment, which a post-hoc
 * `track.enabled = false` (the existing mid-call video toggle) does NOT
 * prevent (the hardware stays active, only the frame is blanked). The
 * callee is unaffected either way - they simply never receive a video track
 * from this side; their own video toggle stays independently usable.
 * @param {'audio'|'video'} [mode]
 * @returns {Promise<MediaStream>}
 * @throws {Error} With a `code` of `'unsupported'` or `'denied'`.
 */
async function requestLocalMedia(mode = 'audio') {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('getUserMedia() is not available in this browser');
    err.code = 'unsupported';
    throw err;
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
  } catch (cause) {
    log.warn('getUserMedia() failed:', cause.message);
    const err = new Error('camera/microphone access was denied or unavailable');
    err.code = 'denied';
    err.cause = cause;
    throw err;
  }
}
