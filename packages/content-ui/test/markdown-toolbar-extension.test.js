import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { mountContentEditor } = await import('../src/content-editor.js');
const { markdownToolbarExtension } = await import('../src/markdown-toolbar-extension.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function toolbarBtn(host, label) {
  return [...host.querySelectorAll('.qu-content-editor-toolbar .qu-slot-resolver-item')].find((btn) => btn.title === label);
}

function selectRange(textarea, start, end) {
  textarea.focus();
  textarea.selectionStart = start;
  textarea.selectionEnd = end;
}

test('registers all five buttons into the toolbar slot, with a real tooltip on each', () => {
  const host = makeHost();
  mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  for (const label of ['Bold', 'Italic', 'Link', 'Code', 'Spoiler']) {
    assert.ok(toolbarBtn(host, label), `expected a "${label}" toolbar button`);
  }
});

test('Bold wraps the current selection in **...**', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('hello world');
  selectRange(editor.textarea, 0, 5); // "hello"
  toolbarBtn(host, 'Bold').click();
  assert.equal(editor.getValue(), '**hello** world');
});

test('Italic wraps the current selection in *...*', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('hello world');
  selectRange(editor.textarea, 6, 11); // "world"
  toolbarBtn(host, 'Italic').click();
  assert.equal(editor.getValue(), 'hello *world*');
});

test('Code wraps the current selection in `...`', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('run npm test now');
  selectRange(editor.textarea, 4, 12); // "npm test"
  toolbarBtn(host, 'Code').click();
  assert.equal(editor.getValue(), 'run `npm test` now');
});

test('Spoiler wraps the current selection in ||...||', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('the ending is a twist');
  selectRange(editor.textarea, 14, 21); // "a twist"
  toolbarBtn(host, 'Spoiler').click();
  assert.equal(editor.getValue(), 'the ending is ||a twist||');
});

test('Bold with no selection inserts an empty pair at the cursor', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('hi ');
  selectRange(editor.textarea, 3, 3);
  toolbarBtn(host, 'Bold').click();
  assert.equal(editor.getValue(), 'hi ****');
});

test('Link prompts for a URL and inserts markdown-link syntax over the selection', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('see docs for more');
  selectRange(editor.textarea, 4, 8); // "docs"
  const originalPrompt = window.prompt;
  window.prompt = () => 'https://example.com';
  try {
    toolbarBtn(host, 'Link').click();
  } finally {
    window.prompt = originalPrompt;
  }
  assert.equal(editor.getValue(), 'see [docs](https://example.com) for more');
});

test('Link falls back to placeholder text when nothing was selected', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('');
  const originalPrompt = window.prompt;
  window.prompt = () => 'https://example.com';
  try {
    toolbarBtn(host, 'Link').click();
  } finally {
    window.prompt = originalPrompt;
  }
  assert.equal(editor.getValue(), '[link text](https://example.com)');
});

test('Link cancelled (prompt returns null) leaves the text untouched', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.setValue('see docs for more');
  selectRange(editor.textarea, 4, 8);
  const originalPrompt = window.prompt;
  window.prompt = () => null;
  try {
    toolbarBtn(host, 'Link').click();
  } finally {
    window.prompt = originalPrompt;
  }
  assert.equal(editor.getValue(), 'see docs for more');
});

test('stop() cleans up the toolbar registration (unregisterToolbarItem called for every button)', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [markdownToolbarExtension()] });
  editor.stop();
  assert.equal(host.querySelectorAll('.qu-content-editor-toolbar .qu-slot-resolver-item').length, 0);
});
