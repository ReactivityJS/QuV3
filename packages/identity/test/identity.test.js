import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine, actorPath } from '../src/identity.js';
import { generateMnemonicPhrase } from '../src/bip39.js';

function freshEngine() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return new QuIdentityEngine(qu);
}

test('actorPath() builds the expected storage path', () => {
  assert.equal(actorPath('abc123', 'profile'), '/store/actors/~abc123/profile');
});

test('generateMnemonic() returns a fresh, valid 24-word mnemonic', () => {
  const engine = freshEngine();
  const mnemonic = engine.generateMnemonic();
  assert.equal(mnemonic.split(' ').length, 24);
});

test('hasIdentity() is false before import, true after', async () => {
  const engine = freshEngine();
  assert.equal(await engine.hasIdentity(), false);
  await engine.importMnemonic(generateMnemonicPhrase());
  assert.equal(await engine.hasIdentity(), true);
});

test('importMnemonic() rejects an invalid mnemonic', async () => {
  const engine = freshEngine();
  await assert.rejects(() => engine.importMnemonic('not a valid mnemonic'), /invalid mnemonic/);
});

test('getMainKey()/_getMasterSeed() throw before any identity has been imported', async () => {
  const engine = freshEngine();
  await assert.rejects(() => engine.getMainKey(), /no master seed found/);
});

test('importMnemonic() called twice with the SAME mnemonic does not throw', async () => {
  const engine = freshEngine();
  const mnemonic = generateMnemonicPhrase();
  await engine.importMnemonic(mnemonic);
  await assert.doesNotReject(() => engine.importMnemonic(mnemonic));
});

test('importMnemonic() called twice with DIFFERENT mnemonics throws without overwrite, succeeds with it', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());
  const secondMnemonic = generateMnemonicPhrase();

  await assert.rejects(() => engine.importMnemonic(secondMnemonic), /already holds a different identity seed/);
  await assert.doesNotReject(() => engine.importMnemonic(secondMnemonic, '', { overwrite: true }));
});

test('overwriting the identity changes the derived main key', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());
  const firstKey = await engine.getMainKey();

  await engine.importMnemonic(generateMnemonicPhrase(), '', { overwrite: true });
  const secondKey = await engine.getMainKey();

  assert.notDeepEqual(firstKey.publicKey, secondKey.publicKey);
});

test('exportSeedCode()/importSeedCode() round-trip onto a FRESH engine reproduces the identical main key', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());
  const originalKey = await engine.getMainKey();

  const code = await engine.exportSeedCode();
  const restored = freshEngine();
  await restored.importSeedCode(code);
  const restoredKey = await restored.getMainKey();

  assert.deepEqual(originalKey.publicKey, restoredKey.publicKey);
});

test('importSeedCode() rejects a malformed or wrong-length code', async () => {
  const engine = freshEngine();
  await assert.rejects(() => engine.importSeedCode('not-base64url-!!!'), /not a valid backup code/);
  await assert.rejects(() => engine.importSeedCode('QQ'), /not a valid backup code/); // decodes, but far too short
});

test('getMainKey()/getMainXKey() are deterministic (cached) and distinct from each other', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());

  const signA = await engine.getMainKey();
  const signB = await engine.getMainKey();
  const enc = await engine.getMainXKey();

  assert.deepEqual(signA, signB); // same object identity via cache
  assert.notDeepEqual(signA.publicKey, enc.publicKey);
});

test('getSpaceKey() is deterministic per spaceId and distinct across spaceIds and from the main key', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());

  const main = await engine.getMainKey();
  const room1a = await engine.getSpaceKey('room1');
  const room1b = await engine.getSpaceKey('room1');
  const room2 = await engine.getSpaceKey('room2');

  assert.deepEqual(room1a, room1b);
  assert.notDeepEqual(room1a.publicKey, room2.publicKey);
  assert.notDeepEqual(room1a.publicKey, main.publicKey);
});

test('getEphemeralKey() is deterministic (same value) per (spaceId, index) but never cached (fresh derivation each call)', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());

  const a = await engine.getEphemeralKey('room1', 0);
  const b = await engine.getEphemeralKey('room1', 0);
  const c = await engine.getEphemeralKey('room1', 1);

  assert.deepEqual(a.publicKey, b.publicKey); // pure re-derivation lands on the identical key
  assert.notDeepEqual(a.publicKey, c.publicKey);
});

