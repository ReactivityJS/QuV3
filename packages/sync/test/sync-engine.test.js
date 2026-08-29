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

// ===== path/quBit.path consistency (splicing defense) + validation on fetch()/fetchPrefix() ====

test('REGRESSION: a validly-signed QuBit for one path is rejected by #handleSync when relayed under a different outer path', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  // A genuinely validly-signed QuBit for its OWN path - nothing forged here.
  const kp = await QuCrypto.generateKeypair();
  const realQu = freshQu();
  const real = await realQu.put('/store/space/docs/real', { title: 'real' }, signedPutOptions(kp));

  // Relayed (or replayed by an attacker who merely observed it) under a
  // DIFFERENT outer path - the signature still verifies (it only ever
  // attested to quBit.path === '/store/space/docs/real'), so without the
  // path-identity check this would be accepted and stored at the decoy path.
  const attackerTransport = new ClientTransport('attacker', network);
  attackerTransport.sendTo('relay', { type: 'sync', path: '/store/space/docs/decoy', quBit: real });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await relayQu.get('/store/space/docs/decoy'), null); // never stored under the mismatched path
  assert.equal(await relayQu.get('/store/space/docs/real'), null); // never touched the real path either - this relay never received a write for it directly
});

test('fetch() rejects a response whose QuBit.path does not match the requested path', async () => {
  const network = new TestNetwork();
  const decoyQuBit = { path: '/store/space/docs/elsewhere', val: { title: 'spliced' }, ts: Date.now(), pub: null, sig: null };
  network.registerRelay(({ data, peerId }) => {
    if (data.type === 'request') {
      network.fromRelayToClient(peerId, { type: 'response', requestId: data.requestId, path: data.path, quBit: decoyQuBit });
    }
  });
  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));

  await assert.rejects(() => client.fetch('/store/space/docs/decoy'), /does not match/);
  assert.equal(await clientQu.get('/store/space/docs/decoy'), null);
  assert.equal(await clientQu.get('/store/space/docs/elsewhere'), null);
});

test('fetchPrefix() skips (and does not count) an entry whose QuBit.path does not match its outer path', async () => {
  const network = new TestNetwork();
  const decoyQuBit = { path: '/store/space/docs/elsewhere', val: { title: 'spliced' }, ts: Date.now(), pub: null, sig: null };
  network.registerRelay(({ data, peerId }) => {
    if (data.type === 'prefix-request') {
      network.fromRelayToClient(peerId, {
        type: 'prefix-response',
        requestId: data.requestId,
        entries: [{ path: '/store/space/docs/decoy', quBit: decoyQuBit }],
      });
    }
  });
  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));

  const count = await client.fetchPrefix('/store/space/docs');
  assert.equal(count, 0);
  assert.equal(await clientQu.get('/store/space/docs/decoy'), null);
});

test('fetch() applies write-ACL to the response too, even if the serving peer itself never enforced it', async () => {
  const network = new TestNetwork();
  // The relay serving this fetch() has NO AccessEngine at all - it will
  // happily store+serve an ACL-violating write, modeling a misconfigured,
  // stale, or outright compromised peer we are fetching from.
  const relayQu = freshQu();
  new SyncEngine(relayQu, new RelayTransport(network));

  const ownerKp = await QuCrypto.generateKeypair();
  const ownerPub = QuCrypto.toBase64Url(ownerKp.publicKey);
  await relayQu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });

  // A validly-signed (by the ATTACKER, not the owner) QuBit, same forging
  // technique as the existing "REGRESSION: ... UNAUTHORIZED signer" sync
  // test above: sealed by a real QuStore, so its signature genuinely
  // verifies - the only thing wrong with it is who signed it.
  const attackerQu = freshQu();
  const attackerKp = await QuCrypto.generateKeypair();
  const forged = await attackerQu.put('/store/space/docs/protected', { title: 'hacked' }, signedPutOptions(attackerKp));
  await relayQu.putSealed('/store/space/docs/protected', forged);

  // The FETCHING client already knows about this protected resource (e.g.
  // from earlier legitimate sync) - it must still enforce the ACL itself,
  // not just trust whatever the serving peer hands back.
  const clientQu = freshQu();
  await clientQu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));

  await assert.rejects(() => client.fetch('/store/space/docs/protected'));
  assert.equal(await clientQu.get('/store/space/docs/protected'), null);
});

