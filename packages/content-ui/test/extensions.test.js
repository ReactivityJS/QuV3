import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mountContentEditor } = await import('../src/content-editor.js');
const { emojiExtension, mentionExtension } = await import('../src/extensions.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

const ADA_PUB = 'adaadaada1234567890abcdefghijk';

function fakeServices() {
  return {
    directory: { async listVisible() { return [{ actorPub: ADA_PUB }]; } },
    contacts: { async listContacts() { return []; } },
    profile: { async getPublicProfile() { return { alias: 'Ada' }; } },
  };
}

// ===== emojiExtension() ======================================================

test('emojiExtension() appends a working trigger into actionsEl', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [emojiExtension({ trigger: '😀' })] });

  const trigger = editor.actionsEl.querySelector('button');
  assert.ok(trigger);
  assert.equal(trigger.textContent, '😀');
});

test('emojiExtension() inserts the picked emoji through the editor\'s own insertText', async () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [emojiExtension({ trigger: '😀' })] });
  editor.setValue('hi ');

  editor.actionsEl.querySelector('button').click();
  await waitFor(() => document.querySelector('.qu-thread-ui-emoji-panel') !== null);
  const someButton = document.querySelectorAll('.qu-thread-ui-emoji-panel-grid button')[0];
  someButton.click();

  assert.equal(editor.getValue(), `hi ${someButton.textContent}`);
});

// ===== mentionExtension() ====================================================

test('mentionExtension() wires mention-autocomplete onto the editor\'s own textarea', async () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [mentionExtension({ services: fakeServices() })] });

  editor.textarea.value = 'hi @ad';
  editor.textarea.selectionStart = editor.textarea.selectionEnd = editor.textarea.value.length;
  editor.textarea.dispatchEvent(new CustomEvent('input', { bubbles: true }));

  await waitFor(() => document.querySelector('.qu-thread-ui-mention-list') !== null);
  assert.ok(document.querySelector('.qu-thread-ui-mention-item'));
});

test('mentionExtension()\'s mount() returns a stop function the editor\'s stop() calls', () => {
  const host = makeHost();
  const editor = mountContentEditor(host, { extensions: [mentionExtension({ services: fakeServices() })] });
  assert.doesNotThrow(() => editor.stop());
});
