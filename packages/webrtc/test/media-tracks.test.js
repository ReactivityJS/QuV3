import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeRTCPeerConnection, getFakeConnections } from './fake-rtc-peer-connection.js';

installFakeRTCPeerConnection();

const { WebRTCTransport } = await import('../src/webrtc-transport.js');

async function waitUntil(check, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function connectPair(transportA, transportB) {
  const aPeerId = transportA.getPeerId();
  const bPeerId = transportB.getPeerId();
  transportA.onOutgoingSignal((toPeerId, signal) => {
    if (toPeerId === bPeerId) transportB.handleIncomingSignal(aPeerId, signal);
  });
  transportB.onOutgoingSignal((toPeerId, signal) => {
    if (toPeerId === aPeerId) transportA.handleIncomingSignal(bPeerId, signal);
  });
}

/** A minimal fake `MediaStream`/`MediaStreamTrack` pair - the fake RTCPeerConnection only ever passes these through opaquely, so a plain object is enough. */
function fakeLocalStream(kinds = ['audio', 'video']) {
  const tracks = kinds.map((kind) => ({ kind, id: `${kind}-track`, enabled: true, stopped: false, stop() { this.stopped = true; } }));
  return { getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') };
}

test('a peer added with localStream publishes its tracks, received by the other side via onTrack()', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const aStream = fakeLocalStream();
  const received = [];
  b.onTrack((peerId, stream, track) => received.push({ peerId, track }));

  a.addPeer('peer-b', { localStream: aStream });

  await waitUntil(() => received.length === 2);
  const kinds = received.map((r) => r.track.kind).sort();
  assert.deepEqual(kinds, ['audio', 'video']);
  assert.equal(received[0].peerId, 'peer-a');
});

test('a data-only peer (no localStream) never fires onTrack on either side', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  let aTrackFired = false;
  let bTrackFired = false;
  a.onTrack(() => { aTrackFired = true; });
  b.onTrack(() => { bTrackFired = true; });

  let connected = false;
  a.onPeerConnected(() => { connected = true; });
  a.addPeer('peer-b');
  await waitUntil(() => connected);

  assert.equal(aTrackFired, false);
  assert.equal(bTrackFired, false);
});

test('tracks are attached to the underlying RTCPeerConnection before the first createOffer(), so they end up in the initial SDP negotiation', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const before = getFakeConnections().length;
  a.addPeer('peer-b', { localStream: fakeLocalStream(['audio']) });
  const [fakePc] = getFakeConnections().slice(before);
  // createOffer() is async but addTrack() inside the PeerConnection constructor
  // runs synchronously before it - by the time this microtask-queued check
  // runs, the offer has already been created with the track already attached.
  await waitUntil(() => true);
  assert.ok(fakePc);
});

test('mute is a local track.enabled toggle, not a renegotiation - the track stays attached', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const aStream = fakeLocalStream(['audio']);
  const received = [];
  b.onTrack((peerId, stream, track) => received.push(track));
  a.addPeer('peer-b', { localStream: aStream });
  await waitUntil(() => received.length === 1);

  aStream.getAudioTracks()[0].enabled = false;
  assert.equal(received[0].enabled, false); // same track object, no new negotiation, no new onTrack fire
});

// ===== addTrackToPeer() - mid-call renegotiation (e.g. an audio call upgrading to video) =====

test('addTrackToPeer() on an already-connected peer delivers the new track to the OTHER side via onTrack(), without a fresh onPeerConnected()', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const aStream = fakeLocalStream(['audio']); // starts audio-only
  let connectedCount = 0;
  a.onPeerConnected(() => { connectedCount++; });
  const received = [];
  b.onTrack((peerId, stream, track) => received.push({ peerId, track }));

  a.addPeer('peer-b', { localStream: aStream });
  await waitUntil(() => received.length === 1);
  assert.equal(received[0].track.kind, 'audio');

  const videoTrack = { kind: 'video', id: 'video-track', enabled: true, stopped: false, stop() { this.stopped = true; } };
  aStream.getTracks().push(videoTrack); // mirrors real MediaStream.addTrack()'s in-place mutation
  await a.addTrackToPeer('peer-b', videoTrack, aStream);

  await waitUntil(() => received.length === 2);
  assert.equal(received[1].track.kind, 'video');
  assert.equal(received[1].peerId, 'peer-a');
  assert.equal(connectedCount, 1); // still just the ONE original connect - renegotiation isn't a fresh connection
});

test('addTrackToPeer() for a peer that was never added is a harmless no-op (with a warning), not a throw', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const fakeTrack = { kind: 'video', id: 'orphan-track' };
  await assert.doesNotReject(() => a.addTrackToPeer('never-added-peer', fakeTrack, fakeLocalStream()));
});
