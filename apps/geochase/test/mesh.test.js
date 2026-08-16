import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { Transport } from '@qu/sync/transport';
import { ListService, AccessService, MessageService, paths } from '@qu/services';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';

installFakeRTCPeerConnection();

const { createGeochaseMesh } = await import('../src/mesh.js');

/**
 * IN-MEMORY RELAY NETWORK for each side's MAIN (signaling) `qu` - the exact
 * client-relay star topology `@qu/sync`'s own `sync-engine.test.js` already
 * uses, standing in for real relay-backed sync so this test can prove the
 * plan's central claim directly: WebRTC signaling genuinely rides the
 * EXISTING relay-backed sync stack, with no bespoke wiring of its own.
 */
class TestNetwork {
  #relayHandlers = [];
  #clientHandlersByPeerId = new Map();
  registerRelay(onMessage) {
    this.#relayHandlers.push(onMessage);
  }
  registerClient(peerId, onMessage) {
    this.#clientHandlersByPeerId.set(peerId, onMessage);
  }
  fromClientToRelay(peerId, data) {
    for (const cb of this.#relayHandlers) cb({ data, peerId });
  }
  fromRelayToClient(peerId, data) {
    this.#clientHandlersByPeerId.get(peerId)?.({ data, peerId: 'relay' });
  }
  fromRelayBroadcast(data) {
    for (const [, cb] of this.#clientHandlersByPeerId) cb({ data, peerId: 'relay' });
  }
}

class RelayTransport extends Transport {
  #network;
  constructor(network) {
    super();
    this.#network = network;
  }
  async connect() {}
  getPeerId() {
    return 'relay';
  }
  onMessage(cb) {
    this.#network.registerRelay(cb);
  }
  send(data) {
    this.#network.fromRelayBroadcast(data);
  }
  sendTo(peerId, data) {
    this.#network.fromRelayToClient(peerId, data);
  }
}

class ClientTransport extends Transport {
  #network;
  #peerId;
  constructor(peerId, network) {
    super();
    this.#peerId = peerId;
    this.#network = network;
  }
  async connect() {}
  getPeerId() {
    return this.#peerId;
  }
  onMessage(cb) {
    this.#network.registerClient(this.#peerId, cb);
  }
  send(data) {
    this.#network.fromClientToRelay(this.#peerId, data);
  }
  sendTo(_peerId, data) {
    this.send(data);
  }
}

async function waitUntil(check, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One participant's full relay-connected setup - main `qu`, identity, and the minimal Service set `createGeochaseMesh()` actually needs (`services.messages`). */
async function freshParticipant(clientPeerId, network) {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const pub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const clientTransport = new ClientTransport(clientPeerId, network);
  const sync = new SyncEngine(qu, clientTransport, { publishAllTo: clientTransport.getPeerId() });

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);

  return { qu, identity, pub, sync, services: { messages } };
}

test('two Geo Chase meshes signal over relay-backed sync, connect via WebRTC, and replicate positions to each other', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const alice = await freshParticipant('client-alice', network);
  const bob = await freshParticipant('client-bob', network);

  const spaceId = 'geochase-test-space';
  const threadId = 'lobby';
  const gameId = 'game-1';

  // Both subscribe to the space, same as apps/shell's real `subscribe(prefix)` wiring -
  // this is what lets each side actually SEE the other's signaling writes.
  alice.sync.subscribe(paths.spacePath(spaceId));
  bob.sync.subscribe(paths.spacePath(spaceId));

  const aliceMesh = await createGeochaseMesh({ qu: alice.qu, identity: alice.identity, services: alice.services, spaceId, threadId, gameId });
  const bobMesh = await createGeochaseMesh({ qu: bob.qu, identity: bob.identity, services: bob.services, spaceId, threadId, gameId });

  let aliceConnected = false;
  let bobConnected = false;
  aliceMesh.webrtcTransport.onPeerConnected(() => { aliceConnected = true; });
  bobMesh.webrtcTransport.onPeerConnected(() => { bobConnected = true; });

  const memberPubs = [alice.pub, bob.pub];
  await Promise.all([aliceMesh.connectToPeer(bob.pub, memberPubs), bobMesh.connectToPeer(alice.pub, memberPubs)]);

  await waitUntil(() => aliceConnected && bobConnected);

  // ===== state side: put()/getChildren()/watchPlayers() replicate over the mesh =====
  await aliceMesh.putPosition({ lat: 52.52, lng: 13.405 });
  const bobSeesAlice = await waitUntil(async () => (await bobMesh.listPlayers()).find((p) => p.actorPub === alice.pub));
  assert.equal(bobSeesAlice.position.lat, 52.52);
  assert.equal(bobSeesAlice.position.lng, 13.405);

  await bobMesh.putPosition({ lat: 48.1351, lng: 11.582 });
  const aliceSeesBob = await waitUntil(async () => (await aliceMesh.listPlayers()).find((p) => p.actorPub === bob.pub));
  assert.equal(aliceSeesBob.position.lat, 48.1351);

  // ===== event side: on()/emit() deliver ephemeral, non-persisted signals =====
  const bobEvents = [];
  bobMesh.p2pQu.on(`/p2p/geochase/${gameId}/events`, (payload) => bobEvents.push(payload));
  await aliceMesh.p2pQu.emit(`/p2p/geochase/${gameId}/events`, { type: 'game-started' });
  await waitUntil(() => bobEvents.length > 0);
  assert.equal(bobEvents[0].type, 'game-started');

  aliceMesh.close();
  bobMesh.close();
});

test('a late joiner catches up on already-known positions via reciprocal fetchPrefix()', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const alice = await freshParticipant('client-alice2', network);
  const bob = await freshParticipant('client-bob2', network);

  const spaceId = 'geochase-test-space-2';
  const threadId = 'lobby';
  const gameId = 'game-2';
  alice.sync.subscribe(paths.spacePath(spaceId));
  bob.sync.subscribe(paths.spacePath(spaceId));

  const aliceMesh = await createGeochaseMesh({ qu: alice.qu, identity: alice.identity, services: alice.services, spaceId, threadId, gameId });

  // Alice is alone in the game for a moment and already has a position.
  await aliceMesh.putPosition({ lat: 1, lng: 2 });

  const bobMesh = await createGeochaseMesh({ qu: bob.qu, identity: bob.identity, services: bob.services, spaceId, threadId, gameId });
  const memberPubs = [alice.pub, bob.pub];
  await Promise.all([aliceMesh.connectToPeer(bob.pub, memberPubs), bobMesh.connectToPeer(alice.pub, memberPubs)]);

  // Bob never wrote his own position, but should still see Alice's existing one -
  // subscribe() alone only delivers FUTURE writes, this only works via the
  // reciprocal fetchPrefix() catch-up wired in createGeochaseMesh()'s own onPeerConnected.
  const bobSeesAlice = await waitUntil(async () => (await bobMesh.listPlayers()).find((p) => p.actorPub === alice.pub));
  assert.equal(bobSeesAlice.position.lat, 1);
  assert.equal(bobSeesAlice.position.lng, 2);

  aliceMesh.close();
  bobMesh.close();
});
