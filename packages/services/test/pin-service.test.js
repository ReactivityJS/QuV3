import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { PinService } from '../src/pin-service.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity, pins: new PinService(qu, identity, new ListService(qu)) };
}

test('setPinned()/listPinned() round-trip', async () => {
  const { pins } = await freshSetup();
  await pins.setPinned('board', 'general', 'm1', true);
  assert.deepEqual(await pins.listPinned('board', 'general'), ['m1']);
});

test('setPinned(..., false) unpins - listPinned() excludes it', async () => {
  const { pins } = await freshSetup();
  await pins.setPinned('board', 'general', 'm1', true);
  await pins.setPinned('board', 'general', 'm1', false);
  assert.deepEqual(await pins.listPinned('board', 'general'), []);
});

test('multiple pinned messages all show up, unpinning one leaves the rest', async () => {
  const { pins } = await freshSetup();
  await pins.setPinned('board', 'general', 'm1', true);
  await pins.setPinned('board', 'general', 'm2', true);
  await pins.setPinned('board', 'general', 'm3', true);
  await pins.setPinned('board', 'general', 'm2', false);

  assert.deepEqual([...(await pins.listPinned('board', 'general'))].sort(), ['m1', 'm3']);
});

test('pins are scoped per thread - pinning in one thread does not affect another', async () => {
  const { pins } = await freshSetup();
  await pins.setPinned('board', 'general', 'm1', true);
  await pins.setPinned('board', 'random', 'm1', true);
  await pins.setPinned('board', 'general', 'm1', false);

  assert.deepEqual(await pins.listPinned('board', 'general'), []);
  assert.deepEqual(await pins.listPinned('board', 'random'), ['m1']);
});

test('listPinned() of a thread with no pins returns an empty array', async () => {
  const { pins } = await freshSetup();
  assert.deepEqual(await pins.listPinned('board', 'untouched'), []);
});

test('ANY current writer may pin a message another actor authored - pins are not per-actor', async () => {
  const { qu, pins } = await freshSetup();
  const kp = await QuCrypto.generateKeypair();
  const otherPins = new PinService(qu, { getMainKey: async () => kp }, new ListService(qu));
  await otherPins.setPinned('board', 'general', 'm1', true);
  assert.deepEqual(await pins.listPinned('board', 'general'), ['m1']);
});
