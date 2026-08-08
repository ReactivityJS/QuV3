import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchChildren } from '../src/watch.js';

/**
 * A minimal fake `qu` - `get()`/`getChildren()`/`onStorageChange()`, enough
 * for `watchChildren()` to work against. `getChildren()` mirrors
 * `QuStore.getChildren()`'s "direct children only, one level deep,
 * `(ts,rel)`-ordered" contract over a flat Map keyed by full path strings.
 */
function fakeQu(initial = {}) {
  const store = new Map(Object.entries(initial).map(([path, val]) => [path, { val, ts: 1 }]));
  const listeners = new Set();
  return {
    async get(path) {
      return store.has(path) ? store.get(path) : null;
    },
    async getChildren(parentPath, { order = 'desc' } = {}) {
      const prefix = `${parentPath}/`;
      const entries = [...store.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, quBit]) => ({ path, quBit }));
      entries.sort((a, b) => (order === 'asc' ? a.quBit.ts - b.quBit.ts : b.quBit.ts - a.quBit.ts));
      return entries;
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

test('delivers the current children immediately by default', async () => {
  const qu = fakeQu({ '/p/a': 'A', '/p/b': 'B' });
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.map((e) => e.path).sort()));
  await flush();
  assert.deepEqual(delivered, [['/p/a', '/p/b']]);
});

test('delivers an empty array for a parent with no children yet', async () => {
  const qu = fakeQu();
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries));
  await flush();
  assert.deepEqual(delivered, [[]]);
});

test('initial: false skips the immediate delivery', async () => {
  const qu = fakeQu({ '/p/a': 'A' });
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries), { initial: false });
  await flush();
  assert.deepEqual(delivered, []);
});

test('a write to a NEW child under the parent triggers a fresh delivery including it', async () => {
  const qu = fakeQu({ '/p/a': 'A' });
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.map((e) => e.path).sort()));
  await flush();
  qu.write('/p/b', 'B', 2);
  await flush();
  assert.deepEqual(delivered, [['/p/a'], ['/p/a', '/p/b']]);
});

test('a write to a DEEPER descendant (grandchild) is ignored - only direct children matter', async () => {
  const qu = fakeQu({ '/p/a': 'A' });
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.length));
  await flush();
  qu.write('/p/a/nested', 'deep', 2);
  await flush();
  assert.deepEqual(delivered, [1]); // no second delivery - /p/a/nested isn't a direct child of /p
});

test('a write to an unrelated path (not under the parent at all) is ignored', async () => {
  const qu = fakeQu({ '/p/a': 'A' });
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.length));
  await flush();
  qu.write('/other/x', 'X', 2);
  await flush();
  assert.deepEqual(delivered, [1]);
});

test('a write to a similarly-PREFIXED but distinct parent is ignored (no false-positive prefix match)', async () => {
  const qu = fakeQu({ '/p/a': 'A' });
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.length));
  await flush();
  qu.write('/prefix-collision/x', 'X', 2); // starts with "/p" as a STRING but is not a child of "/p"
  await flush();
  assert.deepEqual(delivered, [1]);
});

test('unsubscribing stops further delivery', async () => {
  const qu = fakeQu({ '/p/a': 'A' });
  const delivered = [];
  const off = watchChildren(qu, '/p', (entries) => delivered.push(entries.length));
  await flush();
  off();
  assert.equal(qu.listenerCount(), 0);
  qu.write('/p/b', 'B', 2);
  await flush();
  assert.deepEqual(delivered, [1]);
});

test('syncFetch is fired once on attach with the parent path', async () => {
  const qu = fakeQu();
  const fetched = [];
  watchChildren(qu, '/p', () => {}, { syncFetch: async (path) => { fetched.push(path); return null; } });
  await flush();
  assert.deepEqual(fetched, ['/p']);
});

test('a rejecting syncFetch never breaks or delays the initial delivery', async () => {
  const qu = fakeQu({ '/p/a': 'A' });
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.length), { syncFetch: async () => { throw new Error('peer unreachable'); } });
  await flush();
  await flush();
  assert.deepEqual(delivered, [1]);
});

test('order defaults to desc and is forwarded to getChildren()', async () => {
  const qu = fakeQu({ '/p/old': 'old', '/p/new': 'new' });
  // bump timestamps so order is meaningful
  qu.write('/p/old', 'old', 1);
  qu.write('/p/new', 'new', 2);
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.map((e) => e.path)));
  await flush();
  assert.deepEqual(delivered.at(-1), ['/p/new', '/p/old']); // desc by ts
});

test('order: "asc" is honored', async () => {
  const qu = fakeQu();
  qu.write('/p/old', 'old', 1);
  qu.write('/p/new', 'new', 2);
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries.map((e) => e.path)), { order: 'asc' });
  await flush();
  assert.deepEqual(delivered.at(-1), ['/p/old', '/p/new']);
});

// Regression: getChildren() has no single ts to compare across an
// overlapping refetch pair (it's a whole array) - a monotonic call-counter
// guard is the array-shaped equivalent of watch()'s own ts-based one.
test('a stale, late-resolving refetch never overwrites an already-delivered fresher result', async () => {
  const resolvers = [];
  const listeners = new Set();
  const qu = {
    async getChildren() {
      return new Promise((resolve) => resolvers.push(resolve));
    },
    onStorageChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const delivered = [];
  watchChildren(qu, '/p', (entries) => delivered.push(entries), { initial: false });

  for (const l of listeners) l({ path: '/p/x' });
  for (const l of listeners) l({ path: '/p/y' });
  assert.equal(resolvers.length, 2);

  resolvers[1]([{ path: '/p/fresh' }]); // the SECOND (newer) refetch resolves first...
  await flush();
  resolvers[0]([{ path: '/p/stale' }]); // ...then the FIRST (older) resolves late.
  await flush();

  assert.deepEqual(delivered, [[{ path: '/p/fresh' }]]); // the stale result was dropped
});
