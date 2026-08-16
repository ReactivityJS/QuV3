import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeRTCPeerConnection, getFakeConnections } from './fake-rtc-peer-connection.js';

installFakeRTCPeerConnection();

const { WebRTCTransport } = await import('../src/webrtc-transport.js');

/** Polls `check` until truthy, or throws after `timeoutMs` - signaling here is async (queueMicrotask-driven), same reasoning @qu/sync's own sync-engine.test.js waitUntil() gives. */
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
 * Wires two transports' signaling directly to each other - the in-test
 * stand-in for `WebRtcSignalService` carrying signals over the relay. Each
 * side only forwards a signal actually addressed to the OTHER side of this
 * specific pair - needed the moment a transport has more than one
 * `connectPair()` call against it (a mesh test), since `onOutgoingSignal()`
 * fires every registered callback for every peer's signal, not just "the
 * one this pairing cares about".
 */
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

test('two peers complete a handshake and both fire onPeerConnected', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  let aConnectedTo = null;
  let bConnectedTo = null;
  a.onPeerConnected((peerId) => { aConnectedTo = peerId; });
  b.onPeerConnected((peerId) => { bConnectedTo = peerId; });

  a.addPeer('peer-b'); // 'peer-a' < 'peer-b' - a is the deterministic initiator
  await waitUntil(() => aConnectedTo === 'peer-b' && bConnectedTo === 'peer-a');
});

test('sendTo() delivers a message only to the addressed peer, with the sender peerId attached', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);
  a.addPeer('peer-b');

  const received = [];
  b.onMessage((msg) => received.push(msg));
  await waitUntil(() => {
    a.sendTo('peer-b', { hello: 'world' });
    return received.length > 0;
  });

  assert.deepEqual(received[0].data, { hello: 'world' });
  assert.equal(received[0].peerId, 'peer-a');
});

test('sendTo() before the channel opens queues rather than throwing, and flushes on open', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);
  a.addPeer('peer-b');

  const received = [];
  b.onMessage((msg) => received.push(msg));
  // Sent immediately, before the (async) handshake has had a chance to complete.
  a.sendTo('peer-b', { early: true });

  await waitUntil(() => received.length > 0);
  assert.deepEqual(received[0].data, { early: true });
});

test('send() broadcasts to every connected peer in a mesh', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  const c = new WebRTCTransport({ selfPeerId: 'peer-c' });
  connectPair(a, b);
  connectPair(a, c);
  a.addPeer('peer-b');
  a.addPeer('peer-c');

  const bReceived = [];
  const cReceived = [];
  b.onMessage((msg) => bReceived.push(msg));
  c.onMessage((msg) => cReceived.push(msg));

  await waitUntil(() => {
    a.send({ ping: 1 });
    return bReceived.length > 0 && cReceived.length > 0;
  });

  assert.deepEqual(bReceived[0].data, { ping: 1 });
  assert.deepEqual(cReceived[0].data, { ping: 1 });
});

test('a failed connection is torn down and automatically renegotiated', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const connectedEvents = [];
  a.onPeerConnected((peerId) => connectedEvents.push(peerId));

  const before = getFakeConnections().length;
  a.addPeer('peer-b'); // 'peer-a' < 'peer-b' - a is the initiator, so its fake RTCPeerConnection is created first
  await waitUntil(() => connectedEvents.length === 1);

  const [aFakePc] = getFakeConnections().slice(before);
  aFakePc.simulateFailed();

  // #handleFailed() discards the old PeerConnection and calls addPeer() again -
  // a fresh handshake, ending in a SECOND onPeerConnected('peer-b').
  await waitUntil(() => connectedEvents.length === 2);
});

test('removePeer() closes the connection and forgets it, so a later addPeer() starts fresh', async () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const b = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(a, b);

  const pc1 = a.addPeer('peer-b');
  a.removePeer('peer-b');
  const pc2 = a.addPeer('peer-b');
  assert.notEqual(pc1, pc2);
});

test('getPeerId() returns the configured selfPeerId', () => {
  const a = new WebRTCTransport({ selfPeerId: 'peer-a' });
  assert.equal(a.getPeerId(), 'peer-a');
});

test('constructor throws without a selfPeerId', () => {
  assert.throws(() => new WebRTCTransport({}));
});
