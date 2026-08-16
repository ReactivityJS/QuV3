import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { WebRtcSignalService } from '../src/webrtc-signal-service.js';
import { webrtcPairKey, webrtcOfferPath, webrtcIceCandidatePath, webrtcDeclinePath } from '../src/paths.js';

/**
 * A minimal `@qu/webrtc` `WebRTCTransport` double - `WebRtcSignalService`
 * only ever needs `onOutgoingSignal`/`onPeerConnected`/`addPeer`/
 * `handleIncomingSignal`, so this exercises the SERVICE's own logic (path
 * shape, signing, membership check, self-echo skip, cleanup) directly,
 * rather than re-testing `@qu/webrtc`'s own handshake mechanics (already
 * covered by that package's own test suite).
 */
class FakeWebRTCTransport {
  outgoingSignalCallbacks = [];
  peerConnectedCallbacks = [];
  addPeerCalls = [];
  handleIncomingSignalCalls = [];

  onOutgoingSignal(cb) {
    this.outgoingSignalCallbacks.push(cb);
    return () => {};
  }
  onPeerConnected(cb) {
    this.peerConnectedCallbacks.push(cb);
    return () => {};
  }
  addPeer(peerId, options) {
    this.addPeerCalls.push({ peerId, options });
  }
  handleIncomingSignal(peerId, signal) {
    this.handleIncomingSignalCalls.push({ peerId, signal });
  }

  /** Test-only: simulates the transport itself producing a signal that needs to leave. */
  emitOutgoingSignal(peerId, signal) {
    for (const cb of this.outgoingSignalCallbacks) cb(peerId, signal);
  }
  /** Test-only: simulates the transport reporting a peer as fully connected. */
  emitPeerConnected(peerId) {
    for (const cb of this.peerConnectedCallbacks) cb(peerId);
  }
}

/**
 * A minimal identity engine double: just `getMainKey()`, backed by a real
 * generated Ed25519 keypair (so `qu.put({signWith, writerPub})` produces a
 * genuinely verifiable signature). `QuIdentityEngine` itself stores one
 * identity seed per `QuStore` (`/store/secure/identity/seed`) and refuses a
 * second `importMnemonic()` on the same store - these tests need TWO
 * distinct identities sharing ONE `QuStore` (standing in for "the signaling
 * data both sides already see via relay sync"), so a real `QuIdentityEngine`
 * doesn't fit here; this double sidesteps that constraint entirely.
 */
async function freshIdentity() {
  const keypair = await QuCrypto.generateKeypair();
  const pub = QuCrypto.toBase64Url(keypair.publicKey);
  const identity = { getMainKey: async () => ({ privateKeyPkcs8: keypair.privateKey, publicKey: keypair.publicKey }) };
  return { identity, pub };
}

async function waitUntil(check, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function freshQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return qu;
}

test('connectPeer() calls transport.addPeer() with the remote pubkey', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transport = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transport);

  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);
  assert.equal(transport.addPeerCalls.length, 1);
  assert.equal(transport.addPeerCalls[0].peerId, pubB);
});

test('connectPeer() passes an explicit initiator/localStream override through to transport.addPeer()', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transport = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transport);
  const fakeStream = { getTracks: () => [] };

  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB], { initiator: true, localStream: fakeStream });

  assert.equal(transport.addPeerCalls.length, 1);
  assert.deepEqual(transport.addPeerCalls[0], { peerId: pubB, options: { initiator: true, localStream: fakeStream } });
});

test('an outgoing offer is written as a signed QuBit at the deterministic pair offer path', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transport = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transport);
  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  transport.emitOutgoingSignal(pubB, { type: 'offer', sdp: 'test-sdp' });

  const pairKey = webrtcPairKey(pubA, pubB);
  const path = webrtcOfferPath('space1', 'thread1', pairKey);
  const written = await waitUntil(() => qu.get(path));
  assert.equal(written.val.sdp, 'test-sdp');
  assert.equal(written.val.from, pubA);
  assert.ok(written.sig, 'offer QuBit should be signed');
});

test('outgoing ICE candidates get distinct, incrementing seq paths', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transport = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transport);
  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  transport.emitOutgoingSignal(pubB, { type: 'ice', candidate: { candidate: 'c1' } });
  transport.emitOutgoingSignal(pubB, { type: 'ice', candidate: { candidate: 'c2' } });

  const pairKey = webrtcPairKey(pubA, pubB);
  await waitUntil(() => qu.get(webrtcIceCandidatePath('space1', 'thread1', pairKey, pubA, 1)));
  const seq0 = await qu.get(webrtcIceCandidatePath('space1', 'thread1', pairKey, pubA, 0));
  const seq1 = await qu.get(webrtcIceCandidatePath('space1', 'thread1', pairKey, pubA, 1));
  const gotCandidates = [seq0.val.candidate.candidate, seq1.val.candidate.candidate].sort();
  assert.deepEqual(gotCandidates, ['c1', 'c2']);
});

