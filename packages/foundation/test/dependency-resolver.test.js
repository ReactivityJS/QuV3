import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/registry.js';
import { DependencyResolver } from '../src/dependency-resolver.js';

test('resolve() with no requires returns just the target', () => {
  const resolver = new DependencyResolver(new Registry());
  const target = { name: 'a', requires: [] };
  assert.deepEqual(resolver.resolve(target, []), [target]);
});

test('resolve() orders a single dependency before its dependent', () => {
  const resolver = new DependencyResolver(new Registry());
  const dep = { name: 'document-service' };
  const target = { name: 'forum', requires: ['document-service'] };

  const order = resolver.resolve(target, [dep]);
  assert.deepEqual(order, [dep, target]);
});

test('resolve() handles a transitive chain in correct dependency-first order', () => {
  const resolver = new DependencyResolver(new Registry());
  const a = { name: 'a', requires: ['b'] };
  const b = { name: 'b', requires: ['c'] };
  const c = { name: 'c' };

  const order = resolver.resolve(a, [b, c]);
  assert.deepEqual(order.map((m) => m.name), ['c', 'b', 'a']);
});

test('resolve() satisfies a dependency via `provides`, not just `name`', () => {
  const resolver = new DependencyResolver(new Registry());
  const alias = { name: 'thread-engine-v2', provides: ['thread-engine'] };
  const target = { name: 'forum', requires: ['thread-engine'] };

  const order = resolver.resolve(target, [alias]);
  assert.deepEqual(order, [alias, target]);
});

test('resolve() skips anything already satisfied by the Registry', () => {
  const registry = new Registry();
  registry.registerEngine('document-service', {});
  const resolver = new DependencyResolver(registry);
  const target = { name: 'forum', requires: ['document-service'] };

  // No candidate manifest for "document-service" is even offered - if the
  // resolver tried to load it anyway, this would throw "nothing provides it".
  const order = resolver.resolve(target, []);
  assert.deepEqual(order, [target]);
});

test('resolve() throws a clear error naming the missing dependency and what IS available', () => {
  const resolver = new DependencyResolver(new Registry());
  const target = { name: 'forum', requires: ['nonexistent-service'] };
  assert.throws(
    () => resolver.resolve(target, [{ name: 'unrelated-thing' }]),
    /"forum" requires "nonexistent-service".*Available: unrelated-thing/
  );
});

test('resolve() throws and reports the exact cycle for circular requires', () => {
  const resolver = new DependencyResolver(new Registry());
  const a = { name: 'a', requires: ['b'] };
  const b = { name: 'b', requires: ['c'] };
  const c = { name: 'c', requires: ['a'] };

  assert.throws(() => resolver.resolve(a, [b, c]), /circular "requires" chain: a -> b -> c -> a/);
});

test('resolve() a diamond dependency graph only loads the shared dependency once', () => {
  const resolver = new DependencyResolver(new Registry());
  const shared = { name: 'shared' };
  const left = { name: 'left', requires: ['shared'] };
  const right = { name: 'right', requires: ['shared'] };
  const target = { name: 'top', requires: ['left', 'right'] };

  const order = resolver.resolve(target, [shared, left, right]);
  const names = order.map((m) => m.name);
  assert.deepEqual(names.filter((n) => n === 'shared').length, 1);
  assert.deepEqual(names, ['shared', 'left', 'right', 'top']);
});

test('resolve() does not duplicate a manifest already fully processed via another path', () => {
  const resolver = new DependencyResolver(new Registry());
  // "b" and "c" both require "shared"; "a" requires both "b" and "c".
  const shared = { name: 'shared' };
  const b = { name: 'b', requires: ['shared'] };
  const c = { name: 'c', requires: ['shared'] };
  const a = { name: 'a', requires: ['b', 'c'] };

  const order = resolver.resolve(a, [shared, b, c]);
  assert.equal(order.length, 4); // shared, b, c, a - not 5
});
