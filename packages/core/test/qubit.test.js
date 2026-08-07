import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUBIT_FIELDS, isQuBit, isEncryptedEnvelope, createQuBit } from '../src/qubit.js';

test('createQuBit() builds the canonical, unsigned shape', () => {
  const before = Date.now();
  const quBit = createQuBit('/store/foo', { a: 1 });
  const after = Date.now();

  assert.deepEqual(Object.keys(quBit).sort(), [...QUBIT_FIELDS].sort());
  assert.equal(quBit.path, '/store/foo');
  assert.deepEqual(quBit.val, { a: 1 });
  assert.ok(quBit.ts >= before && quBit.ts <= after);
  assert.equal(quBit.pub, null);
  assert.equal(quBit.sig, null);
});

test('isQuBit() accepts a well-shaped object and rejects malformed ones', () => {
  assert.equal(isQuBit(createQuBit('/x', 1)), true);
  assert.equal(isQuBit(null), false);
  assert.equal(isQuBit(undefined), false);
  assert.equal(isQuBit('not an object'), false);
  assert.equal(isQuBit({ path: '/x' }), false); // missing val/ts
  assert.equal(isQuBit({ path: '/x', val: 1, ts: 'not-a-number' }), false);
  assert.equal(isQuBit({ path: '/x', val: null, ts: 0 }), true); // val may legitimately be null (deletion marker)
});

test('isEncryptedEnvelope() distinguishes an envelope from a plain value', () => {
  assert.equal(isEncryptedEnvelope({ iv: 'AA==', ct: 'BB==', to: [] }), true);
  assert.equal(isEncryptedEnvelope({ iv: 'AA==', ct: 'BB==', to: [{ pub: 'p', key: 'k' }] }), true);
  assert.equal(isEncryptedEnvelope({ hello: 'world' }), false);
  assert.equal(isEncryptedEnvelope(null), false);
  assert.equal(isEncryptedEnvelope('plaintext'), false);
  assert.equal(isEncryptedEnvelope({ iv: 'AA==', ct: 'BB==', to: 'not-an-array' }), false);
});
