import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService } from '@qu/services';
import { Registry } from '@qu/foundation';
import { register, THREAD_ID } from '../index.js';

const SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1';
const TEST_MANIFEST = { name: 'forum', version: '1.0.0', spaceId: SPACE_ID };

async function freshRegistry() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const registry = new Registry();
  registry.registerService('message-service', messages);
  return { qu, messages, registry };
}

test('register() creates the public forum thread', async () => {
  const { messages, registry } = await freshRegistry();
  await register({}, TEST_MANIFEST, registry);

  const config = await messages.getConfig(SPACE_ID, THREAD_ID);
  assert.ok(config);
  assert.equal(config.writers, '*');
  assert.equal(config.readers, '*');
});

test('register() applies the forum preset: markdown + mentions formatting enabled', async () => {
  const { messages, registry } = await freshRegistry();
  await register({}, TEST_MANIFEST, registry);

  const config = await messages.getConfig(SPACE_ID, THREAD_ID);
  assert.deepEqual(config.formatting, ['markdown', 'mentions']);
});

test('register() is idempotent - a second call does not reset an already-populated forum', async () => {
  const { messages, registry } = await freshRegistry();
  await register({}, TEST_MANIFEST, registry);
  await messages.postMessage(SPACE_ID, THREAD_ID, { body: 'first post' });

  await register({}, TEST_MANIFEST, registry); // simulates a second relay boot

  const { messages: posts } = await messages.listMessages(SPACE_ID, THREAD_ID);
  assert.deepEqual(posts.map((m) => m.body), ['first post']); // untouched, not reset to empty
});

test('the public forum thread is genuinely public - a real writer can post without any prior ACL setup', async () => {
  const { messages, registry } = await freshRegistry();
  await register({}, TEST_MANIFEST, registry);

  const posted = await messages.postMessage(SPACE_ID, THREAD_ID, { body: 'hello, forum' });
  assert.equal(posted.body, 'hello, forum');
});
