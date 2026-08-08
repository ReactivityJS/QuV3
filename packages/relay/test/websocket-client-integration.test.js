import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { SyncEngine, WebSocketClientTransport } from '@qu/sync';
import { QuRelay } from '../src/relay.js';

/**
 * WEBSOCKET CLIENT TRANSPORT — REAL ROUND TRIP.
 *
 * `WebSocketClientTransport` (`@qu/sync`'s browser-facing transport - the
 * one thing `apps/shell` would need to actually talk to a relay) had ZERO
 * test coverage of its own before this file: `sync-engine.test.js` only
 * ever exercises `SyncEngine`'s logic against a hand-rolled FAKE transport
 * shaped like it, never the real class, and never against a real
 * `QuRelay`. This file closes exactly that gap - a real client, a real
 * relay, a real `ws://` connection, before any shell code is built on top
 * of the assumption that this actually works.
 *
 * Uses Node's native `WebSocket` global (Node 22+, same as this transport's
 * own doc comment describes) - no `WebSocketImpl` override, no `ws`
 * package client-side, so this exercises the EXACT code path a real
 * browser would too.
 */

async function freshRelay() {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-ws-'));
  const relay = await new QuRelay({
    storeDir: join(base, 'store'),
    blobDir: join(base, 'blob'),
    appsDir: join(base, 'apps'), // empty, isolated - see relay.test.js's freshRelay() for why
    port: 0,
  }).boot();
  return {
    relay,
    teardown: async () => {
      await relay.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

/** A star-topology client SyncEngine, connected and ready - the exact shape `apps/shell` would construct. */
async function connectClient(relayPort) {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const transport = new WebSocketClientTransport(`ws://localhost:${relayPort}`);
  const sync = new SyncEngine(qu, transport, { publishAllTo: transport.getPeerId() });
  await transport.connect();
  return {
    qu,
    transport,
    sync,
    teardown: () => {
      sync.close();
      transport.close();
    },
  };
}

async function waitFor(check, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (true) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeout) throw new Error(`waitFor: condition never became true within ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

test('a local write on the client is published to the relay over a real WebSocket connection', async () => {
  const { relay, teardown: teardownRelay } = await freshRelay();
  const client = await connectClient(relay.port);
  try {
    await client.qu.put('/store/space/test/hello', { msg: 'hi from client' });
    await waitFor(async () => (await relay.qu.get('/store/space/test/hello'))?.val);
    const stored = await relay.qu.get('/store/space/test/hello');
    assert.deepEqual(stored.val, { msg: 'hi from client' });
  } finally {
    client.teardown();
    await teardownRelay();
  }
});

test('a write on the relay reaches a client subscribed to the same prefix', async () => {
  const { relay, teardown: teardownRelay } = await freshRelay();
  const client = await connectClient(relay.port);
  try {
    client.sync.subscribe('/store/space');
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the subscribe message land before the relay writes
    await relay.qu.put('/store/space/test/from-relay', { msg: 'hi from relay' });
    await waitFor(async () => (await client.qu.get('/store/space/test/from-relay'))?.val);
    const stored = await client.qu.get('/store/space/test/from-relay');
    assert.deepEqual(stored.val, { msg: 'hi from relay' });
  } finally {
    client.teardown();
    await teardownRelay();
  }
});

test('after a manual disconnect, a fresh connection + fetchPrefix() catches up on what was missed while disconnected', async () => {
  const { relay, teardown: teardownRelay } = await freshRelay();
  const client = await connectClient(relay.port);
  try {
    client.sync.subscribe('/store/space');
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.teardown(); // simulates a page closing / going offline - NOT an unexpected drop, so the transport won't auto-reconnect

    await relay.qu.put('/store/space/test/missed-while-offline', { msg: 'you missed this' });

    // A fresh connection (simulating a page reload) picks up where it left
    // off via fetchPrefix() - the same reciprocal catch-up SyncEngine
    // already relies on for a reconnect, exercised here end-to-end against
    // the real relay for the first time.
    const reconnected = await connectClient(relay.port);
    try {
      await reconnected.sync.fetchPrefix('/store/space');
      const stored = await reconnected.qu.get('/store/space/test/missed-while-offline');
      assert.deepEqual(stored.val, { msg: 'you missed this' });
    } finally {
      reconnected.teardown();
    }
  } finally {
    await teardownRelay();
  }
});
