import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { DirectoryService } from '../src/directory-service.js';

/**
 * QuCrypto.generateKeypair() returns its private key under `privateKey`,
 * while identity.getMainKey() (SLIP-10-derived, via keypairFromSeed())
 * returns the same PKCS8-encoded bytes under `privateKeyPkcs8` - two
 * different field names for the same shape. DirectoryService (like every
 * other Service that signs its own writes) expects the `getMainKey()`
 * shape, so a test faking a second identity from a plain generated keypair
 * needs to rename the field, not just hand the raw keypair through.
 */
function asMainKey(kp) {
  return { publicKey: kp.publicKey, privateKeyPkcs8: kp.privateKey };
}

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const directory = new DirectoryService(qu, identity, new ListService(qu));
  const actorPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  return { qu, identity, directory, actorPub };
}

test('setVisible(true) publishes an entry that shows up in listVisible()', async () => {
  const { directory, actorPub } = await freshSetup();
  await directory.setVisible(true, { name: 'Ada' });
  const entries = await directory.listVisible();
  assert.deepEqual(entries, [{ actorPub, name: 'Ada' }]);
});

test('setVisible(false) tombstones the entry - it drops out of listVisible()', async () => {
  const { directory, actorPub } = await freshSetup();
  await directory.setVisible(true, { name: 'Ada' });
  await directory.setVisible(false);
  assert.deepEqual(await directory.listVisible(), []);
  assert.equal(await directory.isVisible(actorPub), false);
});

test('going invisible then visible again works (not a one-way tombstone)', async () => {
  const { directory, actorPub } = await freshSetup();
  await directory.setVisible(true, { name: 'Ada' });
  await directory.setVisible(false);
  await directory.setVisible(true, { name: 'Ada Again' });
  assert.deepEqual(await directory.listVisible(), [{ actorPub, name: 'Ada Again' }]);
});

test('listVisible() with nobody ever published is an empty array, not an error', async () => {
  const { directory } = await freshSetup();
  assert.deepEqual(await directory.listVisible(), []);
});

test('multiple visible identities all show up', async () => {
  const { qu, directory, actorPub } = await freshSetup();
  await directory.setVisible(true, { name: 'Ada' });

  // A second real QuIdentityEngine on the SAME store would trip its
  // one-seed-per-store guard (a QuStore holds one identity at a time) - a
  // minimal fake identity exposing just getMainKey() sidesteps that, same
  // pattern pin-service.test.js's own multi-actor test uses.
  const otherKp = await QuCrypto.generateKeypair();
  const otherDirectory = new DirectoryService(qu, { getMainKey: async () => asMainKey(otherKp) }, new ListService(qu));
  const otherPub = QuCrypto.toBase64Url(otherKp.publicKey);
  await otherDirectory.setVisible(true, { name: 'Bob' });

  const entries = await directory.listVisible();
  assert.deepEqual(new Set(entries.map((e) => e.actorPub)), new Set([actorPub, otherPub]));
});

test('isVisible() reflects the current state', async () => {
  const { directory, actorPub } = await freshSetup();
  assert.equal(await directory.isVisible(actorPub), false);
  await directory.setVisible(true);
  assert.equal(await directory.isVisible(actorPub), true);
});

// Regression: listVisible() must key off the QuBit's own verified signer,
// never trust the path segment as proof of who published an entry (same
// convention ReactionService/PinService already state and rely on).
test('an entry written under a DIFFERENT actor\'s path (mismatched writer) is not attributed to the path owner', async () => {
  const { qu, directory, actorPub } = await freshSetup();
  const forgerKey = await QuCrypto.generateKeypair();

  // Directly write a QuBit signed by a DIFFERENT key at THIS actor's path -
  // simulates a forged/mismatched entry; QuStore signs whatever key it's
  // given, it's listVisible()'s job to notice the mismatch.
  const path = `/store/directory/entries/${actorPub}`;
  await qu.put(path, { actorPub, name: 'Impersonator' }, { signWith: forgerKey.privateKey, writerPub: forgerKey.publicKey });

  const entries = await directory.listVisible();
  const forgerPub = QuCrypto.toBase64Url(forgerKey.publicKey);
  assert.ok(entries.some((e) => e.actorPub === forgerPub)); // attributed to the REAL signer...
  assert.equal(entries.filter((e) => e.actorPub === actorPub).length, 0); // ...never to the path owner
});
