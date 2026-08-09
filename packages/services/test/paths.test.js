import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as paths from '../src/paths.js';

test('spacePath()', () => {
  assert.equal(paths.spacePath('wiki'), '/store/wiki');
  assert.equal(paths.spacePath(42), '/store/42');
});

test('documentPath()', () => {
  assert.equal(paths.documentPath('wiki', 'intro'), '/store/wiki/docs/intro');
});

test('assetPath()', () => {
  assert.equal(paths.assetPath('gallery', 'photo1'), '/store/gallery/assets/photo1');
});

test('aclPath() puts kind before resourceId, as a sibling of the resource', () => {
  assert.equal(paths.aclPath('wiki', 'docs', 'intro'), '/store/wiki/acl/docs/intro');
  assert.equal(paths.aclPath('board', 'threads', 'general'), '/store/board/acl/threads/general');
});

test('listPath()', () => {
  assert.equal(paths.listPath('wiki', 'featured'), '/store/wiki/lists/featured');
});

test('threadMetaPath()', () => {
  assert.equal(paths.threadMetaPath('board', 'general'), '/store/board/threads/general/meta');
});

test('threadMessagePath()', () => {
  assert.equal(paths.threadMessagePath('board', 'general', 'm1'), '/store/board/threads/general/msgs/m1');
});

test('threadMessagesParentPath() is exactly one level above threadMessagePath()', () => {
  const parent = paths.threadMessagesParentPath('board', 'general');
  const message = paths.threadMessagePath('board', 'general', 'm1');
  assert.equal(parent, '/store/board/threads/general/msgs');
  assert.equal(message, `${parent}/m1`);
});

test('notificationsSpaceId() is prefixed with NOTIFICATIONS_SPACE_PREFIX, and NOTIFICATIONS_THREAD_ID is fixed', () => {
  const spaceId = paths.notificationsSpaceId('abc123');
  assert.equal(spaceId, 'notifications-abc123');
  assert.ok(spaceId.startsWith(paths.NOTIFICATIONS_SPACE_PREFIX));
  assert.equal(paths.NOTIFICATIONS_THREAD_ID, 'notifications');
});
