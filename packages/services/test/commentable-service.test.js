import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { threadMessagePath, threadMetaPath } from '../src/paths.js';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { AccessService } from '../src/access-service.js';
import { MessageService, THREAD_PRESETS } from '../src/message-service.js';
import { CommentableService } from '../src/commentable-service.js';

async function freshIdentity(qu) {
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return identity;
}

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = await freshIdentity(qu);
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const commentable = new CommentableService(messages);
  return { qu, identity, messages, commentable };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

test('enableComments() creates a thread config at the entity id; calling it again returns the SAME config (idempotent)', async () => {
  const { commentable } = await freshSetup();
  const config = await commentable.enableComments('space1', 'topic1', THREAD_PRESETS.forum());
  assert.equal(config.writers, '*');

  const again = await commentable.enableComments('space1', 'topic1', { writers: [] });
  assert.deepEqual(again, config);
});

test('postComment()/listComments() round-trip through the entity id as threadId', async () => {
  const { commentable } = await freshSetup();
  await commentable.enableComments('space1', 'topic1', THREAD_PRESETS.forum());
  await commentable.postComment('space1', 'topic1', 'first comment');
  await tick();
  await commentable.postComment('space1', 'topic1', 'second comment');

  const { messages } = await commentable.listComments('space1', 'topic1');
  assert.deepEqual(messages.map((m) => m.body), ['first comment', 'second comment']);
});

test('comments on two different entities never mix', async () => {
  const { commentable } = await freshSetup();
  await commentable.enableComments('space1', 'topic1', THREAD_PRESETS.forum());
  await commentable.enableComments('space1', 'topic2', THREAD_PRESETS.forum());
  await commentable.postComment('space1', 'topic1', 'on topic1');
  await commentable.postComment('space1', 'topic2', 'on topic2');

  const { messages: topic1Comments } = await commentable.listComments('space1', 'topic1');
  const { messages: topic2Comments } = await commentable.listComments('space1', 'topic2');
  assert.deepEqual(topic1Comments.map((m) => m.body), ['on topic1']);
  assert.deepEqual(topic2Comments.map((m) => m.body), ['on topic2']);
});

test('editComment() updates the body; getComment() reflects it', async () => {
  const { commentable } = await freshSetup();
  await commentable.enableComments('space1', 'topic1', THREAD_PRESETS.forum());
  const { id } = await commentable.postComment('space1', 'topic1', 'original');

  await commentable.editComment('space1', 'topic1', id, 'edited');
  const comment = await commentable.getComment('space1', 'topic1', id);
  assert.equal(comment.body, 'edited');
});

test('editComment() is author-only, enforced by the underlying MessageService', async () => {
  const { qu, commentable } = await freshSetup();
  await commentable.enableComments('space1', 'topic1', THREAD_PRESETS.forum());
  const { id } = await commentable.postComment('space1', 'topic1', 'original');

  // A different actor's own QuStore - public thread, so no key exchange is
  // needed, but the meta/message docs still have to be "synced" over (same
  // copy-across-stores pattern message-service.test.js's own alice/bob tests
  // use) since two QuStores never share underlying storage.
  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(otherQu);
  new ThreadEngine(otherQu);
  const otherIdentity = await freshIdentity(otherQu);
  await otherQu.putSealed(threadMetaPath('space1', 'topic1'), await qu.get(threadMetaPath('space1', 'topic1')));
  await otherQu.putSealed(threadMessagePath('space1', 'topic1', id), await qu.get(threadMessagePath('space1', 'topic1', id)));
  const otherMessages = new MessageService(otherQu, otherIdentity, new ListService(otherQu), new AccessService(otherQu, otherIdentity));
  const otherCommentable = new CommentableService(otherMessages);

  await assert.rejects(otherCommentable.editComment('space1', 'topic1', id, 'hijacked'), /only the original author can edit/);
});
