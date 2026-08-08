import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { sendWebPush } from '../src/send.js';
import { toBase64Url } from '../src/base64url.js';
import { generateVapidKeys } from '../src/vapid.js';

function fakeSubscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: 'https://push.example.com/abc123',
    keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
  };
}

/** Temporarily replaces globalThis.fetch for the duration of `fn`, restoring it afterward even if fn throws. */
async function withFakeFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('sendWebPush() POSTs to the subscription endpoint with the expected headers', async () => {
  const vapid = { ...generateVapidKeys(), subject: 'mailto:admin@example.com' };
  await withFakeFetch(
    async () => new Response(null, { status: 201 }),
    async (calls) => {
      const result = await sendWebPush(fakeSubscription(), { title: 'Hi' }, vapid);
      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
      assert.equal(calls.length, 1);
      const { url, init } = calls[0];
      assert.equal(url, 'https://push.example.com/abc123');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['content-encoding'], 'aes128gcm');
      assert.equal(init.headers['content-type'], 'application/octet-stream');
      assert.ok(init.headers.authorization.startsWith('vapid t='));
      assert.ok(init.headers.authorization.includes(`k=${vapid.publicKey}`));
    }
  );
});

test('sendWebPush() encrypts the body - it is never the plaintext JSON payload', async () => {
  const vapid = { ...generateVapidKeys(), subject: 'mailto:admin@example.com' };
  await withFakeFetch(
    async () => new Response(null, { status: 201 }),
    async (calls) => {
      await sendWebPush(fakeSubscription(), { title: 'Hi', body: 'secret content' }, vapid);
      const bodyText = Buffer.from(calls[0].init.body).toString('utf8');
      assert.ok(!bodyText.includes('secret content'));
    }
  );
});

test('sendWebPush() reports expired: true for a 404 (dead subscription)', async () => {
  const vapid = { ...generateVapidKeys(), subject: 'mailto:admin@example.com' };
  await withFakeFetch(
    async () => new Response(null, { status: 404 }),
    async () => {
      const result = await sendWebPush(fakeSubscription(), { title: 'Hi' }, vapid);
      assert.equal(result.ok, false);
      assert.equal(result.expired, true);
    }
  );
});

test('sendWebPush() reports expired: true for a 410 (gone)', async () => {
  const vapid = { ...generateVapidKeys(), subject: 'mailto:admin@example.com' };
  await withFakeFetch(
    async () => new Response(null, { status: 410 }),
    async () => {
      const result = await sendWebPush(fakeSubscription(), { title: 'Hi' }, vapid);
      assert.equal(result.expired, true);
    }
  );
});

test('sendWebPush() does NOT report expired for an unrelated failure (e.g. 500)', async () => {
  const vapid = { ...generateVapidKeys(), subject: 'mailto:admin@example.com' };
  await withFakeFetch(
    async () => new Response(null, { status: 500 }),
    async () => {
      const result = await sendWebPush(fakeSubscription(), { title: 'Hi' }, vapid);
      assert.equal(result.ok, false);
      assert.equal(result.expired, false);
    }
  );
});

test('sendWebPush() respects a custom ttlSeconds', async () => {
  const vapid = { ...generateVapidKeys(), subject: 'mailto:admin@example.com' };
  await withFakeFetch(
    async () => new Response(null, { status: 201 }),
    async (calls) => {
      await sendWebPush(fakeSubscription(), { title: 'Hi' }, vapid, { ttlSeconds: 60 });
      assert.equal(calls[0].init.headers.ttl, '60');
    }
  );
});
