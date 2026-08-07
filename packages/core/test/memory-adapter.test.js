import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStoreAdapter } from '../src/adapters/memory.js';

function quBit(val, ts) {
  return { path: 'irrelevant-for-the-adapter', val, ts, pub: null, sig: null };
}

test('put()/get() round-trip', async () => {
  const adapter = new MemoryStoreAdapter();
  await adapter.put('/a', quBit(1, 100));
  assert.deepEqual(await adapter.get('/a'), quBit(1, 100));
  assert.equal(await adapter.get('/never-written'), null);
});

test('put() never lets an older ts overwrite a newer one already stored', async () => {
  const adapter = new MemoryStoreAdapter();
  await adapter.put('/a', quBit('new', 200));
  await adapter.put('/a', quBit('stale', 100)); // arrives "late" (e.g. a delayed retry)
  assert.deepEqual((await adapter.get('/a')).val, 'new');

  await adapter.put('/a', quBit('newer-still', 300));
  assert.deepEqual((await adapter.get('/a')).val, 'newer-still');
});

test('getAll() is UNSORTED and arbitrary depth - includes deeply nested descendants', async () => {
  const adapter = new MemoryStoreAdapter();
  await adapter.put('/thread/msgs/m1', quBit('one', 1));
  await adapter.put('/thread/msgs/m1/reactions/like', quBit('reaction', 2));
  await adapter.put('/thread/other', quBit('unrelated', 3));

  const all = await adapter.getAll('/thread/msgs');
  const rels = all.map((e) => e.rel).sort();
  assert.deepEqual(rels, ['/thread/msgs/m1', '/thread/msgs/m1/reactions/like']);
});

test('getChildren() is restricted to exactly ONE level - deeper descendants are excluded', async () => {
  const adapter = new MemoryStoreAdapter();
  await adapter.put('/thread/msgs/m1', quBit('one', 1));
  await adapter.put('/thread/msgs/m1/reactions/like', quBit('reaction', 2));

  const children = await adapter.getChildren('/thread/msgs');
  assert.deepEqual(children.map((e) => e.rel), ['/thread/msgs/m1']);
});

test('getChildren() accepts a parentRel with or without a trailing slash identically', async () => {
  const adapter = new MemoryStoreAdapter();
  await adapter.put('/thread/msgs/m1', quBit('one', 1));

  const withoutSlash = await adapter.getChildren('/thread/msgs');
  const withSlash = await adapter.getChildren('/thread/msgs/');
  assert.deepEqual(withoutSlash.map((e) => e.rel), ['/thread/msgs/m1']);
  assert.deepEqual(withSlash.map((e) => e.rel), ['/thread/msgs/m1']);
});

test('getChildren() cursor is stable and opaque: the same entry yields the same cursor across separate calls', async () => {
  const adapter = new MemoryStoreAdapter();
  await adapter.put('/x/a', quBit('a', 1));
  await adapter.put('/x/b', quBit('b', 2));

  const first = await adapter.getChildren('/x');
  const second = await adapter.getChildren('/x'); // unrelated, later call
  const byRel = (list) => Object.fromEntries(list.map((e) => [e.rel, e.cursor]));

  assert.deepEqual(byRel(first), byRel(second));
});

test('getChildren() with no children under the prefix returns an empty array, not an error', async () => {
  const adapter = new MemoryStoreAdapter();
  assert.deepEqual(await adapter.getChildren('/nothing/here'), []);
});

test('getChildren() default order is descending by ts', async () => {
  const adapter = new MemoryStoreAdapter();
  await adapter.put('/x/old', quBit('old', 1));
  await adapter.put('/x/new', quBit('new', 2));

  const result = await adapter.getChildren('/x');
  assert.deepEqual(result.map((e) => e.quBit.val), ['new', 'old']);
});
