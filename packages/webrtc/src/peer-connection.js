import { createLogger } from '@qu/log';

const log = createLogger('webrtc:peer-connection');

/**
 * PEER CONNECTION — the state machine for exactly ONE remote peer: one
 * `RTCPeerConnection`, an optional `RTCDataChannel` ("qu-sync"), optional
 * local `MediaStreamTrack`s (camera/mic - see `localStream`), offer/answer/
 * ICE handling, and a send queue for anything written before the channel
 * opens. `WebRTCTransport` (the class apps actually see) owns a
 * `Map<peerId, PeerConnection>` of these - this class knows nothing about
 * peerIds beyond its own, and nothing about `Transport`, mounts, or
 * signaling delivery.
 *
 * Signaling itself (getting an offer/answer/ICE candidate to the OTHER
 * side) is entirely the caller's job via `onSignal` - this class only
 * produces/consumes signal payloads, it never sends them anywhere.
 */
export class PeerConnection {
  #pc;
  #peerId;
  #channel = null;
  #sendQueue = [];
  #onSignal;
  #onMessage;
  #onOpen;
  #onClose;
  #onFailed;
  #onTrack;
  #closed = false;

  /**
   * @param {string} peerId - Only used for logging - this class never sends
   *   it anywhere itself.
   * @param {{initiator: boolean, iceServers: Array<object>, localStream?: MediaStream, onSignal: (signal: object) => void, onMessage: (data: object) => void, onOpen: () => void, onClose: () => void, onFailed: () => void, onTrack?: (stream: MediaStream, track: MediaStreamTrack) => void}} options -
   *   `initiator`: whether THIS side creates the data channel and starts the
   *   offer/answer exchange. See `WebRTCTransport`'s own doc comment for the
   *   deterministic tie-break both sides use to agree on this with no extra
   *   message - or an explicit override a caller (e.g. a Phone app's
   *   caller-initiates-the-call flow) supplies directly.
   *   `localStream`: local `MediaStreamTrack`s (camera/mic) to publish to
   *   this peer, added via `pc.addTrack()` BEFORE any offer/answer is
   *   created (both here in the constructor for the initiator, and in
   *   `handleSignal()`'s offer branch for the answerer) - track/transceiver
   *   changes made AFTER an offer/answer is created would need a
   *   renegotiation round trip this class deliberately doesn't implement,
   *   so ordering is the whole story here, not a convenience. Omit entirely
   *   for a data-channel-only peer (e.g. Geochase's mesh) - no media
   *   `m=`-sections end up in the SDP at all.
   *   `onTrack`: fired once per remote track received (`pc.ontrack`) -
   *   independent of the data channel, fires (or not) purely based on
   *   whether the OTHER side attached tracks of its own.
   */
  constructor(peerId, { initiator, iceServers, localStream = null, onSignal, onMessage, onOpen, onClose, onFailed, onTrack = null }) {
    this.#peerId = peerId;
    this.#onSignal = onSignal;
    this.#onMessage = onMessage;
    this.#onOpen = onOpen;
    this.#onClose = onClose;
    this.#onFailed = onFailed;
    this.#onTrack = onTrack;

    this.#pc = new RTCPeerConnection({ iceServers });
    this.#pc.onicecandidate = (event) => {
      if (event.candidate) this.#onSignal({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    this.#pc.onconnectionstatechange = () => this.#handleConnectionStateChange();
    if (this.#onTrack) {
      this.#pc.ontrack = (event) => this.#onTrack(event.streams[0], event.track);
    }

    // Added BEFORE either side's first createOffer()/createAnswer() (this
    // constructor for the initiator, handleSignal()'s offer branch below for
    // the answerer) - see this class's own constructor doc comment on why
    // ordering here is load-bearing, not cosmetic.
    if (localStream) {
      for (const track of localStream.getTracks()) this.#pc.addTrack(track, localStream);
    }

    if (initiator) {
      this.#channel = this.#pc.createDataChannel('qu-sync');
      this.#wireChannel();
      this.#negotiate().catch((err) => log.warn(`negotiate() failed for "${peerId}":`, err.message));
    } else {
      this.#pc.ondatachannel = (event) => {
        this.#channel = event.channel;
        this.#wireChannel();
      };
    }
  }

  /** @returns {string} The underlying `RTCPeerConnection.connectionState`. */
  get connectionState() {
    return this.#pc.connectionState;
  }

  #wireChannel() {
    this.#channel.onopen = () => {
      for (const data of this.#sendQueue.splice(0)) this.#channel.send(JSON.stringify(data));
      this.#onOpen();
    };
    this.#channel.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        log.warn(`ignoring malformed message from "${this.#peerId}"`);
        return;
      }
      this.#onMessage(parsed);
    };
    this.#channel.onclose = () => this.#onClose();
  }

  async #negotiate() {
    const offer = await this.#pc.createOffer();
    await this.#pc.setLocalDescription(offer);
    this.#onSignal({ type: 'offer', sdp: offer.sdp });
  }

  /**
   * Feeds a signal (offer/answer/ICE candidate) that arrived FROM the other
   * side, via whatever signaling channel the caller uses (see
   * `WebRtcSignalService` in `@qu/services`) - this class never fetches one
   * itself.
   * @param {{type: 'offer'|'answer'|'ice', sdp?: string, candidate?: object}} signal
   */
  async handleSignal(signal) {
    if (signal.type === 'offer') {
      await this.#pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await this.#pc.createAnswer();
      await this.#pc.setLocalDescription(answer);
      this.#onSignal({ type: 'answer', sdp: answer.sdp });
    } else if (signal.type === 'answer') {
      await this.#pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else if (signal.type === 'ice') {
      await this.#pc.addIceCandidate(signal.candidate).catch((err) => log.warn(`addIceCandidate failed for "${this.#peerId}":`, err.message));
    }
  }

  /**
   * Sends over the data channel, queuing (same convention
   * `WebSocketClientTransport.send()` already uses) until it opens - never
   * throws for "not open yet".
   * @param {object} data
   */
  send(data) {
    if (this.#channel && this.#channel.readyState === 'open') {
      this.#channel.send(JSON.stringify(data));
    } else {
      this.#sendQueue.push(data);
    }
  }

  /**
   * Only `'failed'` triggers `onFailed()` - `'disconnected'` is a normal,
   * often self-recovering ICE state (per spec) and must not itself tear the
   * connection down. `WebRTCTransport` reacts to `onFailed()` by discarding
   * this instance and creating a fresh one - a full renegotiation, not a
   * socket-style reopen (WebRTC has no equivalent to a reconnecting
   * WebSocket).
   */
  #handleConnectionStateChange() {
    const state = this.#pc.connectionState;
    if (state === 'failed') {
      this.#onFailed();
    } else if (state === 'closed') {
      this.#onClose();
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel?.close();
    this.#pc.close();
  }
}
