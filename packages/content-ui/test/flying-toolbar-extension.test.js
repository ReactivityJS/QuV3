import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { mountContentEditor } = await import('../src/content-editor.js');
const { flyingToolbarExtension } = await import('../src/flying-toolbar-extension.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Earlier tests' editors/panels are never stopped (this file doesn't call
// editor.stop() except in the dedicated cleanup test), so multiple panels
// can be present in the shared jsdom document at once - the LAST one
// appended is always the current test's own.
function panel() {
  const panels = document.querySelectorAll('.qu-content-ui-flying-toolbar');
  return panels[panels.length - 1] ?? null;
}

function panelBtn(label) {
  return [...panel().querySelectorAll('button')].find((btn) => btn.title === label);
}

// getTextareaSelectionRect() (@qu/thread-ui) needs a real layout engine
// (getClientRects()) to report anything - jsdom has none, so every test that
// needs the panel to actually SHOW patches this the same way
// caret-position.test.js does, standing in for a real browser's layout.
async function withFakeSelectionRect(fn) {
  const original = window.Element.prototype.getClientRects;
  window.Element.prototype.getClientRects = function () {
    if (this.tagName === 'SPAN') return [{ top: 100, left: 50, width: 40, height: 15 }];
    return original.call(this);
  };
  try {
    // `await`, not a bare `return fn()` - fn may itself be async (some
    // callers need the patch held across an internal setTimeout wait), and
    // a bare return would let `finally` restore the original BEFORE such a
    // callback's own pending work finishes.
    return await fn();
  } finally {
    window.Element.prototype.getClientRects = original;
  }
}

function selectRange(textarea, start, end) {
  textarea.focus();
  textarea.selectionStart = start;
  textarea.selectionEnd = end;
  textarea.dispatchEvent(new CustomEvent('mouseup', { bubbles: true }));
}

test('the panel is appended to document.body, hidden, at mount time', () => {
  const host = makeHost();
  mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  assert.ok(panel());
  assert.equal(panel().hidden, true);
});

test('mouseup with a real selection shows the panel with Bold/Italic/Strikethrough buttons', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  withFakeSelectionRect(() => selectRange(editor.textarea, 0, 5));

  assert.equal(panel().hidden, false);
  assert.ok(panelBtn('Bold'));
  assert.ok(panelBtn('Italic'));
  assert.ok(panelBtn('Strikethrough'));
});

test('mouseup with a collapsed selection (nothing selected) keeps/hides the panel', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  selectRange(editor.textarea, 3, 3);
  assert.equal(panel().hidden, true);
});

test('Bold wraps the current selection in **...** and hides the panel afterward', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  withFakeSelectionRect(() => selectRange(editor.textarea, 0, 5));

  panelBtn('Bold').dispatchEvent(new CustomEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(editor.getValue(), '**hello** world');
  assert.equal(panel().hidden, true);
});

test('Italic wraps the current selection in *...*', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  withFakeSelectionRect(() => selectRange(editor.textarea, 6, 11));

  panelBtn('Italic').dispatchEvent(new CustomEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(editor.getValue(), 'hello *world*');
});

test('Strikethrough wraps the current selection in ~~...~~ - matching thread-formatting.js\'s own marker', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('this is gone');
  withFakeSelectionRect(() => selectRange(editor.textarea, 8, 12)); // "gone"

  panelBtn('Strikethrough').dispatchEvent(new CustomEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(editor.getValue(), 'this is ~~gone~~');
});

test('typing (input event) hides the panel - the selection is gone anyway', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  withFakeSelectionRect(() => selectRange(editor.textarea, 0, 5));
  assert.equal(panel().hidden, false);

  editor.textarea.dispatchEvent(new CustomEvent('input', { bubbles: true }));
  assert.equal(panel().hidden, true);
});

test('scrolling hides the panel (a position:fixed panel does not track scroll on its own)', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  withFakeSelectionRect(() => selectRange(editor.textarea, 0, 5));
  assert.equal(panel().hidden, false);

  window.dispatchEvent(new CustomEvent('scroll'));
  assert.equal(panel().hidden, true);
});

test('blur hides the panel after a short defer (so a button\'s own mousedown lands first)', async () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  withFakeSelectionRect(() => selectRange(editor.textarea, 0, 5));
  assert.equal(panel().hidden, false);

  editor.textarea.dispatchEvent(new CustomEvent('blur', { bubbles: true }));
  assert.equal(panel().hidden, false); // not yet - deferred
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(panel().hidden, true);
});

test('document selectionchange (debounced) shows the panel too - the touch-selection-handle-drag-ending trigger mouseup/keyup can miss', async () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  editor.textarea.focus();
  editor.textarea.selectionStart = 0;
  editor.textarea.selectionEnd = 5;

  await withFakeSelectionRect(async () => {
    document.dispatchEvent(new CustomEvent('selectionchange'));
    assert.equal(panel().hidden, true); // not yet - debounced
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(panel().hidden, false);
  });
});

test('document selectionchange is ignored while a DIFFERENT element is focused - it is document-wide, not scoped to this composer', async () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');
  editor.textarea.selectionStart = 0;
  editor.textarea.selectionEnd = 5;
  const elsewhere = document.createElement('input');
  document.body.appendChild(elsewhere);
  elsewhere.focus(); // some other field is focused, NOT this composer's textarea

  await withFakeSelectionRect(async () => {
    document.dispatchEvent(new CustomEvent('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(panel().hidden, true);
  });
});

test('prefers BELOW the selection on a coarse (touch) pointer, ABOVE on a fine (mouse) pointer', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');

  withFakeSelectionRect(() => selectRange(editor.textarea, 0, 5));
  const aboveTop = Number.parseFloat(panel().style.top); // default: fine pointer, matchMedia unmocked -> above

  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query === '(pointer: coarse)' });
  try {
    withFakeSelectionRect(() => selectRange(editor.textarea, 6, 11));
  } finally {
    window.matchMedia = originalMatchMedia;
  }
  const belowTop = Number.parseFloat(panel().style.top);

  // Below the selection is a LARGER top than above it (jsdom reports a
  // zero-height panel, so this purely isolates the preference flip, not a
  // real panel-height-dependent fits-or-not calculation).
  assert.ok(belowTop > aboveTop, `expected the coarse-pointer position (${belowTop}) below the fine-pointer one (${aboveTop})`);
});

test('visualViewport offset (not just size) shifts the panel - position:fixed does not follow the on-screen keyboard\'s viewport pan on its own', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  editor.setValue('hello world');

  window.visualViewport = { width: window.innerWidth, height: window.innerHeight, offsetTop: 50, offsetLeft: 20 };
  try {
    withFakeSelectionRect(() => selectRange(editor.textarea, 0, 5));
    // Anchor rect from the fake getClientRects(): top:100, left:50 (see withFakeSelectionRect).
    // jsdom's panel/textarea rects are all-zero, so top = rect.top - 0 - GAP(8) = 92, +offsetTop(50) = 142.
    assert.equal(panel().style.top, '142px');
    assert.equal(panel().style.left, '70px'); // rect.left(50) + offsetLeft(20)
  } finally {
    delete window.visualViewport;
  }
});

test('stop() removes the panel from the DOM', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [flyingToolbarExtension()] });
  const thisPanel = panel(); // capture before stop() - other tests' own panels may remain in the shared document
  editor.stop();
  assert.equal(thisPanel.isConnected, false);
});
