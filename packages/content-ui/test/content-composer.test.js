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

function submitBtn(host) {
  return host.querySelector('.qu-content-editor-submit-slot button');
}

test('submitting calls onSubmit() with a createContent()-shaped object matching the typed text/format', () => {
  const host = makeHost();
  const submitted = [];
  const composer = mountContentComposer(host, { format: 'markdown', onSubmit: (content) => submitted.push(content) });

  composer.editor.setValue('**hello**');
  submitBtn(host).click();

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, '**hello**');
  assert.equal(submitted[0].format, 'markdown');
  assert.deepEqual(submitted[0].attachments, []);
  assert.equal(submitted[0].location, null);
});

test('format defaults to "plain"', () => {
  const host = makeHost();
  const submitted = [];
  const composer = mountContentComposer(host, { onSubmit: (content) => submitted.push(content) });

  composer.editor.setValue('hi');
  submitBtn(host).click();
  assert.equal(submitted[0].format, 'plain');
});

test('the editor clears after a successful submit', () => {
  const host = makeHost();
  const composer = mountContentComposer(host, { onSubmit: () => {} });

  composer.editor.setValue('hi');
  submitBtn(host).click();
  assert.equal(composer.editor.getValue(), '');
});

test('submitting an empty value never calls onSubmit (and never clears anything, since there was nothing to submit)', () => {
  const host = makeHost();
  const submitted = [];
  const composer = mountContentComposer(host, { onSubmit: (content) => submitted.push(content) });

  submitBtn(host).click();
  assert.deepEqual(submitted, []);
});

test('requireText: false allows an empty-text submit', () => {
  const host = makeHost();
  const submitted = [];
  const composer = mountContentComposer(host, { requireText: false, onSubmit: (content) => submitted.push(content) });

  submitBtn(host).click();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, '');
});

test('onSubmit is optional - submitting without one does not throw', () => {
  const host = makeHost();
  const composer = mountContentComposer(host);
  composer.editor.setValue('hi');
  assert.doesNotThrow(() => submitBtn(host).click());
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

// ===== attachment/location extras =============================================

test('a contributed attachment is folded into the submitted Content, with empty text allowed', () => {
  const host = makeHost();
  const submitted = [];
  const extension = {
    id: 'attach-test',
    mount: (ctx) => { ctx.contributeContent('attach-test', { attachments: [{ id: 'a1', name: 'photo.png' }] }); },
  };
  const composer = mountContentComposer(host, { extensions: [extension], onSubmit: (content) => submitted.push(content) });

  submitBtn(host).click(); // no typed text - the contribution alone justifies it (requireText's default rule)
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, '');
  assert.deepEqual(submitted[0].attachments, [{ id: 'a1', name: 'photo.png' }]);
});

test('a contributed location is folded into the submitted Content', () => {
  const host = makeHost();
  const submitted = [];
  const extension = {
    id: 'loc-test',
    mount: (ctx) => { ctx.contributeContent('loc-test', { location: { lat: 52.52, lng: 13.405 } }); },
  };
  const composer = mountContentComposer(host, { extensions: [extension], onSubmit: (content) => submitted.push(content) });

  submitBtn(host).click();
  assert.deepEqual(submitted[0].location, { lat: 52.52, lng: 13.405 });
});

test('contributions are cleared after a successful submit - a second submit does not resend them', () => {
  const host = makeHost();
  const submitted = [];
  const extension = {
    id: 'attach-test',
    mount: (ctx) => { ctx.contributeContent('attach-test', { attachments: [{ id: 'a1' }] }); },
  };
  const composer = mountContentComposer(host, { extensions: [extension], requireText: false, onSubmit: (content) => submitted.push(content) });

  submitBtn(host).click();
  submitBtn(host).click();
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[0].attachments, [{ id: 'a1' }]);
  assert.deepEqual(submitted[1].attachments, []);
});

test('submitNow() (e.g. Voice) produces a Content object independent of the current draft', () => {
  const host = makeHost();
  const submitted = [];
  let ctxRef;
  const extension = { id: 'voice-test', mount: (ctx) => { ctxRef = ctx; } };
  const composer = mountContentComposer(host, { extensions: [extension], onSubmit: (content) => submitted.push(content) });

  composer.editor.setValue('an unrelated draft');
  ctxRef.submitNow({ attachments: [{ id: 'voice1' }] });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, '');
  assert.deepEqual(submitted[0].attachments, [{ id: 'voice1' }]);
  assert.equal(composer.editor.getValue(), 'an unrelated draft'); // untouched
});
