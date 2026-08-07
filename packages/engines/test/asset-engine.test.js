import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AssetEngine } from '../src/asset-engine.js';

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
