import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { DocumentEngine } from '../src/document-engine.js';

function storeWithDocs() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new DocumentEngine(qu);
  return qu;
}

test('put() under a "docs" segment stamps _id and _created', async () => {
  const qu = storeWithDocs();
  const quBit = await qu.put('/store/wiki/docs/1', { title: 'Intro' });
  assert.ok(quBit.val._id);
  assert.equal(typeof quBit.val._created, 'number');
  assert.equal(quBit.val.title, 'Intro');
});

test('put() never runs for a path with no "docs" segment', async () => {
  const qu = storeWithDocs();
  const quBit = await qu.put('/store/wiki/other/1', { title: 'x' });
  assert.equal(quBit.val._id, undefined);
  assert.equal(quBit.val._created, undefined);
});

test('put() does not overwrite an already-present _id/_created (an update keeps its original creation metadata)', async () => {
  const qu = storeWithDocs();
  const first = await qu.put('/store/wiki/docs/1', { title: 'v1' });
  const second = await qu.put('/store/wiki/docs/1', { title: 'v2', _id: first.val._id, _created: first.val._created });
  assert.equal(second.val._id, first.val._id);
  assert.equal(second.val._created, first.val._created);
});

test('each document gets a distinct _id, even created in the same tick', async () => {
  const qu = storeWithDocs();
  const [a, b] = await Promise.all([
    qu.put('/store/wiki/docs/a', { title: 'a' }),
    qu.put('/store/wiki/docs/b', { title: 'b' }),
  ]);
  assert.notEqual(a.val._id, b.val._id);
});

test('dispose() unregisters the engine - stamping stops happening', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const engine = new DocumentEngine(qu);
  engine.dispose();

  const quBit = await qu.put('/store/wiki/docs/1', { title: 'x' });
  assert.equal(quBit.val._id, undefined);
});
