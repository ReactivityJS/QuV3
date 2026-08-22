import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, assertWriteAuthorized } from '../src/access-engine.js';

function storeWithAccess() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  new AccessEngine(qu);
  return qu;
}

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { ...kp, pubB64Url: QuCrypto.toBase64Url(kp.publicKey) };
}

test('a resource with no ACL doc is fully open - any writer, even unsigned', async () => {
  const qu = storeWithAccess();
  await assert.doesNotReject(() => qu.put('/store/wiki/docs/1', { title: 'open' }));
  const alice = await actor();
  await assert.doesNotReject(() =>
    qu.put('/store/wiki/docs/2', { title: 'still open' }, { signWith: alice.privateKey, writerPub: alice.publicKey })
  );
});

test('once an ACL doc exists, an unlisted writer is rejected', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  const eve = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] });

  await assert.rejects(
    () => qu.put('/store/wiki/docs/1', { title: 'x' }, { signWith: eve.privateKey, writerPub: eve.publicKey }),
    /not authorized to write to docs "1"/
  );
});

test('a listed writer is allowed', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] });

  await assert.doesNotReject(() =>
    qu.put('/store/wiki/docs/1', { title: 'x' }, { signWith: alice.privateKey, writerPub: alice.publicKey })
  );
});

test('an unsigned write to an ACL-protected resource is rejected', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] });

  await assert.rejects(() => qu.put('/store/wiki/docs/1', { title: 'x' })); // no signWith/writerPub at all
});

test('writers: "*" means anyone signed may write', async () => {
  const qu = storeWithAccess();
  const anyone = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: '*' });

  await assert.doesNotReject(() =>
    qu.put('/store/wiki/docs/1', { title: 'x' }, { signWith: anyone.privateKey, writerPub: anyone.publicKey })
  );
});

test('every protectable kind (docs, collections, assets-meta, threads) is gated the same way', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  const eve = await actor();

  const cases = [
    ['collections', '/store/s/collections/1'],
    ['assets', '/store/s/assets/1/meta'],
    ['threads', '/store/s/threads/1/meta'],
    ['threads', '/store/s/threads/1/msgs/m1'], // same kind+resourceId as above on purpose - one ACL doc gates both paths
  ];
  const aclEstablished = new Set();
  for (const [kind, path] of cases) {
    if (!aclEstablished.has(kind)) {
      await qu.put(`/store/s/acl/${kind}/1`, { writers: [alice.pubB64Url] }); // first-writer-wins bootstrap, unsigned is fine here
      aclEstablished.add(kind);
    }
    await assert.rejects(
      () => qu.put(path, { x: 1 }, { signWith: eve.privateKey, writerPub: eve.publicKey }),
      new RegExp(`not authorized to write to ${kind} "1"`),
      `kind=${kind}`
    );
    await assert.doesNotReject(
      () => qu.put(path, { x: 1 }, { signWith: alice.privateKey, writerPub: alice.publicKey }),
      `kind=${kind}`
    );
  }
});

test('the "entities" kind (Quniverse V4) is gated the same way as every other kind', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  const eve = await actor();
  await qu.put('/store/s/acl/entities/1', { writers: [alice.pubB64Url] });

  await assert.rejects(
    () => qu.put('/store/s/entities/1', { _type: 'article' }, { signWith: eve.privateKey, writerPub: eve.publicKey }),
    /not authorized to write to entities "1"/
  );
  await assert.doesNotReject(() =>
    qu.put('/store/s/entities/1', { _type: 'article' }, { signWith: alice.privateKey, writerPub: alice.publicKey })
  );
});

test('an entity with no ACL doc is fully open, same first-writer-wins default as every other kind', async () => {
  const qu = storeWithAccess();
  await assert.doesNotReject(() => qu.put('/store/wiki/entities/1', { _type: 'article' }));
});

test('a path outside every recognized kind is never gated', async () => {
  const qu = storeWithAccess();
  await assert.doesNotReject(() => qu.put('/store/some/unrelated/path', { x: 1 }));
});

test('ACL bootstrap: the FIRST writer to create an ACL doc establishes it, no prior authorization needed', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  await assert.doesNotReject(() =>
    qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] }, { signWith: alice.privateKey, writerPub: alice.publicKey })
  );
});

test('ACL self-protection: once established, only an already-listed writer may change the ACL doc itself', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  const eve = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] });

  await assert.rejects(
    () => qu.put('/store/wiki/acl/docs/1', { writers: [eve.pubB64Url] }, { signWith: eve.privateKey, writerPub: eve.publicKey }),
    /not authorized to change access for docs "1"/
  );
  await assert.doesNotReject(() =>
    qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url, eve.pubB64Url] }, { signWith: alice.privateKey, writerPub: alice.publicKey })
  );
});

