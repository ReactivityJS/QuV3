import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '../src/crypto.js';

test('generateKeypair() returns usable Ed25519 + X25519 material', async () => {
  const kp = await QuCrypto.generateKeypair();
  assert.equal(kp.publicKey.length, 32);
  assert.equal(kp.xPublicKey.length, 32);
  assert.ok(kp.privateKey instanceof Uint8Array);
  assert.ok(kp.xPrivateKey instanceof Uint8Array);
});

test('keypairFromSeed() is deterministic - same scalar in, same public key out', async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const a = await QuCrypto.keypairFromSeed('Ed25519', seed);
  const b = await QuCrypto.keypairFromSeed('Ed25519', seed);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.deepEqual(a.privateKeyPkcs8, b.privateKeyPkcs8);

  const differentSeed = crypto.getRandomValues(new Uint8Array(32));
  const c = await QuCrypto.keypairFromSeed('Ed25519', differentSeed);
  assert.notDeepEqual(a.publicKey, c.publicKey);
});

test('keypairFromSeed() rejects a scalar of the wrong length', async () => {
  await assert.rejects(() => QuCrypto.keypairFromSeed('Ed25519', new Uint8Array(31)));
  await assert.rejects(() => QuCrypto.keypairFromSeed('Ed25519', new Uint8Array(33)));
});

test('keypairFromSeed() rejects an unsupported curve', async () => {
  await assert.rejects(() => QuCrypto.keypairFromSeed('P-256', new Uint8Array(32)));
});

test('sign()/verify() round-trip, and rejects a tampered message or wrong key', async () => {
  const kp = await QuCrypto.generateKeypair();
  const data = new TextEncoder().encode('hello qu v3');
  const sig = await QuCrypto.sign(data, kp.privateKey);

  assert.equal(await QuCrypto.verify(data, sig, kp.publicKey), true);
  assert.equal(await QuCrypto.verify(new TextEncoder().encode('tampered'), sig, kp.publicKey), false);

  const other = await QuCrypto.generateKeypair();
  assert.equal(await QuCrypto.verify(data, sig, other.publicKey), false);
});

test('encrypt()/decrypt() round-trip for multiple recipients, each independently', async () => {
  const sender = await QuCrypto.generateKeypair();
  const alice = await QuCrypto.generateKeypair();
  const bob = await QuCrypto.generateKeypair();
  const plaintext = new TextEncoder().encode('secret payload');

  const { iv, ct, to } = await QuCrypto.encrypt(plaintext, [alice.xPublicKey, bob.xPublicKey], sender.xPrivateKey);
  assert.equal(to.length, 2);

  const aliceEntry = to.find((entry) => arraysEqual(entry.pub, alice.xPublicKey));
  const bobEntry = to.find((entry) => arraysEqual(entry.pub, bob.xPublicKey));

  const aliceDecrypted = await QuCrypto.decrypt(iv, ct, aliceEntry.key, sender.xPublicKey, alice.xPrivateKey);
  const bobDecrypted = await QuCrypto.decrypt(iv, ct, bobEntry.key, sender.xPublicKey, bob.xPrivateKey);

  assert.equal(new TextDecoder().decode(aliceDecrypted), 'secret payload');
  assert.equal(new TextDecoder().decode(bobDecrypted), 'secret payload');
});

test('decrypt() fails for a recipient who was not on the original recipient list', async () => {
  const sender = await QuCrypto.generateKeypair();
  const alice = await QuCrypto.generateKeypair();
  const eve = await QuCrypto.generateKeypair(); // never a recipient
  const plaintext = new TextEncoder().encode('only for alice');

  const { iv, ct, to } = await QuCrypto.encrypt(plaintext, [alice.xPublicKey], sender.xPrivateKey);
  const aliceEntry = to[0];

  // Eve has no wrapped key of her own - even attempting decrypt with Alice's
  // wrapped key under Eve's own private key must not recover the plaintext.
  await assert.rejects(() => QuCrypto.decrypt(iv, ct, aliceEntry.key, sender.xPublicKey, eve.xPrivateKey));
});

test('sha256() matches the well-known NIST test vector for "abc"', async () => {
  const digest = await QuCrypto.sha256(new TextEncoder().encode('abc'));
  assert.equal(QuCrypto.toHex(digest), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('toBase64()/fromBase64() and toBase64Url()/fromBase64Url() round-trip arbitrary bytes', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  assert.deepEqual(QuCrypto.fromBase64(QuCrypto.toBase64(bytes)), bytes);

  const url = QuCrypto.toBase64Url(bytes);
  assert.doesNotMatch(url, /[+/=]/); // URL-safe alphabet, no padding
  assert.deepEqual(QuCrypto.fromBase64Url(url), bytes);
});

test('toHex()/fromHex() round-trip, and fromHex() rejects invalid input', () => {
  const bytes = new Uint8Array([0, 1, 254, 255, 16]);
  const hex = QuCrypto.toHex(bytes);
  assert.equal(hex, '0001feff10');
  assert.deepEqual(QuCrypto.fromHex(hex), bytes);

  // Odd length must throw, not silently truncate the last nibble.
  assert.throws(() => QuCrypto.fromHex('abc'), /not valid hex/);
  // Non-hex characters must throw.
  assert.throws(() => QuCrypto.fromHex('zz'), /not valid hex/);
  // Empty string is valid hex for zero bytes.
  assert.deepEqual(QuCrypto.fromHex(''), new Uint8Array(0));
});

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
