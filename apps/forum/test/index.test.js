import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, CollectionEngine, EntityEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, ChannelService } from '@qu/services';
import { Registry } from '@qu/foundation';
import { register, GENERAL_CHANNEL_ID } from '../index.js';

const SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1';
const TEST_MANIFEST = { name: 'forum', version: '1.0.0', spaceId: SPACE_ID };

async function freshRegistry() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu); // resolves ChannelService's curated {$list} documents
  new EntityEngine(qu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
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

test('register() creates a "General" channel + its opening topic', async () => {
  const { qu, channels, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);

  const channelList = await channels.listChannels(SPACE_ID);
  assert.equal(channelList.length, 1);
  assert.equal(channelList[0]._id, GENERAL_CHANNEL_ID);
  assert.equal(channelList[0].title, 'General');

  const topics = await channels.listTopics(SPACE_ID, GENERAL_CHANNEL_ID);
  assert.equal(topics.length, 1);
  assert.equal(topics[0]._type, 'topic');
  assert.ok(topics[0].content); // has its own opening content, not posted as a message
});

test('register() applies the forum preset to the opening topic\'s comment thread: markdown + mentions formatting, publicly writable', async () => {
  const { qu, channels, messages, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);

  const [topic] = await channels.listTopics(SPACE_ID, GENERAL_CHANNEL_ID);
  const config = await messages.getConfig(SPACE_ID, topic._id);
  assert.ok(config);
  assert.equal(config.writers, '*');
  assert.equal(config.readers, '*');
  assert.deepEqual(config.formatting, ['markdown', 'mentions']);
});

test('register() is idempotent - a second call does not create a duplicate channel/topic or reset an already-populated one', async () => {
  const { qu, channels, messages, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);
  const [topic] = await channels.listTopics(SPACE_ID, GENERAL_CHANNEL_ID);
  await messages.postMessage(SPACE_ID, topic._id, { body: 'first comment' });

  await register(qu, TEST_MANIFEST, registry); // simulates a second relay boot

  assert.equal((await channels.listChannels(SPACE_ID)).length, 1);
  assert.equal((await channels.listTopics(SPACE_ID, GENERAL_CHANNEL_ID)).length, 1);
  const { messages: comments } = await messages.listMessages(SPACE_ID, topic._id);
  assert.deepEqual(comments.map((m) => m.body), ['first comment']); // untouched, not reset to empty
});

test('the opening topic\'s comment thread is genuinely public - a real writer can post without any prior ACL setup', async () => {
  const { qu, channels, messages, registry } = await freshRegistry();
  await register(qu, TEST_MANIFEST, registry);
  const [topic] = await channels.listTopics(SPACE_ID, GENERAL_CHANNEL_ID);

  const posted = await messages.postMessage(SPACE_ID, topic._id, { body: 'hello, forum' });
  assert.equal(posted.body, 'hello, forum');
});
