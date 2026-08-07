import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { CollectionEngine } from '@qu/engines';
import { ListService } from '../src/list-service.js';

// CollectionEngine resolves a curated list's {$list: [...]} document to full
// QuBits on read (see @qu/engines/collection-engine.js) - listCurated()'s
// unwrapAll() call depends on that resolution having already happened, same
// as it would need to at any real call site. Registering it here is exactly
// what a real composition root (a future Runtime bootstrap) is responsible
// for; ListService itself never wires engines, on purpose.
function storeAndService() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new CollectionEngine(qu);
  return { qu, service: new ListService(qu) };
}

// ===== derived lists ===========================================================

test('listDerived() delegates to QuStore.getChildren() with sensible defaults', async () => {
  const { qu, service } = storeAndService();
  await qu.put('/store/board/threads/general/msgs/m0', { body: 'zero' });
  await qu.put('/store/board/threads/general/msgs/m1', { body: 'one' });

  const entries = await service.listDerived('/store/board/threads/general/msgs');
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => typeof e.cursor === 'string'));
});

test('listDerived() respects order/limit/cursor exactly like QuStore.getChildren()', async () => {
  const { qu, service } = storeAndService();
  for (let i = 0; i < 4; i++) await qu.put(`/store/board/threads/g/msgs/m${i}`, { i });

  const page1 = await service.listDerived('/store/board/threads/g/msgs', { order: 'asc', limit: 2 });
  assert.deepEqual(page1.map((e) => e.quBit.val.i), [0, 1]);
  const page2 = await service.listDerived('/store/board/threads/g/msgs', { order: 'asc', limit: 2, cursor: page1[1].cursor });
  assert.deepEqual(page2.map((e) => e.quBit.val.i), [2, 3]);
});

test('listDerived() of a parent with no children returns an empty array', async () => {
  const { service } = storeAndService();
  assert.deepEqual(await service.listDerived('/store/nothing/here'), []);
});

test('derived items need no ListService call to add - a plain qu.put() to the item path is enough', async () => {
  const { qu, service } = storeAndService();
  await qu.put('/store/board/threads/g/msgs/only', { body: 'hi' }); // no service.add*() call at all
  const entries = await service.listDerived('/store/board/threads/g/msgs');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].quBit.val.body, 'hi');
});

// ===== curated lists ============================================================

test('createCurated()/listCurated() round-trip, returning plain UNWRAPPED values', async () => {
  const { qu, service } = storeAndService();
  await qu.put('/store/wiki/docs/a', { title: 'A' });
  await qu.put('/store/wiki/docs/b', { title: 'B' });
  await service.createCurated('/store/wiki/lists/featured', ['/store/wiki/docs/a', '/store/wiki/docs/b']);

  const items = await service.listCurated('/store/wiki/lists/featured');
  assert.deepEqual(items.map((i) => i.title), ['A', 'B']); // plain values, not {path,val,ts,...} envelopes
});

test('listCurated() of a never-created list (no syncFetch configured) returns null', async () => {
  const { service } = storeAndService();
  assert.equal(await service.listCurated('/store/wiki/lists/never-made'), null);
});

test('listCurated() backfills via syncFetch on a genuine local miss', async () => {
  const { qu } = storeAndService();
  let syncFetchCalls = 0;
  const syncFetch = async (path) => {
    syncFetchCalls++;
    // Simulate the peer's data arriving.
    await qu.put('/store/wiki/docs/remote', { title: 'Remote' });
    await qu.putSealed(path, { path, val: { $list: ['/store/wiki/docs/remote'] }, ts: Date.now(), pub: null, sig: null });
  };
  const service = new ListService(qu, syncFetch);

  const items = await service.listCurated('/store/wiki/lists/shared');
  assert.equal(syncFetchCalls, 1);
  assert.deepEqual(items.map((i) => i.title), ['Remote']);
});

test('addCurated() to a not-yet-existing list creates it', async () => {
  const { service } = storeAndService();
  await service.addCurated('/store/wiki/lists/new', '/store/wiki/docs/a');
  assert.deepEqual(await service.listCuratedRawPaths('/store/wiki/lists/new'), ['/store/wiki/docs/a']);
});

test('addCurated() is idempotent - adding an already-present item does not duplicate it', async () => {
  const { service } = storeAndService();
  await service.addCurated('/store/wiki/lists/x', '/store/wiki/docs/a');
  await service.addCurated('/store/wiki/lists/x', '/store/wiki/docs/a');
  assert.deepEqual(await service.listCuratedRawPaths('/store/wiki/lists/x'), ['/store/wiki/docs/a']);
});

