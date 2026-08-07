import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine } from '@qu/engines';
import { Transport } from '../src/transport.js';
import { SyncEngine } from '../src/sync-engine.js';
import { MemoryOutboxStore } from '../src/outbox.js';

/**
 * IN-MEMORY TEST TRANSPORT — models the real star topology
 * (WebSocketClientTransport <-> a relay's server-side transport) precisely
 * enough for deterministic SyncEngine unit tests, with no real network:
 *   - RelayTransport.sendTo(peerId, data) reaches exactly that one client.
 *   - ClientTransport.send()/sendTo() always reach the relay (a client only
 *     ever has one peer, same as the real WebSocketClientTransport).
 *   - ClientTransport exposes onReconnect()/simulateReconnect() so tests can
 *     drive SyncEngine's reconnect-handling code directly; RelayTransport
 *     deliberately has NO onReconnect (duck-typed absence, matching the real
 *     server-side transport, which only ever accepts connections).
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
    const cb = this.#clientHandlersByPeerId.get(peerId);
    if (cb) cb({ data, peerId: 'relay' });
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
  #reconnectCallbacks = [];
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
  onReconnect(cb) {
    this.#reconnectCallbacks.push(cb);
  }
  /** Test-only: drives SyncEngine's constructor onReconnect hook directly. */
  simulateReconnect() {
    for (const cb of this.#reconnectCallbacks) cb();
  }
}

function freshQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return qu;
}

/** Polls `check` until it returns truthy, or throws after `timeoutMs`. Needed because SyncEngine's message handling is async and not awaitable from the sending side (mirrors a real network). */
async function waitUntil(check, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function signedPutOptions(kp) {
  return { signWith: kp.privateKeyPkcs8, writerPub: kp.publicKey };
}

// ===== fetch() ======================================================================

test('fetch() retrieves a value the target peer already has', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/docs/d1', { title: 'hello' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));

  const quBit = await client.fetch('/store/space/docs/d1');
  assert.equal(quBit.val.title, 'hello');
});

test('fetch() of a path the target does not have resolves to null', async () => {
  const network = new TestNetwork();
  new SyncEngine(freshQu(), new RelayTransport(network));
  const client = new SyncEngine(freshQu(), new ClientTransport('client-a', network));

  assert.equal(await client.fetch('/store/space/docs/never-written'), null);
});

test('fetch() persists the response locally', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/docs/d1', { title: 'hello' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));
  await client.fetch('/store/space/docs/d1');

  assert.equal((await clientQu.get('/store/space/docs/d1')).val.title, 'hello');
});

test('fetch() of a LOCAL_ONLY_PREFIX path is refused - the target never serves it', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.putSealed('/store/secure/identity/seed', { path: '/store/secure/identity/seed', val: [1, 2, 3], ts: Date.now(), pub: null, sig: null });
  new SyncEngine(relayQu, new RelayTransport(network));
  const client = new SyncEngine(freshQu(), new ClientTransport('client-a', network));

  assert.equal(await client.fetch('/store/secure/identity/seed'), null);
});

// ===== subscribe() / broadcast =====================================================

test('subscribe() delivers a FUTURE write on the subscribed prefix to the subscriber', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));
  client.subscribe('/store/space/threads/general/msgs');

  await relayQu.put('/store/space/threads/general/msgs/m1', { body: 'hi' });

  await waitUntil(async () => (await clientQu.get('/store/space/threads/general/msgs/m1'))?.val?.body === 'hi');
});

test('subscribe() does NOT deliver a write outside the subscribed prefix', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));
  client.subscribe('/store/space/threads/general/msgs');

  await relayQu.put('/store/space/docs/unrelated', { body: 'nope' });
  await new Promise((resolve) => setTimeout(resolve, 20)); // give any (incorrect) delivery a chance to land
  assert.equal(await clientQu.get('/store/space/docs/unrelated'), null);
});

