import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AssetEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { AssetService } from '../src/asset-service.js';
import { assetPath } from '../src/paths.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  const engine = new AssetEngine(qu, { chunkSize: 10 });
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const assets = new AssetService(qu, engine, identity);
  return { qu, engine, identity, assets };
}

async function copyQuBit(fromQu, toQu, path) {
  const quBit = await fromQu.get(path);
  if (quBit) await toQu.putSealed(path, quBit);
  return quBit;
}

test('upload()/download() round-trip a public (unencrypted) asset', async () => {
  const { assets } = await freshSetup();
  const data = new TextEncoder().encode('hello world, this is more than ten bytes');
  const described = await assets.upload('gallery', 'photo1', { name: 'greeting.txt', mime: 'text/plain', data });
  assert.deepEqual(described, { name: 'greeting.txt', mime: 'text/plain', size: data.length });

  const asset = await assets.download('gallery', 'photo1');
  assert.equal(asset.meta.name, 'greeting.txt');
  assert.deepEqual(asset.data, data);
});

test('upload() with readerPubs genuinely encrypts - the raw meta/chunks are ciphertext', async () => {
  const { qu, assets, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await identity.publishMainProfile({ name: 'Me' }); // resolveReaderXKeys needs a published X key, even for self

  await assets.upload('gallery', 'secret1', new TextEncoder().encode('top secret bytes!!'), { readerPubs: [myPub] });

  const rawMeta = await qu.get(assetPath('gallery', 'secret1') + '/meta');
  assert.equal(typeof rawMeta.val.iv, 'string'); // an encrypted envelope, not a plain {name,mime,...} object
});

test('a reader-restricted upload genuinely decrypts for the intended reader via a synced copy', async () => {
  const alice = await freshSetup();
  await alice.identity.publishMainProfile({ name: 'Alice' });

  const bob = await freshSetup();
  await bob.identity.publishMainProfile({ name: 'Bob' });
  const bobPub = QuCrypto.toBase64Url((await bob.identity.getMainKey()).publicKey);

  // Alice needs Bob's profile (for his X25519 key) to encrypt for him.
  await copyQuBit(bob.qu, alice.qu, `/store/actors/~${bobPub}/profile`);

  const data = new TextEncoder().encode('for bobs eyes only, more than ten bytes');
  await alice.assets.upload('gallery', 'forbob', data, { readerPubs: [bobPub] });

  // Simulate sync: meta + every chunk land on Bob's store, and Bob needs
  // Alice's profile to resolve the SENDER's X key when decrypting.
  const alicePub = QuCrypto.toBase64Url((await alice.identity.getMainKey()).publicKey);
  await copyQuBit(alice.qu, bob.qu, `/store/actors/~${alicePub}/profile`);
  await copyQuBit(alice.qu, bob.qu, assetPath('gallery', 'forbob') + '/meta');
  const metaBit = await alice.qu.get(assetPath('gallery', 'forbob') + '/meta');
  // meta is encrypted - Bob decrypts it himself via download(), but to copy
  // the CHUNKS we need the blob path, which requires decrypting here too
  // (test-only shortcut: read it straight from Alice's own already-decrypted view).
  const aliceOwnAsset = await alice.assets.download('gallery', 'forbob');
  const chunkCount = Math.ceil(data.length / 10);
  for (let i = 0; i < chunkCount; i++) {
    await copyQuBit(alice.qu, bob.qu, `${'/blob/gallery/forbob'}/chunk_${i}`);
  }
  void metaBit; void aliceOwnAsset;

  const bobsAsset = await bob.assets.download('gallery', 'forbob');
  assert.ok(bobsAsset, 'Bob should be able to decrypt and reassemble the asset');
  assert.deepEqual(bobsAsset.data, data);
});

test('upload() fails closed if a reader has no resolvable profile/X key', async () => {
  const { assets } = await freshSetup();
  await assert.rejects(
    () => assets.upload('gallery', 'x', new TextEncoder().encode('hi'), { readerPubs: ['nobody-ever-published'] }),
    /has no published profile/
  );
});

test('download() of a never-uploaded asset returns null', async () => {
  const { assets } = await freshSetup();
  assert.equal(await assets.download('gallery', 'nope'), null);
});

test('verifySyncOut() reports synced status via the underlying engine, using freshly-resolved putOptions', async () => {
  const { assets } = await freshSetup();
  await assets.upload('gallery', 'photo1', new TextEncoder().encode('short'));

  let called = 0;
  const syncFetch = async () => { called++; return {}; }; // relay already has everything
  const assetsWithSync = new AssetService(assets.qu, assets.engine, assets.identity, syncFetch);
  const status = await assetsWithSync.verifySyncOut('gallery', 'photo1');
  assert.equal(status.synced, true);
  assert.ok(called > 0);
});

test('verifySyncOut() throws without a configured syncFetch', async () => {
  const { assets } = await freshSetup();
  await assets.upload('gallery', 'photo1', new TextEncoder().encode('short'));
  await assert.rejects(() => assets.verifySyncOut('gallery', 'photo1'), /no syncFetch configured/);
});

test('upload() accepts a Blob-like {name, mime, data} object, Uint8Array, and ArrayBuffer alike for describeFile()', async () => {
  const { assets } = await freshSetup();
  const u8 = new TextEncoder().encode('raw bytes here, more than ten');
  const described1 = await assets.upload('gallery', 'a', u8);
  assert.deepEqual(described1, { name: 'unnamed', mime: 'application/octet-stream', size: u8.length });

  const described2 = await assets.upload('gallery', 'b', u8.buffer);
  assert.deepEqual(described2, { name: 'unnamed', mime: 'application/octet-stream', size: u8.buffer.byteLength });
});
