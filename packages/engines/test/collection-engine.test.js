import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { CollectionEngine } from '../src/collection-engine.js';

function storeWithCollections() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new CollectionEngine(qu);
  return qu;
}

test('get() resolves a {$ref} value to the full QuBit it points at', async () => {
  const qu = storeWithCollections();
  await qu.put('/store/wiki/docs/target', { title: 'Target doc' });
  await qu.put('/store/wiki/pointer', { $ref: '/store/wiki/docs/target' });

  const resolved = await qu.get('/store/wiki/pointer');
  assert.equal(resolved.val.title, 'Target doc');
});

test('get() resolves a {$list} value to an array of the referenced FULL QuBits (not unwrapped values), in list order', async () => {
  const qu = storeWithCollections();
  await qu.put('/store/wiki/docs/a', { title: 'A' });
  await qu.put('/store/wiki/docs/b', { title: 'B' });
  await qu.put('/store/wiki/collections/all', { $list: ['/store/wiki/docs/b', '/store/wiki/docs/a'] });

  const resolved = await qu.get('/store/wiki/collections/all');
  // Each list entry is a full QuBit ({path, val, ts, pub, sig}), same as a
  // bare get() would return - $list resolution never unwraps `.val` itself.
  assert.deepEqual(resolved.val.map((item) => item.val.title), ['B', 'A']);
});

test('get() of a $list containing a never-written path resolves that entry to null, not an error', async () => {
  const qu = storeWithCollections();
  await qu.put('/store/wiki/docs/a', { title: 'A' });
  await qu.put('/store/wiki/collections/mixed', { $list: ['/store/wiki/docs/a', '/store/wiki/docs/missing'] });

  const resolved = await qu.get('/store/wiki/collections/mixed');
  assert.deepEqual(resolved.val.map((item) => item?.val?.title ?? null), ['A', null]);
});

test('get() of a plain value (no $ref/$list) is returned unchanged', async () => {
  const qu = storeWithCollections();
  await qu.put('/store/wiki/docs/1', { title: 'Plain' });
  const resolved = await qu.get('/store/wiki/docs/1');
  assert.equal(resolved.val.title, 'Plain');
});

test('get() of a never-written path still returns null, engine does not choke on it', async () => {
  const qu = storeWithCollections();
  assert.equal(await qu.get('/store/nothing'), null);
});

test('a $ref chain resolves transitively (ref pointing at another ref)', async () => {
  const qu = storeWithCollections();
  await qu.put('/store/wiki/docs/real', { title: 'Real' });
  await qu.put('/store/wiki/middle', { $ref: '/store/wiki/docs/real' });
  await qu.put('/store/wiki/outer', { $ref: '/store/wiki/middle' });

  const resolved = await qu.get('/store/wiki/outer');
  assert.equal(resolved.val.title, 'Real');
});

test('runs on every path (segment: null) - a $ref under an unrelated segment still resolves', async () => {
  const qu = storeWithCollections();
  await qu.put('/store/wiki/docs/target', { title: 'Target' });
  await qu.put('/store/wiki/completely/custom/path', { $ref: '/store/wiki/docs/target' });

  const resolved = await qu.get('/store/wiki/completely/custom/path');
  assert.equal(resolved.val.title, 'Target');
});
