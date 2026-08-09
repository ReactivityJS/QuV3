import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { createClientServices } from '../src/services.js';

async function freshServices() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity, services: createClientServices(qu, identity) };
}

test('createClientServices() wires a real, functional AssetService (AssetEngine registered on the SAME qu)', async () => {
  const { services } = await freshServices();
  const data = new TextEncoder().encode('hello from the shell');
  await services.assets.upload('gallery', 'photo1', { name: 'x.txt', mime: 'text/plain', data });

  const asset = await services.assets.download('gallery', 'photo1');
  assert.deepEqual(asset.data, data);
});

test('createClientServices() returns exactly one AssetEngine registration - no accidental double-chunking', async () => {
  const { qu, services } = await freshServices();
  let putCalls = 0;
  const blobAdapter = qu.resolveMount('/blob/gallery').adapter;
  const originalPut = blobAdapter.put.bind(blobAdapter);
  blobAdapter.put = (rel, quBit) => { putCalls++; return originalPut(rel, quBit); };

  await services.assets.upload('gallery', 'photo1', { name: 'x.txt', mime: 'text/plain', data: new TextEncoder().encode('short') });
  assert.equal(putCalls, 1); // exactly one chunk written once, not twice by a duplicate engine registration
});

test('createClientServices() wires a real, functional BookmarksService', async () => {
  const { services } = await freshServices();
  await services.bookmarks.add('msg1', { body: 'hi' });
  assert.equal(await services.bookmarks.isBookmarked('msg1'), true);
});

test('createClientServices() wires a real, functional ChannelService (CollectionEngine registered on the SAME qu, so curated lists actually resolve)', async () => {
  const { services } = await freshServices();
  const channel = await services.channels.createChannel('forum-space', { title: 'General' });
  const topic = await services.channels.createTopic('forum-space', channel._id, { title: 'Hello' });
  await services.messages.postMessage('forum-space', topic._id, { body: 'first post' });

  const channels = await services.channels.listChannels('forum-space');
  assert.equal(channels.length, 1);
  assert.equal(channels[0].title, 'General');

  const topics = await services.channels.listTopics('forum-space', channel._id);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].replyCount, 1);
});

test('createClientServices() wires a real, functional NotificationPrefsService and PushSubscriptionService', async () => {
  const { services } = await freshServices();
  await services.notificationPrefs.savePrefs({ enabled: true, mentions: false, apps: { forum: { enabled: false } } });
  assert.deepEqual(await services.notificationPrefs.getOwnPrefs(), { enabled: true, mentions: false, apps: { forum: { enabled: false } } });

  await services.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  assert.deepEqual(await services.pushSubscriptions.listOwnSubscriptions(), [{ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } }]);
});
