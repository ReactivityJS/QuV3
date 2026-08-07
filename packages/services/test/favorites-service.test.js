import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { StarredService } from '../src/starred-service.js';
import { ListService } from '../src/list-service.js';
import { FlagService } from '../src/flag-service.js';
import { FavoritesService } from '../src/favorites-service.js';

async function freshFavorites() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const flags = new FlagService(qu, identity, new StarredService(qu, identity), new ListService(qu));
  return new FavoritesService(flags);
}

test('add()/list()/isFavorite() round-trip', async () => {
  const favorites = await freshFavorites();
  await favorites.add('forum');
  assert.deepEqual(await favorites.list(), ['forum']);
  assert.equal(await favorites.isFavorite('forum'), true);
  assert.equal(await favorites.isFavorite('chat'), false);
});

test('remove() un-favorites an app', async () => {
  const favorites = await freshFavorites();
  await favorites.add('forum');
  await favorites.add('chat');
  await favorites.remove('forum');
  assert.deepEqual(await favorites.list(), ['chat']);
});

test('list() returns plain app id strings, not {id, starredAt} records', async () => {
  const favorites = await freshFavorites();
  await favorites.add('forum');
  const list = await favorites.list();
  assert.equal(typeof list[0], 'string');
  assert.equal(list[0], 'forum');
});
