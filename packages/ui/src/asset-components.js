/**
 * QU-ASSET-COMPONENTS — the Custom Element layer over `@qu/services`'
 * `AssetService` (which itself is a thin facade over `@qu/engines`'
 * `AssetEngine` - see either's own doc comment for why ALL the chunking/
 * hashing/dedup/retry LOGIC lives there, not here). This file only ever
 * calls `assetService.upload()`/`.verifySyncOut()`/`.download()` and
 * renders the result - it holds no storage/sync logic of its own, exactly
 * mirroring how `<qu-view>`/`<qu-bind>` (components.js) never re-implement
 * `watch()`, they just call it and render.
 *
 * Two elements:
 *   <qu-asset-upload>  a file picker that uploads, shows LOCAL-write
 *                       progress, then SEPARATELY tracks sync-out
 *                       verification/retry progress (two distinguishable
 *                       phases - see `AssetEngine`'s own doc comment for
 *                       why "saved locally" and "confirmed synced" are
 *                       deliberately not the same moment). Fires
 *                       `qu-asset-uploaded` (detail: `{assetId, meta}`) the
 *                       moment the local write is durable, then
 *                       `qu-asset-synced` (detail: `{assetId, synced,
 *                       missing}`) once sync verification finishes (success
 *                       or exhausted retries) - a host app reacts to the
 *                       first to remember the new `assetId`, and MAY listen
 *                       to the second for a "confirmed synced" indicator.
 *   <qu-asset>          a read-only viewer: downloads once (an uploaded
 *                       asset's bytes never change - matches the
 *                       established "render* is imperative/call-once"
 *                       convention this package already uses for e.g.
 *                       `renderAvatar()`, just packaged as a Custom Element
 *                       per this app's own request for a uniform
 *                       declarative API alongside `<qu-view>`/`<qu-list>`)
 *                       and renders `<img>`/`<video>`/`<audio>`/a download
 *                       link depending on MIME type (or a forced `kind`
 *                       attribute). Object URLs are cached per `assetId`
 *                       (module-level `Map`, mirroring the established
 *                       QuV2 `assetCache` pattern this was ported from) and
 *                       revoked when the LAST element referencing one
 *                       disconnects, so repeated re-renders (e.g. inside a
 *                       `<qu-list>` row rebuild) never redundantly
 *                       re-download/re-decrypt, and a long-lived page never
 *                       leaks blob URLs.
 *
 * WHICH `AssetService`: never a global, same discipline `.qu` already
 * requires elsewhere in `@qu/ui` - set `.assetService` as a plain property
 * on the element itself or an ancestor (`findAssetService()` below walks up
 * exactly like `findQu()`/`findSyncFetch()` in components.js), BEFORE the
 * element connects.
 */
import { injectStyle } from './style.js';
import { createLogger } from '@qu/log';

const log = createLogger('qu-asset-components');

/** Same ancestor-walk as `findQu()`/`findSyncFetch()` (components.js), for `.assetService`. */
export function findAssetService(el) {
  let node = el;
  while (node) {
    if (node.assetService) return node.assetService;
    node = node.parentNode || node.host || null;
  }
  return null;
}

