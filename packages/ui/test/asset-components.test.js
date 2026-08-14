import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '../src/testing.js';

installDom();
const { QuAssetUploadElement, QuAssetElement, findAssetService } = await import('../src/asset-components.js');

function makeContainer(assetService) {
  const el = document.createElement('div');
  el.assetService = assetService;
  document.body.appendChild(el);
  return el;
}

function fakeAssetService({
  uploadResult = { name: 'greeting.txt', mime: 'text/plain', size: 5 },
  downloadResult = { meta: { name: 'greeting.txt', mime: 'text/plain', size: 5 }, data: new TextEncoder().encode('hello') },
  syncFetch = async () => ({}),
  synced = { synced: true, missing: [] },
  uploadShouldReject = null,
} = {}) {
  return {
    syncFetch,
    uploadCalls: [],
    downloadCalls: [],
    async upload(spaceId, assetId, file, { onProgress } = {}) {
      this.uploadCalls.push({ spaceId, assetId, file });
      if (uploadShouldReject) throw uploadShouldReject;
      onProgress?.(0.5);
      onProgress?.(1);
      return uploadResult;
    },
    async verifySyncOut(spaceId, assetId, { onSyncProgress } = {}) {
      onSyncProgress?.(1, synced);
      return { ...synced, attempts: 1 };
    },
    async download(spaceId, assetId) {
      this.downloadCalls.push({ spaceId, assetId });
      return downloadResult;
    },
  };
}

function pickFile(uploadEl, file) {
  const input = uploadEl.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
}

// ===== findAssetService ===========================================

test('findAssetService walks up through parents', () => {
  const service = fakeAssetService();
  const outer = document.createElement('div');
  outer.assetService = service;
  const inner = document.createElement('span');
  outer.appendChild(inner);
  assert.equal(findAssetService(inner), service);
});

// ===== <qu-asset-upload> ===========================================

test('<qu-asset-upload>: picking a file uploads it and fires qu-asset-uploaded with the assetId + meta', async () => {
  const service = fakeAssetService();
  const container = makeContainer(service);
  const el = document.createElement('qu-asset-upload');
  el.setAttribute('space-id', 'gallery');
  container.appendChild(el);

  let detail = null;
  el.addEventListener('qu-asset-uploaded', (e) => { detail = e.detail; });

  const file = new File(['hello'], 'greeting.txt', { type: 'text/plain' });
  pickFile(el, file);

  await waitFor(() => detail !== null);
  assert.equal(typeof detail.assetId, 'string');
  assert.deepEqual(detail.meta, { name: 'greeting.txt', mime: 'text/plain', size: 5 });
  assert.equal(service.uploadCalls[0].spaceId, 'gallery');
  assert.equal(service.uploadCalls[0].file, file);
});

test('<qu-asset-upload>: sync-out verification is deferred - picking a file alone never fires qu-asset-synced', async () => {
  const service = fakeAssetService();
  const container = makeContainer(service);
  const el = document.createElement('qu-asset-upload');
  el.setAttribute('space-id', 'gallery');
  container.appendChild(el);

  let uploaded = null;
  let syncDetail = null;
  el.addEventListener('qu-asset-uploaded', (e) => { uploaded = e.detail; });
  el.addEventListener('qu-asset-synced', (e) => { syncDetail = e.detail; });
  pickFile(el, new File(['hello'], 'x.txt', { type: 'text/plain' }));

  await waitFor(() => uploaded !== null);
  const status = el.querySelector('.qu-asset-upload-progress');
  await waitFor(() => status.hidden === true);
  assert.equal(service.uploadCalls.length, 1);
  // no verifySyncOut() call yet, and the local-save box is hidden again -
  // the confusing "stuck at 0%" bar this used to leave floating over the
  // composer right after picking a file (before the message is even sent).
  assert.equal(syncDetail, null);
});

test('<qu-asset-upload>.confirmSent(assetId) starts the deferred sync-out phase and fires qu-asset-synced once it completes', async () => {
  const service = fakeAssetService();
  const container = makeContainer(service);
  const el = document.createElement('qu-asset-upload');
  el.setAttribute('space-id', 'gallery');
  container.appendChild(el);

  let uploaded = null;
  let syncDetail = null;
  el.addEventListener('qu-asset-uploaded', (e) => { uploaded = e.detail; });
  el.addEventListener('qu-asset-synced', (e) => { syncDetail = e.detail; });
  pickFile(el, new File(['hello'], 'x.txt', { type: 'text/plain' }));
  await waitFor(() => uploaded !== null);

  await el.confirmSent(uploaded.assetId);
  await waitFor(() => syncDetail !== null);
  assert.equal(syncDetail.synced, true);
  assert.equal(syncDetail.assetId, uploaded.assetId);
});

