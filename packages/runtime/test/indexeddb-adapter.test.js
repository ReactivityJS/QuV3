// fake-indexeddb/auto installs global `indexedDB`/`IDBKeyRange` polyfills so
// IndexedDBAdapter (which only ever touches those globals, exactly as it
// would in a real browser) can be unit-tested under plain `node --test`
// without a browser. Test-only - the adapter source itself has zero
// dependency on this package, see indexeddb-adapter.js's own doc comment.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexedDBAdapter } from '../src/indexeddb-adapter.js';

let dbCounter = 0;
/** A fresh, uniquely-named database per test - avoids any cross-test bleed-through in the shared fake-indexeddb backend. */
function freshAdapter() {
  return new IndexedDBAdapter(`qu-test-${dbCounter++}`);
}

function quBit(val, ts) {
  return { path: 'irrelevant', val, ts, pub: null, sig: null };
}

test('put()/get() round-trip', async () => {
  const adapter = freshAdapter();
  await adapter.put('/a', quBit(1, 100));
  assert.deepEqual(await adapter.get('/a'), quBit(1, 100));
});

test('get() of a never-written path returns null', async () => {
  const adapter = freshAdapter();
  assert.equal(await adapter.get('/never-written'), null);
});

test('put() overwrites unconditionally - unlike FsAdapter, IndexedDBAdapter has no ts-guard of its own', async () => {
  // Documents actual current behavior: ts-guarding here is QuStore/putSealed's
  // job upstream, not duplicated in every adapter. Regression guard against
  // silently changing this contract without updating callers.
  const adapter = freshAdapter();
  await adapter.put('/a', quBit('new', 200));
  await adapter.put('/a', quBit('older-write', 100));
  assert.equal((await adapter.get('/a')).val, 'older-write');
});

test('getAll() is recursive and unsorted - includes deeply nested descendants', async () => {
  const adapter = freshAdapter();
  await adapter.put('/thread/msgs/m1', quBit('one', 1));
  await adapter.put('/thread/msgs/m1/reactions/like', quBit('reaction', 2));
  await adapter.put('/thread/other', quBit('unrelated', 3));

  const all = await adapter.getAll('/thread/msgs');
  assert.deepEqual(all.map((e) => e.rel).sort(), ['/thread/msgs/m1', '/thread/msgs/m1/reactions/like']);
});

test('getAll() of a prefix with nothing stored returns an empty array', async () => {
  const adapter = freshAdapter();
  assert.deepEqual(await adapter.getAll('/nothing/here'), []);
});

test('getChildren() is restricted to exactly ONE level - deeper descendants are excluded', async () => {
  const adapter = freshAdapter();
  await adapter.put('/thread/msgs/m1', quBit('one', 1));
  await adapter.put('/thread/msgs/m1/reactions/like', quBit('reaction', 2));

  const children = await adapter.getChildren('/thread/msgs');
  assert.deepEqual(children.map((e) => e.rel), ['/thread/msgs/m1']);
});

test('getChildren() of a prefix with nothing stored returns an empty array', async () => {
  const adapter = freshAdapter();
  assert.deepEqual(await adapter.getChildren('/never/written'), []);
});

test('getChildren() orders by ts (desc by default), tie-broken by rel', async () => {
  const adapter = freshAdapter();
  await adapter.put('/x/b', quBit('b', 100));
  await adapter.put('/x/a', quBit('a', 100));
  await adapter.put('/x/c', quBit('c', 200));

  const desc = await adapter.getChildren('/x', { order: 'desc' });
  assert.deepEqual(desc.map((e) => e.rel), ['/x/c', '/x/b', '/x/a']);

  const asc = await adapter.getChildren('/x', { order: 'asc' });
  assert.deepEqual(asc.map((e) => e.rel), ['/x/a', '/x/b', '/x/c']);
});

test('getChildren() limit+cursor pagination covers every child exactly once, no gaps or duplicates', async () => {
  const adapter = freshAdapter();
  for (let i = 0; i < 5; i++) await adapter.put(`/x/m${i}`, quBit(i, i));

  let cursor;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const page = await adapter.getChildren('/x', { order: 'asc', limit: 2, cursor });
    if (page.length === 0) break;
    seen.push(...page.map((e) => e.rel));
    cursor = page[page.length - 1].cursor;
  }

  assert.deepEqual(seen, ['/x/m0', '/x/m1', '/x/m2', '/x/m3', '/x/m4']);
});

test('two adapters with different dbName are fully isolated from each other', async () => {
  const a = new IndexedDBAdapter('qu-isolation-a');
  const b = new IndexedDBAdapter('qu-isolation-b');
  await a.put('/x', quBit('in-a', 1));
  assert.equal(await b.get('/x'), null);
});

test('destroy() removes every QuBit and closes the connection - a fresh adapter for the same name starts empty', async () => {
  const name = 'qu-destroy-test';
  const adapter = new IndexedDBAdapter(name);
  await adapter.put('/a', quBit(1, 1));
  await adapter.destroy();

  const reopened = new IndexedDBAdapter(name);
  assert.equal(await reopened.get('/a'), null);
});
