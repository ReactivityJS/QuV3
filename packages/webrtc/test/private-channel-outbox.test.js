// PRIVATE 2-PEER CHANNEL, WITH OUTBOX PERSISTENCE — proves the plan's
// "Persistenz & Re-Sync für private Direktkanäle" claim directly: a
// `publishAllTo`+`outbox` `SyncEngine`, the EXACT combination
// `apps/shell/src/sync.js` already uses for relay sync, works completely
// unmodified when pointed at a `WebRTCTransport` instead of a
// `WebSocketClientTransport` - no new `@qu/sync` code, only
// `WebRTCTransport.onReconnect()` (an alias for `onPeerConnected()`) was
// needed for `SyncEngine`'s own existing "replay the outbox once the
// connection comes up" logic to actually fire.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { SyncEngine } from '@qu/sync';
import { IndexedDBOutboxStore } from '@qu/runtime/indexeddb-outbox';
import { installFakeRTCPeerConnection } from './fake-rtc-peer-connection.js';

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

test('a write made before the WebRTC handshake completes is queued in the outbox and delivered once connected', async () => {
  const aQu = new QuStore();
  aQu.mount('store', new MemoryStoreAdapter());
  const bQu = new QuStore();
  bQu.mount('store', new MemoryStoreAdapter());

  const aTransport = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const bTransport = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(aTransport, bTransport);

  const outbox = new IndexedDBOutboxStore('qu-webrtc-outbox-test-1');
  // Exactly the shell's own `connectToRelay()` shape (apps/shell/src/sync.js),
  // just addressed at a peer over WebRTC instead of the relay over WebSocket.
  new SyncEngine(aQu, aTransport, { publishAllTo: 'peer-b', outbox });
  new SyncEngine(bQu, bTransport);

  // Written BEFORE addPeer() - no connection exists yet, only the transport's
  // (and now the outbox's) own queuing can be what saves this write.
  await aQu.put('/store/private/note', { text: 'hello' });

  const pendingBeforeConnect = await outbox.getAll();
  assert.equal(pendingBeforeConnect.length, 1);
  assert.equal(pendingBeforeConnect[0].path, '/store/private/note');

  aTransport.addPeer('peer-b');

  const written = await waitUntil(() => bQu.get('/store/private/note'));
  assert.equal(written.val.text, 'hello');

  // The unconditional sync-ack B's SyncEngine sends back once it persists a
  // synced write (see sync-engine.js's own #handleSync) is what clears this.
  await waitUntil(async () => (await outbox.getAll()).length === 0);
});

test('WebRTCTransport.onReconnect() is a working alias for onPeerConnected(), which is what SyncEngine relies on for outbox replay', async () => {
  const aTransport = new WebRTCTransport({ selfPeerId: 'peer-a' });
  const bTransport = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(aTransport, bTransport);

  let fired = null;
  aTransport.onReconnect((peerId) => { fired = peerId; });
  aTransport.addPeer('peer-b');

  await waitUntil(() => fired === 'peer-b');
});

test('a fresh SyncEngine instance over the SAME outbox replays whatever is still unacknowledged, exactly like a reload while offline would', async () => {
  const outbox = new IndexedDBOutboxStore('qu-webrtc-outbox-test-2');
  const aQu = new QuStore();
  aQu.mount('store', new MemoryStoreAdapter());

  const orphanTransport = new WebRTCTransport({ selfPeerId: 'peer-a-orphan' });
  new SyncEngine(aQu, orphanTransport, { publishAllTo: 'peer-b', outbox });
  await aQu.put('/store/private/note2', { text: 'left unacked' });
  assert.equal((await outbox.getAll()).length, 1);
  // No peer ever connects on this transport - this write is now exactly what
  // a page reload while offline would have left behind.

  const bQu = new QuStore();
  bQu.mount('store', new MemoryStoreAdapter());
  const aTransport = new WebRTCTransport({ selfPeerId: 'peer-a' }); // a fresh "post-reload" transport instance
  const bTransport = new WebRTCTransport({ selfPeerId: 'peer-b' });
  connectPair(aTransport, bTransport);
  new SyncEngine(aQu, aTransport, { publishAllTo: 'peer-b', outbox }); // same qu, same outbox - a fresh SyncEngine, as a reload would produce
  new SyncEngine(bQu, bTransport);

  aTransport.addPeer('peer-b');

  const written = await waitUntil(() => bQu.get('/store/private/note2'));
  assert.equal(written.val.text, 'left unacked');
  await waitUntil(async () => (await outbox.getAll()).length === 0);
});
