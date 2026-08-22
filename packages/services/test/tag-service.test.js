import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { TagService } from '../src/tag-service.js';

async function freshTags() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return new TagService(qu, identity, new ListService(qu));
}

test('addTag() is reflected on both sides: getTags() and getTaggedEntities()', async () => {
  const tags = await freshTags();
  await tags.addTag('space1', 'article', 'a1', 'javascript');

  assert.deepEqual(await tags.getTags('space1', 'article', 'a1'), ['javascript']);
  assert.deepEqual(await tags.getTaggedEntities('space1', 'javascript', 'article'), ['a1']);
});

test('an entity can have multiple tags', async () => {
  const tags = await freshTags();
  await tags.addTag('space1', 'article', 'a1', 'javascript');
  await tags.addTag('space1', 'article', 'a1', 'tutorial');

  assert.deepEqual([...(await tags.getTags('space1', 'article', 'a1'))].sort(), ['javascript', 'tutorial']);
});

test('a tag can apply to multiple entities', async () => {
  const tags = await freshTags();
  await tags.addTag('space1', 'article', 'a1', 'javascript');
  await tags.addTag('space1', 'article', 'a2', 'javascript');

  assert.deepEqual([...(await tags.getTaggedEntities('space1', 'javascript', 'article'))].sort(), ['a1', 'a2']);
});

test('removeTag() clears both directions', async () => {
  const tags = await freshTags();
  await tags.addTag('space1', 'article', 'a1', 'javascript');
  await tags.removeTag('space1', 'article', 'a1', 'javascript');

  assert.deepEqual(await tags.getTags('space1', 'article', 'a1'), []);
  assert.deepEqual(await tags.getTaggedEntities('space1', 'javascript', 'article'), []);
});

test('tags are scoped per entityKind - tagging an "article" a1 does not tag a "task" a1', async () => {
  const tags = await freshTags();
  await tags.addTag('space1', 'article', 'a1', 'javascript');

  assert.deepEqual(await tags.getTags('space1', 'task', 'a1'), []);
  assert.deepEqual(await tags.getTaggedEntities('space1', 'javascript', 'task'), []);
});

test('getTags()/getTaggedEntities() of an untagged entity/tag return an empty array', async () => {
  const tags = await freshTags();
  assert.deepEqual(await tags.getTags('space1', 'article', 'nope'), []);
  assert.deepEqual(await tags.getTaggedEntities('space1', 'nope', 'article'), []);
});
