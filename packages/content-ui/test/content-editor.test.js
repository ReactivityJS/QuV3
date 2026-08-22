import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { mountContentEditor } = await import('../src/content-editor.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('renders a textarea and a submit button', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { placeholder: 'Say something...' });
  assert.equal(editor.textarea.placeholder, 'Say something...');
  assert.ok(host.querySelector('.qu-content-editor-submit'));
});

test('getValue()/setValue() round-trip', () => {
  const host = makeHost();
  const editor = mountContentEditor(host);
  editor.setValue('hello world');
  assert.equal(editor.getValue(), 'hello world');
  assert.equal(editor.textarea.value, 'hello world');
});

test('onSubmit() fires with the current text when the submit button is clicked', () => {
  const host = makeHost();
  const editor = mountContentEditor(host);
  const submitted = [];
  editor.onSubmit((text) => submitted.push(text));

  editor.setValue('hi there');
  host.querySelector('.qu-content-editor-submit').click();
  assert.deepEqual(submitted, ['hi there']);
});

test('submitting an empty/whitespace-only value does not fire onSubmit', () => {
  const host = makeHost();
  const editor = mountContentEditor(host);
  const submitted = [];
  editor.onSubmit((text) => submitted.push(text));

  editor.setValue('   ');
  host.querySelector('.qu-content-editor-submit').click();
  assert.deepEqual(submitted, []);
});

test('Enter submits, Shift+Enter does not', () => {
  const host = makeHost();
  const editor = mountContentEditor(host);
  const submitted = [];
  editor.onSubmit((text) => submitted.push(text));
  editor.setValue('a message');

  editor.textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(submitted, []);

  editor.textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true }));
  assert.deepEqual(submitted, ['a message']);
});

test('an extension\'s mount() receives a working insertText/actionsEl/textarea, and appending into actionsEl is visible in the DOM', () => {
  const host = makeHost();
  let seenCtx = null;
  const extension = {
    id: 'test-ext',
    mount: (ctx) => {
      seenCtx = ctx;
      const btn = document.createElement('button');
      btn.className = 'my-test-ext-button';
      ctx.actionsEl.appendChild(btn);
    },
  };
  const editor = mountContentEditor(host, { extensions: [extension] });

  assert.equal(seenCtx.textarea, editor.textarea);
  assert.equal(seenCtx.actionsEl, editor.actionsEl);
  assert.ok(host.querySelector('.my-test-ext-button'));

  seenCtx.insertText('👍');
  assert.equal(editor.getValue(), '👍');
});

test('stop() calls every extension\'s own returned stop function', () => {
  const host = makeHost();
  let stopped = false;
  const extension = { id: 'test-ext', mount: () => () => { stopped = true; } };
  const editor = mountContentEditor(host, { extensions: [extension] });

  editor.stop();
  assert.equal(stopped, true);
});

test('an extension whose mount() returns nothing does not break stop()', () => {
  const host = makeHost();
  const extension = { id: 'no-op', mount: () => {} };
  const editor = mountContentEditor(host, { extensions: [extension] });
  assert.doesNotThrow(() => editor.stop());
});
