import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/registry.js';
import { HookBus } from '../src/hooks.js';

test('registerEngine()/getEngine() round-trip', () => {
  const registry = new Registry();
  const instance = { doThing: () => 'x' };
  registry.registerEngine('thread-engine', instance);
  assert.equal(registry.getEngine('thread-engine'), instance);
});

test('registerService()/getService() round-trip', () => {
  const registry = new Registry();
  const instance = {};
  registry.registerService('document-service', instance);
  assert.equal(registry.getService('document-service'), instance);
});

test('engines and services are separate namespaces - same name in both is allowed', () => {
  const registry = new Registry();
  const engine = {};
  const service = {};
  registry.registerEngine('thing', engine);
  registry.registerService('thing', service);
  assert.equal(registry.getEngine('thing'), engine);
  assert.equal(registry.getService('thing'), service);
});

test('registerEngine() throws on a duplicate name', () => {
  const registry = new Registry();
  registry.registerEngine('thread-engine', {});
  assert.throws(() => registry.registerEngine('thread-engine', {}), /already registered/);
});

test('registerService() throws on a duplicate name', () => {
  const registry = new Registry();
  registry.registerService('document-service', {});
  assert.throws(() => registry.registerService('document-service', {}), /already registered/);
});

test('getEngine()/getService() throw a helpful error listing known names', () => {
  const registry = new Registry();
  registry.registerEngine('thread-engine', {});
  assert.throws(() => registry.getEngine('nope'), /no engine named "nope".*thread-engine/);
});

test('getEngine() on an empty registry mentions "(none)"', () => {
  const registry = new Registry();
  assert.throws(() => registry.getEngine('nope'), /\(none\)/);
});

test('hasEngine()/hasService()/has() reflect registration state', () => {
  const registry = new Registry();
  registry.registerEngine('e', {});
  registry.registerService('s', {});
  assert.equal(registry.hasEngine('e'), true);
  assert.equal(registry.hasEngine('s'), false);
  assert.equal(registry.hasService('s'), true);
  assert.equal(registry.has('e'), true);
  assert.equal(registry.has('s'), true);
  assert.equal(registry.has('nope'), false);
});

test('listEngines()/listServices() return every registered name', () => {
  const registry = new Registry();
  registry.registerEngine('e1', {});
  registry.registerEngine('e2', {});
  registry.registerService('s1', {});
  assert.deepEqual(registry.listEngines().sort(), ['e1', 'e2']);
  assert.deepEqual(registry.listServices(), ['s1']);
});

test('each Registry instance owns its own independent HookBus', () => {
  const a = new Registry();
  const b = new Registry();
  assert.ok(a.hooks instanceof HookBus);
  assert.notEqual(a.hooks, b.hooks);

  let firedOnA = 0;
  a.hooks.on('x', () => { firedOnA++; });
  return b.hooks.notify('x', {}).then(() => {
    assert.equal(firedOnA, 0); // b's hooks firing must never reach a's handlers
  });
});
