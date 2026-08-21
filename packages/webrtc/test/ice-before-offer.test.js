import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeRTCPeerConnection, getFakeConnections } from './fake-rtc-peer-connection.js';

installFakeRTCPeerConnection();

const { WebRTCTransport } = await import('../src/webrtc-transport.js');

/** Same helper as webrtc-transport.test.js. */
async function waitUntil(check, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * A REAL bug, reported from real cross-device Wi-Fi calls (never reproduced
 * on a same-machine test, where signaling has no network jitter to reorder
 * it): `WebRtcSignalService` sends the offer and each trickled ICE candidate
 * as independent, unordered writes (see that class's own doc comment) - on
 * a real network, a candidate routinely arrives at the other side BEFORE its
 * offer/answer does. `RTCPeerConnection.addIceCandidate()` throws
 * "The remote description was null" for that, and the original code just
 * logged and dropped it - losing real candidates, sometimes enough of them
 * that ICE never finds a working pair at all.
 *
 * This test skips `WebRtcSignalService` entirely (it isn't what's under
 * test) and instead calls `WebRTCTransport.handleIncomingSignal()` directly,
 * delivering an 'ice' signal BEFORE the 'offer' signal that would normally
 * precede it - the same reordering a real relay round trip can produce.
 */
test('an ICE candidate that arrives before the offer/answer is queued and applied once the remote description lands, not dropped', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });

  const outgoingFromA = [];
  a.onOutgoingSignal((toPeerId, signal) => outgoingFromA.push({ toPeerId, signal }));

  const before = getFakeConnections().length;
  a.addPeer('peer-b'); // 'peer-a' < 'peer-b' - a is the deterministic initiator, creates its offer synchronously in the constructor

  // The offer signal a would send - captured but deliberately NOT delivered
  // to b yet, so a "late" ICE candidate can be delivered to b FIRST below,
  // reproducing the exact reordering a real network produces.
  await waitUntil(() => outgoingFromA.some((s) => s.signal.type === 'offer'));
  const offerSignal = outgoingFromA.find((s) => s.signal.type === 'offer').signal;

  // A candidate that "arrived early" - delivered to b's transport before b
  // has ever seen an offer for this peer. `handleIncomingSignal()` creates
  // b's answerer PeerConnection lazily, right here, on this first signal.
  const earlyCandidate = { candidate: 'candidate:1 1 UDP 1 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  b.handleIncomingSignal('peer-a', { type: 'ice', candidate: earlyCandidate });

  const [answererFakePc] = getFakeConnections().slice(before + 1); // a's fake pc is created first (before), b's just now, above
  assert.equal(answererFakePc.remoteDescription, null, 'no offer delivered yet');
  // The candidate must NOT have been dropped (the original bug) nor applied
  // yet (there's no remote description to apply it against) - queued.
  assert.equal(answererFakePc.getAppliedCandidates().length, 0);

  // NOW deliver the offer - completing what a real handshake would have done in the other order.
  b.handleIncomingSignal('peer-a', offerSignal);

  await waitUntil(() => answererFakePc.getAppliedCandidates().length > 0);
  assert.equal(answererFakePc.getAppliedCandidates().length, 1);
  assert.deepEqual(answererFakePc.getAppliedCandidates()[0], earlyCandidate);
  // Applied only AFTER a remote description actually existed - proves this
  // went through the queue/flush path, not a lucky same-tick ordering.
  assert.ok(answererFakePc.remoteDescription, 'remote description must be set before the queued candidate was applied');
});

test('an ICE candidate that arrives after the offer/answer is applied immediately, unchanged from before', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  a.onOutgoingSignal((toPeerId, signal) => {
    if (toPeerId === 'peer-b') b.handleIncomingSignal('peer-a', signal);
  });
  b.onOutgoingSignal((toPeerId, signal) => {
    if (toPeerId === 'peer-a') a.handleIncomingSignal('peer-b', signal);
  });

  const before = getFakeConnections().length;
  let connected = false;
  b.onPeerConnected(() => { connected = true; });
  a.addPeer('peer-b');
  await waitUntil(() => connected);

  const [, bFakePc] = getFakeConnections().slice(before);
  const lateCandidate = { candidate: 'candidate:2 1 UDP 1 5.6.7.8 6000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  b.handleIncomingSignal('peer-a', { type: 'ice', candidate: lateCandidate });

  await waitUntil(() => bFakePc.getAppliedCandidates().length > 0);
  assert.deepEqual(bFakePc.getAppliedCandidates()[0], lateCandidate);
});
