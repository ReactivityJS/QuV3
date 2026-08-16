// RELIABILITY — targeted tests for the specific WebRTC connection-setup
// properties `apps/phone` depends on, per the plan's own "Zuverlässigkeit
// des WebRTC-Verbindungsaufbaus" section: an explicit initiator override
// actually overrides the deterministic tie-break (not just "usually agrees
// with it by chance"), local media tracks are attached BEFORE any
// offer/answer is created (not just "eventually attached"), and a failed
// connection's renegotiation re-attaches the same local tracks a call had
// before the failure.
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

function fakeLocalStream(kinds = ['audio', 'video']) {
  const tracks = kinds.map((kind) => ({ kind, id: `${kind}-track`, enabled: true, stopped: false, stop() { this.stopped = true; } }));
  return { getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') };
}

test('an explicit initiator override wins even against a peerId pair the deterministic tie-break would decide the OPPOSITE way', async () => {
  // 'peer-z' > 'peer-a' lexicographically, so the deterministic tie-break
  // (selfPeerId < remotePeerId) would make 'peer-z' the ANSWERER by
  // default - forcing it to be the initiator here is the actual thing
  // under test, not an accident of string comparison.
  const z = new WebRTCTransport({ selfPeerId: 'peer-z' });
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  connectPair(z, a);

  let zConnected = false;
  let aConnected = false;
  z.onPeerConnected(() => { zConnected = true; });
  a.onPeerConnected(() => { aConnected = true; });

  z.addPeer('peer-a', { initiator: true }); // explicit override, opposite of the deterministic default
  a.addPeer('peer-z', { initiator: false });

  await waitUntil(() => zConnected && aConnected);
  // If the override had been silently ignored, 'peer-a' (the deterministic
  // initiator by string comparison) would ALSO try to send an offer,
  // producing two competing offers ("glare") that this simple fake would
  // surface as a broken/never-resolving handshake - reaching `connected`
  // at all is the proof exactly one side offered.
});

test('local tracks are attached (addTrack) BEFORE the first createOffer()/createAnswer() on both sides', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const before = getFakeConnections().length;
  let connected = false;
  a.onPeerConnected(() => { connected = true; });

  a.addPeer('peer-b', { localStream: fakeLocalStream(['audio']) }); // initiator (a < b)
  await waitUntil(() => connected);

  const [initiatorPc, answererPc] = getFakeConnections().slice(before);
  assert.deepEqual(initiatorPc.getCallLog(), ['addTrack', 'createOffer']);
  // The answerer never got a localStream in this test - no addTrack() call for it, just the answer.
  assert.deepEqual(answererPc.getCallLog(), ['createAnswer']);
});

test('both sides attaching localStream still get tracks attached before their own createOffer()/createAnswer()', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const before = getFakeConnections().length;
  let aConnected = false;
  a.onPeerConnected(() => { aConnected = true; });

  a.addPeer('peer-b', { localStream: fakeLocalStream(['audio']) });
  b.addPeer('peer-a', { initiator: false, localStream: fakeLocalStream(['video']) });
  await waitUntil(() => aConnected);

  const [initiatorPc, answererPc] = getFakeConnections().slice(before);
  assert.deepEqual(initiatorPc.getCallLog(), ['addTrack', 'createOffer']);
  assert.deepEqual(answererPc.getCallLog(), ['addTrack', 'createAnswer']);
});

test('after an onFailed renegotiation, the SAME local tracks are re-attached to the fresh PeerConnection automatically', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const stream = fakeLocalStream(['audio']);
  const before = getFakeConnections().length;
  const connectedEvents = [];
  a.onPeerConnected(() => connectedEvents.push(1));

  const firstPc = a.addPeer('peer-b', { localStream: stream });
  await waitUntil(() => connectedEvents.length === 1);
  const firstFakePc = getFakeConnections().slice(before)[0];
  assert.deepEqual(firstFakePc.getCallLog(), ['addTrack', 'createOffer']);

  const beforeFailure = getFakeConnections().length;
  firstFakePc.simulateFailed();
  await waitUntil(() => connectedEvents.length === 2);

  // #handleFailed() already discarded the old entry and created a fresh one
  // under the same peerId - addPeer() is idempotent, so this call just
  // returns that fresh instance directly, no index-guessing needed.
  const secondPc = a.addPeer('peer-b');
  assert.notEqual(secondPc, firstPc);
  // Proves #localStreams's per-peer memory (webrtc-transport.js) fed the
  // SAME stream into the fresh PeerConnection automatically - a renegotiated
  // call keeps sending audio/video, not silently drops to a track-less
  // reconnect.
  const [secondFakePc] = getFakeConnections().slice(beforeFailure);
  assert.deepEqual(secondFakePc.getCallLog(), ['addTrack', 'createOffer']);
});
