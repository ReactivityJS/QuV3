import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { putPrivate, getPrivate, getPrivateChildren, createPrivateStore } from '../src/private-storage.js';

async function identityOnFreshStore() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity };
}

test('putPrivate()/getPrivate() round-trip an arbitrary JSON value', async () => {
  const { qu, identity } = await identityOnFreshStore();
  await putPrivate(qu, identity, '/store/x', { hello: 'world', n: 42 });
  assert.deepEqual(await getPrivate(qu, identity, '/store/x'), { hello: 'world', n: 42 });
});

test('the stored QuBit is actually encrypted, not plaintext, on the wire', async () => {
  const { qu, identity } = await identityOnFreshStore();
  await putPrivate(qu, identity, '/store/x', { secret: 'value' });
  const raw = await qu.get('/store/x');
  assert.notEqual(raw.val.secret, 'value'); // not readable without decrypting
  assert.ok(raw.val.iv && raw.val.ct && Array.isArray(raw.val.to));
});

test('putPrivate() signs the QuBit with the identity\'s main key', async () => {
  const { qu, identity } = await identityOnFreshStore();
  const { QuCrypto } = await import('@qu/core');
  await putPrivate(qu, identity, '/store/x', 'v');
  const raw = await qu.get('/store/x');
  const mainKey = await identity.getMainKey();
  assert.equal(raw.pub, QuCrypto.toBase64(mainKey.publicKey));
});

test('getPrivate() of a never-written path returns null', async () => {
  const { qu, identity } = await identityOnFreshStore();
  assert.equal(await getPrivate(qu, identity, '/store/nope'), null);
});

test('getPrivate() tolerates a plaintext (non-envelope) value already stored at the path', async () => {
  const { qu, identity } = await identityOnFreshStore();
  await qu.put('/store/x', { plain: true });
  assert.deepEqual(await getPrivate(qu, identity, '/store/x'), { plain: true });
});

test('getPrivate() returns null when a DIFFERENT identity tries to decrypt (not an intended recipient)', async () => {
  const { qu, identity: owner } = await identityOnFreshStore();
  await putPrivate(qu, owner, '/store/x', 'owners-secret');

  const { identity: stranger } = await identityOnFreshStore(); // its own separate store + seed
  assert.equal(await getPrivate(qu, stranger, '/store/x'), null); // read via the OWNER's qu, but decrypt as a stranger
});

test('putPrivate() with different values at different paths does not cross-contaminate', async () => {
  const { qu, identity } = await identityOnFreshStore();
  await putPrivate(qu, identity, '/store/a', 'A');
  await putPrivate(qu, identity, '/store/b', 'B');
  assert.equal(await getPrivate(qu, identity, '/store/a'), 'A');
  assert.equal(await getPrivate(qu, identity, '/store/b'), 'B');
});

// ===== getPrivateChildren() =================================================

test('getPrivateChildren() returns every child, decrypted', async () => {
  const { qu, identity } = await identityOnFreshStore();
  await putPrivate(qu, identity, '/store/p/a', { name: 'Alpha' });
  await putPrivate(qu, identity, '/store/p/b', { name: 'Beta' });

  const entries = await getPrivateChildren(qu, identity, '/store/p');
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e.value]));
  assert.deepEqual(byPath, { '/store/p/a': { name: 'Alpha' }, '/store/p/b': { name: 'Beta' } });
});

test('getPrivateChildren() of a parent with no children yet returns an empty array', async () => {
  const { qu, identity } = await identityOnFreshStore();
  assert.deepEqual(await getPrivateChildren(qu, identity, '/store/nope'), []);
});

test('getPrivateChildren() skips a plain (tombstoned) null child without attempting to decrypt it', async () => {
  const { qu, identity } = await identityOnFreshStore();
  await putPrivate(qu, identity, '/store/p/a', { name: 'Alpha' });
  const mainKey = await identity.getMainKey();
  await qu.put('/store/p/b', null, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });

  const entries = await getPrivateChildren(qu, identity, '/store/p');
  assert.deepEqual(entries.map((e) => e.path), ['/store/p/a']);
});

test('getPrivateChildren() never returns a child a different identity encrypted for itself', async () => {
  const { qu, identity: owner } = await identityOnFreshStore();
  await putPrivate(qu, owner, '/store/p/a', 'owners');

  const { identity: stranger } = await identityOnFreshStore();
  await putPrivate(qu, stranger, '/store/p/b', 'strangers'); // writes on the OWNER's shared qu, encrypted for the stranger

  const entries = await getPrivateChildren(qu, owner, '/store/p');
  assert.deepEqual(entries.map((e) => e.path), ['/store/p/a']); // the stranger's entry exists but isn't decryptable by owner
});

test('getPrivateChildren() honors limit/order like ListService.listDerived()', async () => {
  const { qu, identity } = await identityOnFreshStore();
  await putPrivate(qu, identity, '/store/p/x1', 'first');
  await putPrivate(qu, identity, '/store/p/x2', 'second');
  await putPrivate(qu, identity, '/store/p/x3', 'third');

  const limited = await getPrivateChildren(qu, identity, '/store/p', { limit: 1, order: 'asc' });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].path, '/store/p/x1');
});

// ===== createPrivateStore() =================================================

test('createPrivateStore().get()/put() round-trip a value through transparent encryption', async () => {
  const { qu, identity } = await identityOnFreshStore();
  const store = createPrivateStore(qu, identity);
  await store.put('/store/x', { secret: 'v' });

  const raw = await qu.get('/store/x');
  assert.ok(raw.val.iv && raw.val.ct); // actually encrypted on the wire

  const read = await store.get('/store/x');
  assert.deepEqual(read.val, { secret: 'v' });
  assert.equal(typeof read.ts, 'number');
});

test('createPrivateStore().get() of a never-written path returns null (matches watch()\'s expectation)', async () => {
  const { qu, identity } = await identityOnFreshStore();
  const store = createPrivateStore(qu, identity);
  assert.equal(await store.get('/store/nope'), null);
});

test('createPrivateStore().put(path, null) writes a plain tombstone, not an encrypted null', async () => {
  const { qu, identity } = await identityOnFreshStore();
  const store = createPrivateStore(qu, identity);
  await store.put('/store/x', { v: 1 });
  await store.put('/store/x', null);

  const raw = await qu.get('/store/x');
  assert.equal(raw.val, null); // plain, not an envelope

  const read = await store.get('/store/x');
  assert.equal(read.val, null);
});

test('createPrivateStore().getChildren() returns decrypted entries in the {path, quBit: {val, ts}} shape watchChildren()/<qu-list> expect', async () => {
  const { qu, identity } = await identityOnFreshStore();
  const store = createPrivateStore(qu, identity);
  await store.put('/store/p/a', { name: 'Alpha' });

  const entries = await store.getChildren('/store/p');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, '/store/p/a');
  assert.deepEqual(entries[0].quBit.val, { name: 'Alpha' });
  assert.equal(typeof entries[0].quBit.ts, 'number');
});

test('createPrivateStore().onStorageChange() delegates directly to the underlying qu (watch()/watchChildren() reuse it unmodified)', async () => {
  const { qu, identity } = await identityOnFreshStore();
  const store = createPrivateStore(qu, identity);
  const seen = [];
  store.onStorageChange((event) => seen.push(event.path));
  await store.put('/store/x', 'v');
  assert.deepEqual(seen, ['/store/x']);
});
