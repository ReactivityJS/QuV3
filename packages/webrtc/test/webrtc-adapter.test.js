import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter } from '@qu/core/adapters/memory';
import { installFakeRTCPeerConnection } from './fake-rtc-peer-connection.js';

installFakeRTCPeerConnection();

const { WebRTCTransport } = await import('../src/webrtc-transport.js');
const { WebRTCAdapter } = await import('../src/webrtc-adapter.js');

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

function quBit(val, ts) {
  return { path: 'irrelevant', val, ts, pub: null, sig: null };
}

// ===== state side (put/get/getAll/getChildren) - delegates to localAdapter =====

test('put()/get() delegate straight to the injected localAdapter', async () => {
  const localAdapter = new MemoryStoreAdapter();
  const transport = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const adapter = new WebRTCAdapter({ localAdapter, webrtcTransport: transport });

  const bit = quBit({ lat: 1, lng: 2 }, 100);
  await adapter.put('/players/p1', bit);
  assert.deepEqual(await adapter.get('/players/p1'), bit);
  // Directly visible on the underlying adapter too - proves this is pure delegation, not a copy.
  assert.deepEqual(await localAdapter.get('/players/p1'), bit);
});

test('getChildren()/getAll() delegate to localAdapter and honor its ordering contract', async () => {
  const localAdapter = new MemoryStoreAdapter();
  const transport = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const adapter = new WebRTCAdapter({ localAdapter, webrtcTransport: transport });

  await adapter.put('/players/p1', quBit('one', 10));
  await adapter.put('/players/p2', quBit('two', 20));

  const children = await adapter.getChildren('/players', { order: 'asc' });
  assert.deepEqual(children.map((e) => e.rel), ['/players/p1', '/players/p2']);

  const all = await adapter.getAll('/players');
  assert.equal(all.length, 2);
});

// ===== event side (on/emit) - network-backed VolatileAdapter =====

test('emit() delivers to local on() listeners even with no peers connected', async () => {
  const transport = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const adapter = new WebRTCAdapter({ localAdapter: new MemoryStoreAdapter(), webrtcTransport: transport });

  const received = [];
  adapter.on('/broadcast/ping', (payload) => received.push(payload));
  await adapter.emit('/broadcast/ping', { n: 1 });

  assert.deepEqual(received, [{ n: 1 }]);
});

test('emit() under a /peer/<pub>/... path reaches only that peer, tagged with fromPeerId on arrival', async () => {
  const transportA = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const transportB = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(transportA, transportB);

  const adapterA = new WebRTCAdapter({ localAdapter: new MemoryStoreAdapter(), webrtcTransport: transportA });
  const adapterB = new WebRTCAdapter({ localAdapter: new MemoryStoreAdapter(), webrtcTransport: transportB });

  let connected = false;
  transportA.onPeerConnected(() => { connected = true; });
  transportA.addPeer('peer-b');
  await waitUntil(() => connected);

  const received = [];
  adapterB.on('/peer/peer-b/call-signal', (payload) => received.push(payload));

  await waitUntil(() => {
    adapterA.emit('/peer/peer-b/call-signal', { type: 'ringing' });
    return received.length > 0;
  });

  assert.equal(received[0].type, 'ringing');
  assert.equal(received[0].fromPeerId, 'peer-a');
});

test('emit() under a non-/peer/ path broadcasts to every connected peer', async () => {
  const transportA = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const transportB = new WebRTCTransport({ selfPeerId: 'peer-b' });
  const transportC = new WebRTCTransport({ selfPeerId: 'peer-c' });
  connectPair(transportA, transportB);
  connectPair(transportA, transportC);

  const adapterA = new WebRTCAdapter({ localAdapter: new MemoryStoreAdapter(), webrtcTransport: transportA });
  const adapterB = new WebRTCAdapter({ localAdapter: new MemoryStoreAdapter(), webrtcTransport: transportB });
  const adapterC = new WebRTCAdapter({ localAdapter: new MemoryStoreAdapter(), webrtcTransport: transportC });

  let bConnected = false;
  let cConnected = false;
  transportA.onPeerConnected((peerId) => {
    if (peerId === 'peer-b') bConnected = true;
    if (peerId === 'peer-c') cConnected = true;
  });
  transportA.addPeer('peer-b');
  transportA.addPeer('peer-c');
  await waitUntil(() => bConnected && cConnected);

  const bReceived = [];
  const cReceived = [];
  adapterB.on('/broadcast/game-started', (payload) => bReceived.push(payload));
  adapterC.on('/broadcast/game-started', (payload) => cReceived.push(payload));

  await waitUntil(() => {
    adapterA.emit('/broadcast/game-started', { gameId: 'g1' });
    return bReceived.length > 0 && cReceived.length > 0;
  });

  assert.equal(bReceived[0].gameId, 'g1');
  assert.equal(cReceived[0].gameId, 'g1');
});
