import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { QuRelay } from '../src/relay.js';

async function freshRelay(options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const relay = await new QuRelay({
    storeDir: join(base, 'store'),
    blobDir: join(base, 'blob'),
    port: 0,
    ...options,
  }).boot();
  return {
    relay,
    base,
    teardown: async () => {
      await relay.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('boot() starts a real HTTP server and assigns an actual port', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    assert.ok(relay.port > 0);
  } finally {
    await teardown();
  }
});

test('GET /healthz reports ok with this relay\'s real peerId', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const res = await fetch(`http://localhost:${relay.port}/healthz`);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.peerId, relay.transport.getPeerId());
  } finally {
    await teardown();
  }
});

test('GET /push/vapid-public-key returns a real, resolved VAPID public key after boot', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const res = await fetch(`http://localhost:${relay.port}/push/vapid-public-key`);
    const body = await res.json();
    assert.ok(typeof body.publicKey === 'string' && body.publicKey.length > 0);
  } finally {
    await teardown();
  }
});

test('the relay establishes and persists its own operational identity across a reboot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  try {
    const first = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), port: 0 }).boot();
    const firstPub = QuCrypto.toBase64Url((await first.identity.getMainKey()).publicKey);
    await first.close();

    const second = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), port: 0 }).boot();
    const secondPub = QuCrypto.toBase64Url((await second.identity.getMainKey()).publicKey);
    await second.close();

    assert.equal(firstPub, secondPub);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('identityMnemonic pins the relay\'s identity explicitly, independent of stored state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  try {
    const scratchQu = new QuStore();
    scratchQu.mount('store', new MemoryStoreAdapter());
    const scratchIdentity = new QuIdentityEngine(scratchQu);
    const mnemonic = scratchIdentity.generateMnemonic();
    await scratchIdentity.importMnemonic(mnemonic);
    const expectedPub = QuCrypto.toBase64Url((await scratchIdentity.getMainKey()).publicKey);

    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), port: 0, identityMnemonic: mnemonic }).boot();
    try {
      const actualPub = QuCrypto.toBase64Url((await relay.identity.getMainKey()).publicKey);
      assert.equal(actualPub, expectedPub);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a client connects over WebSocket, publishes a write, and the relay persists it', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const ws = new WebSocket(`ws://localhost:${relay.port}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const quBit = { path: '/store/space/docs/d1', val: { title: 'from a client' }, ts: Date.now(), pub: null, sig: null };
    ws.send(JSON.stringify({ type: 'sync', path: quBit.path, quBit }));

    let stored = null;
    const start = Date.now();
    while (!stored) {
      stored = await relay.qu.get('/store/space/docs/d1');
      if (stored) break;
      if (Date.now() - start > 2000) throw new Error('timed out waiting for the relay to persist the write');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stored.val.title, 'from a client');
    ws.close();
  } finally {
    await teardown();
  }
});

test('a protected resource cannot be overwritten via a forged synced write - the relay\'s AccessEngine rejects it (docs/v3-technical-concept.md §3.3)', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const ownerKp = await QuCrypto.generateKeypair();
    const ownerPub = QuCrypto.toBase64Url(ownerKp.publicKey);
    await relay.qu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });

    const ws = new WebSocket(`ws://localhost:${relay.port}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const attackerKp = await QuCrypto.generateKeypair();
    const payload = { path: '/store/space/docs/protected', val: { title: 'hacked' }, ts: Date.now(), pub: null };
    const signed = await QuCrypto.sign(
      new TextEncoder().encode(JSON.stringify({ path: payload.path, val: payload.val, ts: payload.ts, pub: QuCrypto.toBase64(attackerKp.publicKey) })),
      attackerKp.privateKey
    );
    const quBit = { ...payload, pub: QuCrypto.toBase64(attackerKp.publicKey), sig: QuCrypto.toBase64(signed) };
    ws.send(JSON.stringify({ type: 'sync', path: quBit.path, quBit }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await relay.qu.get('/store/space/docs/protected'), null);
    ws.close();
  } finally {
    await teardown();
  }
});

test('posting a thread message writes a real in-app notification for a mentioned actor with a resolvable profile', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const { ListService, AccessService, MessageService, THREAD_PRESETS, paths } = await import('@qu/services');
    const { QuStore, MemoryStoreAdapter } = await import('@qu/core');

    // A separate identity/store standing in for a synced client - publishes
    // a profile (needed so the relay's own in-app-notification write can
    // encrypt for them) and copies it onto the relay's own store, simulating
    // an already-synced profile.
    const clientQu = new QuStore();
    clientQu.mount('store', new MemoryStoreAdapter());
    const clientIdentity = new QuIdentityEngine(clientQu);
    await clientIdentity.importMnemonic(clientIdentity.generateMnemonic());
    await clientIdentity.publishMainProfile({});
    const clientPub = QuCrypto.toBase64Url((await clientIdentity.getMainKey()).publicKey);
    const profileQuBit = await clientQu.get(`/store/actors/~${clientPub}/profile`);
    await relay.qu.putSealed(`/store/actors/~${clientPub}/profile`, profileQuBit);

    const list = new ListService(relay.qu);
    const access = new AccessService(relay.qu, relay.identity);
    const messages = new MessageService(relay.qu, relay.identity, list, access);
    await messages.createThread('board', 'general', THREAD_PRESETS.forum());
    await messages.postMessage('board', 'general', { body: `hi @${clientPub}`, extra: { mentions: [clientPub] } });

    let entries = [];
    const start = Date.now();
    while (entries.length === 0) {
      entries = await relay.qu.getChildren(paths.threadMessagesParentPath(`notifications-${clientPub}`, 'notifications'));
      if (entries.length) break;
      if (Date.now() - start > 2000) throw new Error('timed out waiting for push delivery to write the in-app notification');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(entries.length, 1);
  } finally {
    await teardown();
  }
});

test('close() shuts down cleanly and releases the port', async () => {
  const { relay, teardown } = await freshRelay();
  const port = relay.port;
  await teardown();
  await assert.rejects(() => fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(300) }));
});
