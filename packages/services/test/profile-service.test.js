import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ProfileService } from '../src/profile-service.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const profiles = new ProfileService(qu, identity);
  const actorPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  return { qu, identity, profiles, actorPub };
}

test('saveProfile()/getOwnProfile() round-trips alias and avatar', async () => {
  const { profiles } = await freshSetup();
  await profiles.saveProfile({ alias: 'Ada', avatar: '🚀' });
  const own = await profiles.getOwnProfile();
  assert.equal(own.alias, 'Ada');
  assert.equal(own.avatar, '🚀');
});

test('getOwnProfile() returns this identity\'s own pub and epub', async () => {
  const { profiles, actorPub } = await freshSetup();
  await profiles.saveProfile({ alias: 'Ada' });
  const own = await profiles.getOwnProfile();
  assert.equal(own.pub, actorPub);
  assert.ok(own.epub);
});

test('public fields are visible via getPublicProfile() by anyone', async () => {
  const { profiles, actorPub } = await freshSetup();
  await profiles.saveProfile({ alias: 'Ada', fields: [{ key: 'bio', value: 'hello', visibility: 'public' }] });
  const pub = await profiles.getPublicProfile(actorPub);
  assert.equal(pub.bio, 'hello');
  assert.equal(pub.alias, 'Ada');
});

test('private fields are NOT included in the public profile', async () => {
  const { profiles, actorPub } = await freshSetup();
  await profiles.saveProfile({ alias: 'Ada', fields: [{ key: 'secret', value: 'shh', visibility: 'private' }] });
  const pub = await profiles.getPublicProfile(actorPub);
  assert.equal(pub.secret, undefined);
});

test('private fields ARE included when this same identity reads its own profile back', async () => {
  const { profiles } = await freshSetup();
  await profiles.saveProfile({ alias: 'Ada', fields: [{ key: 'secret', value: 'shh', visibility: 'private' }] });
  const own = await profiles.getOwnProfile();
  assert.deepEqual(own.fields, [{ key: 'secret', value: 'shh', visibility: 'private' }]);
});

test('public and private fields both round-trip together, correctly tagged', async () => {
  const { profiles } = await freshSetup();
  await profiles.saveProfile({
    alias: 'Ada',
    fields: [
      { key: 'website', value: 'https://example.com', visibility: 'public' },
      { key: 'note', value: 'personal reminder', visibility: 'private' },
    ],
  });
  const own = await profiles.getOwnProfile();
  const sorted = [...own.fields].sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(sorted, [
    { key: 'note', value: 'personal reminder', visibility: 'private' },
    { key: 'website', value: 'https://example.com', visibility: 'public' },
  ]);
});

test('saveProfile() replaces wholesale - a field omitted from a later call is gone', async () => {
  const { profiles } = await freshSetup();
  await profiles.saveProfile({ alias: 'Ada', fields: [{ key: 'bio', value: 'v1', visibility: 'public' }] });
  await profiles.saveProfile({ alias: 'Ada' }); // no fields this time
  const own = await profiles.getOwnProfile();
  assert.deepEqual(own.fields, []);
});

test('getPublicProfile() for an identity with no published profile returns null', async () => {
  const { profiles } = await freshSetup();
  const randomKp = await QuCrypto.generateKeypair();
  const randomPub = QuCrypto.toBase64Url(randomKp.publicKey);
  assert.equal(await profiles.getPublicProfile(randomPub), null);
});

test('a freshly imported identity with no local data backfills via syncFetch', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const actorPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const fetchedPaths = [];
  const syncFetch = async (path) => { fetchedPaths.push(path); return null; };
  const profiles = new ProfileService(qu, identity, syncFetch);
  await profiles.getOwnProfile();

  assert.ok(fetchedPaths.length >= 1);
});
