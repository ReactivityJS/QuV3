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

function submitBtn(host) {
  return host.querySelector('.qu-content-editor-submit-slot button');
}

test('renders a textarea and a submit button', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { placeholder: 'Say something...' });
  assert.equal(editor.textarea.placeholder, 'Say something...');
  assert.ok(submitBtn(host));
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
  submitBtn(host).click();
  assert.deepEqual(submitted, ['hi there']);
});

test('submitting an empty/whitespace-only value does not fire onSubmit (requireText defaults to true)', () => {
  const host = makeHost();
  const editor = mountContentEditor(host);
  const submitted = [];
  editor.onSubmit((text) => submitted.push(text));

  editor.setValue('   ');
  submitBtn(host).click();
  assert.deepEqual(submitted, []);
});

test('requireText: false allows an empty submit', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { requireText: false });
  const submitted = [];
  editor.onSubmit((text) => submitted.push(text));

  submitBtn(host).click();
  assert.deepEqual(submitted, ['']);
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

test('an extension\'s mount() receives a working insertText/actionsEl/textarea', () => {
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

// ===== leading action slot (registerAction) ===================================

function leadingItems(host) {
  return host.querySelectorAll('.qu-content-editor-leading .qu-slot-resolver-item');
}

test('registerAction() renders per the configured leadingSlot strategy', () => {
  const host = makeHost();
  const extension = {
    id: 'test-ext',
    mount: (ctx) => { ctx.registerAction({ id: 'a', icon: 'a', onClick: () => {} }); },
  };
  mountContentEditor(host, { extensions: [extension], leadingSlot: { strategy: 'inline', threshold: 2 } });
  assert.equal(leadingItems(host).length, 1);
});

test('unregisterAction() removes a previously registered leading action', () => {
  const host = makeHost();
  let unregister;
  const extension = {
    id: 'test-ext',
    mount: (ctx) => {
      ctx.registerAction({ id: 'a', icon: 'a', onClick: () => {} });
      unregister = () => ctx.unregisterAction('a');
    },
  };
  mountContentEditor(host, { extensions: [extension] });
  assert.equal(leadingItems(host).length, 1);
  unregister();
  assert.equal(leadingItems(host).length, 0);
});

test('multiple leading actions past the configured threshold collapse into a "More" menu', () => {
  const host = makeHost();
  const extension = {
    id: 'test-ext',
    mount: (ctx) => {
      ctx.registerAction({ id: 'a', icon: 'a', onClick: () => {} });
      ctx.registerAction({ id: 'b', icon: 'b', onClick: () => {} });
      ctx.registerAction({ id: 'c', icon: 'c', onClick: () => {} });
    },
  };
  mountContentEditor(host, { extensions: [extension], leadingSlot: { strategy: 'inline-then-menu', threshold: 2 } });
  assert.equal(leadingItems(host).length, 2);
  assert.ok(host.querySelector('.qu-content-editor-leading .qu-thread-ui-context-menu-trigger'));
});

// ===== submit slot candidates (registerSubmitCandidate) =======================

test('registerSubmitCandidate() with an initially-false "when" does not change the visible submit button', () => {
  const host = makeHost();
  const extension = {
    id: 'test-ext',
    mount: (ctx) => { ctx.registerSubmitCandidate({ id: 'alt', icon: '🎙️', when: () => false, onClick: () => {} }); },
  };
  mountContentEditor(host, { extensions: [extension], submitLabel: '➤' });
  assert.equal(submitBtn(host).textContent, '➤');
});

test('a registered submit candidate whose "when" becomes true replaces the default Send button, and reverts once typing starts', () => {
  const host = makeHost();
  let flag = true;
  const extension = {
    id: 'test-ext',
    mount: (ctx) => { ctx.registerSubmitCandidate({ id: 'alt', icon: '🎙️', when: () => flag, onClick: () => {} }); },
  };
  const editor = mountContentEditor(host, { extensions: [extension], submitLabel: '➤' });
  assert.equal(submitBtn(host).textContent, '🎙️');

  flag = false;
  editor.setValue('hi'); // triggers an input event, which re-resolves the submit slot
  assert.equal(submitBtn(host).textContent, '➤');
});

test('unregisterSubmitCandidate() removes a candidate from the switch', () => {
  const host = makeHost();
  let unregister;
  const extension = {
    id: 'test-ext',
    mount: (ctx) => {
      ctx.registerSubmitCandidate({ id: 'alt', icon: '🎙️', when: () => true, onClick: () => {} });
      unregister = () => ctx.unregisterSubmitCandidate('alt');
    },
  };
  const editor = mountContentEditor(host, { extensions: [extension], submitLabel: '➤' });
  assert.equal(submitBtn(host).textContent, '🎙️');
  unregister();
  assert.equal(submitBtn(host).textContent, '➤');
  void editor;
});

// ===== content contributions (contributeContent/retractContent) ===============

test('contributeContent() is merged into onSubmit()\'s second argument', () => {
  const host = makeHost();
  const extension = {
    id: 'test-ext',
    mount: (ctx) => { ctx.contributeContent('test-ext', { attachments: [{ id: 'a1' }] }); },
  };
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  editor.setValue('hi');
  submitBtn(host).click();
  assert.deepEqual(submitted, [{ attachments: [{ id: 'a1' }], location: null }]);
});

test('a contribution alone (no text) allows submit when requireText defaults to true', () => {
  const host = makeHost();
  const extension = {
    id: 'test-ext',
    mount: (ctx) => { ctx.contributeContent('test-ext', { attachments: [{ id: 'a1' }] }); },
  };
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  submitBtn(host).click(); // empty text, but a contribution is present
  assert.equal(submitted.length, 1);
  void editor;
});

test('retractContent() removes a contribution, and can block an otherwise-empty submit again', () => {
  const host = makeHost();
  let retract;
  const extension = {
    id: 'test-ext',
    mount: (ctx) => {
      ctx.contributeContent('test-ext', { attachments: [{ id: 'a1' }] });
      retract = () => ctx.retractContent('test-ext');
    },
  };
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  retract();
  submitBtn(host).click();
  assert.deepEqual(submitted, []);
});

test('clearContributions() removes every standing contribution', () => {
  const host = makeHost();
  const extension = {
    id: 'test-ext',
    mount: (ctx) => { ctx.contributeContent('test-ext', { location: { lat: 1, lng: 2 } }); },
  };
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  editor.clearContributions();
  submitBtn(host).click();
  assert.deepEqual(submitted, []);
});

// ===== chrome swap (setChrome) =================================================

test('setChrome() replaces the normal row with a custom panel, and null restores it', () => {
  const host = makeHost();
  let ctxRef;
  const extension = { id: 'test-ext', mount: (ctx) => { ctxRef = ctx; } };
  mountContentEditor(host, { extensions: [extension] });
  const normalRow = host.querySelector('.qu-content-editor-row');

  assert.equal(normalRow.hidden, false);
  const panel = document.createElement('div');
  panel.className = 'my-custom-panel';
  ctxRef.setChrome(panel);
  assert.equal(normalRow.hidden, true);
  assert.ok(host.querySelector('.my-custom-panel'));

  ctxRef.setChrome(null);
  assert.equal(normalRow.hidden, false);
  assert.equal(host.querySelector('.my-custom-panel'), null);
});

// ===== submitNow() ==============================================================

test('submitNow() submits immediately with empty text and only the given extra, ignoring the typed draft and standing contributions', () => {
  const host = makeHost();
  let ctxRef;
  const extension = {
    id: 'test-ext',
    mount: (ctx) => {
      ctxRef = ctx;
      ctx.contributeContent('test-ext', { attachments: [{ id: 'standing' }] });
    },
  };
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push({ text, extras }));

  editor.setValue('a typed draft, unrelated to the voice send');
  ctxRef.submitNow({ attachments: [{ id: 'voice1' }] });

  assert.deepEqual(submitted, [{ text: '', extras: { attachments: [{ id: 'voice1' }], location: null } }]);
  assert.equal(editor.getValue(), 'a typed draft, unrelated to the voice send'); // untouched
});
