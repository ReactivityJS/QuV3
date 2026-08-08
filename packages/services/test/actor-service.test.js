import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ActorService } from '../src/actor-service.js';

test('whoAmI() returns this identity\'s own base64url main actor pubkey', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const actors = new ActorService(identity);

  const expected = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  assert.equal(await actors.whoAmI(), expected);
});

test('whoAmI() is stable across repeated calls', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const actors = new ActorService(identity);

  assert.equal(await actors.whoAmI(), await actors.whoAmI());
});
