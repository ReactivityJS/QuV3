import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { getTextareaSelectionRect } = await import('../src/caret-position.js');

function makeTextarea(value, selectionStart, selectionEnd) {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  textarea.value = value;
  textarea.selectionStart = selectionStart;
  textarea.selectionEnd = selectionEnd;
  return textarea;
}

test('getTextareaSelectionRect() returns null for a collapsed selection - nothing to anchor a toolbar to', () => {
  const textarea = makeTextarea('hello world', 5, 5);
  assert.equal(getTextareaSelectionRect(textarea), null);
});

test('getTextareaSelectionRect() returns null when jsdom (no layout engine) reports an empty getClientRects()', () => {
  // This IS what jsdom actually does, unpatched - the real, documented
  // limitation this file's own doc comment flags: no layout engine means
  // getClientRects() always returns an empty list. Verified here explicitly
  // rather than left implicit, so a future jsdom upgrade that changes this
  // silently fails this test instead of silently changing behavior.
  const textarea = makeTextarea('hello world', 0, 5);
  assert.equal(getTextareaSelectionRect(textarea), null);
});

test('getTextareaSelectionRect() builds a mirror with a span around exactly the selected text, and removes the mirror afterward', () => {
  const textarea = makeTextarea('hello world', 6, 11); // "world"
  let seenSpanText = null;
  const original = window.Element.prototype.getClientRects;
  window.Element.prototype.getClientRects = function () {
    if (this.tagName === 'SPAN') {
      seenSpanText = this.textContent;
      return [{ top: 10, left: 20, width: 30, height: 15 }];
    }
    return original.call(this);
  };
  const bodyChildrenBefore = document.body.children.length;
  try {
    const result = getTextareaSelectionRect(textarea);
    assert.equal(seenSpanText, 'world');
    assert.ok(result);
  } finally {
    window.Element.prototype.getClientRects = original;
  }
  // The mirror div was appended and removed again - no leftover node.
  assert.equal(document.body.children.length, bodyChildrenBefore);
});

test('getTextareaSelectionRect() returns a duck-typed {getBoundingClientRect} anchored to the START of the selection, translated into viewport coordinates', () => {
  const textarea = makeTextarea('hello world', 6, 11);
  const original = window.Element.prototype.getClientRects;
  const originalBCR = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getClientRects = function () {
    if (this.tagName === 'SPAN') return [{ top: 10, left: 20, width: 30, height: 15 }];
    return original.call(this);
  };
  // Both the mirror (an off-screen div) and the real textarea report a
  // zero-origin rect here - isolates the assertion to "the span's own
  // offset passes through unchanged" without needing to also fake a
  // realistic mirror/textarea position.
  window.Element.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 });
  try {
    const result = getTextareaSelectionRect(textarea);
    const rect = result.getBoundingClientRect();
    assert.equal(rect.top, 10);
    assert.equal(rect.left, 20);
    assert.equal(rect.width, 30);
    assert.equal(rect.height, 15);
    assert.equal(rect.right, 50);
    assert.equal(rect.bottom, 25);
  } finally {
    window.Element.prototype.getClientRects = original;
    window.Element.prototype.getBoundingClientRect = originalBCR;
  }
});

test('getTextareaSelectionRect() anchors to getClientRects()[0] (the START), not a getBoundingClientRect() union box, for a multi-line selection', () => {
  const textarea = makeTextarea('line one\nline two\nline three', 0, 28);
  const original = window.Element.prototype.getClientRects;
  window.Element.prototype.getClientRects = function () {
    if (this.tagName === 'SPAN') {
      // Three visual lines - a union box would report top:0 spanning all
      // three; anchoring to [0] must report only the FIRST line's rect.
      return [
        { top: 0, left: 0, width: 60, height: 15 },
        { top: 15, left: 0, width: 55, height: 15 },
        { top: 30, left: 0, width: 65, height: 15 },
      ];
    }
    return original.call(this);
  };
  try {
    const result = getTextareaSelectionRect(textarea);
    const rect = result.getBoundingClientRect();
    assert.equal(rect.top, 0);
    assert.equal(rect.height, 15); // the first line's height, not a 45px union
  } finally {
    window.Element.prototype.getClientRects = original;
  }
});
