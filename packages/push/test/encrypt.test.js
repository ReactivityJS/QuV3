import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { encryptPayload, decryptPayload } from '../src/encrypt.js';
import { toBase64Url } from '../src/base64url.js';

/** Simulates a browser's PushSubscription: a P-256 keypair + a 16-byte auth secret. */
function fakeBrowserSubscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return {
    clientKeys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(authSecret) },
    receiverKeys: { uaPrivateD: ecdh.getPrivateKey(), authSecret },
  };
}

test('encryptPayload()/decryptPayload() round-trip recovers the original plaintext', () => {
  const { clientKeys, receiverKeys } = fakeBrowserSubscriber();
  const plaintext = new TextEncoder().encode(JSON.stringify({ title: 'Hi', body: 'hello' }));

  const encrypted = encryptPayload(plaintext, clientKeys);
  const decrypted = decryptPayload(encrypted, receiverKeys);

  assert.deepEqual(JSON.parse(Buffer.from(decrypted).toString('utf8')), { title: 'Hi', body: 'hello' });
});

test('encryptPayload() produces a different ciphertext every call, even for the same plaintext (random salt/ephemeral key)', () => {
  const { clientKeys } = fakeBrowserSubscriber();
  const plaintext = new TextEncoder().encode('same message');
  const a = encryptPayload(plaintext, clientKeys);
  const b = encryptPayload(plaintext, clientKeys);
  assert.notEqual(a.toString('base64'), b.toString('base64'));
});

test('decryptPayload() throws if the AEAD tag does not verify (tampered ciphertext)', () => {
  const { clientKeys, receiverKeys } = fakeBrowserSubscriber();
  const encrypted = encryptPayload(new TextEncoder().encode('hello'), clientKeys);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff; // flip a byte inside the ciphertext/tag region

  assert.throws(() => decryptPayload(tampered, receiverKeys));
});

test('decryptPayload() with the WRONG receiver key fails to recover the plaintext', () => {
  const { clientKeys } = fakeBrowserSubscriber();
  const wrongReceiver = fakeBrowserSubscriber().receiverKeys;
  const encrypted = encryptPayload(new TextEncoder().encode('hello'), clientKeys);

  assert.throws(() => decryptPayload(encrypted, wrongReceiver));
});

test('round-trips an empty plaintext', () => {
  const { clientKeys, receiverKeys } = fakeBrowserSubscriber();
  const encrypted = encryptPayload(new Uint8Array(0), clientKeys);
  const decrypted = decryptPayload(encrypted, receiverKeys);
  assert.equal(decrypted.length, 0);
});

test('round-trips a larger payload (multi-block AES-GCM)', () => {
  const { clientKeys, receiverKeys } = fakeBrowserSubscriber();
  const big = 'x'.repeat(5000);
  const encrypted = encryptPayload(new TextEncoder().encode(big), clientKeys);
  const decrypted = decryptPayload(encrypted, receiverKeys);
  assert.equal(Buffer.from(decrypted).toString('utf8'), big);
});