const STYLE_ID = 'qu-asset-components-style';
const STYLE = `
  .qu-asset-upload-picker { display: inline-flex; align-items: center; gap: 0.5rem; }
  .qu-asset-upload-progress { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85em; opacity: 0.85; }
  /* Without this, the [hidden] attribute this file sets via \`status.hidden = true\`
     (a plain author-stylesheet class selector beats the UA's own [hidden]
     rule at equal specificity) would never actually hide anything - the
     "Syncing..." status would stay visibly stuck at 100% forever once sync
     finishes, confirmed live. */
  .qu-asset-upload-progress[hidden] { display: none; }
  .qu-asset-upload-bar { width: 8rem; height: 0.35rem; border-radius: 999px; background: var(--qu-color-border, #8884); overflow: hidden; }
  .qu-asset-upload-fill { height: 100%; background: var(--qu-color-accent, #5b5bd6); transition: width 0.15s ease; }
  .qu-asset-upload-fill.qu-asset-upload-fill-sync { background: var(--qu-color-success, #3fb950); }
  .qu-asset-upload-error { color: var(--qu-color-danger, #e5484d); }
  .qu-asset img, .qu-asset video { max-width: 100%; border-radius: var(--qu-radius-md, 0.4rem); display: block; }
  .qu-asset audio { width: 100%; }
  .qu-asset-file-link { display: inline-flex; align-items: center; gap: 0.4rem; text-decoration: none; }
  .qu-asset-empty { opacity: 0.6; font-size: 0.85em; }
  /* LIGHTBOX - see renderImageLightbox()'s own doc comment. The thumbnail
     itself just gets a zoom-in cursor; everything else is the overlay,
     appended to document.body (never a local wrapper) so it genuinely
     covers the whole viewport no matter where in the DOM the thumbnail
     that opened it lives (a chat bubble, a forum post, ...). */
  .qu-asset-image-wrap img { cursor: zoom-in; }
  .qu-asset-lightbox-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.85); }
  .qu-asset-lightbox-scroll { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: auto; }
  .qu-asset-lightbox-img { max-width: 90vw; max-height: 90vh; cursor: zoom-in; box-shadow: 0 0.5rem 2rem rgba(0,0,0,0.5); }
  /* Zoomed: natural size, no max-width/height cap - .qu-asset-lightbox-scroll's
     own overflow:auto is what makes an image now larger than the viewport
     scrollable instead of clipped. */
  .qu-asset-lightbox-img-zoomed { max-width: none; max-height: none; cursor: zoom-out; }
  .qu-asset-lightbox-close { position: fixed; top: 1rem; right: 1.2rem; z-index: 1001; background: none; border: none; color: white; font-size: 2rem; line-height: 1; cursor: pointer; opacity: 0.85; }
  .qu-asset-lightbox-close:hover { opacity: 1; }
`;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `<qu-asset-upload space-id="gallery">` - see this file's own top doc
 * comment for the two events it fires. Optional `.readerPubs`/`.asSpaceId`
 * properties (set before a file is picked) are forwarded to
 * `AssetService.upload()`/`.verifySyncOut()` verbatim - same "structured
 * value, so a JS property rather than a string attribute" reasoning as
 * `<qu-list>`'s own `.relatedPaths`.
 */
export class QuAssetUploadElement extends HTMLElement {
  connectedCallback() {
    injectStyle(STYLE_ID, STYLE);
    this.textContent = '';

    const picker = document.createElement('span');
    picker.className = 'qu-asset-upload-picker';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.hidden = true;
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.textContent = this.getAttribute('label') ?? '📎';
    pickBtn.addEventListener('click', () => fileInput.click());
    picker.append(pickBtn, fileInput);

    const status = document.createElement('div');
    status.className = 'qu-asset-upload-progress';
    status.hidden = true;

    this.append(picker, status);

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (file) this._upload(file, status);
    });
  }

  disconnectedCallback() {
    this.textContent = '';
  }

  async _upload(file, status) {
    const assetService = findAssetService(this);
    if (!assetService) {
      log.error('qu-asset-upload: no AssetService found - set .assetService on this element or an ancestor', this);
      return;
    }
    const spaceId = this.getAttribute('space-id');
    if (!spaceId) {
      log.error('qu-asset-upload: missing required "space-id" attribute', this);
      return;
    }

    const assetId = globalThis.crypto.randomUUID();
    const readerPubs = this.readerPubs ?? [];
    const asSpaceId = this.asSpaceId ?? null;

    status.hidden = false;
    const renderPhase = (label, fraction, extraClass = '') => {
      status.textContent = '';
      const line = document.createElement('span');
      line.textContent = `${label} · ${file.name} (${fmtSize(file.size)}) · ${Math.round(fraction * 100)}%`;
      const bar = document.createElement('div');
      bar.className = 'qu-asset-upload-bar';
      const fill = document.createElement('div');
      fill.className = `qu-asset-upload-fill ${extraClass}`;
      fill.style.width = `${fraction * 100}%`;
      bar.appendChild(fill);
      status.append(line, bar);
    };
    renderPhase('Saving', 0);

    let meta;
    try {
      meta = await assetService.upload(spaceId, assetId, file, {
        readerPubs,
        asSpaceId,
        onProgress: (fraction) => renderPhase('Saving', fraction),
      });
    } catch (err) {
      status.textContent = '';
      const errEl = document.createElement('span');
      errEl.className = 'qu-asset-upload-error';
      errEl.textContent = `Upload failed: ${err.message}`;
      status.appendChild(errEl);
      log.error('qu-asset-upload: upload failed', err);
      return;
    }

    // Local write is durable - dismiss-worthy per this codebase's own
    // established convention (see AssetEngine's doc comment), the host
    // already has everything it needs via this event.
    this.dispatchEvent(new CustomEvent('qu-asset-uploaded', { detail: { assetId, meta }, bubbles: true }));

    if (!assetService.syncFetch) {
      status.hidden = true; // no sync configured at all - nothing further to show
      return;
    }

    renderPhase('Syncing', 0, 'qu-asset-upload-fill-sync');
    const syncStatus = await assetService.verifySyncOut(spaceId, assetId, {
      readerPubs,
      asSpaceId,
      onSyncProgress: (fraction) => renderPhase('Syncing', fraction, 'qu-asset-upload-fill-sync'),
    });
    if (syncStatus.synced) {
      status.hidden = true;
    } else {
      status.textContent = '';
      const errEl = document.createElement('span');
      errEl.className = 'qu-asset-upload-error';
      errEl.textContent = `Sync incomplete after retries (${syncStatus.missing.length} piece(s) unconfirmed)`;
      status.appendChild(errEl);
    }
    this.dispatchEvent(new CustomEvent('qu-asset-synced', { detail: { assetId, ...syncStatus }, bubbles: true }));
  }
}