test('fetchPrefix() applies write-ACL per entry, excluding unauthorized entries from both persistence and the returned count', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu(); // no AccessEngine - same "misbehaving peer" setup as the fetch() test above
  new SyncEngine(relayQu, new RelayTransport(network));

  const ownerKp = await QuCrypto.generateKeypair();
  const ownerPub = QuCrypto.toBase64Url(ownerKp.publicKey);
  await relayQu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });

  const attackerKp = await QuCrypto.generateKeypair();
  await relayQu.put('/store/space/docs/protected', { title: 'hacked' }, signedPutOptions(attackerKp));
  await relayQu.put('/store/space/docs/open', { title: 'anyone can write this' });

  const clientQu = freshQu();
  await clientQu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));

  const count = await client.fetchPrefix('/store/space/docs');
  assert.equal(count, 1);
  assert.equal(await clientQu.get('/store/space/docs/protected'), null);
  assert.equal((await clientQu.get('/store/space/docs/open')).val.title, 'anyone can write this');
});

test('fetchPrefix() return value counts only entries actually persisted - excludes ones skipped by the anti-regression ts-guard', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/docs/stale', { title: 'older (relay)' });
  await relayQu.put('/store/space/docs/fresh', { title: 'new (relay)' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  await new Promise((resolve) => setTimeout(resolve, 5)); // ensure a strictly later ts than the relay's write above
  await clientQu.put('/store/space/docs/stale', { title: 'newer (client)' });
  const client = new SyncEngine(clientQu, new ClientTransport('client-a', network));

  const count = await client.fetchPrefix('/store/space/docs');
  assert.equal(count, 1); // only /fresh actually merged - /stale was skipped by the ts-guard
  assert.equal((await clientQu.get('/store/space/docs/stale')).val.title, 'newer (client)'); // untouched
  assert.equal((await clientQu.get('/store/space/docs/fresh')).val.title, 'new (relay)');
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

// ===== reconnect replay of in-flight fetch()/fetchPrefix() requests =======

test('fetch() still in flight during a reconnect is replayed, not left to time out - regression: a relay restart while a request was in the air used to silently degrade to stale local data until a full page reload', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/docs/d1', { title: 'hello' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientTransport = new ClientTransport('client-a', network);
  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, clientTransport);

  // Simulate the request being sent right as the connection drops: swallow
  // the very first message the client sends (the fetch request never
  // reaches the relay) - same as a real WebSocket that closes moments after
  // `send()` queued/flushed it.
  const realSend = network.fromClientToRelay.bind(network);
  let swallowedOne = false;
  network.fromClientToRelay = (peerId, data) => {
    if (!swallowedOne) { swallowedOne = true; return; }
    realSend(peerId, data);
  };

  const fetchPromise = client.fetch('/store/space/docs/d1', null, 2000);
  await waitUntil(() => swallowedOne);

  network.fromClientToRelay = realSend; // "reconnected" - the network works again
  clientTransport.simulateReconnect();

  const quBit = await fetchPromise;
  assert.equal(quBit.val.title, 'hello');
});

test('fetchPrefix() still in flight during a reconnect is replayed the same way', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/threads/general/msgs/m1', { body: 'one' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientTransport = new ClientTransport('client-a', network);
  const clientQu = freshQu();
  const client = new SyncEngine(clientQu, clientTransport);

  const realSend = network.fromClientToRelay.bind(network);
  let swallowedOne = false;
  network.fromClientToRelay = (peerId, data) => {
    if (!swallowedOne) { swallowedOne = true; return; }
    realSend(peerId, data);
  };

  const fetchPromise = client.fetchPrefix('/store/space/threads/general/msgs', null, 2000);
  await waitUntil(() => swallowedOne);

  network.fromClientToRelay = realSend;
  clientTransport.simulateReconnect();

  const count = await fetchPromise;
  assert.equal(count, 1);
  assert.equal((await clientQu.get('/store/space/threads/general/msgs/m1')).val.body, 'one');
});

