import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { putPrivate, getPrivate } from '../src/private-storage.js';

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
