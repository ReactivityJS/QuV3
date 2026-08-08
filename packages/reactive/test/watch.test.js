import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watch } from '../src/watch.js';

/**
 * A minimal fake `qu` - just enough of QuStore's surface (`get()` +
 * `onStorageChange()`) for `watch()` to work against, with `write()` below
 * driving both the stored value AND the notify event `watch()` reacts to
 * (mirroring what a real `QuStore.put()` does).
 */
function fakeQu(initial = {}) {
  const store = new Map(Object.entries(initial));
  const listeners = new Set();
  return {
    async get(path) {
      return store.has(path) ? store.get(path) : null;
    },
    write(path, val, ts) {
      store.set(path, { val, ts });
      for (const listener of listeners) listener({ path });
    },
    onStorageChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('delivers the current value immediately by default', async () => {
  const qu = fakeQu({ '/p': { val: 'hello', ts: 1 } });
  const delivered = [];
  watch(qu, '/p', (v) => delivered.push(v));
  await flush();
  assert.deepEqual(delivered, ['hello']);
});

test('delivers null for a path with nothing stored yet', async () => {
  const qu = fakeQu();
  const delivered = [];
  watch(qu, '/p', (v) => delivered.push(v));
  await flush();
  assert.deepEqual(delivered, [null]);
});

test('initial: false skips the immediate delivery', async () => {
  const qu = fakeQu({ '/p': { val: 'hello', ts: 1 } });
  const delivered = [];
  watch(qu, '/p', (v) => delivered.push(v), { initial: false });
  await flush();
  assert.deepEqual(delivered, []);
});

test('a write to the watched path delivers the new value', async () => {
  const qu = fakeQu({ '/p': { val: 'first', ts: 1 } });
  const delivered = [];
  watch(qu, '/p', (v) => delivered.push(v));
  await flush();
  qu.write('/p', 'second', 2);
  await flush();
  assert.deepEqual(delivered, ['first', 'second']);
});

test('a write to a different path is ignored', async () => {
  const qu = fakeQu({ '/p': { val: 'a', ts: 1 } });
  const delivered = [];
  watch(qu, '/p', (v) => delivered.push(v));
  await flush();
  qu.write('/other', 'b', 2);
  await flush();
  assert.deepEqual(delivered, ['a']);
});

test('unsubscribing stops further delivery', async () => {
  const qu = fakeQu({ '/p': { val: 'a', ts: 1 } });
  const delivered = [];
  const off = watch(qu, '/p', (v) => delivered.push(v));
  await flush();
  off();
  assert.equal(qu.listenerCount(), 0);
  qu.write('/p', 'b', 2);
  await flush();
  assert.deepEqual(delivered, ['a']);
});

test('syncFetch is fired once on attach with the watched path', async () => {
  const qu = fakeQu();
  const fetched = [];
  watch(qu, '/p', () => {}, { syncFetch: async (path) => { fetched.push(path); return null; } });
  await flush();
  assert.deepEqual(fetched, ['/p']);
});

test('a rejecting syncFetch never breaks or delays the initial delivery', async () => {
  const qu = fakeQu({ '/p': { val: 'a', ts: 1 } });
  const delivered = [];
  watch(qu, '/p', (v) => delivered.push(v), { syncFetch: async () => { throw new Error('peer unreachable'); } });
  await flush();
  await flush();
  assert.deepEqual(delivered, ['a']);
});

// Regression: qu.get(path) races the next write to the same path by design
// (see watch.js's own doc comment) - two overlapping refetches can resolve
// in EITHER order. A slower, OLDER refetch resolving AFTER a faster, NEWER
// one must never overwrite the value already delivered.
test('a stale, late-resolving refetch never overwrites an already-delivered fresher value', async () => {
  const resolvers = [];
  const listeners = new Set();
  const qu = {
    async get() {
      return new Promise((resolve) => resolvers.push(resolve));
    },
    onStorageChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const delivered = [];
  watch(qu, '/p', (v) => delivered.push(v), { initial: false });

  // Two writes in quick succession fire two overlapping refetches.
  for (const l of listeners) l({ path: '/p' });
  for (const l of listeners) l({ path: '/p' });
  assert.equal(resolvers.length, 2);

  // The SECOND (fresher, higher ts) refetch resolves first...
  resolvers[1]({ val: 'fresh', ts: 200 });
  await flush();
  // ...then the FIRST (older, lower ts) refetch resolves late.
  resolvers[0]({ val: 'stale', ts: 100 });
  await flush();

  assert.deepEqual(delivered, ['fresh']); // the stale value was dropped, never delivered
});
