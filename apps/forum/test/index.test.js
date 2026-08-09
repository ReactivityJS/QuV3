import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, CollectionEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, ChannelService } from '@qu/services';
import { Registry } from '@qu/foundation';
import { register, THREAD_ID, GENERAL_CHANNEL_ID } from '../index.js';

const SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1';
const TEST_MANIFEST = { name: 'forum', version: '1.0.0', spaceId: SPACE_ID };

async function freshRegistry() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu); // resolves ChannelService's curated {$list} documents
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const channels = new ChannelService(qu, identity, list, access, messages);
  const registry = new Registry();
  registry.registerService('list-service', list);
  registry.registerService('message-service', messages);
  registry.registerService('channel-service', channels);
  return { qu, messages, channels, registry };
}

test('register() creates the public forum thread', async () => {
  const { qu, messages, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);

  const config = await messages.getConfig(SPACE_ID, THREAD_ID);
  assert.ok(config);
  assert.equal(config.writers, '*');
  assert.equal(config.readers, '*');
});

test('register() applies the forum preset: markdown + mentions formatting enabled', async () => {
  const { qu, messages, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);

  const config = await messages.getConfig(SPACE_ID, THREAD_ID);
  assert.deepEqual(config.formatting, ['markdown', 'mentions']);
});

test('register() is idempotent - a second call does not reset an already-populated forum', async () => {
  const { qu, messages, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);
  await messages.postMessage(SPACE_ID, THREAD_ID, { body: 'first post' });

  await register(qu, TEST_MANIFEST, registry); // simulates a second relay boot

  const { messages: posts } = await messages.listMessages(SPACE_ID, THREAD_ID);
  assert.deepEqual(posts.map((m) => m.body), ['first post']); // untouched, not reset to empty
});

test('the public forum thread is genuinely public - a real writer can post without any prior ACL setup', async () => {
  const { qu, messages, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);

  const posted = await messages.postMessage(SPACE_ID, THREAD_ID, { body: 'hello, forum' });
  assert.equal(posted.body, 'hello, forum');
});

test('register() also creates a "General" channel + "General" topic wrapping the SAME pre-existing thread - no data migration, nothing re-created', async () => {
  const { qu, messages, channels, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);
  await messages.postMessage(SPACE_ID, THREAD_ID, { body: 'pre-existing message' });

  const channelList = await channels.listChannels(SPACE_ID);
  assert.equal(channelList.length, 1);
  assert.equal(channelList[0]._id, GENERAL_CHANNEL_ID);
  assert.equal(channelList[0].title, 'General');

  const topics = await channels.listTopics(SPACE_ID, GENERAL_CHANNEL_ID);
  assert.equal(topics.length, 1);
  assert.equal(topics[0]._id, THREAD_ID); // the topic IS the pre-existing thread, same id
  assert.equal(topics[0].replyCount, 1); // the pre-existing message is already "in" this topic
});

test('register() is idempotent for the "General" channel/topic too - a second boot does not create a duplicate', async () => {
  const { qu, registry, channels } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);
  await register(qu, TEST_MANIFEST, registry); // simulates a second relay boot

  assert.equal((await channels.listChannels(SPACE_ID)).length, 1);
  assert.equal((await channels.listTopics(SPACE_ID, GENERAL_CHANNEL_ID)).length, 1);
});
