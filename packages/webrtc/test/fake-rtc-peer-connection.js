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
  /** Test-only: records call ORDER (not just occurrence) of the methods a reliability test cares about - see `getCallLog()`. */
  #callLog = [];
  connectionState = 'new';
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

  /** Records the track for delivery to the remote side's `ontrack` once connected - see `#markConnected()`. Returns a minimal fake `RTCRtpSender` (unused by production code today). */
  addTrack(track, stream) {
    this.#callLog.push('addTrack');
    this.#localTracks.push({ track, stream });
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
    if (desc.type === 'offer') {
      const offererTag = desc.sdp.slice('offer:'.length);
      this.#remote = registry.get(offererTag);
      const offererChannel = this.#remote.#localChannel;
      const answererChannel = new FakeRTCDataChannel();
      answererChannel._link(offererChannel);
      offererChannel._link(answererChannel);
      this.#localChannel = answererChannel;
      queueMicrotask(() => this.ondatachannel?.({ channel: answererChannel }));
    } else if (desc.type === 'answer') {
      const [, , answererTag] = desc.sdp.split(':');
      this.#remote = registry.get(answererTag);
      this.#markConnected();
      this.#remote.#markConnected();
    }
  }

  async addIceCandidate(_candidate) {}

  #markConnected() {
    this.connectionState = 'connected';
    const remoteTracks = this.#remote?.#localTracks ?? [];
    queueMicrotask(() => {
      this.onconnectionstatechange?.();
      this.#localChannel?._open();
      for (const { track, stream } of remoteTracks) this.ontrack?.({ streams: [stream], track });
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
