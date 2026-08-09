import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { FlagService } from '../src/flag-service.js';
import { BookmarksService } from '../src/bookmarks-service.js';

async function freshBookmarks() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const flags = new FlagService(qu, identity, new ListService(qu));
  return new BookmarksService(flags);
}

test('add()/list()/isBookmarked() round-trip', async () => {
  const bookmarks = await freshBookmarks();
  await bookmarks.add('msg1');
  assert.equal(await bookmarks.isBookmarked('msg1'), true);
  assert.equal(await bookmarks.isBookmarked('msg2'), false);
  const list = await bookmarks.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'msg1');
});

test('add() stores the optional snapshot alongside starredAt', async () => {
  const bookmarks = await freshBookmarks();
  await bookmarks.add('msg1', { body: 'hello world', author: 'pub1', spaceId: 'forum-space', threadId: 'general' });

  const [entry] = await bookmarks.list();
  assert.equal(entry.body, 'hello world');
  assert.equal(entry.author, 'pub1');
  assert.equal(entry.spaceId, 'forum-space');
  assert.equal(entry.threadId, 'general');
  assert.equal(typeof entry.starredAt, 'number');
});

test('remove() un-bookmarks a message', async () => {
  const bookmarks = await freshBookmarks();
  await bookmarks.add('msg1');
  await bookmarks.add('msg2');
  await bookmarks.remove('msg1');

  const list = await bookmarks.list();
  assert.deepEqual(list.map((e) => e.id), ['msg2']);
  assert.equal(await bookmarks.isBookmarked('msg1'), false);
});

test('bookmarks are private to the identity that set them', async () => {
  const aliceQu = new QuStore();
  aliceQu.mount('store', new MemoryStoreAdapter());
  const alice = new QuIdentityEngine(aliceQu);
  await alice.importMnemonic(alice.generateMnemonic());
  const aliceBookmarks = new BookmarksService(new FlagService(aliceQu, alice, new ListService(aliceQu)));
  await aliceBookmarks.add('msg1');

  const bobQu = new QuStore();
  bobQu.mount('store', new MemoryStoreAdapter());
  const bob = new QuIdentityEngine(bobQu);
  await bob.importMnemonic(bob.generateMnemonic());
  const bobBookmarks = new BookmarksService(new FlagService(bobQu, bob, new ListService(bobQu)));

  assert.equal(await bobBookmarks.isBookmarked('msg1'), false);
  assert.deepEqual(await bobBookmarks.list(), []);
});