test('a response that arrives for a request no longer pending (already answered, or replayed twice) is ignored, not a double-resolve', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/docs/d1', { title: 'hello' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(freshQu(), clientTransport);

  const quBit = await client.fetch('/store/space/docs/d1');
  assert.equal(quBit.val.title, 'hello');

  // The request already resolved and was removed from the pending map -
  // replaying it now (as a reconnect would for a GENUINELY still-pending
  // request) must not throw or otherwise misbehave.
  assert.doesNotThrow(() => clientTransport.simulateReconnect());
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

test('refreshSubscriptions() does the SAME resubscribe + reciprocal catch-up as a real reconnect, without touching the transport - the mobile "background/foreground never closed the socket" case', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  await relayQu.put('/store/space/threads/general/msgs/missed', { body: 'while backgrounded' });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(clientQu, clientTransport);
  client.subscribe('/store/space/threads/general/msgs');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await clientQu.get('/store/space/threads/general/msgs/missed'), null); // confirmed genuinely missed - subscribe() alone never retroactively fetches

  const generationBefore = client.getGeneration();
  client.refreshSubscriptions(); // no transport reconnect happened - the connection was never dropped
  await waitUntil(async () => (await clientQu.get('/store/space/threads/general/msgs/missed'))?.val?.body === 'while backgrounded');
  assert.equal(client.getGeneration(), generationBefore + 1); // still bumped, so per-generation background refresh (@qu/services' sync-freshness.js) re-checks too
});

test('refreshSubscriptions() does NOT fire onReconnect() app-level callbacks - it is not actually a reconnect', async () => {
  const network = new TestNetwork();
  new SyncEngine(freshQu(), new RelayTransport(network));
  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(freshQu(), clientTransport);
  let calls = 0;
  client.onReconnect(() => calls++);

  client.refreshSubscriptions();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 0);
});

// ===== incremental resync watermark correctness =====================================
// `ts` is always a WRITER's own local clock (createQuBit(), packages/core/
// src/qubit.js) - there is no relay-authoritative timestamp anywhere in this
// codebase. The two tests below lock in a real, confirmed bug (not a
// hypothetical): an incremental `fetchPrefix()` catch-up's own `sinceTs`
// watermark used to be able to get permanently inflated by a single
// clock-skewed write, silently and PERMANENTLY hiding a different, later,
// genuinely-new write whose own (accurate) `ts` happened to be lower - see
// #bumpWatermark()'s and refreshSubscriptions()'s own doc comments for the
// full fix (watermark advances only from a whole confirmed fetchPrefix()
// batch, plus a CLOCK_SKEW_MARGIN_MS trailing margin applied when that
// watermark becomes a `sinceTs` request).