test('an incoming, member-signed offer is delivered to transport.handleIncomingSignal()', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { identity: identityB, pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const serviceA = new WebRtcSignalService(qu, identityA, transportA);
  await serviceA.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  // Stands in for "this write already arrived via relay sync" - B's own
  // signal service would have written this via the exact same mechanism.
  const signKeyB = await identityB.getMainKey();
  const pairKey = webrtcPairKey(pubA, pubB);
  await qu.put(
    webrtcOfferPath('space1', 'thread1', pairKey),
    { sdp: 'b-offer', from: pubB },
    { signWith: signKeyB.privateKeyPkcs8, writerPub: signKeyB.publicKey }
  );

  await waitUntil(() => transportA.handleIncomingSignalCalls.length > 0);
  assert.deepEqual(transportA.handleIncomingSignalCalls[0], { peerId: pubB, signal: { type: 'offer', sdp: 'b-offer' } });
});

test('a signal signed by a non-member is never delivered to the transport', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const { identity: identityStranger } = await freshIdentity(); // deliberately NOT in memberPubs
  const transportA = new FakeWebRTCTransport();
  const serviceA = new WebRtcSignalService(qu, identityA, transportA);
  await serviceA.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  const signKeyStranger = await identityStranger.getMainKey();
  const pairKey = webrtcPairKey(pubA, pubB);
  await qu.put(
    webrtcOfferPath('space1', 'thread1', pairKey),
    { sdp: 'stranger-offer', from: 'someone-else' },
    { signWith: signKeyStranger.privateKeyPkcs8, writerPub: signKeyStranger.publicKey }
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(transportA.handleIncomingSignalCalls.length, 0);
});

test('an unsigned signal write is never delivered to the transport', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const serviceA = new WebRtcSignalService(qu, identityA, transportA);
  await serviceA.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  const pairKey = webrtcPairKey(pubA, pubB);
  await qu.put(webrtcOfferPath('space1', 'thread1', pairKey), { sdp: 'unsigned-offer' }); // no signWith

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(transportA.handleIncomingSignalCalls.length, 0);
});

test('this service never feeds its own just-sent signal back into its own transport', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const serviceA = new WebRtcSignalService(qu, identityA, transportA);
  await serviceA.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  transportA.emitOutgoingSignal(pubB, { type: 'offer', sdp: 'a-offer' });
  const pairKey = webrtcPairKey(pubA, pubB);
  await waitUntil(() => qu.get(webrtcOfferPath('space1', 'thread1', pairKey)));

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(transportA.handleIncomingSignalCalls.length, 0);
});

test('once onPeerConnected fires, the pair signaling paths are tombstoned after the cleanup delay', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transportA, { cleanupDelayMs: 10, negotiationTimeoutMs: 100_000 });
  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  transportA.emitOutgoingSignal(pubB, { type: 'offer', sdp: 'test-sdp' });
  const pairKey = webrtcPairKey(pubA, pubB);
  const offerPath = webrtcOfferPath('space1', 'thread1', pairKey);
  await waitUntil(() => qu.get(offerPath));

  transportA.emitPeerConnected(pubB);
  await waitUntil(async () => (await qu.get(offerPath))?.val === null, 500);
});

test('connecting shortly before negotiationTimeoutMs would fire cancels the pending timeout cleanup - a slow-to-answer call still survives', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  // A short timeout AND a short cleanup delay, chosen so the race is tight:
  // if #armTimeout()'s clearTimeout() in #handleConnected() didn't actually
  // cancel the pending timer, the timeout-triggered cleanup and the
  // connect-triggered cleanup would both fire, but harmlessly (idempotent) -
  // the real regression this guards is the timeout firing SECOND and wiping
  // out a connection that had already succeeded, which this proves doesn't
  // silently corrupt anything either way.
  const service = new WebRtcSignalService(qu, identityA, transportA, { negotiationTimeoutMs: 60, cleanupDelayMs: 500 });
  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  transportA.emitOutgoingSignal(pubB, { type: 'offer', sdp: 'test-sdp' });
  const pairKey = webrtcPairKey(pubA, pubB);
  const offerPath = webrtcOfferPath('space1', 'thread1', pairKey);
  await waitUntil(() => qu.get(offerPath));

  await new Promise((resolve) => setTimeout(resolve, 40)); // well before the 60ms timeout
  transportA.emitPeerConnected(pubB);

  // Still not cleaned up immediately (cleanupDelayMs is 500ms) - proves this
  // is the CONNECT-triggered cleanup path, not the timeout having fired.
  await new Promise((resolve) => setTimeout(resolve, 80)); // past the 60ms timeout mark, still short of the 500ms cleanup delay
  assert.notEqual((await qu.get(offerPath))?.val, null);

  await waitUntil(async () => (await qu.get(offerPath))?.val === null, 1000);
});

