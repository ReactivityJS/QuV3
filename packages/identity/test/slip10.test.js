import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMasterNode, deriveChildNode, deriveNodeFromPath } from '../src/slip10.js';

function seed(n = 1) {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * n) % 256;
  return bytes;
}

test('deriveMasterNode() returns a 32-byte privateKey and 32-byte chainCode', async () => {
  const node = await deriveMasterNode(seed());
  assert.equal(node.privateKey.length, 32);
  assert.equal(node.chainCode.length, 32);
});

test('deriveMasterNode() is deterministic for the same seed, different for a different seed', async () => {
  const a = await deriveMasterNode(seed(1));
  const b = await deriveMasterNode(seed(1));
  const c = await deriveMasterNode(seed(2));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.privateKey, c.privateKey);
});

test('deriveChildNode() is deterministic per (parent, index), distinct across indices', async () => {
  const master = await deriveMasterNode(seed());
  const child0a = await deriveChildNode(master, 0);
  const child0b = await deriveChildNode(master, 0);
  const child1 = await deriveChildNode(master, 1);
  assert.deepEqual(child0a, child0b);
  assert.notDeepEqual(child0a.privateKey, child1.privateKey);
});

test('deriveChildNode() rejects a non-integer or out-of-range index', async () => {
  const master = await deriveMasterNode(seed());
  await assert.rejects(() => deriveChildNode(master, -1));
  await assert.rejects(() => deriveChildNode(master, 1.5));
  await assert.rejects(() => deriveChildNode(master, 0x80000000)); // >= hardened offset, out of allowed unhardened range
});

test('deriveNodeFromPath() matches manually chaining deriveChildNode() calls', async () => {
  const s = seed();
  const viaPath = await deriveNodeFromPath(s, "m/44'/123'/0'");

  const master = await deriveMasterNode(s);
  const step1 = await deriveChildNode(master, 44);
  const step2 = await deriveChildNode(step1, 123);
  const step3 = await deriveChildNode(step2, 0);

  assert.deepEqual(viaPath, step3);
});

test('deriveNodeFromPath() works with or without the leading "m/"', async () => {
  const s = seed();
  const withPrefix = await deriveNodeFromPath(s, "m/44'/123'");
  const withoutPrefix = await deriveNodeFromPath(s, "44'/123'");
  assert.deepEqual(withPrefix, withoutPrefix);
});

test('deriveNodeFromPath() throws for a non-hardened segment', async () => {
  await assert.rejects(() => deriveNodeFromPath(seed(), "m/44'/123"), /not hardened/);
});

test('deriveNodeFromPath() throws for a non-integer segment', async () => {
  await assert.rejects(() => deriveNodeFromPath(seed(), "m/abc'"), /not a valid integer/);
});

test('deriveNodeFromPath() with an empty path (just "m/") returns the master node', async () => {
  const s = seed();
  const viaPath = await deriveNodeFromPath(s, 'm/');
  const master = await deriveMasterNode(s);
  assert.deepEqual(viaPath, master);
});

test('two DIFFERENT paths never collide for the same seed (spot check over several depths)', async () => {
  const s = seed();
  const a = await deriveNodeFromPath(s, "m/44'/123'/0'/0'/0'");
  const b = await deriveNodeFromPath(s, "m/44'/123'/0'/0'/1'");
  const c = await deriveNodeFromPath(s, "m/44'/123'/0'/1'/0'");
  assert.notDeepEqual(a.privateKey, b.privateKey);
  assert.notDeepEqual(a.privateKey, c.privateKey);
  assert.notDeepEqual(b.privateKey, c.privateKey);
});
