import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntityTypeRegistry, defaultEntityTypes, resolveContentFormat } from '../src/entity-types.js';

test('register()/get() round-trip, with defaults filled in', () => {
  const registry = new EntityTypeRegistry();
  registry.register('widget', { fields: { size: 'text' } });

  const def = registry.get('widget');
  assert.deepEqual(def.fields, { size: 'text' });
  assert.equal(def.content, false);
  assert.deepEqual(def.capabilities, []);
  assert.equal(def.contentFormat, 'plain');
});

test('get() returns null for an unknown type, never throws', () => {
  const registry = new EntityTypeRegistry();
  assert.equal(registry.get('nope'), null);
});

test('list() returns every registered type in registration order', () => {
  const registry = new EntityTypeRegistry();
  registry.register('a', {});
  registry.register('b', {});
  assert.deepEqual(registry.list().map((entry) => entry.type), ['a', 'b']);
});

test('re-registering a type replaces its definition', () => {
  const registry = new EntityTypeRegistry();
  registry.register('widget', { content: false });
  registry.register('widget', { content: true });
  assert.equal(registry.get('widget').content, true);
});

test('defaultEntityTypes has all seven Quniverse V4 seed types', () => {
  const types = defaultEntityTypes.list().map((entry) => entry.type);
  assert.deepEqual(types, ['topic', 'message', 'article', 'page', 'notification', 'task', 'event']);
});

test('defaultEntityTypes: topic is commentable/reactable/followable/attachable, with content', () => {
  const topic = defaultEntityTypes.get('topic');
  assert.equal(topic.content, true);
  assert.deepEqual(topic.capabilities, ['commentable', 'reactable', 'followable', 'attachable']);
});

test('defaultEntityTypes: notification has no comment/reaction capabilities', () => {
  const notification = defaultEntityTypes.get('notification');
  assert.deepEqual(notification.capabilities, ['notifiable']);
});

test('defaultEntityTypes: contentFormat matches each seeded type\'s real THREAD_PRESETS precedent', () => {
  assert.equal(defaultEntityTypes.get('topic').contentFormat, 'markdown');
  assert.equal(defaultEntityTypes.get('message').contentFormat, 'plain');
  assert.equal(defaultEntityTypes.get('article').contentFormat, 'markdown');
  assert.equal(defaultEntityTypes.get('page').contentFormat, 'markdown');
  assert.equal(defaultEntityTypes.get('notification').contentFormat, 'plain');
  assert.equal(defaultEntityTypes.get('task').contentFormat, 'plain');
  assert.equal(defaultEntityTypes.get('event').contentFormat, 'plain');
});

test('resolveContentFormat() returns a registered type\'s configured format', () => {
  assert.equal(resolveContentFormat('topic'), 'markdown');
  assert.equal(resolveContentFormat('task'), 'plain');
});

test('resolveContentFormat() falls back to \'plain\' for an unregistered type', () => {
  assert.equal(resolveContentFormat('nope'), 'plain');
});

test('resolveContentFormat() accepts a custom registry', () => {
  const registry = new EntityTypeRegistry();
  registry.register('widget', { contentFormat: 'richtext' });
  assert.equal(resolveContentFormat('widget', registry), 'richtext');
  assert.equal(resolveContentFormat('widget'), 'plain'); // defaultEntityTypes has no 'widget'
});
