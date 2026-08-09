import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AssetEngine } from '../src/asset-engine.js';
import { AccessEngine } from '../src/access-engine.js';

function storeWithAssets(options) {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  const engine = new AssetEngine(qu, options);
  return { qu, engine };
}

test('put()/getAsset() round-trip a small (single-chunk) file', async () => {
  const { qu, engine } = storeWithAssets();
  const data = new TextEncoder().encode('hello asset engine');
  await qu.put('/store/gallery/assets/photo1', { name: 'greeting.txt', mime: 'text/plain', data });

  const asset = await engine.getAsset('/store/gallery/assets/photo1');
  assert.equal(asset.meta.name, 'greeting.txt');
  assert.equal(asset.meta.chunkCount, 1);
  assert.deepEqual(asset.data, data);
});

test('a large upload splits into multiple chunks and reassembles byte-exact', async () => {
  const { qu, engine } = storeWithAssets({ chunkSize: 10 });
  const data = crypto.getRandomValues(new Uint8Array(35)); // 4 chunks: 10,10,10,5
  await qu.put('/store/gallery/assets/big', { name: 'big.bin', mime: 'application/octet-stream', data });

  const asset = await engine.getAsset('/store/gallery/assets/big');
  assert.equal(asset.meta.chunkCount, 4);
  assert.deepEqual(asset.data, data);
});

test('put() writes chunks under the blob mount, NOT the store mount', async () => {
  const { qu } = storeWithAssets({ chunkSize: 1000 });
  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data: new TextEncoder().encode('x') });

  assert.ok(await qu.get('/blob/gallery/photo1/chunk_0'));
  const storeEntries = await qu.getAllUnderMount('/store/gallery');
  assert.ok(storeEntries.some((e) => e.path === '/store/gallery/assets/photo1/meta'));
  assert.equal(storeEntries.some((e) => e.path.includes('chunk_')), false);
});

test('re-uploading byte-identical content skips rewriting the chunk (dedup/resume)', async () => {
  const { qu } = storeWithAssets({ chunkSize: 1000 });
  const data = new TextEncoder().encode('identical content');
  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data });

  // Spy on the blob mount's put() to count actual chunk writes on the SECOND upload.
  const blobAdapter = qu.resolveMount('/blob/x').adapter;
  let chunkWrites = 0;
  const originalPut = blobAdapter.put.bind(blobAdapter);
  blobAdapter.put = (rel, quBit) => {
    chunkWrites++;
    return originalPut(rel, quBit);
  };

  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data }); // same bytes again
  assert.equal(chunkWrites, 0); // resume check found the existing, hash-identical chunk - nothing re-sent
});

test('re-uploading DIFFERENT content at the same path DOES rewrite the chunk', async () => {
  const { qu } = storeWithAssets({ chunkSize: 1000 });
  await qu.put('/store/gallery/assets/photo1', {
    name: 'x',
    mime: 'text/plain',
    data: new TextEncoder().encode('version one'),
  });

  const blobAdapter = qu.resolveMount('/blob/x').adapter;
  let chunkWrites = 0;
  const originalPut = blobAdapter.put.bind(blobAdapter);
  blobAdapter.put = (rel, quBit) => {
    chunkWrites++;
    return originalPut(rel, quBit);
  };

  await qu.put('/store/gallery/assets/photo1', {
    name: 'x',
    mime: 'text/plain',
    data: new TextEncoder().encode('version two - different content'),
  });
  assert.equal(chunkWrites, 1);
});

test('getAsset() of a never-uploaded path returns null', async () => {
  const { engine } = storeWithAssets();
  assert.equal(await engine.getAsset('/store/gallery/assets/nope'), null);
});

test('getAsset() detects a tampered chunk via hash verification and refuses to reassemble it', async () => {
  const { qu, engine } = storeWithAssets({ chunkSize: 1000 });
  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data: new TextEncoder().encode('original') });

  // Tamper the stored chunk directly, bypassing the engine.
  const chunkBit = await qu.get('/blob/gallery/photo1/chunk_0');
  await qu.put('/blob/gallery/photo1/chunk_0', QuCrypto.toBase64(new TextEncoder().encode('TAMPERED!')));

  const asset = await engine.getAsset('/store/gallery/assets/photo1');
  assert.equal(asset, null); // hash mismatch treated as missing, no syncFetch given so no backfill possible
  void chunkBit;
});

test('accepts a Uint8Array directly (no {name,mime,data} wrapper)', async () => {
  const { qu, engine } = storeWithAssets();
  const data = new TextEncoder().encode('raw bytes');
  await qu.put('/store/gallery/assets/raw', data);

  const asset = await engine.getAsset('/store/gallery/assets/raw');
  assert.equal(asset.meta.name, 'unnamed');
  assert.deepEqual(asset.data, data);
});

