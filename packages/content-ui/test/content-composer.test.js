import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { mountContentComposer } = await import('../src/content-composer.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('submitting calls onSubmit() with a createContent()-shaped object matching the typed text/format', () => {
  const host = makeHost();
  const submitted = [];
  const composer = mountContentComposer(host, { format: 'markdown', onSubmit: (content) => submitted.push(content) });

  composer.editor.setValue('**hello**');
  host.querySelector('.qu-content-editor-submit').click();

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, '**hello**');
  assert.equal(submitted[0].format, 'markdown');
  assert.deepEqual(submitted[0].attachments, []);
});

test('format defaults to "plain"', () => {
  const host = makeHost();
  const submitted = [];
  const composer = mountContentComposer(host, { onSubmit: (content) => submitted.push(content) });

  composer.editor.setValue('hi');
  host.querySelector('.qu-content-editor-submit').click();
  assert.equal(submitted[0].format, 'plain');
});

test('the editor clears after a successful submit', () => {
  const host = makeHost();
  const composer = mountContentComposer(host, { onSubmit: () => {} });

  composer.editor.setValue('hi');
  host.querySelector('.qu-content-editor-submit').click();
  assert.equal(composer.editor.getValue(), '');
});

test('submitting an empty value never calls onSubmit (and never clears anything, since there was nothing to submit)', () => {
  const host = makeHost();
  const submitted = [];
  const composer = mountContentComposer(host, { onSubmit: (content) => submitted.push(content) });

  host.querySelector('.qu-content-editor-submit').click();
  assert.deepEqual(submitted, []);
});

test('onSubmit is optional - submitting without one does not throw', () => {
  const host = makeHost();
  const composer = mountContentComposer(host);
  composer.editor.setValue('hi');
  assert.doesNotThrow(() => host.querySelector('.qu-content-editor-submit').click());
});

test('extensions passed through to the underlying ContentEditor still work', () => {
  const host = makeHost();
  const extension = { id: 'test-ext', mount: (ctx) => { ctx.insertText('👍'); } };
  const composer = mountContentComposer(host, { extensions: [extension], onSubmit: () => {} });
  assert.equal(composer.editor.getValue(), '👍');
});

test('stop() stops the underlying editor', () => {
  const host = makeHost();
  let stopped = false;
  const extension = { id: 'test-ext', mount: () => () => { stopped = true; } };
  const composer = mountContentComposer(host, { extensions: [extension] });
  composer.stop();
  assert.equal(stopped, true);
});