test('a write under LOCAL_ONLY_PREFIX is never broadcast, even to an active subscriber of a covering prefix', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));
  client.subscribe('/store/secure');

  await relayQu.putSealed('/store/secure/identity/seed', { path: '/store/secure/identity/seed', val: [9], ts: Date.now(), pub: null, sig: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await clientQu.get('/store/secure/identity/seed'), null);
});

test('hub re-broadcast: a relay with two subscribed clients forwards one client\'s write to the OTHER, not back to the sender', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const aQu = freshQu();
  const a = new SyncEngine(aQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });
  a.subscribe('/store/space/threads/general/msgs', 'relay');

  const bQu = freshQu();
  const b = new SyncEngine(bQu, new ClientTransport('client-b', network), { publishAllTo: 'relay' });
  b.subscribe('/store/space/threads/general/msgs', 'relay');

  await aQu.put('/store/space/threads/general/msgs/m1', { body: 'from a' });

  await waitUntil(async () => (await bQu.get('/store/space/threads/general/msgs/m1'))?.val?.body === 'from a');
  // Sanity: relay itself also received and persisted it (publishAllTo path).
  assert.equal((await relayQu.get('/store/space/threads/general/msgs/m1')).val.body, 'from a');
});

// ===== publishAllTo =================================================================

test('publishAllTo forwards a local write to the configured peer unconditionally, with no subscribe() needed', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });

  await clientQu.put('/store/space/docs/d1', { title: 'pushed' });
  await waitUntil(async () => (await relayQu.get('/store/space/docs/d1'))?.val?.title === 'pushed');
});

test('publishAllTo never forwards a LOCAL_ONLY_PREFIX write', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });

  await clientQu.put('/store/secure/identity/seed', [1, 2, 3]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await relayQu.get('/store/secure/identity/seed'), null);
});

// ===== ACL enforcement on synced writes (docs/v3-technical-concept.md §3.3) ========

test('REGRESSION: a synced write to a protected resource from an UNAUTHORIZED signer is rejected - not persisted, not re-broadcast', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new AccessEngine(relayQu); // the relay enforces ACLs on writes reaching it, synced or not
  new SyncEngine(relayQu, new RelayTransport(network));

  const ownerKp = await QuCrypto.generateKeypair();
  const ownerPub = QuCrypto.toBase64Url(ownerKp.publicKey);
  await relayQu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });

  // A malicious/compromised peer's OWN store has no AccessEngine at all - its
  // local put() succeeds unrestricted, exactly modeling "an attacker can
  // write whatever they want locally, the only question is whether the
  // network will accept it." Deliberately not going through a SyncEngine's
  // own publishAllTo (which would just forward the same local write) -
  // exercising #handleSync directly is the point, since that's the exact
  // code path this fix touches.
  const attackerQu = freshQu();
  const attackerKp = await QuCrypto.generateKeypair();
  const forged = await attackerQu.put('/store/space/docs/protected', { title: 'hacked' }, signedPutOptions(attackerKp));

  const bystanderQu = freshQu();
  const bystander = new SyncEngine(bystanderQu, new ClientTransport('bystander', network));
  bystander.subscribe('/store/space/docs');

  // Sent directly over a bare transport, no SyncEngine wrapper needed on the
  // attacker's side - #handleSync is the relay's own code under test, and a
  // ClientTransport's send()/sendTo() reach the relay regardless of what (if
  // anything) is listening for a reply.
  const attackerTransport = new ClientTransport('attacker', network);
  attackerTransport.sendTo('relay', { type: 'sync', path: '/store/space/docs/protected', quBit: forged });

  await new Promise((resolve) => setTimeout(resolve, 30)); // give rejection (or, if the fix were absent, acceptance) time to happen
  assert.equal(await relayQu.get('/store/space/docs/protected'), null); // never persisted on the relay
  assert.equal(await bystanderQu.get('/store/space/docs/protected'), null); // never re-broadcast to subscribers either
});

