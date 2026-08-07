import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrap, unwrapAll } from '../src/unwrap.js';

test('unwrap() of a QuBit-shaped object returns its .val', () => {
  assert.equal(unwrap({ path: '/x', val: 'hello', ts: 1, pub: null, sig: null }), 'hello');
});

test('unwrap() of a plain (non-QuBit) value returns it unchanged', () => {
  assert.equal(unwrap('plain string'), 'plain string');
  assert.equal(unwrap(42), 42);
  assert.equal(unwrap(null), null);
  assert.deepEqual(unwrap({ just: 'an object', no: 'ts field' }), { just: 'an object', no: 'ts field' });
});

test('unwrap() of an object with val but no ts is treated as a plain value, not a QuBit', () => {
  const value = { val: 'looks-like-a-key-named-val-but-isnt-a-qubit' };
  assert.equal(unwrap(value), value);
});

test('unwrapAll() maps unwrap() over every element, including null entries', () => {
  const list = [
    { path: '/a', val: 'A', ts: 1, pub: null, sig: null },
    null,
    { path: '/b', val: 'B', ts: 2, pub: null, sig: null },
  ];
  assert.deepEqual(unwrapAll(list), ['A', null, 'B']);
});

test('unwrapAll() of an empty array returns an empty array', () => {
  assert.deepEqual(unwrapAll([]), []);
});
