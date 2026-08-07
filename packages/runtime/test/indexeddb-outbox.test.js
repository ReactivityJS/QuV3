import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexedDBOutboxStore } from '../src/indexeddb-outbox.js';

let dbCounter = 0;
/** A fresh, uniquely-named database per test - avoids any cross-test bleed-through in the shared fake-indexeddb backend. */
function freshOutbox() {
  return new IndexedDBOutboxStore(`qu-test-outbox-${dbCounter++}`);
}

function quBit(val, ts) {
  return { path: 'irrelevant', val, ts, pub: null, sig: null };
}

test('set()/get() round-trip', async () => {
  const outbox = freshOutbox();
  await outbox.set('/a', quBit(1, 100));
  assert.deepEqual(await outbox.get('/a'), quBit(1, 100));
});

test('get() of a never-set path returns null', async () => {
  const outbox = freshOutbox();
  assert.equal(await outbox.get('/never-set'), null);
});

test('set() overwrites an existing entry at the same path', async () => {
  const outbox = freshOutbox();
  await outbox.set('/a', quBit(1, 100));
  await outbox.set('/a', quBit(2, 200));
  assert.deepEqual(await outbox.get('/a'), quBit(2, 200));
});

test('delete() removes exactly the given entry', async () => {
  const outbox = freshOutbox();
  await outbox.set('/a', quBit(1, 100));
  await outbox.set('/b', quBit(2, 200));
  await outbox.delete('/a');
  assert.equal(await outbox.get('/a'), null);
  assert.deepEqual(await outbox.get('/b'), quBit(2, 200));
});

test('delete() of a never-set path is a harmless no-op', async () => {
  const outbox = freshOutbox();
  await assert.doesNotReject(() => outbox.delete('/never-set'));
});

test('getAll() returns every pending entry as {path, quBit} pairs', async () => {
  const outbox = freshOutbox();
  await outbox.set('/a', quBit(1, 100));
  await outbox.set('/b', quBit(2, 200));
  const all = await outbox.getAll();
  assert.deepEqual(
    all.map((e) => e.path).sort(),
    ['/a', '/b']
  );
});

test('getAll() of an empty outbox returns an empty array', async () => {
  const outbox = freshOutbox();
  assert.deepEqual(await outbox.getAll(), []);
});

test('a fresh IndexedDBOutboxStore instance on the same dbName sees entries a previous instance wrote (genuinely persistent, not in-memory)', async () => {
  const dbName = `qu-test-outbox-persist-${dbCounter++}`;
  await new IndexedDBOutboxStore(dbName).set('/a', quBit(1, 100));
  const reopened = new IndexedDBOutboxStore(dbName);
  assert.deepEqual(await reopened.get('/a'), quBit(1, 100));
});