test('a synced write to a protected resource from the AUTHORIZED writer is accepted', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new AccessEngine(relayQu);
  new SyncEngine(relayQu, new RelayTransport(network));

  const ownerKp = await QuCrypto.generateKeypair();
  const ownerPub = QuCrypto.toBase64Url(ownerKp.publicKey);
  await relayQu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });

  const ownerQu = freshQu();
  new SyncEngine(ownerQu, new ClientTransport('owner', network), { publishAllTo: 'relay' });
  await ownerQu.put('/store/space/docs/protected', { title: 'legit update' }, signedPutOptions(ownerKp));

  await waitUntil(async () => (await relayQu.get('/store/space/docs/protected'))?.val?.title === 'legit update');
});

test('a synced write to an UNPROTECTED resource is accepted regardless of signer', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new AccessEngine(relayQu);
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });
  await clientQu.put('/store/space/docs/open', { title: 'anyone can write this' });

  await waitUntil(async () => (await relayQu.get('/store/space/docs/open'))?.val?.title === 'anyone can write this');
});

// ===== onPeerIdentified =============================================================

test('onPeerIdentified fires with the verified actorPub of a signed synced write, never for an unsigned one', async () => {
  const network = new TestNetwork();
  const identified = [];
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network), { onPeerIdentified: (peerId, actorPub) => identified.push({ peerId, actorPub }) });

  const kp = await QuCrypto.generateKeypair();
  const expectedPub = QuCrypto.toBase64Url(kp.publicKey);
  const clientQu = freshQu();
  new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });
  await clientQu.put('/store/space/docs/signed', { title: 'x' }, signedPutOptions(kp));
  await clientQu.put('/store/space/docs/unsigned', { title: 'y' });

  await waitUntil(() => identified.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(identified, [{ peerId: 'client-a', actorPub: expectedPub }]);
});

// ===== fetchPrefix() / reconnect catch-up ==========================================

test('fetchPrefix() merges every QuBit the target has under a prefix', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/threads/general/msgs/m1', { body: 'one' });
  await relayQu.put('/store/space/threads/general/msgs/m2', { body: 'two' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));
  const count = await client.fetchPrefix('/store/space/threads/general/msgs');

  assert.equal(count, 2);
  assert.equal((await clientQu.get('/store/space/threads/general/msgs/m1')).val.body, 'one');
  assert.equal((await clientQu.get('/store/space/threads/general/msgs/m2')).val.body, 'two');
});

test('fetchPrefix() excludes LOCAL_ONLY_PREFIX entries even when they fall under the requested prefix', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.putSealed('/store/secure/identity/seed', { path: '/store/secure/identity/seed', val: [1], ts: Date.now(), pub: null, sig: null });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));
  const count = await client.fetchPrefix('/store/secure');

  assert.equal(count, 0);
  assert.equal(await clientQu.get('/store/secure/identity/seed'), null);
});

test('a reconnect resubscribes and fetches whatever was missed while disconnected (reciprocal catch-up)', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  // Written on the relay BEFORE the client ever subscribes - stands in for
  // "written while this session was offline/didn't exist yet", since this
  // test's simplified in-memory transport has no real notion of a dropped
  // connection (a live-connected subscriber would just receive it immediately).
  await relayQu.put('/store/space/threads/general/msgs/missed', { body: 'while offline' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(clientQu, clientTransport);
  client.subscribe('/store/space/threads/general/msgs');

  // subscribe() ALONE only ever covers FUTURE writes (see the class's own
  // doc comment) - it must not have retroactively fetched this.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await clientQu.get('/store/space/threads/general/msgs/missed'), null); // confirmed genuinely missed

  clientTransport.simulateReconnect(); // triggers fetchPrefix() for every active subscription - see the constructor
  await waitUntil(async () => (await clientQu.get('/store/space/threads/general/msgs/missed'))?.val?.body === 'while offline');
});

test('reconnect catch-up never regresses a NEWER local write with an OLDER remote one for the same path', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/docs/d1', { title: 'stale (relay)' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(clientQu, clientTransport);
  client.subscribe('/store/space/docs');

  await new Promise((resolve) => setTimeout(resolve, 5)); // ensure the next write gets a strictly later ts
  await clientQu.put('/store/space/docs/d1', { title: 'fresh (client)' });

  clientTransport.simulateReconnect();
  await new Promise((resolve) => setTimeout(resolve, 30)); // let catch-up run
  assert.equal((await clientQu.get('/store/space/docs/d1')).val.title, 'fresh (client)');
});

