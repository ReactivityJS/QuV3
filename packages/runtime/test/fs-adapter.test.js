import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAdapter } from '../src/fs-adapter.js';

async function freshAdapter() {
  const dir = await mkdtemp(join(tmpdir(), 'qu-fs-adapter-test-'));
  return new FsAdapter(dir);
}

function quBit(val, ts) {
  return { path: 'irrelevant', val, ts, pub: null, sig: null };
}

test('put()/get() round-trip', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/a', quBit(1, 100));
  assert.deepEqual(await adapter.get('/a'), quBit(1, 100));
});

test('get() of a never-written path returns null, not an error', async () => {
  const adapter = await freshAdapter();
  assert.equal(await adapter.get('/never-written'), null);
});

test('put() creates nested directories as needed', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/a/b/c/d', quBit('deep', 1));
  assert.deepEqual((await adapter.get('/a/b/c/d')).val, 'deep');
});

test('put() never lets an older ts overwrite a newer one already stored', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/a', quBit('new', 200));
  await adapter.put('/a', quBit('stale', 100));
  assert.equal((await adapter.get('/a')).val, 'new');
});

test('many concurrent put()s to the SAME path converge on the highest ts, never a torn write', async () => {
  const adapter = await freshAdapter();
  const writes = Array.from({ length: 20 }, (_, i) => adapter.put('/hot', quBit(`v${i}`, i)));
  await Promise.all(writes);

  const final = await adapter.get('/hot');
  assert.equal(final.ts, 19);
  assert.equal(final.val, 'v19');
});

test('get() treats corrupt JSON on disk as "nothing usable" (null), not a thrown error', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/a', quBit(1, 1)); // ensure the directory exists
  await writeFile(join(adapter.basePath, 'corrupt.json'), '{ not valid json', 'utf8');
  assert.equal(await adapter.get('/corrupt'), null);
});

test('getAll() is recursive and unsorted - includes deeply nested descendants', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/thread/msgs/m1', quBit('one', 1));
  await adapter.put('/thread/msgs/m1/reactions/like', quBit('reaction', 2));
  await adapter.put('/thread/other', quBit('unrelated', 3));

  const all = await adapter.getAll('/thread/msgs');
  assert.deepEqual(all.map((e) => e.rel).sort(), ['/thread/msgs/m1', '/thread/msgs/m1/reactions/like']);
});

test('getAll() of a prefix with nothing stored returns an empty array', async () => {
  const adapter = await freshAdapter();
  assert.deepEqual(await adapter.getAll('/nothing/here'), []);
});

test('getChildren() is restricted to exactly ONE level - a nested subdirectory is excluded', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/thread/msgs/m1', quBit('one', 1));
  await adapter.put('/thread/msgs/m1/reactions/like', quBit('reaction', 2)); // deeper - lives in a subdirectory "m1/"

  const children = await adapter.getChildren('/thread/msgs');
  assert.deepEqual(children.map((e) => e.rel), ['/thread/msgs/m1']);
});

test('getChildren() of a parent directory that does not exist yet returns an empty array', async () => {
  const adapter = await freshAdapter();
  assert.deepEqual(await adapter.getChildren('/never/written'), []);
});

test('getChildren() orders by ts (desc by default), tie-broken by rel', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/x/b', quBit('b', 100));
  await adapter.put('/x/a', quBit('a', 100)); // same ts as /x/b
  await adapter.put('/x/c', quBit('c', 200));

  const desc = await adapter.getChildren('/x', { order: 'desc' });
  assert.deepEqual(desc.map((e) => e.rel), ['/x/c', '/x/b', '/x/a']);

  const asc = await adapter.getChildren('/x', { order: 'asc' });
  assert.deepEqual(asc.map((e) => e.rel), ['/x/a', '/x/b', '/x/c']);
});

test('getChildren() limit+cursor pagination covers every child exactly once, no gaps or duplicates', async () => {
  const adapter = await freshAdapter();
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

test('getChildren() skips a corrupt child file instead of throwing', async () => {
  const adapter = await freshAdapter();
  await adapter.put('/x/good', quBit('fine', 1));
  await mkdir(join(adapter.basePath, 'x'), { recursive: true });
  await writeFile(join(adapter.basePath, 'x', 'bad.json'), 'not json at all', 'utf8');

  const children = await adapter.getChildren('/x');
  assert.deepEqual(children.map((e) => e.rel), ['/x/good']);
});