test('publishMainProfile()/getProfile() round-trip with a verified signature', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());

  const actorPub = await engine.publishMainProfile({ name: 'Alice' });
  const profile = await engine.getProfile(actorPub);

  assert.equal(profile.name, 'Alice');
  assert.ok(profile.xPublicKey); // main X25519 key auto-included for attestation encryption
});

test('getProfile() returns null for a tampered stored record (signature no longer verifies)', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const engine = new QuIdentityEngine(qu);
  await engine.importMnemonic(generateMnemonicPhrase());
  const actorPub = await engine.publishMainProfile({ name: 'Alice' });

  // Tamper directly, bypassing the engine's own signing.
  const stored = await qu.get(actorPath(actorPub, 'profile'));
  await qu.put(actorPath(actorPub, 'profile'), { ...stored.val, profile: { ...stored.val.profile, name: 'Eve' } });

  assert.equal(await engine.getProfile(actorPub), null);
});

test('getProfile() of a never-published actor returns null', async () => {
  const engine = freshEngine();
  assert.equal(await engine.getProfile('nonexistent-pub'), null);
});

test('publishProfile(spaceId, fields) publishes under the SPACE identity, not the main one', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());

  const mainPub = (await engine.getMainKey()).publicKey;
  const spacePub = await engine.publishProfile('room1', { name: 'Pseudonym' });

  assert.notEqual(spacePub, QuCrypto.toBase64Url(mainPub));
  const profile = await engine.getProfile(spacePub);
  assert.equal(profile.name, 'Pseudonym');
});

test('attestation: a trusted contact resolves the main identity behind a space actor; an untrusted one cannot', async () => {
  // Three SEPARATE stores, one per identity - a QuStore holds at most one
  // identity's seed (see #storeSeed()'s own guard, and the test above that
  // verifies it), the same as a real device/browser profile would. Public
  // writes (profiles, attestations) are copied between stores explicitly
  // below, standing in for what @qu/sync (not yet built) will do for real -
  // this is exactly the set of QuBits a relay would actually propagate.
  const alice = freshEngine();
  await alice.importMnemonic(generateMnemonicPhrase());
  const trusted = freshEngine();
  await trusted.importMnemonic(generateMnemonicPhrase());
  const untrusted = freshEngine();
  await untrusted.importMnemonic(generateMnemonicPhrase());

  const trustedPub = QuCrypto.toBase64Url((await trusted.getMainKey()).publicKey);
  await trusted.publishMainProfile({ name: 'Trusted' }); // needs a published X key to receive attestations
  await untrusted.publishMainProfile({ name: 'Untrusted' });

  // Alice needs trusted's profile locally to encrypt an attestation to it.
  await copyQuBit(trusted.qu, alice.qu, actorPath(trustedPub, 'profile'));

  const spacePub = await alice.publishProfile('room1', { name: 'Alice-in-room1' });
  await alice.createAttestation('room1', [trustedPub]);

  // Simulates alice's space profile (needed for its X key) and attestation
  // having synced out to both contacts.
  for (const contact of [trusted, untrusted]) {
    await copyQuBit(alice.qu, contact.qu, actorPath(spacePub, 'profile'));
    await copyQuBit(alice.qu, contact.qu, actorPath(spacePub, 'attestation'));
  }

  const resolvedByTrusted = await trusted.resolveMainUser(spacePub);
  const resolvedByUntrusted = await untrusted.resolveMainUser(spacePub);

  assert.equal(resolvedByTrusted, QuCrypto.toBase64Url((await alice.getMainKey()).publicKey));
  assert.equal(resolvedByUntrusted, null);
});

/** Copies one already-sealed (signed) QuBit from one QuStore to another unchanged - see the test above for why. */
async function copyQuBit(fromQu, toQu, path) {
  const quBit = await fromQu.get(path);
  await toQu.putSealed(path, quBit);
}

test('resolveMainUser() of an actor with no attestation at all returns null', async () => {
  const engine = freshEngine();
  await engine.importMnemonic(generateMnemonicPhrase());
  assert.equal(await engine.resolveMainUser('some-random-pub-nobody-attested-to'), null);
});

test('resolveMainUser() caches its result - repeated calls do not re-derive', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const engine = new QuIdentityEngine(qu);
  await engine.importMnemonic(generateMnemonicPhrase());

  let getCalls = 0;
  const originalGet = qu.get.bind(qu);
  qu.get = (path) => {
    getCalls++;
    return originalGet(path);
  };

  await engine.resolveMainUser('never-attested-actor');
  const afterFirst = getCalls;
  await engine.resolveMainUser('never-attested-actor');
  assert.equal(getCalls, afterFirst); // second call served entirely from _attestationCache
});

