import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mountContentEditor } = await import('../src/content-editor.js');
const { attachmentExtension } = await import('../src/attachment-extension.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function fakeAssetService(uploadResult = { name: 'photo.png', mime: 'image/png', size: 100 }) {
  return {
    uploadCalls: [],
    async upload(spaceId, assetId, file) {
      this.uploadCalls.push({ spaceId, assetId, file });
      return uploadResult;
    },
  };
}

function pickFile(uploadEl, file) {
  const input = uploadEl.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
}

function triggerBtn(host) {
  return host.querySelector('.qu-content-editor-leading button');
}

test('registers a 📎 trigger that opens the file picker', () => {
  const host = makeHost();
  mountContentEditor(host, { extensions: [attachmentExtension({ assetService: fakeAssetService(), spaceId: 'space1' })] });
  assert.equal(triggerBtn(host).textContent, '📎');
});

test('the <qu-asset-upload> element is configured with the right space-id/assetService', () => {
  const host = makeHost();
  const service = fakeAssetService();
  mountContentEditor(host, { extensions: [attachmentExtension({ assetService: service, spaceId: 'gallery' })] });

  const uploadEl = host.querySelector('qu-asset-upload');
  assert.equal(uploadEl.getAttribute('space-id'), 'gallery');
  assert.equal(uploadEl.assetService, service);
  assert.ok(uploadEl.hasAttribute('hide-picker'));
});

test('a completed upload contributes the attachment and renders a removable chip', async () => {
  const host = makeHost();
  const service = fakeAssetService({ name: 'photo.png', mime: 'image/png', size: 100 });
  const extension = attachmentExtension({ assetService: service, spaceId: 'space1' });
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  const file = new File(['x'], 'photo.png', { type: 'image/png' });
  pickFile(host.querySelector('qu-asset-upload'), file);
  await waitFor(() => host.querySelector('.qu-content-ui-attachment-chip') !== null);

  assert.equal(host.querySelector('.qu-content-ui-attachment-chip').textContent.includes('photo.png'), true);

  host.querySelector('.qu-content-editor-submit-slot button').click(); // no text needed - the attachment alone justifies it
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].attachments.length, 1);
  assert.equal(submitted[0].attachments[0].name, 'photo.png');
});

test('removing the chip retracts the contribution - an otherwise-empty submit is blocked again', async () => {
  const host = makeHost();
  const service = fakeAssetService();
  const extension = attachmentExtension({ assetService: service, spaceId: 'space1' });
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  pickFile(host.querySelector('qu-asset-upload'), new File(['x'], 'a.png', { type: 'image/png' }));
  await waitFor(() => host.querySelector('.qu-content-ui-attachment-chip') !== null);

  host.querySelector('.qu-content-ui-attachment-chip button').click(); // remove
  assert.equal(host.querySelector('.qu-content-ui-attachment-chip'), null);

  host.querySelector('.qu-content-editor-submit-slot button').click();
  assert.deepEqual(submitted, []);
});

test('two uploads both contribute - attachments accumulate rather than replace', async () => {
  const host = makeHost();
  const service = fakeAssetService();
  const extension = attachmentExtension({ assetService: service, spaceId: 'space1' });
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  const uploadEl = host.querySelector('qu-asset-upload');
  pickFile(uploadEl, new File(['x'], 'a.png', { type: 'image/png' }));
  await waitFor(() => host.querySelectorAll('.qu-content-ui-attachment-chip').length === 1);
  pickFile(uploadEl, new File(['y'], 'b.png', { type: 'image/png' }));
  await waitFor(() => host.querySelectorAll('.qu-content-ui-attachment-chip').length === 2);

  host.querySelector('.qu-content-editor-submit-slot button').click();
  assert.equal(submitted[0].attachments.length, 2);
});

test('stop() cleans up the upload element, trigger, and contribution', () => {
  const host = makeHost();
  const service = fakeAssetService();
  const extension = attachmentExtension({ assetService: service, spaceId: 'space1' });
  const editor = mountContentEditor(host, { extensions: [extension] });

  editor.stop();
  assert.equal(host.querySelector('qu-asset-upload'), null);
  assert.equal(triggerBtn(host), null);
});

test('clearContributions() (a successful submit) clears the pending-attachment chip too - not just the editor\'s own contribution map', async () => {
  const host = makeHost();
  const service = fakeAssetService({ name: 'photo.png', mime: 'image/png', size: 100 });
  const extension = attachmentExtension({ assetService: service, spaceId: 'space1' });
  const editor = mountContentEditor(host, { extensions: [extension] });
  const submitted = [];
  editor.onSubmit((text, extras) => submitted.push(extras));

  pickFile(host.querySelector('qu-asset-upload'), new File(['x'], 'photo.png', { type: 'image/png' }));
  await waitFor(() => host.querySelector('.qu-content-ui-attachment-chip') !== null);

  host.querySelector('.qu-content-editor-submit-slot button').click();
  assert.equal(submitted.length, 1);
  editor.clearContributions(); // mountContentComposer()'s own post-success call

  assert.equal(host.querySelector('.qu-content-ui-attachment-chip'), null);

  // A SECOND, unrelated submit no longer carries the first (already-sent)
  // attachment along with it - the real bug this reset() hook fixes.
  editor.setValue('a second, unrelated message');
  host.querySelector('.qu-content-editor-submit-slot button').click();
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[1].attachments, []);
});
