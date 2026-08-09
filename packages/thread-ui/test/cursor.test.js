import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { insertAtCursor } = await import('../src/cursor.js');

function makeTextarea(value, caret) {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  el.value = value;
  el.selectionStart = el.selectionEnd = caret ?? value.length;
  return el;
}

test('inserts at the current collapsed caret position and moves the caret to the end of the inserted text', () => {
  const el = makeTextarea('hi !', 3); // caret right before "!"
  insertAtCursor(el, 'there');
  assert.equal(el.value, 'hi there!');
  assert.equal(el.selectionStart, 8);
  assert.equal(el.selectionEnd, 8);
});

test('replaces an explicit range instead of the current selection', () => {
  const el = makeTextarea('hello @ab world', 8); // caret irrelevant here - explicit range given
  insertAtCursor(el, '@fullpub123456', { start: 6, end: 9 });
  assert.equal(el.value, 'hello @fullpub123456 world');
});

test('replaces a real (non-collapsed) selection when no explicit range is given', () => {
  const el = makeTextarea('replace THIS please', 0);
  el.selectionStart = 8;
  el.selectionEnd = 12; // "THIS"
  insertAtCursor(el, 'that');
  assert.equal(el.value, 'replace that please');
});

test('fires a real input event so an attached listener sees the change', () => {
  const el = makeTextarea('a', 1);
  let fired = false;
  el.addEventListener('input', () => { fired = true; });
  insertAtCursor(el, 'b');
  assert.equal(fired, true);
});