test('REGRESSION: a live push with an inflated (clock-skewed) ts must never permanently hide a later, genuinely-new write with a lower ts from the NEXT incremental catch-up', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  const prefix = '/store/space/threads/general/msgs';
  const T0 = Date.now();
  await relayQu.putSealed(`${prefix}/seed`, { path: `${prefix}/seed`, val: { body: 'seed' }, ts: T0, pub: null, sig: null });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(clientQu, clientTransport);
  client.subscribe(prefix);

  // First catch-up - a FULL sync (no #fullSyncDone entry yet): watermark
  // becomes T0, from the one seed entry in this batch.
  client.refreshSubscriptions();
  await waitUntil(async () => (await clientQu.get(`${prefix}/seed`))?.val?.body === 'seed');

  // A LIVE push arrives (as if the relay had just forwarded it from a
  // different, clock-skewed device) with ts 5 minutes AHEAD - delivered
  // directly to this client's transport, exactly the shape #handleSync
  // receives for any live write, regardless of this client's own
  // subscriptions (subscription bookkeeping is the SENDER's concern, not a
  // receive-side filter - see #validateIncomingWrite()'s own doc comment).
  const fromA = { path: `${prefix}/from-a`, val: { body: 'from a (skewed clock)' }, ts: T0 + 5 * 60_000, pub: null, sig: null };
  network.fromRelayToClient('client-a', { type: 'sync', path: fromA.path, quBit: fromA });
  await waitUntil(async () => (await clientQu.get(fromA.path))?.val?.body === 'from a (skewed clock)');

  // While this client is "briefly disconnected", a genuinely new message
  // from a DIFFERENT, accurate-clock device lands directly on the relay -
  // its ts is LOWER than A's skewed one above, but it is real, new
  // information this client has never seen.
  const fromB = { path: `${prefix}/from-b`, val: { body: 'from b (accurate clock)' }, ts: T0 + 2000, pub: null, sig: null };
  await relayQu.putSealed(fromB.path, fromB);

  // Reconnect catch-up - must still retrieve B's message. Before the fix,
  // the live push above would have bumped the watermark to T0+5min,
  // `sinceTs` would exclude B's ts=T0+2000 write, and it would never be
  // returned again.
  client.refreshSubscriptions();
  await waitUntil(async () => (await clientQu.get(fromB.path))?.val?.body === 'from b (accurate clock)');
});

test('REGRESSION: an inflated ts that legitimately enters a fetchPrefix() BATCH (not a live push) must not permanently hide a later, lower-ts write either - closed by CLOCK_SKEW_MARGIN_MS, not by batch-scoping alone', async () => {
  const network = new TestNetwork();
  const relayQu = freshQu();
  const prefix = '/store/space/threads/general/msgs';
  const T0 = Date.now();
  await relayQu.putSealed(`${prefix}/seed`, { path: `${prefix}/seed`, val: { body: 'seed' }, ts: T0, pub: null, sig: null });
  new SyncEngine(relayQu, new RelayTransport(network));

  const clientQu = freshQu();
  const clientTransport = new ClientTransport('client-a', network);
  const client = new SyncEngine(clientQu, clientTransport);
  client.subscribe(prefix);

  client.refreshSubscriptions(); // first full sync - watermark = T0
  await waitUntil(async () => (await clientQu.get(`${prefix}/seed`))?.val?.body === 'seed');

  // NOT a live push this time - the inflated entry reaches the RELAY's own
  // store directly, standing in for "device A's skewed write landed on the
  // relay while this client wasn't even connected to receive it live".
  const fromA = { path: `${prefix}/from-a`, val: { body: 'from a (skewed clock)' }, ts: T0 + 5 * 60_000, pub: null, sig: null };
  await relayQu.putSealed(fromA.path, fromA);

  // Second catch-up - a REAL fetchPrefix() batch legitimately includes A's
  // inflated entry, so per the fix's own rule (batch-scoped, not per-write)
  // the watermark correctly - for that rule - advances to T0+5min anyway.
  client.refreshSubscriptions();
  await waitUntil(async () => (await clientQu.get(fromA.path))?.val?.body === 'from a (skewed clock)');

  // A genuine, lower-ts message from an accurate-clock device lands during
  // the NEXT offline gap.
  const fromB = { path: `${prefix}/from-b`, val: { body: 'from b (accurate clock)' }, ts: T0 + 2000, pub: null, sig: null };
  await relayQu.putSealed(fromB.path, fromB);

  // Third catch-up - only passes WITH the clock-skew margin in place;
  // without it, sinceTs = T0+5min would exclude B's message exactly like
  // the original bug, just entered via a batch instead of a live push.
  client.refreshSubscriptions();
  await waitUntil(async () => (await clientQu.get(fromB.path))?.val?.body === 'from b (accurate clock)');
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
