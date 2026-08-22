import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { EntityEngine } from '../src/entity-engine.js';

function storeWithEntities() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new EntityEngine(qu);
  return qu;
}

test('put() under an "entities" segment stamps _id/_created and requires _type', async () => {
  const qu = storeWithEntities();
  const quBit = await qu.put('/store/wiki/entities/1', { _type: 'article', title: 'Intro' });
  assert.ok(quBit.val._id);
  assert.equal(typeof quBit.val._created, 'number');
  assert.equal(quBit.val._type, 'article');
  assert.equal(quBit.val.title, 'Intro');
});

test('put() never runs for a path with no "entities" segment', async () => {
  const qu = storeWithEntities();
  const quBit = await qu.put('/store/wiki/other/1', { title: 'x' });
  assert.equal(quBit.val._id, undefined);
  assert.equal(quBit.val._created, undefined);
});

test('a brand-new entity with no _type is rejected', async () => {
  const qu = storeWithEntities();
  await assert.rejects(
    () => qu.put('/store/wiki/entities/1', { title: 'no type here' }),
    /EntityEngine: entity write to "\/store\/wiki\/entities\/1" is missing required "_type"/
  );
});

test('put() does not overwrite an already-present _id/_created (an update keeps its original creation metadata)', async () => {
  const qu = storeWithEntities();
  const first = await qu.put('/store/wiki/entities/1', { _type: 'article', title: 'v1' });
  const second = await qu.put('/store/wiki/entities/1', {
    title: 'v2',
    _id: first.val._id,
    _created: first.val._created,
    _type: first.val._type,
  });
  assert.equal(second.val._id, first.val._id);
  assert.equal(second.val._created, first.val._created);
});

test('an update omitting _type does not throw - the already-stored _type is re-attached', async () => {
  const qu = storeWithEntities();
  await qu.put('/store/wiki/entities/1', { _type: 'article', title: 'v1' });

  const second = await qu.put('/store/wiki/entities/1', { title: 'v2' });
  assert.equal(second.val._type, 'article');
  assert.equal(second.val.title, 'v2');
});

test('each entity gets a distinct _id, even created in the same tick', async () => {
  const qu = storeWithEntities();
  const [a, b] = await Promise.all([
    qu.put('/store/wiki/entities/a', { _type: 'article', title: 'a' }),
    qu.put('/store/wiki/entities/b', { _type: 'article', title: 'b' }),
  ]);
  assert.notEqual(a.val._id, b.val._id);
});

test('dispose() unregisters the engine - stamping and _type enforcement stop happening', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const engine = new EntityEngine(qu);
  engine.dispose();

  const quBit = await qu.put('/store/wiki/entities/1', { title: 'no type, no engine, no problem' });
  assert.equal(quBit.val._id, undefined);
  assert.equal(quBit.val._type, undefined);
});
