import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { ThreadEngine } from '../src/thread-engine.js';
import { AccessEngine } from '../src/access-engine.js';

function storeWithThreads() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new ThreadEngine(qu);
  return qu;
}

test('put() of a message path stamps _id and createdAt', async () => {
  const qu = storeWithThreads();
  const quBit = await qu.put('/store/board/threads/general/msgs/m1', { body: 'hi' });
  assert.ok(quBit.val._id);
  assert.equal(typeof quBit.val.createdAt, 'number');
});

test('put() does not overwrite an already-present _id/createdAt', async () => {
  const qu = storeWithThreads();
  const first = await qu.put('/store/board/threads/general/msgs/m1', { body: 'v1' });
  const second = await qu.put('/store/board/threads/general/msgs/m1', {
    body: 'v2',
    _id: first.val._id,
    createdAt: first.val.createdAt,
  });
  assert.equal(second.val._id, first.val._id);
  assert.equal(second.val.createdAt, first.val.createdAt);
});

test('put() of a thread meta path is left untouched - no stamping applies to config', async () => {
  const qu = storeWithThreads();
  const quBit = await qu.put('/store/board/threads/general/meta', { formatting: ['markdown'] });
  assert.equal(quBit.val._id, undefined);
  assert.equal(quBit.val.createdAt, undefined);
});

test('put() of a non-thread path with a "threads" segment elsewhere is untouched', async () => {
  const qu = storeWithThreads();
  const quBit = await qu.put('/store/board/threads/general/pins/p1', { x: 1 }); // not a /msgs/ path
  assert.equal(quBit.val._id, undefined);
});

test('ThreadEngine performs NO ACL check of its own - an unsigned message is stamped and stored when no AccessEngine is present', async () => {
  const qu = storeWithThreads(); // ThreadEngine only, no AccessEngine
  await assert.doesNotReject(() => qu.put('/store/board/threads/general/msgs/m1', { body: 'anyone can post' }));
});

test('integration: with AccessEngine also registered, thread write-authorization is enforced there, not duplicated here', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu); // order 0
  new ThreadEngine(qu); // order 5 - runs only if AccessEngine didn't already throw

  const kp = await QuCrypto.generateKeypair();
  const alicePubB64Url = QuCrypto.toBase64Url(kp.publicKey);
  await qu.put('/store/board/acl/threads/general', { writers: [alicePubB64Url] });

  // Unauthorized: AccessEngine throws before ThreadEngine's stamping ever runs.
  await assert.rejects(() => qu.put('/store/board/threads/general/msgs/m1', { body: 'nope' }));

  // Authorized: passes AccessEngine, THEN gets stamped by ThreadEngine.
  const quBit = await qu.put(
    '/store/board/threads/general/msgs/m1',
    { body: 'yes' },
    { signWith: kp.privateKey, writerPub: kp.publicKey }
  );
  assert.ok(quBit.val._id);
  assert.equal(typeof quBit.val.createdAt, 'number');
});

test('dispose() unregisters the engine - stamping stops happening', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const engine = new ThreadEngine(qu);
  engine.dispose();

  const quBit = await qu.put('/store/board/threads/general/msgs/m1', { body: 'hi' });
  assert.equal(quBit.val._id, undefined);
});