/** @type {Map<string, {promise: Promise<{url: string, meta: object}|null>, refCount: number}>} */
const assetCache = new Map();

function cacheKey(spaceId, assetId) {
  return `${spaceId}:${assetId}`;
}

function acquireCachedAsset(assetService, spaceId, assetId) {
  const key = cacheKey(spaceId, assetId);
  let entry = assetCache.get(key);
  if (!entry) {
    const promise = assetService.download(spaceId, assetId).then((asset) => {
      if (!asset) return null;
      return { url: URL.createObjectURL(new Blob([asset.data], { type: asset.meta.mime })), meta: asset.meta };
    });
    entry = { promise, refCount: 0 };
    assetCache.set(key, entry);
  }
  entry.refCount++;
  return entry;
}

function releaseCachedAsset(spaceId, assetId) {
  const key = cacheKey(spaceId, assetId);
  const entry = assetCache.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    assetCache.delete(key);
    entry.promise.then((resolved) => { if (resolved) URL.revokeObjectURL(resolved.url); });
  }
}

/**
 * `<qu-asset space-id="gallery" asset-id="photo1" kind="auto|image|video|audio|file">` -
 * `kind="auto"` (default, or omitted) picks the widget from the resolved
 * asset's MIME type; force a specific one if a caller already knows better
 * (e.g. a voice-message convention layered on top of a generic upload).
 */
