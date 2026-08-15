import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { prefersNativeEmojiKeyboard } = await import('../src/platform.js');

test('no window.matchMedia at all (plain jsdom, no polyfill): treated as NOT touch, i.e. desktop', () => {
  const previous = window.matchMedia;
  delete window.matchMedia;
  try {
    assert.equal(prefersNativeEmojiKeyboard(), false);
  } finally {
    window.matchMedia = previous;
  }
});

test('matchMedia("(pointer: coarse)").matches === true -> touch/native', () => {
  const previous = window.matchMedia;
  window.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' });
  try {
    assert.equal(prefersNativeEmojiKeyboard(), true);
  } finally {
    window.matchMedia = previous;
  }
});

test('matchMedia("(pointer: coarse)").matches === false -> desktop', () => {
  const previous = window.matchMedia;
  window.matchMedia = () => ({ matches: false });
  try {
    assert.equal(prefersNativeEmojiKeyboard(), false);
  } finally {
    window.matchMedia = previous;
  }
});

test('a throwing matchMedia falls back to desktop rather than propagating', () => {
  const previous = window.matchMedia;
  window.matchMedia = () => { throw new Error('boom'); };
  try {
    assert.equal(prefersNativeEmojiKeyboard(), false);
  } finally {
    window.matchMedia = previous;
  }
});
