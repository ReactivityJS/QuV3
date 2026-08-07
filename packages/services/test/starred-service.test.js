import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { StarredService } from '../src/starred-service.js';

async function freshService() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return new StarredService(qu, identity);
}

test('star()/list()/isStarred() round-trip', async () => {
  const service = await freshService();
  await service.star('apps', 'forum');
  const list = await service.list('apps');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'forum');
  assert.equal(typeof list[0].starredAt, 'number');
  assert.equal(await service.isStarred('apps', 'forum'), true);
  assert.equal(await service.isStarred('apps', 'chat'), false);
});

test('star() stores extra data alongside id/starredAt', async () => {
  const service = await freshService();
  await service.star('contacts', 'pub123', { nickname: 'Bob' });
  const [entry] = await service.list('contacts');
  assert.equal(entry.nickname, 'Bob');
  assert.equal(entry.id, 'pub123');
  assert.equal(typeof entry.starredAt, 'number');
});

test('star() is idempotent - starring an already-starred item does not duplicate it', async () => {
  const service = await freshService();
  await service.star('apps', 'forum');
  await service.star('apps', 'forum');
  assert.equal((await service.list('apps')).length, 1);
});

test('unstar() removes exactly the given item, an absent item is a harmless no-op', async () => {
  const service = await freshService();
  await service.star('apps', 'forum');
  await service.star('apps', 'chat');
  await service.unstar('apps', 'forum');
  assert.deepEqual((await service.list('apps')).map((i) => i.id), ['chat']);

  await service.unstar('apps', 'never-starred');
  assert.deepEqual((await service.list('apps')).map((i) => i.id), ['chat']);
});

test('list() of a namespace never used returns an empty array, not null/undefined', async () => {
  const service = await freshService();
  assert.deepEqual(await service.list('never-touched'), []);
});

test('different namespaces are fully independent', async () => {
  const service = await freshService();
  await service.star('apps', 'forum');
  await service.star('contacts', 'forum'); // same id, different namespace
  assert.deepEqual((await service.list('apps')).map((i) => i.id), ['forum']);
  assert.deepEqual((await service.list('contacts')).map((i) => i.id), ['forum']);
  await service.unstar('apps', 'forum');
  assert.deepEqual(await service.list('apps'), []);
  assert.deepEqual((await service.list('contacts')).map((i) => i.id), ['forum']); // untouched
});

test('two different identities never see each other\'s starred lists', async () => {
  // Each identity gets its OWN store - a QuStore holds at most one
  // identity's seed (see @qu/identity's own guard), the same as a real
  // device/browser profile would.
  const aliceQu = new QuStore();
  aliceQu.mount('store', new MemoryStoreAdapter());
  const alice = new QuIdentityEngine(aliceQu);
  await alice.importMnemonic(alice.generateMnemonic());
  const aliceStarred = new StarredService(aliceQu, alice);
  await aliceStarred.star('apps', 'forum');

  const bobQu = new QuStore();
  bobQu.mount('store', new MemoryStoreAdapter());
  const bob = new QuIdentityEngine(bobQu);
  await bob.importMnemonic(bob.generateMnemonic());
  const bobStarred = new StarredService(bobQu, bob);

  assert.deepEqual(await bobStarred.list('apps'), []);
});

test('REGRESSION: many concurrent star() calls to the SAME namespace all survive (QuV2 had no protection against this at all)', async () => {
  const service = await freshService();
  const itemIds = Array.from({ length: 10 }, (_, i) => `item${i}`);

  await Promise.all(itemIds.map((id) => service.star('hot', id)));

  const list = await service.list('hot');
  assert.equal(list.length, 10);
  assert.deepEqual(new Set(list.map((i) => i.id)).size, 10); // no duplicates, none lost
});

test('REGRESSION: concurrent star() and unstar() calls on overlapping items converge correctly', async () => {
  const service = await freshService();
  await service.star('hot', 'keep-me');

  await Promise.all([
    service.star('hot', 'a'),
    service.star('hot', 'b'),
    service.unstar('hot', 'keep-me'),
    service.star('hot', 'c'),
  ]);

  const ids = (await service.list('hot')).map((i) => i.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('syncFetch backfills a starred list this session has never seen locally', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());

  // Simulate the SAME identity's list already existing on a peer, arriving via sync.
  const remoteQu = new QuStore();
  remoteQu.mount('store', new MemoryStoreAdapter());
  const remoteService = new StarredService(remoteQu, identity); // same identity engine, different store = different device
  await remoteService.star('apps', 'from-another-device');

  let syncFetchCalls = 0;
  const syncFetch = async (path) => {
    syncFetchCalls++;
    const quBit = await remoteQu.get(path);
    if (quBit) await qu.putSealed(path, quBit);
  };
  const localService = new StarredService(qu, identity, syncFetch);

  const list = await localService.list('apps');
  assert.equal(syncFetchCalls, 1);
  assert.deepEqual(list.map((i) => i.id), ['from-another-device']);
});
