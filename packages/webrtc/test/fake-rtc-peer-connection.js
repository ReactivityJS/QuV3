// FAKE RTCPeerConnection/RTCDataChannel — just enough of the real API
// surface that PeerConnection/WebRTCTransport actually call, so both can be
// exercised end-to-end (real offer/answer/data-channel-open sequencing, no
// shortcuts around the production code) without a real browser. Mirrors
// @qu/sync's own sync-engine.test.js TestNetwork: a small in-process
// simulation, not a spec-complete WebRTC polyfill.
//
// Two instances become a genuine pair the moment an offer's `sdp` (opaque
// to the production code, but tagged here with the offering instance's own
// id) is fed into the other's `setRemoteDescription()` - exactly the
// "identify each other via the SDP exchange" property a real signaling
// handshake has, just without real SDP content.

let connCounter = 0;
const registry = new Map(); // tag -> FakeRTCPeerConnection

class FakeRTCDataChannel {
  #peer = null;
  readyState = 'connecting';
  onopen = null;
  onmessage = null;
  onclose = null;

  send(data) {
    if (this.readyState !== 'open') throw new Error('FakeRTCDataChannel: send() while not open');
    const peer = this.#peer;
    queueMicrotask(() => peer?.onmessage?.({ data }));
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }

  _link(peerChannel) {
    this.#peer = peerChannel;
  }

  _open() {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.onopen?.();
  }
}

export class FakeRTCPeerConnection {
  #tag = `conn-${connCounter++}`;
  #remote = null;
  #localChannel = null;
  #localTracks = []; // {track, stream} pairs added via addTrack()
  /** Every track.id ever delivered to `ontrack` - see `#deliverTrack()`. Prevents a renegotiation's `#markConnected()` re-firing from re-delivering tracks that already arrived. */
  #deliveredTrackIds = new Set();
  /** Test-only: records call ORDER (not just occurrence) of the methods a reliability test cares about - see `getCallLog()`. */
  #callLog = [];
  connectionState = 'new';
  /** Mirrors the real `RTCPeerConnection.remoteDescription` - null until `setRemoteDescription()` resolves. `PeerConnection`'s own trickle-ICE queueing (see `peer-connection.js`'s `#pendingCandidates`) reads exactly this property, so a test can prove that behavior against the fake the same way production code observes it. */
  remoteDescription = null;
  /** Test-only: every candidate actually handed to `addIceCandidate()`, in order - see `getAppliedCandidates()`. */
  #appliedCandidates = [];
  onicecandidate = null;
  onconnectionstatechange = null;
  ondatachannel = null;
  ontrack = null;

  constructor(_config) {
    registry.set(this.#tag, this);
  }

  createDataChannel(_label) {
    this.#localChannel = new FakeRTCDataChannel();
    return this.#localChannel;
  }

  /**
   * Records the track for delivery to the remote side's `ontrack`. Two
   * cases: called BEFORE the initial connect (the common case, still
   * pending delivery until `#markConnected()` runs), or called on an
   * ALREADY-connected pair - a renegotiation (`PeerConnection.addTrack()`
   * mid-call, e.g. Phone's audio-call-upgrades-to-video) - delivered
   * directly here instead of waiting for `#markConnected()`, which only
   * ever fires once per initial handshake. A real negotiation would only
   * deliver once the fresh offer/answer round trip settles; this fake
   * simplifies that to "immediately on addTrack()" (same "just enough of
   * the real API surface, not spec-complete" philosophy as the rest of this
   * file) - the actual offer/answer round trip still runs for real via
   * `PeerConnection.addTrack()`'s own `#negotiate()` call, this only
   * simplifies WHEN the fake hands the track to the remote's `ontrack`.
   * Returns a minimal fake `RTCRtpSender` (unused by production code today).
   */
  addTrack(track, stream) {
    this.#callLog.push('addTrack');
    this.#localTracks.push({ track, stream });
    if (this.connectionState === 'connected' && this.#remote) {
      queueMicrotask(() => this.#remote.#deliverTrack(track, stream));
    }
    return { track };
  }

  async createOffer() {
    this.#callLog.push('createOffer');
    return { type: 'offer', sdp: `offer:${this.#tag}` };
  }

  async createAnswer() {
    this.#callLog.push('createAnswer');
    return { type: 'answer', sdp: `answer:${this.#remote.#tag}:${this.#tag}` };
  }

  /** Test-only: the order `addTrack`/`createOffer`/`createAnswer` were actually called in - proves tracks were attached BEFORE negotiation, not just that both happened. */
  getCallLog() {
    return [...this.#callLog];
  }

  async setLocalDescription(_desc) {}

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    if (desc.type === 'offer') {
      const offererTag = desc.sdp.slice('offer:'.length);
      // A RENEGOTIATION offer (mid-call, e.g. PeerConnection.addTrack())
      // arrives on a pair that's already fully wired - `#remote` is already
      // set from the initial handshake, and re-running the data-channel
      // pairing below would replace an already-open channel with a fresh,
      // never-opened one. Only the very FIRST offer does that setup.
      const isRenegotiation = this.#remote != null;
      this.#remote = registry.get(offererTag);
      if (!isRenegotiation) {
        const offererChannel = this.#remote.#localChannel;
        const answererChannel = new FakeRTCDataChannel();
        answererChannel._link(offererChannel);
        offererChannel._link(answererChannel);
        this.#localChannel = answererChannel;
        queueMicrotask(() => this.ondatachannel?.({ channel: answererChannel }));
      }
    } else if (desc.type === 'answer') {
      const [, , answererTag] = desc.sdp.split(':');
      this.#remote = registry.get(answererTag);
      this.#markConnected();
      this.#remote.#markConnected();
    }
  }

  async addIceCandidate(candidate) {
    this.#callLog.push('addIceCandidate');
    this.#appliedCandidates.push(candidate);
  }

  /** Test-only: every candidate actually applied via `addIceCandidate()`, in order. */
  getAppliedCandidates() {
    return [...this.#appliedCandidates];
  }

  /** @param {MediaStreamTrack} track @param {MediaStream} stream */
  #deliverTrack(track, stream) {
    if (this.#deliveredTrackIds.has(track.id)) return; // already delivered (e.g. an earlier #markConnected(), or addTrack()'s own immediate delivery) - see #deliveredTrackIds' own doc comment
    this.#deliveredTrackIds.add(track.id);
    this.ontrack?.({ streams: [stream], track });
  }

  /** Idempotent-safe to call more than once (a renegotiation's answer receipt calls this again) - `#deliverTrack()`'s own dedup is what makes a second call harmless rather than re-delivering every track a second time. */
  #markConnected() {
    this.connectionState = 'connected';
    const remoteTracks = this.#remote?.#localTracks ?? [];
    queueMicrotask(() => {
      this.onconnectionstatechange?.();
      this.#localChannel?._open();
      for (const { track, stream } of remoteTracks) this.#deliverTrack(track, stream);
    });
  }

  close() {
    this.connectionState = 'closed';
    this.#localChannel?.close();
  }

  /** Test-only: forces a `'failed'` connectionState transition. */
  simulateFailed() {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
}

/** Installs the fake as the global `RTCPeerConnection` for the current test file. */
export function installFakeRTCPeerConnection() {
  globalThis.RTCPeerConnection = FakeRTCPeerConnection;
}

/** Test-only: every `FakeRTCPeerConnection` ever constructed, in creation order - lets a test find the specific instance backing a given `PeerConnection` (which never exposes its internal `RTCPeerConnection` itself). */
export function getFakeConnections() {
  return [...registry.values()];
}