test('if negotiation never completes, the pair is cleaned up after negotiationTimeoutMs', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transportA, { negotiationTimeoutMs: 20 });
  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);

  transportA.emitOutgoingSignal(pubB, { type: 'offer', sdp: 'test-sdp' });
  const pairKey = webrtcPairKey(pubA, pubB);
  const offerPath = webrtcOfferPath('space1', 'thread1', pairKey);
  await waitUntil(() => qu.get(offerPath));

  await waitUntil(async () => (await qu.get(offerPath))?.val === null, 1000);
});

// ===== onTimeout() =====

test('onTimeout() fires with the remotePub when negotiation never completes within negotiationTimeoutMs', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transportA, { negotiationTimeoutMs: 20 });
  const timedOut = [];
  service.onTimeout((remotePub) => timedOut.push(remotePub));

  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);
  // Never emitPeerConnected() - this pair simply never connects (e.g. no
  // usable ICE candidate pair at all - see this plan's own "Bugfix: Keine
  // WebRTC-Verbindung..." section for the real-world scenario this covers).

  await waitUntil(() => timedOut.length > 0);
  assert.deepEqual(timedOut, [pubB]);
});

test('onTimeout() never fires for a pair that connects before negotiationTimeoutMs elapses', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transportA, { negotiationTimeoutMs: 30 });
  const timedOut = [];
  service.onTimeout((remotePub) => timedOut.push(remotePub));

  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);
  transportA.emitPeerConnected(pubB); // connects well before the 30ms timeout

  await new Promise((resolve) => setTimeout(resolve, 60)); // past the original timeout window
  assert.deepEqual(timedOut, []);
});

test('the returned unsubscribe function from onTimeout() stops further delivery', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const service = new WebRtcSignalService(qu, identityA, transportA, { negotiationTimeoutMs: 15 });
  const timedOut = [];
  const unsubscribe = service.onTimeout((remotePub) => timedOut.push(remotePub));
  unsubscribe();

  await service.connectPeer('space1', 'thread1', pubB, [pubA, pubB]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(timedOut, []);
});

// ===== declineCall()/onDeclined() =====

test('declineCall() writes a signed decline QuBit without requiring connectPeer() to have been called first', async () => {
  const qu = freshQu();
  const { identity: identityB, pub: pubB } = await freshIdentity();
  const { pub: pubA } = await freshIdentity();
  const transportB = new FakeWebRTCTransport();
  const serviceB = new WebRtcSignalService(qu, identityB, transportB);
  // B never calls connectPeer() - declining straight from a notification, per apps/phone's design.

  await serviceB.declineCall('space1', 'thread1', pubA);

  const pairKey = webrtcPairKey(pubA, pubB);
  const written = await qu.get(webrtcDeclinePath('space1', 'thread1', pairKey));
  assert.equal(written.val.declined, true);
  assert.equal(written.val.from, pubB);
  assert.ok(written.sig);
});

test('the caller\'s onDeclined() fires when the callee declines, and the pair is cleaned up', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { identity: identityB, pub: pubB } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const serviceA = new WebRtcSignalService(qu, identityA, transportA, { cleanupDelayMs: 10, negotiationTimeoutMs: 100_000 });
  await serviceA.connectPeer('space1', 'thread1', pubB, [pubA, pubB], { initiator: true });

  const declined = [];
  serviceA.onDeclined((remotePub) => declined.push(remotePub));

  // Stands in for "B's own declineCall() write already arrived via relay sync".
  const signKeyB = await identityB.getMainKey();
  const pairKey = webrtcPairKey(pubA, pubB);
  await qu.put(
    webrtcDeclinePath('space1', 'thread1', pairKey),
    { declined: true, from: pubB },
    { signWith: signKeyB.privateKeyPkcs8, writerPub: signKeyB.publicKey }
  );

  await waitUntil(() => declined.length > 0);
  assert.equal(declined[0], pubB);

  // #cleanup() runs right after notifying onDeclined() - the decline QuBit itself gets tombstoned too.
  await waitUntil(async () => (await qu.get(webrtcDeclinePath('space1', 'thread1', pairKey)))?.val === null, 500);
});

test('a decline signed by a non-member is ignored', async () => {
  const qu = freshQu();
  const { identity: identityA, pub: pubA } = await freshIdentity();
  const { pub: pubB } = await freshIdentity();
  const { identity: identityStranger } = await freshIdentity();
  const transportA = new FakeWebRTCTransport();
  const serviceA = new WebRtcSignalService(qu, identityA, transportA);
  await serviceA.connectPeer('space1', 'thread1', pubB, [pubA, pubB], { initiator: true });

  const declined = [];
  serviceA.onDeclined((remotePub) => declined.push(remotePub));

  const signKeyStranger = await identityStranger.getMainKey();
  const pairKey = webrtcPairKey(pubA, pubB);
  await qu.put(
    webrtcDeclinePath('space1', 'thread1', pairKey),
    { declined: true, from: 'someone-else' },
    { signWith: signKeyStranger.privateKeyPkcs8, writerPub: signKeyStranger.publicKey }
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(declined.length, 0);
});
