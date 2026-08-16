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
 * @param {{qu: import('@qu/core').QuStore, identity: import('@qu/identity').QuIdentityEngine, services: object, spaceId: string, remotePub: string, iceServers?: Array<object>, initiator: boolean, onTrack?: (stream: MediaStream) => void, onPeerConnected?: () => void, onDeclined?: () => void}} options
 * @returns {Promise<{selfPub: string, localStream: MediaStream, toggleAudio: (enabled: boolean) => void, toggleVideo: (enabled: boolean) => void, hangUp: () => void}>}
 */
export async function createPhoneCall({ qu, identity, services, spaceId, remotePub, iceServers, initiator, onTrack, onPeerConnected, onDeclined } = {}) {
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
  const localStream = await requestLocalMedia();

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
  const signalService = new WebRtcSignalService(qu, identity, webrtcTransport, { negotiationTimeoutMs: NEGOTIATION_TIMEOUT_MS });

  const unsubTrack = webrtcTransport.onTrack((peerId, stream) => {
    if (peerId === remotePub) onTrack?.(stream);
  });
  const unsubConnected = webrtcTransport.onPeerConnected((peerId) => {
    if (peerId === remotePub) onPeerConnected?.();
  });
  const unsubDeclined = signalService.onDeclined((peerId) => {
    if (peerId === remotePub) onDeclined?.();
  });

  await signalService.connectPeer(spaceId, threadId, remotePub, memberPubs, { initiator, localStream });

  function toggleAudio(enabled) {
    for (const track of localStream.getAudioTracks()) track.enabled = enabled;
  }

  function toggleVideo(enabled) {
    for (const track of localStream.getVideoTracks()) track.enabled = enabled;
  }

  function hangUp() {
    for (const track of localStream.getTracks()) track.stop(); // camera light off
    webrtcTransport.removePeer(remotePub);
    unsubTrack();
    unsubConnected();
    unsubDeclined();
    signalService.close();
  }

  return { selfPub, localStream, toggleAudio, toggleVideo, hangUp };
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
 * @returns {Promise<MediaStream>}
 * @throws {Error} With a `code` of `'unsupported'` or `'denied'`.
 */
async function requestLocalMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('getUserMedia() is not available in this browser');
    err.code = 'unsupported';
    throw err;
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (cause) {
    log.warn('getUserMedia() failed:', cause.message);
    const err = new Error('camera/microphone access was denied or unavailable');
    err.code = 'denied';
    err.cause = cause;
    throw err;
  }
}
