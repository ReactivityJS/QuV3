import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as paths from '../src/paths.js';

test('mainSigningPath()/mainEncryptionPath() are fixed, distinct paths', () => {
  assert.equal(paths.mainSigningPath(), "m/44'/123'/0'/0'/0'");
  assert.equal(paths.mainEncryptionPath(), "m/44'/123'/0'/1'/0'");
});

test('spaceSigningPath()/spaceEncryptionPath() are deterministic per spaceId and differ by purpose', async () => {
  const signing = await paths.spaceSigningPath('room1');
  const encryption = await paths.spaceEncryptionPath('room1');
  assert.equal(signing, await paths.spaceSigningPath('room1'));
  assert.notEqual(signing, encryption);
  assert.match(signing, /^m\/44'\/123'\/0'\/0'\/\d+'$/);
  assert.match(encryption, /^m\/44'\/123'\/0'\/1'\/\d+'$/);
});

test('spaceSigningPath() differs for different spaceIds', async () => {
  const a = await paths.spaceSigningPath('room1');
  const b = await paths.spaceSigningPath('room2');
  assert.notEqual(a, b);
});

test('ephemeralSigningPath() appends the ephemeral index as its own hardened segment', async () => {
  const spacePath = await paths.spaceSigningPath('room1');
  const ephemeral = await paths.ephemeralSigningPath('room1', 5);
  assert.equal(ephemeral, `${spacePath}/5'`);
});

test('ephemeralSigningPath() rejects an out-of-range or non-integer index', async () => {
  await assert.rejects(() => paths.ephemeralSigningPath('room1', -1));
  await assert.rejects(() => paths.ephemeralSigningPath('room1', 1.5));
  await assert.rejects(() => paths.ephemeralSigningPath('room1', 0x80000000));
});

test('spaceIdToIndex() passes a valid numeric spaceId through unchanged', async () => {
  assert.equal(await paths.spaceIdToIndex(42), 42);
});

test('spaceIdToIndex() rejects an out-of-range or non-integer numeric spaceId', async () => {
  await assert.rejects(() => paths.spaceIdToIndex(-1));
  await assert.rejects(() => paths.spaceIdToIndex(1.5));
  await assert.rejects(() => paths.spaceIdToIndex(0x80000000));
});

test('spaceIdToIndex() hashes a string spaceId deterministically to an index < 2^31', async () => {
  const a = await paths.spaceIdToIndex('some-room-id');
  const b = await paths.spaceIdToIndex('some-room-id');
  assert.equal(a, b);
  assert.ok(Number.isInteger(a));
  assert.ok(a >= 0 && a < 0x80000000);
});

test('spaceIdToIndex() gives different strings different indices (spot check)', async () => {
  const a = await paths.spaceIdToIndex('room-a');
  const b = await paths.spaceIdToIndex('room-b');
  assert.notEqual(a, b);
});