test('accepts an ArrayBuffer directly', async () => {
  const { qu, engine } = storeWithAssets();
  const data = new TextEncoder().encode('array buffer bytes');
  await qu.put('/store/gallery/assets/ab', data.buffer);

  const asset = await engine.getAsset('/store/gallery/assets/ab');
  assert.deepEqual(asset.data, data);
});

test('rejects an unrecognized file input shape', async () => {
  const { qu } = storeWithAssets();
  await assert.rejects(() => qu.put('/store/gallery/assets/bad', { totally: 'wrong shape' }), /unrecognised file input/);
});

test('onProgress is called and reaches 1 by the end of a multi-chunk upload', async () => {
  const { qu } = storeWithAssets({ chunkSize: 5 });
  const data = new TextEncoder().encode('this is fifteen'); // > 1 chunk at size 5
  const progressValues = [];
  await qu.put(
    '/store/gallery/assets/p',
    { name: 'x', mime: 'text/plain', data },
    { onProgress: (p) => progressValues.push(p) }
  );
  assert.ok(progressValues.length > 0);
  assert.equal(progressValues[progressValues.length - 1], 1);
});

test('getAsset() retries the whole backfill cycle when maxRetries > 1, succeeding once syncFetch starts finding it', async () => {
  const { qu, engine } = storeWithAssets({ chunkSize: 1000 });
  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data: new TextEncoder().encode('hello') });
  const metaBit = await qu.get('/store/gallery/assets/photo1/meta');
  const chunkBit = await qu.get('/blob/gallery/photo1/chunk_0');

  // Simulate "relay doesn't have it YET" for the first two syncFetch calls,
  // then "relay caught up" from the third call onward - a real race between
  // an upload landing and a peer opening the asset before sync catches up.
  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  otherQu.mount('blob', new MemoryStoreAdapter());
  const otherEngine = new AssetEngine(otherQu);
  let syncFetchCalls = 0;
  const syncFetch = async (path) => {
    syncFetchCalls++;
    if (syncFetchCalls <= 2) throw new Error('not on relay yet'); // fails for meta + chunk_0 on attempt 1
    if (path === '/store/gallery/assets/photo1/meta') await otherQu.putSealed(path, metaBit);
    else await otherQu.putSealed(path, chunkBit);
  };

  const asset = await otherEngine.getAsset('/store/gallery/assets/photo1', syncFetch, null, { maxRetries: 3, retryDelayMs: 1 });
  assert.ok(asset);
  assert.equal(new TextDecoder().decode(asset.data), 'hello');
});

test('getAsset() with the default maxRetries=1 behaves exactly as before (single attempt, no retry)', async () => {
  const { engine } = storeWithAssets();
  let calls = 0;
  const syncFetch = async () => { calls++; throw new Error('unreachable'); };
  const asset = await engine.getAsset('/store/gallery/assets/nope', syncFetch);
  assert.equal(asset, null);
  assert.equal(calls, 1); // only the meta fetch attempted once - never retried
});

test('verifySyncOut(): reports synced:true immediately when the relay already has everything', async () => {
  const { qu, engine } = storeWithAssets({ chunkSize: 1000 });
  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data: new TextEncoder().encode('hi') });

  const status = await engine.verifySyncOut('/store/gallery/assets/photo1', async () => ({}), { maxRetries: 3, retryDelayMs: 1 });
  assert.deepEqual(status, { synced: true, missing: [], attempts: 1 });
});

test('verifySyncOut(): re-puts exactly the pieces missing on the relay, retrying until synced', async () => {
  const { qu, engine } = storeWithAssets({ chunkSize: 5 });
  await qu.put('/store/gallery/assets/big', { name: 'x', mime: 'text/plain', data: new TextEncoder().encode('this is fifteen') }); // 3 chunks

  // The relay is missing chunk_1 for the first 2 checks, then catches up
  // (simulating the RE-PUT this method performs actually landing).
  const relayHas = new Set(['/store/gallery/assets/big/meta', '/blob/gallery/big/chunk_0', '/blob/gallery/big/chunk_2']);
  let putCallsForChunk1 = 0;
  const syncFetch = async (path) => {
    if (relayHas.has(path)) return {};
    throw new Error('not on relay');
  };
  const originalPut = qu.put.bind(qu);
  qu.put = async (path, val, options) => {
    if (path === '/blob/gallery/big/chunk_1') { putCallsForChunk1++; relayHas.add(path); } // simulate this specific re-put reaching the relay
    return originalPut(path, val, options);
  };

  const onSyncProgress = [];
  const status = await engine.verifySyncOut('/store/gallery/assets/big', syncFetch, {
    maxRetries: 3,
    retryDelayMs: 1,
    onSyncProgress: (fraction, s) => onSyncProgress.push({ fraction, missing: s.missing.length }),
  });

  assert.equal(status.synced, true);
  assert.equal(putCallsForChunk1, 1); // exactly one re-send, not one per remaining attempt
  assert.ok(onSyncProgress.length >= 2);
  assert.equal(onSyncProgress[0].missing, 1); // chunk_1 missing on the first check
  assert.equal(onSyncProgress[onSyncProgress.length - 1].fraction, 1);
});

