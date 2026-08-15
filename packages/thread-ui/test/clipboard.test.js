import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyToClipboard } from '../src/clipboard.js';

// Node's own built-in `navigator` global is a getter-only accessor property
// (no setter) - plain assignment throws in strict-mode ESM, so every test
// below swaps it out via defineProperty and restores the original
// descriptor afterward.
function withNavigator(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  return fn().finally(() => Object.defineProperty(globalThis, 'navigator', original));
}

test('copyToClipboard() writes to navigator.clipboard and resolves true on success', async () => {
  const written = [];
  await withNavigator({ clipboard: { writeText: async (text) => { written.push(text); } } }, async () => {
    const ok = await copyToClipboard('hello world');
    assert.equal(ok, true);
    assert.deepEqual(written, ['hello world']);
  });
});

test('copyToClipboard() resolves false (never throws) when navigator.clipboard is unavailable', async () => {
  await withNavigator({}, async () => {
    const ok = await copyToClipboard('hello world');
    assert.equal(ok, false);
  });
});

test('copyToClipboard() resolves false (never throws) when writeText() itself rejects', async () => {
  await withNavigator({ clipboard: { writeText: async () => { throw new Error('denied'); } } }, async () => {
    const ok = await copyToClipboard('hello world');
    assert.equal(ok, false);
  });
});
