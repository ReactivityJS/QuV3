import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { paths } from '@qu/services';
import { publishAppsCatalog } from '../src/apps-catalog-store.js';

function fakeLoader(manifests = []) {
  return { listManifests: () => manifests.map((manifest) => ({ manifest, originUrl: null })) };
}

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity };
}

test('publishes one signed entry per app with a clientMain', async () => {
  const { qu, identity } = await freshEnv();
  const loader = fakeLoader([
    { name: 'app-list', clientMain: './dist/client.js', label: 'App List', navOrder: 6 },
    { name: 'user-list', clientMain: './dist/client.js', label: 'User List', navOrder: 8 },
  ]);

  const catalog = await publishAppsCatalog(qu, identity, loader, { disabledApps: [] });
  assert.equal(catalog.length, 2);

  const entry = await qu.get(paths.appCatalogEntryPath('app-list'));
  assert.ok(entry);
  assert.equal(entry.val.label, 'App List');
  assert.equal(entry.val.clientMainUrl, '/apps/app-list/dist/client.js');
});

test('an app with no clientMain (server-only) is not published', async () => {
  const { qu, identity } = await freshEnv();
  const loader = fakeLoader([{ name: 'forum', label: 'Forum' }]); // no clientMain

  await publishAppsCatalog(qu, identity, loader, { disabledApps: [] });
  assert.equal(await qu.get(paths.appCatalogEntryPath('forum')), null);
});

test('a disabled app is still published, marked enabled: false', async () => {
  const { qu, identity } = await freshEnv();
  const loader = fakeLoader([{ name: 'forum-ui', clientMain: './dist/client.js', label: 'Forum' }]);

  await publishAppsCatalog(qu, identity, loader, { disabledApps: ['forum-ui'] });
  const entry = await qu.get(paths.appCatalogEntryPath('forum-ui'));
  assert.equal(entry.val.enabled, false);
});

test('every published entry is signed with the given identity\'s main key', async () => {
  const { qu, identity } = await freshEnv();
  const loader = fakeLoader([{ name: 'notes', clientMain: './dist/client.js', label: 'Notes' }]);

  await publishAppsCatalog(qu, identity, loader, { disabledApps: [] });
  const entry = await qu.get(paths.appCatalogEntryPath('notes'));
  const mainKey = await identity.getMainKey();
  assert.equal(entry.pub, QuCrypto.toBase64(mainKey.publicKey));
});

test('re-publishing updates an already-existing entry in place (does not error, does not duplicate)', async () => {
  const { qu, identity } = await freshEnv();
  const loader = fakeLoader([{ name: 'notes', clientMain: './dist/client.js', label: 'Notes', navOrder: 1 }]);

  await publishAppsCatalog(qu, identity, loader, { disabledApps: [] });
  await publishAppsCatalog(qu, identity, loader, { disabledApps: ['notes'] });

  const entry = await qu.get(paths.appCatalogEntryPath('notes'));
  assert.equal(entry.val.enabled, false);
});

test('publishAppsCatalog() returns the same catalog shape buildAppsCatalog() produces', async () => {
  const { qu, identity } = await freshEnv();
  const loader = fakeLoader([{ name: 'notes', clientMain: './dist/client.js', label: 'Notes', icon: '📝', navOrder: 1, pushActions: [], actions: [] }]);

  const [entry] = await publishAppsCatalog(qu, identity, loader, { disabledApps: [], hiddenFromAppList: [] });
  assert.deepEqual(Object.keys(entry).sort(), [
    'actions', 'clientIntegrity', 'clientMainUrl', 'clientSignature', 'contributes', 'definesExtensionPoints',
    'enabled', 'hiddenFromList', 'icon', 'label', 'name', 'navOrder', 'pushActions', 'spaceId',
  ].sort());
});
