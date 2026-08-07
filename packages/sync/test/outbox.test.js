import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryOutboxStore } from '../src/outbox.js';

function quBit(val, ts) {
  return { path: 'irrelevant', val, ts, pub: null, sig: null };
}

test('set()/get() round-trip', async () => {
  const outbox = new MemoryOutboxStore();
  await outbox.set('/a', quBit(1, 100));
  assert.deepEqual(await outbox.get('/a'), quBit(1, 100));
});

test('get() of a never-set path returns null', async () => {
  const outbox = new MemoryOutboxStore();
  assert.equal(await outbox.get('/never-set'), null);
});

test('set() overwrites an existing entry at the same path', async () => {
  const outbox = new MemoryOutboxStore();
  await outbox.set('/a', quBit(1, 100));
  await outbox.set('/a', quBit(2, 200));
  assert.deepEqual(await outbox.get('/a'), quBit(2, 200));
});

test('delete() removes exactly the given entry, leaving the rest', async () => {
  const outbox = new MemoryOutboxStore();
  await outbox.set('/a', quBit(1, 100));
  await outbox.set('/b', quBit(2, 200));
  await outbox.delete('/a');
  assert.equal(await outbox.get('/a'), null);
  assert.deepEqual(await outbox.get('/b'), quBit(2, 200));
});

test('getAll() returns every pending entry', async () => {
  const outbox = new MemoryOutboxStore();
  await outbox.set('/a', quBit(1, 100));
  await outbox.set('/b', quBit(2, 200));
  assert.deepEqual(
    (await outbox.getAll()).map((e) => e.path).sort(),
    ['/a', '/b']
  );
});

test('getAll() of an empty outbox returns an empty array', async () => {
  assert.deepEqual(await new MemoryOutboxStore().getAll(), []);
});

test('two separate MemoryOutboxStore instances do NOT share state (no persistence, by design)', async () => {
  const a = new MemoryOutboxStore();
  await a.set('/x', quBit(1, 100));
  const b = new MemoryOutboxStore();
  assert.equal(await b.get('/x'), null);
});