test('onReconnect() app-level callback fires on a reconnect, and its unsubscribe function stops future calls', async () => {
  const network = new TestNetwork();
  new SyncEngine(freshQu(), new RelayTransport(network));

  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(freshQu(), clientTransport);
  let calls = 0;
  const unsubscribe = client.onReconnect(() => calls++);

  clientTransport.simulateReconnect();
  assert.equal(calls, 1);

  unsubscribe();
  clientTransport.simulateReconnect();
  assert.equal(calls, 1);
});

test('getGeneration() increments on every reconnect', async () => {
  const network = new TestNetwork();
  new SyncEngine(freshQu(), new RelayTransport(network));
  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(freshQu(), clientTransport);

  const before = client.getGeneration();
  clientTransport.simulateReconnect();
  assert.equal(client.getGeneration(), before + 1);
  clientTransport.simulateReconnect();
  assert.equal(client.getGeneration(), before + 2);
});

// ===== waitForAck() / outbox ========================================================

test('waitForAck() resolves once the target peer has durably persisted the write', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });
  const written = await clientQu.put('/store/space/docs/d1', { title: 'x' });

  await client.waitForAck('/store/space/docs/d1', written.ts, 1000);
  assert.equal((await relayQu.get('/store/space/docs/d1')).val.title, 'x');
});

test('waitForAck() resolves immediately if a covering ack already arrived before it was called', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });
  const written = await clientQu.put('/store/space/docs/d1', { title: 'x' });

  await waitUntil(async () => (await relayQu.get('/store/space/docs/d1'))?.val?.title === 'x'); // let the ack land first
  await client.waitForAck('/store/space/docs/d1', written.ts, 100); // must not time out
});

test('waitForAck() rejects on timeout when no peer is reachable', async () => {
  const network = new TestNetwork(); // no relay registered at all
  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });
  await clientQu.put('/store/space/docs/d1', { title: 'x' });

  await assert.rejects(() => client.waitForAck('/store/space/docs/d1', Date.now(), 30));
});

test('an outbox entry is recorded on write and cleared once acknowledged', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const outbox = new MemoryOutboxStore();
  const clientQu = freshQu();
  new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay', outbox });
  await clientQu.put('/store/space/docs/d1', { title: 'x' });

  await waitUntil(async () => (await outbox.get('/store/space/docs/d1')) === null);
});

test('outbox entries survive a reload (simulated: a fresh SyncEngine over the SAME outbox) and replay on the next reconnect', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  // Simulates a page that wrote locally, recorded it in a persistent
  // outbox, then reloaded before the relay could ack it - the OLD
  // SyncEngine/transport instance is gone; only the outbox survives.
  const outbox = new MemoryOutboxStore();
  await outbox.set('/store/space/docs/d1', { path: '/store/space/docs/d1', val: { title: 'never acked' }, ts: Date.now(), pub: null, sig: null });

  const clientTransport = new ClientTransport('client-a', network);
  new SyncEngine(freshQu(), clientTransport, { publishAllTo: 'relay', outbox });

  clientTransport.simulateReconnect(); // the "fresh page load" connecting for the first time
  await waitUntil(async () => (await relayQu.get('/store/space/docs/d1'))?.val?.title === 'never acked');
});

// ===== close() =======================================================================

test('close() stops forwarding local writes to the configured peer', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network), { publishAllTo: 'relay' });
  client.close();

  await clientQu.put('/store/space/docs/d1', { title: 'after close' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await relayQu.get('/store/space/docs/d1'), null);
});
