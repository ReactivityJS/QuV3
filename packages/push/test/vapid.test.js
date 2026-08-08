import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { generateVapidKeys, signVapidJwt } from '../src/vapid.js';
import { fromBase64Url } from '../src/base64url.js';

/** @param {string} publicKeyB64Url - As returned by generateVapidKeys(). @returns {import('node:crypto').KeyObject} */
function publicKeyObjectFrom(publicKeyB64Url) {
  const rawPublic = fromBase64Url(publicKeyB64Url);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.from(rawPublic.subarray(1, 33)).toString('base64url'),
    y: Buffer.from(rawPublic.subarray(33, 65)).toString('base64url'),
  };
  return createPublicKey({ key: jwk, format: 'jwk' });
}

test('generateVapidKeys() returns a base64url publicKey decoding to a 65-byte uncompressed EC point', () => {
  const { publicKey } = generateVapidKeys();
  const raw = fromBase64Url(publicKey);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04); // uncompressed point marker
});

test('generateVapidKeys() returns a different keypair on every call', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.privateKey, b.privateKey);
});

test('signVapidJwt() produces a three-segment dot-separated token', () => {
  const { privateKey } = generateVapidKeys();
  const jwt = signVapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'mailto:admin@example.com' }, privateKey);
  assert.equal(jwt.split('.').length, 3);
});

test('signVapidJwt() header is {typ: "JWT", alg: "ES256"}', () => {
  const { privateKey } = generateVapidKeys();
  const jwt = signVapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'mailto:a@b.com' }, privateKey);
  const [headerB64] = jwt.split('.');
  const header = JSON.parse(fromBase64Url(headerB64).toString('utf8'));
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
});

test('signVapidJwt() payload carries aud/sub and an expiry ~12h in the future', () => {
  const { privateKey } = generateVapidKeys();
  const before = Math.floor(Date.now() / 1000);
  const jwt = signVapidJwt({ audience: 'https://push.example.com', subject: 'mailto:a@b.com' }, privateKey);
  const [, payloadB64] = jwt.split('.');
  const payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  assert.equal(payload.aud, 'https://push.example.com');
  assert.equal(payload.sub, 'mailto:a@b.com');
  assert.ok(payload.exp >= before + 12 * 3600 - 5 && payload.exp <= before + 12 * 3600 + 5);
});

test('signVapidJwt() signature segment is 64 raw bytes (ieee-p1363, not ASN.1/DER)', () => {
  const { privateKey } = generateVapidKeys();
  const jwt = signVapidJwt({ audience: 'https://push.example.com', subject: 'mailto:a@b.com' }, privateKey);
  const [, , sigB64] = jwt.split('.');
  assert.equal(fromBase64Url(sigB64).length, 64);
});

test('signVapidJwt() verifies against the matching publicKey using plain node:crypto', () => {
  const { publicKey, privateKey } = generateVapidKeys();
  const jwt = signVapidJwt({ audience: 'https://push.example.com', subject: 'mailto:a@b.com' }, privateKey);
  const [headerB64, payloadB64, sigB64] = jwt.split('.');

  const ok = cryptoVerify(
    'sha256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: publicKeyObjectFrom(publicKey), dsaEncoding: 'ieee-p1363' },
    fromBase64Url(sigB64)
  );
  assert.equal(ok, true);
});

test('signVapidJwt() for a different privateKey produces a signature that does NOT verify against the first publicKey', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  const jwt = signVapidJwt({ audience: 'https://push.example.com', subject: 'mailto:a@b.com' }, b.privateKey);
  const [headerB64, payloadB64, sigB64] = jwt.split('.');

  const ok = cryptoVerify(
    'sha256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: publicKeyObjectFrom(a.publicKey), dsaEncoding: 'ieee-p1363' }, // WRONG key on purpose
    fromBase64Url(sigB64)
  );
  assert.equal(ok, false);
});