test('<qu-asset-upload>.confirmSent(assetId) is a no-op when the assetId doesn\'t match the pending upload (a stale confirm racing a newer pick)', async () => {
  const service = fakeAssetService();
  const container = makeContainer(service);
  const el = document.createElement('qu-asset-upload');
  el.setAttribute('space-id', 'gallery');
  container.appendChild(el);

  let uploaded = null;
  let syncDetail = null;
  el.addEventListener('qu-asset-uploaded', (e) => { uploaded = e.detail; });
  el.addEventListener('qu-asset-synced', (e) => { syncDetail = e.detail; });
  pickFile(el, new File(['hello'], 'x.txt', { type: 'text/plain' }));
  await waitFor(() => uploaded !== null);

  await el.confirmSent('some-other-assetId-entirely');
  assert.equal(syncDetail, null); // ignored - not the asset that was actually confirmed sent
});

test('<qu-asset-upload>: without a configured syncFetch, no sync phase runs (progress hides right after the local save)', async () => {
  const service = fakeAssetService({ syncFetch: null });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset-upload');
  el.setAttribute('space-id', 'gallery');
  container.appendChild(el);

  let uploaded = false;
  let synced = false;
  el.addEventListener('qu-asset-uploaded', () => { uploaded = true; });
  el.addEventListener('qu-asset-synced', () => { synced = true; });
  pickFile(el, new File(['hello'], 'x.txt', { type: 'text/plain' }));

  await waitFor(() => uploaded);
  const status = el.querySelector('.qu-asset-upload-progress');
  await waitFor(() => status.hidden === true);
  assert.equal(synced, false); // verifySyncOut() never called without syncFetch
});

test('<qu-asset-upload>: shows an error message when upload() rejects', async () => {
  const service = fakeAssetService({ uploadShouldReject: new Error('disk full') });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset-upload');
  el.setAttribute('space-id', 'gallery');
  container.appendChild(el);

  pickFile(el, new File(['hello'], 'x.txt', { type: 'text/plain' }));

  await waitFor(() => el.querySelector('.qu-asset-upload-error') !== null);
  assert.match(el.querySelector('.qu-asset-upload-error').textContent, /disk full/);
});

test('<qu-asset-upload>: forwards .readerPubs/.asSpaceId to upload()', async () => {
  const service = fakeAssetService();
  const origUpload = service.upload.bind(service);
  let capturedOptions = null;
  service.upload = (spaceId, assetId, file, options) => { capturedOptions = options; return origUpload(spaceId, assetId, file, options); };

  const container = makeContainer(service);
  const el = document.createElement('qu-asset-upload');
  el.setAttribute('space-id', 'gallery');
  el.readerPubs = ['reader1'];
  el.asSpaceId = 'pseudo1';
  container.appendChild(el);

  pickFile(el, new File(['hello'], 'x.txt', { type: 'text/plain' }));
  await waitFor(() => capturedOptions !== null);
  assert.deepEqual(capturedOptions.readerPubs, ['reader1']);
  assert.equal(capturedOptions.asSpaceId, 'pseudo1');
});

// ===== <qu-asset> ===========================================

test('<qu-asset>: renders an <img> for an image/* asset', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'p.png', mime: 'image/png', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'photo1');
  container.appendChild(el);

  await waitFor(() => el.querySelector('img') !== null);
  assert.equal(el.querySelector('img').alt, 'p.png');
});

test('<qu-asset>: clicking an image opens a fullscreen lightbox overlay; clicking the enlarged image toggles zoom; Escape closes it', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'p.png', mime: 'image/png', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'photo1');
  container.appendChild(el);

  await waitFor(() => el.querySelector('img') !== null);
  assert.equal(document.querySelector('.qu-asset-lightbox-overlay'), null);

  el.querySelector('img').click();
  const overlay = document.querySelector('.qu-asset-lightbox-overlay');
  assert.ok(overlay);
  const lightboxImg = overlay.querySelector('.qu-asset-lightbox-img');
  assert.equal(lightboxImg.alt, 'p.png');
  assert.equal(lightboxImg.classList.contains('qu-asset-lightbox-img-zoomed'), false);

  lightboxImg.click(); // toggle zoom on, without closing the overlay
  assert.ok(document.querySelector('.qu-asset-lightbox-overlay'));
  assert.equal(lightboxImg.classList.contains('qu-asset-lightbox-img-zoomed'), true);

  lightboxImg.click(); // toggle zoom back off
  assert.equal(lightboxImg.classList.contains('qu-asset-lightbox-img-zoomed'), false);

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(document.querySelector('.qu-asset-lightbox-overlay'), null);
});

test('<qu-asset>: clicking the lightbox backdrop (outside the image) closes it', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'p.png', mime: 'image/png', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'photo1');
  container.appendChild(el);

  await waitFor(() => el.querySelector('img') !== null);
  el.querySelector('img').click();
  assert.ok(document.querySelector('.qu-asset-lightbox-overlay'));

  document.querySelector('.qu-asset-lightbox-overlay').click();
  assert.equal(document.querySelector('.qu-asset-lightbox-overlay'), null);
});

