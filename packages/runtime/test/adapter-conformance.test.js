// CONFORMANCE SUITE — runs the identical scenario against every QuAdapter
// implementation (MemoryStoreAdapter, FsAdapter, IndexedDBAdapter,
// SessionStorageAdapter, LocalStorageAdapter) and asserts they agree.
// MemoryStoreAdapter is the reference implementation of the getChildren()
// contract (docs/v3-technical-concept.md §1.2); this file is what actually
// proves the others live up to it, rather than just each independently
// believing their own tests. A one-way dependency on @qu/core for the
// reference adapter is fine here (this package already depends on
// @qu/core); @qu/core's own tests never import anything from @qu/runtime.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStoreAdapter } from '@qu/core/adapters/memory';
import { FsAdapter } from '../src/fs-adapter.js';
import { IndexedDBAdapter } from '../src/indexeddb-adapter.js';
import { SessionStorageAdapter } from '../src/session-storage-adapter.js';
import { LocalStorageAdapter } from '../src/local-storage-adapter.js';
import { installWebStoragePolyfill } from './web-storage-polyfill.js';

installWebStoragePolyfill();

let idbCounter = 0;
let sessionStorageCounter = 0;
let localStorageCounter = 0;

const adapterFactories = {
  Memory: async () => new MemoryStoreAdapter(),
  Fs: async () => new FsAdapter(await mkdtemp(join(tmpdir(), 'qu-conformance-'))),
  IndexedDB: async () => new IndexedDBAdapter(`qu-conformance-${idbCounter++}`),
  SessionStorage: async () => new SessionStorageAdapter(`qu-conformance-session-${sessionStorageCounter++}`),
  LocalStorage: async () => new LocalStorageAdapter(`qu-conformance-local-${localStorageCounter++}`),
};

function quBit(val, ts) {
  return { path: 'irrelevant', val, ts, pub: null, sig: null };
}

for (const [name, makeAdapter] of Object.entries(adapterFactories)) {
  test(`[${name}] getChildren(): one level deep, (ts,rel)-ordered, cursor-paginated - full scenario`, async () => {
    const adapter = await makeAdapter();

    // Direct children, deliberately written out of ts order.
    await adapter.put('/thread/msgs/m2', quBit('two', 20));
    await adapter.put('/thread/msgs/m0', quBit('zero', 0));
    await adapter.put('/thread/msgs/m1', quBit('one', 10));
    // A deeper descendant that must NOT appear as a direct child.
    await adapter.put('/thread/msgs/m1/reactions/like', quBit('reaction', 99));
    // An unrelated sibling that must not leak in.
    await adapter.put('/thread/other', quBit('unrelated', 5));

    const desc = await adapter.getChildren('/thread/msgs', { order: 'desc' });
    assert.deepEqual(
      desc.map((e) => e.rel),
      ['/thread/msgs/m2', '/thread/msgs/m1', '/thread/msgs/m0'],
      `[${name}] desc order`
    );

    const asc = await adapter.getChildren('/thread/msgs', { order: 'asc' });
    assert.deepEqual(
      asc.map((e) => e.rel),
      ['/thread/msgs/m0', '/thread/msgs/m1', '/thread/msgs/m2'],
      `[${name}] asc order`
    );

    // Full pagination sweep must reconstruct exactly the 3 direct children, no more, no less.
    let cursor;
    const paged = [];
    for (let i = 0; i < 10; i++) {
      const page = await adapter.getChildren('/thread/msgs', { order: 'asc', limit: 1, cursor });
      if (page.length === 0) break;
      paged.push(...page.map((e) => e.rel));
      cursor = page[page.length - 1].cursor;
    }
    assert.deepEqual(paged, ['/thread/msgs/m0', '/thread/msgs/m1', '/thread/msgs/m2'], `[${name}] paginated sweep`);
  });

  test(`[${name}] getChildren() of an empty/nonexistent parent returns []`, async () => {
    const adapter = await makeAdapter();
    assert.deepEqual(await adapter.getChildren('/nothing/here'), []);
  });

  test(`[${name}] put()/get() round-trip preserves the QuBit exactly`, async () => {
    const adapter = await makeAdapter();
    const bit = quBit({ nested: ['a', 1, null] }, 123);
    await adapter.put('/x', bit);
    assert.deepEqual(await adapter.get('/x'), bit);
  });
}
