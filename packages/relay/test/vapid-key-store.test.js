import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { setupVapidKeys, VAPID_PATH } from '../src/vapid-key-store.js';

function freshQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return qu;
}

test('explicit publicKey+privateKey options win, without touching storage', async () => {
  const qu = freshQu();
  const keys = await setupVapidKeys(qu, { publicKey: 'pinned-pub', privateKey: 'pinned-priv' });
  assert.deepEqual(keys, { publicKey: 'pinned-pub', privateKey: 'pinned-priv', subject: 'mailto:admin@example.com' });
  assert.equal(await qu.get(VAPID_PATH), null);
});

test('with neither option given, a fresh keypair is generated and persisted on first call', async () => {
  const qu = freshQu();
  const keys = await setupVapidKeys(qu);
  assert.ok(keys.publicKey);
  assert.ok(keys.privateKey);
  assert.ok(await qu.get(VAPID_PATH));
});

test('a second call reuses the SAME persisted keypair, not a freshly generated one', async () => {
  const qu = freshQu();
  const first = await setupVapidKeys(qu);
  const second = await setupVapidKeys(qu);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(first.privateKey, second.privateKey);
});

test('custom subject is applied even to an auto-generated keypair', async () => {
  const qu = freshQu();
  const keys = await setupVapidKeys(qu, { subject: 'mailto:ops@example.com' });
  assert.equal(keys.subject, 'mailto:ops@example.com');
});

test('subject can change across restarts without regenerating the keypair', async () => {
  const qu = freshQu();
  const first = await setupVapidKeys(qu, { subject: 'mailto:a@example.com' });
  const second = await setupVapidKeys(qu, { subject: 'mailto:b@example.com' });
  assert.equal(first.publicKey, second.publicKey); // same keypair
  assert.equal(second.subject, 'mailto:b@example.com'); // new subject applied
});

test('giving only ONE of publicKey/privateKey falls through to the persisted/generated path, not a half-pinned keypair', async () => {
  const qu = freshQu();
  const keys = await setupVapidKeys(qu, { publicKey: 'only-public' });
  assert.notEqual(keys.publicKey, 'only-public');
  assert.ok(keys.privateKey);
});
