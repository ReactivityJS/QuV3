import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { FlagService } from '../src/flag-service.js';
import { FollowService } from '../src/follow-service.js';

async function freshFollows() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const flags = new FlagService(qu, identity, new ListService(qu));
  return new FollowService(flags);
}

test('follow()/isFollowing()/listFollowed() round-trip', async () => {
  const follows = await freshFollows();
  await follows.follow('topic', 't1');
  assert.equal(await follows.isFollowing('topic', 't1'), true);
  assert.equal(await follows.isFollowing('topic', 't2'), false);

  const list = await follows.listFollowed('topic');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 't1');
});

test('follow() stores the optional snapshot alongside starredAt', async () => {
  const follows = await freshFollows();
  await follows.follow('topic', 't1', { title: 'Announcements' });

  const [entry] = await follows.listFollowed('topic');
  assert.equal(entry.title, 'Announcements');
  assert.equal(typeof entry.starredAt, 'number');
});

test('unfollow() removes a follow', async () => {
  const follows = await freshFollows();
  await follows.follow('topic', 't1');
  await follows.follow('topic', 't2');
  await follows.unfollow('topic', 't1');

  const list = await follows.listFollowed('topic');
  assert.deepEqual(list.map((e) => e.id), ['t2']);
  assert.equal(await follows.isFollowing('topic', 't1'), false);
});

test('follows are independent per entityKind - following a topic does not follow an entity of the same id', async () => {
  const follows = await freshFollows();
  await follows.follow('topic', 'x1');

  assert.equal(await follows.isFollowing('entity', 'x1'), false);
  assert.deepEqual(await follows.listFollowed('entity'), []);
});

test('follows are private to the identity that set them', async () => {
  const aliceQu = new QuStore();
  aliceQu.mount('store', new MemoryStoreAdapter());
  const alice = new QuIdentityEngine(aliceQu);
  await alice.importMnemonic(alice.generateMnemonic());
  const aliceFollows = new FollowService(new FlagService(aliceQu, alice, new ListService(aliceQu)));
  await aliceFollows.follow('topic', 't1');

  const bobQu = new QuStore();
  bobQu.mount('store', new MemoryStoreAdapter());
  const bob = new QuIdentityEngine(bobQu);
  await bob.importMnemonic(bob.generateMnemonic());
  const bobFollows = new FollowService(new FlagService(bobQu, bob, new ListService(bobQu)));

  assert.equal(await bobFollows.isFollowing('topic', 't1'), false);
  assert.deepEqual(await bobFollows.listFollowed('topic'), []);
});
