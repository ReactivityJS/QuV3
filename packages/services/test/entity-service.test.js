import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { EntityEngine } from '@qu/engines';
import { EntityService } from '../src/entity-service.js';
import { EntityTypeRegistry } from '../src/entity-types.js';

async function freshEntities() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new EntityEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return new EntityService(qu, identity);
}

test('createEntity() stamps _id/_type/_created and stores the given fields', async () => {
  const entities = await freshEntities();
  const entity = await entities.createEntity('space1', 'article', { title: 'Hello' });
  assert.ok(entity._id);
  assert.equal(entity._type, 'article');
  assert.equal(typeof entity._created, 'number');
  assert.equal(entity.title, 'Hello');
});

test('createEntity() normalizes a supplied content field via createContent()', async () => {
  const entities = await freshEntities();
  const entity = await entities.createEntity('space1', 'article', { title: 'x', content: { text: 'body text' } });
  assert.equal(entity.content.text, 'body text');
  assert.equal(entity.content.format, 'plain');
  assert.deepEqual(entity.content.attachments, []);
});

test('createEntity() with an unregistered type does not throw', async () => {
  const entities = await freshEntities();
  const entity = await entities.createEntity('space1', 'totally-unregistered', { x: 1 });
  assert.equal(entity._type, 'totally-unregistered');
});

test('getEntity() returns null for a non-existent entity', async () => {
  const entities = await freshEntities();
  assert.equal(await entities.getEntity('space1', 'nope'), null);
});

test('updateEntity() merge-writes and preserves _id/_created/_type', async () => {
  const entities = await freshEntities();
  const created = await entities.createEntity('space1', 'article', { title: 'v1' });

  const updated = await entities.updateEntity('space1', created._id, { title: 'v2' });
  assert.equal(updated._id, created._id);
  assert.equal(updated._created, created._created);
  assert.equal(updated._type, 'article');
  assert.equal(updated.title, 'v2');
});

test('updateEntity() throws for a non-existent entity', async () => {
  const entities = await freshEntities();
  await assert.rejects(() => entities.updateEntity('space1', 'nope', { title: 'x' }), /no entity "nope"/);
});

test('a type declaring content: false is left untouched even if a content field is passed', async () => {
  const registry = new EntityTypeRegistry();
  registry.register('no-content-type', { content: false });

  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new EntityEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const entities = new EntityService(qu, identity, registry);

  const entity = await entities.createEntity('space1', 'no-content-type', { content: 'not-a-content-object' });
  assert.equal(entity.content, 'not-a-content-object');
});