test('verifySyncOut(): gives up after maxRetries, reporting the still-missing pieces', async () => {
  const { qu, engine } = storeWithAssets({ chunkSize: 1000 });
  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data: new TextEncoder().encode('hi') });

  const syncFetch = async (path) => { throw new Error('relay never gets it'); };
  const status = await engine.verifySyncOut('/store/gallery/assets/photo1', syncFetch, { maxRetries: 2, retryDelayMs: 1 });

  assert.equal(status.synced, false);
  assert.equal(status.attempts, 3); // 1 initial + 2 retries
  assert.deepEqual(status.missing.sort(), ['/blob/gallery/photo1/chunk_0', '/store/gallery/assets/photo1/meta'].sort());
});

test('verifySyncOut(): a syncFetch that RESOLVES null (peer confirms "not found", the real SyncEngine.fetch() contract) is treated as missing, not found', async () => {
  // Regression test: `syncFetch(path).then(() => true)` used to ignore the
  // resolved VALUE entirely - any settled promise, including a legitimate
  // `null` ("relay confirms it doesn't have this yet", not an error) was
  // counted as "found". That made a fresh upload's very first
  // verifySyncOut() call report synced:true on attempt 1 regardless of
  // whether the relay actually had anything yet, since SyncEngine.fetch()
  // only REJECTS on an actual timeout, never for a normal "not found" -
  // confirmed live: the uploader's own progress UI jumped straight to
  // "Syncing 100%" instantly, before the relay could possibly have
  // received the chunk yet.
  const { qu, engine } = storeWithAssets({ chunkSize: 1000 });
  await qu.put('/store/gallery/assets/photo1', { name: 'x', mime: 'text/plain', data: new TextEncoder().encode('hi') });

  const relayHas = new Set(['/store/gallery/assets/photo1/meta']); // chunk_0 legitimately not there yet
  const syncFetch = async (path) => (relayHas.has(path) ? {} : null); // resolves null, never rejects/throws

  const status = await engine.verifySyncOut('/store/gallery/assets/photo1', syncFetch, { maxRetries: 0, retryDelayMs: 1 });
  assert.equal(status.synced, false);
  assert.deepEqual(status.missing, ['/blob/gallery/photo1/chunk_0']);
});

test('verifySyncOut(): throws for a path with no local asset at all', async () => {
  const { engine } = storeWithAssets();
  await assert.rejects(
    () => engine.verifySyncOut('/store/gallery/assets/never-uploaded', async () => ({})),
    /no local asset/
  );
});

// ===== real cross-Engine integration with AccessEngine ====================

test('INTEGRATION: with AccessEngine also registered, a hostile second uploader cannot hijack an already-uploaded asset id', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  new AccessEngine(qu); // global, order 0 - runs before AssetEngine (order 10) on every chunk/meta put()
  const engine = new AssetEngine(qu, { chunkSize: 1000 });
  const alice = await QuCrypto.generateKeypair();
  const mallory = await QuCrypto.generateKeypair();

  await qu.put(
    '/store/gallery/assets/photo1',
    { name: 'alice.png', mime: 'image/png', data: new TextEncoder().encode('alices real photo') },
    { signWith: alice.privateKey, writerPub: alice.publicKey }
  );

  // Mallory tries to overwrite the SAME assetId with her own content, signed
  // as herself - AssetEngine writes chunks CONCURRENTLY before the meta
  // write, so this must fail on the very first chunk, before any of her
  // bytes land.
  await assert.rejects(
    () =>
      qu.put(
        '/store/gallery/assets/photo1',
        { name: 'mallory.png', mime: 'image/png', data: new TextEncoder().encode('mallory hijack attempt') },
        { signWith: mallory.privateKey, writerPub: mallory.publicKey }
      ),
    /writer not authorized/
  );

  // Alice's original upload is untouched.
  const asset = await engine.getAsset('/store/gallery/assets/photo1');
  assert.equal(new TextDecoder().decode(asset.data), 'alices real photo');

  // Alice herself can still legitimately re-upload (e.g. resume/retry).
  await assert.doesNotReject(() =>
    qu.put(
      '/store/gallery/assets/photo1',
      { name: 'alice.png', mime: 'image/png', data: new TextEncoder().encode('alices updated photo') },
      { signWith: alice.privateKey, writerPub: alice.publicKey }
    )
  );
});

test('dispose() unregisters the engine - assets put() falls through to default seal/persist instead', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  const engine = new AssetEngine(qu);
  engine.dispose();

  // Without the engine, put() just seals/persists the raw value - no chunking happens.
  const quBit = await qu.put('/store/gallery/assets/x', { name: 'x' });
  assert.deepEqual(quBit.val, { name: 'x' });
});
