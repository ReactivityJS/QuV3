import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { createTrustedCatalogStore } from '../src/apps-catalog-store.js';
import { appCatalogEntryPath, appCatalogParentPath } from '../src/paths.js';

async function freshQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return qu;
}

async function publishEntry(qu, kp, name, fields = {}) {
  await qu.put(appCatalogEntryPath(name), { name, label: name, enabled: true, ...fields }, {
    signWith: kp.privateKey,
    writerPub: kp.publicKey,
  });
}

test('getChildren() only returns entries signed by relayPub', async () => {
  const qu = await freshQu();
  const relayKp = await QuCrypto.generateKeypair();
  const relayPub = QuCrypto.toBase64Url(relayKp.publicKey);
  const forgerKp = await QuCrypto.generateKeypair();

  await publishEntry(qu, relayKp, 'notes');
  await publishEntry(qu, forgerKp, 'evil-app');

  const store = createTrustedCatalogStore(qu, relayPub);
  const entries = await store.getChildren(appCatalogParentPath());
  assert.deepEqual(entries.map((e) => e.quBit.val.name), ['notes']);
});

test('getChildren() excludes entries with enabled: false', async () => {
  const qu = await freshQu();
  const relayKp = await QuCrypto.generateKeypair();
  const relayPub = QuCrypto.toBase64Url(relayKp.publicKey);

  await publishEntry(qu, relayKp, 'notes');
  await publishEntry(qu, relayKp, 'off', { enabled: false });

  const store = createTrustedCatalogStore(qu, relayPub);
  const entries = await store.getChildren(appCatalogParentPath());
  assert.deepEqual(entries.map((e) => e.quBit.val.name), ['notes']);
});

test('get()/put()/onStorageChange() pass straight through to the underlying qu, unfiltered', async () => {
  const qu = await freshQu();
  const relayKp = await QuCrypto.generateKeypair();
  const relayPub = QuCrypto.toBase64Url(relayKp.publicKey);
  const store = createTrustedCatalogStore(qu, relayPub);

  await store.put('/store/space/x', { hello: 'world' });
  assert.deepEqual((await store.get('/store/space/x')).val, { hello: 'world' });

  let notified = null;
  store.onStorageChange(({ path }) => { notified = path; });
  await qu.put('/store/space/y', { another: true });
  assert.equal(notified, '/store/space/y');
});