export class QuAssetElement extends HTMLElement {
  static get observedAttributes() { return ['space-id', 'asset-id', 'kind']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  // A monotonic per-element counter (same pattern `apps/profile/client.js`'s
  // `render()` uses) guards against an overlapping, now-stale `_mount()`
  // call ever touching the DOM - an `attributeChangedCallback()` firing
  // again (or a disconnect) while a previous call's `download()` is still
  // in flight must never let that older call's result land after a newer
  // one already did, or after the element left the document entirely.
  async _mount() {
    this._unmount();
    const token = (this._mountToken = (this._mountToken ?? 0) + 1);
    injectStyle(STYLE_ID, STYLE);
    this.classList.add('qu-asset'); // ADD, never REPLACE - a caller may have already set its own class (e.g. `apps/forum` marking one as "the message attachment")
    this.textContent = '';

    const assetService = findAssetService(this);
    const spaceId = this.getAttribute('space-id');
    const assetId = this.getAttribute('asset-id');
    if (!assetService || !spaceId || !assetId) {
      log.error('qu-asset: needs an AssetService (.assetService on this element or an ancestor), "space-id" and "asset-id"', this);
      return;
    }

    const entry = acquireCachedAsset(assetService, spaceId, assetId);
    const resolved = await entry.promise;
    if (token !== this._mountToken || !this.isConnected) {
      releaseCachedAsset(spaceId, assetId); // this mount lost the race (or was torn down) - don't leak the reference we just acquired
      return;
    }
    this._releaseKey = { spaceId, assetId };

    if (!resolved) {
      const empty = document.createElement('span');
      empty.className = 'qu-asset-empty';
      empty.textContent = '(unavailable)';
      this.appendChild(empty);
      return;
    }

    const kindAttr = this.getAttribute('kind') || 'auto';
    const kind = kindAttr === 'auto' ? kindFromMime(resolved.meta.mime) : kindAttr;
    this.appendChild(renderByKind(kind, resolved.url, resolved.meta));
  }

  _unmount() {
    this._mountToken = (this._mountToken ?? 0) + 1; // invalidates any in-flight _mount() from a previous call
    if (this._releaseKey) {
      releaseCachedAsset(this._releaseKey.spaceId, this._releaseKey.assetId);
      this._releaseKey = null;
    }
  }
}

function kindFromMime(mime) {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Opens a fullscreen overlay (appended to `document.body`, `position:
 * fixed; inset: 0`) showing `url` at up to 90vw/90vh, with a ✕ close
 * button, Escape-to-close, and click-outside-to-close - the same trigger/
 * overlay/outside-click-close shape `@qu/thread-ui`'s `renderEmojiPicker()`/
 * `renderContextMenu()` already establish for a LOCAL popup, just anchored
 * to the whole viewport instead of a trigger element, since a lightbox is
 * conventionally a global overlay, not something scoped to wherever its
 * thumbnail happens to sit in the DOM (a chat bubble, a forum post, ...).
 *
 * ZOOM: clicking the enlarged image itself toggles between "fit the
 * viewport" (the default open state) and "natural size, scrollable" (the
 * `-zoomed` class) - the same plain click-to-toggle idiom most lightboxes
 * use, deliberately not a drag-to-pan/pinch-to-zoom gesture layer (real,
 * valid future work, not attempted half-way here for a first pass).
 * @param {string} url @param {{name?: string}} meta
 */
function openImageLightbox(url, meta) {
  const overlay = document.createElement('div');
  overlay.className = 'qu-asset-lightbox-overlay';
  const scroll = document.createElement('div');
  scroll.className = 'qu-asset-lightbox-scroll';
  const img = document.createElement('img');
  img.className = 'qu-asset-lightbox-img';
  img.src = url;
  img.alt = meta.name ?? '';
  scroll.appendChild(img);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'qu-asset-lightbox-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close';

  function close() {
    overlay.remove();
    closeBtn.remove();
    document.removeEventListener('keydown', onKeydown);
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  // The image toggles zoom; the surrounding backdrop (this same listener,
  // since `scroll`/`overlay` fully wrap the image) closes - a click ON the
  // image is stopped from also bubbling into that same close handler.
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    img.classList.toggle('qu-asset-lightbox-img-zoomed');
  });
  overlay.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  overlay.appendChild(scroll);
  document.body.append(overlay, closeBtn);
}

function renderByKind(kind, url, meta) {
  if (kind === 'image') {
    const wrap = document.createElement('span');
    wrap.className = 'qu-asset-image-wrap';
    const img = document.createElement('img');
    img.src = url;
    img.alt = meta.name;
    img.addEventListener('click', () => openImageLightbox(url, meta));
    wrap.appendChild(img);
    return wrap;
  }
  if (kind === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    return video;
  }
  if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    return audio;
  }
  const link = document.createElement('a');
  link.className = 'qu-asset-file-link';
  link.href = url;
  link.download = meta.name;
  link.textContent = `📎 ${meta.name} (${fmtSize(meta.size)})`;
  return link;
}

if (!customElements.get('qu-asset-upload')) customElements.define('qu-asset-upload', QuAssetUploadElement);
if (!customElements.get('qu-asset')) customElements.define('qu-asset', QuAssetElement);
