import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mountEmojiAutocomplete } = await import('../src/emoji-autocomplete.js');
const { EMOJI_EXTENDED } = await import('../src/emoji.js');
const { EMOJI_SHORTCODES, EMOJI_SHORTCODE_LIST } = await import('../src/emoji-shortcodes.js');

function makeTextarea() {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  return el;
}

function type(el, value, caret = value.length) {
  el.value = value;
  el.selectionStart = el.selectionEnd = caret;
  el.dispatchEvent(new CustomEvent('input', { bubbles: true }));
}

test('every EMOJI_EXTENDED glyph has a shortcode name', () => {
  for (const emoji of EMOJI_EXTENDED) assert.ok(EMOJI_SHORTCODES[emoji], `missing shortcode for ${emoji}`);
  assert.equal(EMOJI_SHORTCODE_LIST.length, EMOJI_EXTENDED.length);
});

test('one typed character after : does not open the dropdown', async () => {
  const el = makeTextarea();
  const stop = mountEmojiAutocomplete(el);
  try {
    type(el, 'hi :f');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector('.qu-thread-ui-emoji-ac-list'), null);
  } finally {
    stop();
  }
});

test('two typed characters after : opens the dropdown, matching by shortcode substring', async () => {
  const el = makeTextarea();
  const stop = mountEmojiAutocomplete(el);
  try {
    type(el, 'hi :fir');
    await waitFor(() => document.querySelector('.qu-thread-ui-emoji-ac-list') !== null);
    const items = [...document.querySelectorAll('.qu-thread-ui-emoji-ac-item')];
    assert.ok(items.some((li) => li.textContent.includes('🔥')));
  } finally {
    stop();
  }
});

test('selecting a candidate inserts the plain glyph (no colons) and closes the dropdown, without reopening', async () => {
  const el = makeTextarea();
  const stop = mountEmojiAutocomplete(el);
  try {
    type(el, 'nice :fire');
    await waitFor(() => document.querySelector('.qu-thread-ui-emoji-ac-item') !== null);
    document.querySelector('.qu-thread-ui-emoji-ac-item').dispatchEvent(new CustomEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(el.value, 'nice 🔥');
    assert.equal(document.querySelector('.qu-thread-ui-emoji-ac-list'), null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector('.qu-thread-ui-emoji-ac-list'), null);
  } finally {
    stop();
  }
});

test('no match narrows the dropdown to nothing and closes it', async () => {
  const el = makeTextarea();
  const stop = mountEmojiAutocomplete(el);
  try {
    type(el, 'hi :fir');
    await waitFor(() => document.querySelector('.qu-thread-ui-emoji-ac-list') !== null);
    type(el, 'hi :firzzzznomatch');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector('.qu-thread-ui-emoji-ac-list'), null);
  } finally {
    stop();
  }
});

test('stop() removes listeners and closes any open dropdown', async () => {
  const el = makeTextarea();
  const stop = mountEmojiAutocomplete(el);
  type(el, 'hi :fir');
  await waitFor(() => document.querySelector('.qu-thread-ui-emoji-ac-list') !== null);
  stop();
  assert.equal(document.querySelector('.qu-thread-ui-emoji-ac-list'), null);
  type(el, 'hi :fir more');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.querySelector('.qu-thread-ui-emoji-ac-list'), null);
});