test('assertWriteAuthorized() is the exact function AccessEngine delegates to - usable standalone (e.g. by sync)', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  const eve = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] });

  await assert.doesNotReject(() => assertWriteAuthorized(qu, '/store/wiki/docs/1', alice.publicKey));
  await assert.rejects(() => assertWriteAuthorized(qu, '/store/wiki/docs/1', eve.publicKey));
  await assert.rejects(() => assertWriteAuthorized(qu, '/store/wiki/docs/1', null));
});

test('assertWriteAuthorized() with a base64 (not base64url) decoded writerPub still matches - the caller normalizes to raw bytes first', async () => {
  // Simulates @qu/sync's use case: a synced QuBit's `pub` is a base64 STRING,
  // decoded to raw bytes via QuCrypto.fromBase64() before calling here - see
  // access-engine.js's own doc comment on this contract.
  const qu = storeWithAccess();
  const alice = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] });

  const quBitPubField = QuCrypto.toBase64(alice.publicKey); // what a real QuBit.pub looks like
  const rawBytes = QuCrypto.fromBase64(quBitPubField);
  await assert.doesNotReject(() => assertWriteAuthorized(qu, '/store/wiki/docs/1', rawBytes));
});

// ===== blob chunks (asset attachments) ==================================

test('a blob chunk write is open when no asset meta doc exists yet - first writer bootstraps the asset, same as any other kind', async () => {
  const qu = storeWithAccess();
  const eve = await actor();
  await assert.doesNotReject(() =>
    qu.put('/blob/gallery/photo1/chunk_0', 'AAAA', { signWith: eve.privateKey, writerPub: eve.publicKey })
  );
});

test('once an asset\'s meta doc is established, only its OWN signer may write its chunks', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  const eve = await actor();
  await qu.put('/store/gallery/assets/photo1/meta', { name: 'x' }, { signWith: alice.privateKey, writerPub: alice.publicKey });

  await assert.rejects(
    () => qu.put('/blob/gallery/photo1/chunk_0', 'AAAA', { signWith: eve.privateKey, writerPub: eve.publicKey }),
    /writer not authorized to write chunks for asset "photo1" - does not match its established owner/
  );
  await assert.doesNotReject(() =>
    qu.put('/blob/gallery/photo1/chunk_0', 'AAAA', { signWith: alice.privateKey, writerPub: alice.publicKey })
  );
});

test('an UNSIGNED chunk write is rejected once an asset has an established (signed) owner', async () => {
  const qu = storeWithAccess();
  const alice = await actor();
  await qu.put('/store/gallery/assets/photo1/meta', { name: 'x' }, { signWith: alice.privateKey, writerPub: alice.publicKey });

  await assert.rejects(() => qu.put('/blob/gallery/photo1/chunk_0', 'AAAA')); // no signWith/writerPub at all
});

test('an explicit "assets" ACL doc takes precedence over the meta-signer fallback', async () => {
  const qu = storeWithAccess();
  const alice = await actor(); // uploaded the asset (meta signer)
  const eve = await actor(); // NOT the uploader, but IS listed on the ACL doc
  await qu.put('/store/gallery/assets/photo1/meta', { name: 'x' }, { signWith: alice.privateKey, writerPub: alice.publicKey });
  await qu.put('/store/gallery/acl/assets/photo1', { writers: [eve.pubB64Url] });

  // The ACL doc, not the meta signer, now decides - alice (the original
  // uploader) is REJECTED because the ACL doc doesn't list her.
  await assert.rejects(() =>
    qu.put('/blob/gallery/photo1/chunk_0', 'AAAA', { signWith: alice.privateKey, writerPub: alice.publicKey })
  );
  await assert.doesNotReject(() =>
    qu.put('/blob/gallery/photo1/chunk_0', 'AAAA', { signWith: eve.privateKey, writerPub: eve.publicKey })
  );
});

test('every kind other than assets stays fully open with no ACL doc - the meta-signer fallback is blob-chunk-specific, not a general default change', async () => {
  const qu = storeWithAccess();
  const eve = await actor();
  await qu.put('/store/wiki/docs/1', { title: 'first' }, { signWith: eve.privateKey, writerPub: eve.publicKey });

  const mallory = await actor();
  await assert.doesNotReject(() =>
    qu.put('/store/wiki/docs/1', { title: 'overwritten' }, { signWith: mallory.privateKey, writerPub: mallory.publicKey })
  );
});

test('dispose() unregisters the engine - ACL enforcement stops happening', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const engine = new AccessEngine(qu);
  const alice = await actor();
  const eve = await actor();
  await qu.put('/store/wiki/acl/docs/1', { writers: [alice.pubB64Url] });

  engine.dispose();
  await assert.doesNotReject(() =>
    qu.put('/store/wiki/docs/1', { title: 'x' }, { signWith: eve.privateKey, writerPub: eve.publicKey })
  );
});