test('removeCurated() of an absent item is a harmless no-op', async () => {
  const { service } = storeAndService();
  await service.addCurated('/store/wiki/lists/x', '/store/wiki/docs/a');
  await service.removeCurated('/store/wiki/lists/x', '/store/wiki/docs/never-added');
  assert.deepEqual(await service.listCuratedRawPaths('/store/wiki/lists/x'), ['/store/wiki/docs/a']);
});

test('removeCurated() removes exactly the given item, preserving the rest', async () => {
  const { service } = storeAndService();
  await service.addCurated('/store/wiki/lists/x', '/store/wiki/docs/a');
  await service.addCurated('/store/wiki/lists/x', '/store/wiki/docs/b');
  await service.removeCurated('/store/wiki/lists/x', '/store/wiki/docs/a');
  assert.deepEqual(await service.listCuratedRawPaths('/store/wiki/lists/x'), ['/store/wiki/docs/b']);
});

test('listCuratedRawPaths() returns the raw, unresolved paths - not resolved items', async () => {
  const { qu, service } = storeAndService();
  await qu.put('/store/wiki/docs/a', { title: 'A' });
  await service.addCurated('/store/wiki/lists/x', '/store/wiki/docs/a');

  const raw = await service.listCuratedRawPaths('/store/wiki/lists/x');
  assert.deepEqual(raw, ['/store/wiki/docs/a']); // a path string, not {title: 'A'}
});

test('listCuratedRawPaths() of a never-created list returns an empty array', async () => {
  const { service } = storeAndService();
  assert.deepEqual(await service.listCuratedRawPaths('/store/wiki/lists/nope'), []);
});

// ===== concurrency regression coverage =========================================
// This is the entire reason #locks/#mutateOnce's retry logic exists - see the
// class doc comment's own account of the adversarial test that found the bug.

test('REGRESSION: many concurrent same-process addCurated() calls to the SAME list all survive', async () => {
  const { service } = storeAndService();
  const itemPaths = Array.from({ length: 10 }, (_, i) => `/store/wiki/docs/item${i}`);

  await Promise.all(itemPaths.map((p) => service.addCurated('/store/wiki/lists/hot', p)));

  const raw = await service.listCuratedRawPaths('/store/wiki/lists/hot');
  assert.equal(new Set(raw).size, 10); // all 10 present, no duplicates, none lost
  assert.deepEqual([...raw].sort(), [...itemPaths].sort());
});

test('REGRESSION: two independent ListService instances (simulating two peers) racing on the same list both survive via retry', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const peerA = new ListService(qu);
  const peerB = new ListService(qu);

  await Promise.all([
    peerA.addCurated('/store/wiki/lists/shared', '/store/wiki/docs/from-a'),
    peerB.addCurated('/store/wiki/lists/shared', '/store/wiki/docs/from-b'),
  ]);

  const raw = await peerA.listCuratedRawPaths('/store/wiki/lists/shared');
  assert.deepEqual([...raw].sort(), ['/store/wiki/docs/from-a', '/store/wiki/docs/from-b']);
});

test('a persistently-losing race gives up gracefully after MAX_MUTATE_RETRIES - resolves, does not hang or throw', async () => {
  const inner = new MemoryStoreAdapter();
  // A "hostile peer" adapter: every write ListService makes to the list is
  // immediately clobbered by a competing value that never contains our item -
  // simulates permanent, unwinnable contention.
  const flaky = {
    put: async (rel, quBit) => {
      await inner.put(rel, quBit);
      if (rel === '/wiki/lists/contested') {
        await inner.put(rel, { path: quBit.path, val: { $list: ['/decoy'] }, ts: quBit.ts + 1, pub: null, sig: null });
      }
      return quBit;
    },
    get: (rel) => inner.get(rel),
    getAll: (rel) => inner.getAll(rel),
    getChildren: (rel, opts) => inner.getChildren(rel, opts),
  };
  const qu = new QuStore();
  qu.mount('store', flaky);
  const service = new ListService(qu);

  await assert.doesNotReject(() => service.addCurated('/store/wiki/lists/contested', '/store/wiki/docs/never-wins'));
  const raw = await service.listCuratedRawPaths('/store/wiki/lists/contested');
  assert.equal(raw.includes('/store/wiki/docs/never-wins'), false); // truly lost the race every time, as designed
});
