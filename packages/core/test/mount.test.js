import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuMount } from '../src/mount.js';

test('resolve() splits an absolute path into adapter + rel + mountName', () => {
  const mount = new QuMount();
  const adapter = {};
  mount.mount('store', adapter);

  const result = mount.resolve('/store/actors/~alice/profile');
  assert.equal(result.adapter, adapter);
  assert.equal(result.rel, '/actors/~alice/profile');
  assert.equal(result.mountName, 'store');
});

test('resolve() of the mount root itself yields an empty rel', () => {
  const mount = new QuMount();
  mount.mount('temp', {});
  const result = mount.resolve('/temp');
  assert.equal(result.rel, '/');
});

test('resolve() throws for an unregistered mount', () => {
  const mount = new QuMount();
  assert.throws(() => mount.resolve('/nowhere/x'), /mount "nowhere" not found/);
});

test('resolve() throws for an empty path', () => {
  const mount = new QuMount();
  assert.throws(() => mount.resolve('/'), /path is empty/);
});

test('resolve() rejects "." and ".." path-traversal segments anywhere in the path', () => {
  const mount = new QuMount();
  mount.mount('store', {});
  assert.throws(() => mount.resolve('/store/..'), /unsafe path segment/);
  assert.throws(() => mount.resolve('/store/../../etc/passwd'), /unsafe path segment/);
  assert.throws(() => mount.resolve('/store/a/./b'), /unsafe path segment/);
});

test('a segment that merely CONTAINS ".." but is not exactly ".." is allowed', () => {
  const mount = new QuMount();
  mount.mount('store', {});
  // Regression guard: the check is `segment === '..'`, not `segment.includes('..')`.
  const result = mount.resolve('/store/foo..bar');
  assert.equal(result.rel, '/foo..bar');
});

test('resolve() rejects a NUL byte in any segment', () => {
  const mount = new QuMount();
  mount.mount('store', {});
  assert.throws(() => mount.resolve('/store/evil\0name'), /unsafe path segment/);
});

test('unmount() removes a mount; a subsequent resolve() throws', () => {
  const mount = new QuMount();
  mount.mount('store', {});
  mount.unmount('store');
  assert.throws(() => mount.resolve('/store/x'));
});

test('mount() throws when a name is already registered', () => {
  const mount = new QuMount();
  mount.mount('store', {});
  assert.throws(() => mount.mount('store', {}), /already exists/);
});

test('names()/get() expose the registered mounts', () => {
  const mount = new QuMount();
  const storeAdapter = {};
  mount.mount('store', storeAdapter);
  mount.mount('temp', {});
  assert.deepEqual(mount.names().sort(), ['store', 'temp']);
  assert.equal(mount.get('store'), storeAdapter);
  assert.equal(mount.get('nope'), undefined);
});