test('<qu-asset>: a class set by the caller BEFORE mounting survives - "qu-asset" is ADDED, never a full replacement', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'p.png', mime: 'image/png', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.className = 'qu-forum-message-attachment';
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'photo1');
  container.appendChild(el);

  await waitFor(() => el.querySelector('img') !== null);
  assert.ok(el.classList.contains('qu-forum-message-attachment'));
  assert.ok(el.classList.contains('qu-asset'));
});

test('<qu-asset>: renders a <video controls> for a video/* asset', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'v.mp4', mime: 'video/mp4', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'vid1');
  container.appendChild(el);

  await waitFor(() => el.querySelector('video') !== null);
  assert.equal(el.querySelector('video').controls, true);
});

test('<qu-asset>: renders an <audio controls> for an audio/* asset', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'a.mp3', mime: 'audio/mpeg', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'aud1');
  container.appendChild(el);

  await waitFor(() => el.querySelector('audio') !== null);
});

test('<qu-asset>: renders a download link for anything else', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'doc.pdf', mime: 'application/pdf', size: 1024 }, data: new Uint8Array([1]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'doc1');
  container.appendChild(el);

  await waitFor(() => el.querySelector('a.qu-asset-file-link') !== null);
  const link = el.querySelector('a.qu-asset-file-link');
  assert.equal(link.download, 'doc.pdf');
  assert.match(link.textContent, /doc\.pdf/);
});

test('<qu-asset kind="file">: forces the file-link rendering even for an image mime', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'p.png', mime: 'image/png', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'photo1');
  el.setAttribute('kind', 'file');
  container.appendChild(el);

  await waitFor(() => el.querySelector('a.qu-asset-file-link') !== null);
  assert.equal(el.querySelector('img'), null);
});

test('<qu-asset>: shows "(unavailable)" when download() resolves null', async () => {
  const service = fakeAssetService({ downloadResult: null });
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'nope');
  container.appendChild(el);

  await waitFor(() => el.querySelector('.qu-asset-empty') !== null);
});

test('<qu-asset>: two elements referencing the SAME asset share one download() call (cache)', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'p.png', mime: 'image/png', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const elA = document.createElement('qu-asset');
  elA.setAttribute('space-id', 'gallery');
  elA.setAttribute('asset-id', 'shared1');
  container.appendChild(elA);
  const elB = document.createElement('qu-asset');
  elB.setAttribute('space-id', 'gallery');
  elB.setAttribute('asset-id', 'shared1');
  container.appendChild(elB);

  await waitFor(() => elA.querySelector('img') !== null && elB.querySelector('img') !== null);
  assert.equal(service.downloadCalls.length, 1);
});

test('<qu-asset>: revokes the object URL once the last referencing element disconnects', async () => {
  const service = fakeAssetService({ downloadResult: { meta: { name: 'p.png', mime: 'image/png', size: 3 }, data: new Uint8Array([1, 2, 3]) } });
  const container = makeContainer(service);
  const elA = document.createElement('qu-asset');
  elA.setAttribute('space-id', 'gallery');
  elA.setAttribute('asset-id', 'revoke1');
  container.appendChild(elA);
  const elB = document.createElement('qu-asset');
  elB.setAttribute('space-id', 'gallery');
  elB.setAttribute('asset-id', 'revoke1');
  container.appendChild(elB);
  await waitFor(() => elA.querySelector('img') !== null);
  const url = elA.querySelector('img').src;

  let revoked = null;
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => { revoked = u; };
  try {
    elA.remove();
    assert.equal(revoked, null); // elB still references it - not revoked yet
    elB.remove();
    await waitFor(() => revoked !== null);
    assert.ok(url.includes(revoked) || revoked.includes(url) || revoked === url);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});

test('<qu-asset>: changing "asset-id" re-mounts and fetches the new asset, ignoring a stale in-flight resolve', async () => {
  const resolvers = {};
  const service = {
    syncFetch: null,
    async download(spaceId, assetId) {
      return new Promise((resolve) => { resolvers[assetId] = resolve; });
    },
  };
  const container = makeContainer(service);
  const el = document.createElement('qu-asset');
  el.setAttribute('space-id', 'gallery');
  el.setAttribute('asset-id', 'first');
  container.appendChild(el);
  await waitFor(() => typeof resolvers.first === 'function');

  el.setAttribute('asset-id', 'second');
  await waitFor(() => typeof resolvers.second === 'function');

  // Resolve the STALE ("first") request after the switch - must be ignored.
  resolvers.first({ meta: { name: 'first.png', mime: 'image/png', size: 1 }, data: new Uint8Array([1]) });
  resolvers.second({ meta: { name: 'second.png', mime: 'image/png', size: 1 }, data: new Uint8Array([2]) });

  await waitFor(() => el.querySelector('img') !== null);
  assert.equal(el.querySelector('img').alt, 'second.png');
});
