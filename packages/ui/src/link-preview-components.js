/**
 * QU-LINK-PREVIEW-COMPONENTS — `<qu-link-preview url="https://...">`, a
 * card (site name, title, description, preview image) for a URL found in a
 * message body. Fetched from THIS ORIGIN's own relay (`GET /link-preview?
 * url=...`, see `@qu/relay`'s `link-preview.js`/`http-router.js`) rather
 * than the target site directly - a client fetching arbitrary third-party
 * URLs itself would leak the viewer's IP to every site anyone ever pasted a
 * link to, and would hit CORS on most sites that don't send permissive
 * headers. The relay is same-origin (apps are served BY it - see
 * `apps/profile/client.js`'s own `fetch('/push/vapid-public-key')` for the
 * identical "no base-URL config, just a relative fetch" precedent), does
 * the SSRF-guarded outbound fetch, and caches the result server-side too
 * (see `link-preview.js`'s own doc comment) - this element's OWN
 * module-level cache below is a second, client-side-only layer on top of
 * that, so re-rendering the SAME url within one page session (e.g. a
 * message list's incremental append re-touching earlier rows, or the same
 * link posted twice) never re-issues the request at all.
 *
 * Renders NOTHING (not an empty card) when there's nothing preview-worthy
 * for `url` - a dead link, the feature turned off relay-side, or a page
 * with no title/description/image - same "no widget beats an empty one"
 * rule `<qu-asset>`'s own `_mount()` follows for a truly-unavailable asset.
 */
import { injectStyle } from './style.js';

const STYLE_ID = 'qu-link-preview-components-style';
const STYLE = `
  qu-link-preview[hidden] { display: none; }
  .qu-link-preview { display: flex; gap: 0; align-items: stretch; max-width: 26rem; margin-top: 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); overflow: hidden; text-decoration: none; color: inherit; background: var(--qu-color-surface, #ffffff); }
  .qu-link-preview:hover { background: var(--qu-color-border, #8882); }
  .qu-link-preview-image { width: 6rem; flex-shrink: 0; object-fit: cover; background: var(--qu-color-border, #8884); }
  .qu-link-preview-body { min-width: 0; padding: 0.4rem 0.6rem; display: flex; flex-direction: column; justify-content: center; gap: 0.15rem; }
  .qu-link-preview-site { font-size: 0.75em; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.02em; }
  .qu-link-preview-title { font-weight: 600; font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .qu-link-preview-description { font-size: 0.82em; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
`;

const MAX_CACHE_ENTRIES = 200;
/** @type {Map<string, Promise<{url: string, title: string|null, description: string|null, image: string|null, siteName: string|null}|null>>} Insertion-ordered - the oldest entry is `previewCache.keys().next().value`, used for the simple size-cap eviction below. */
const previewCache = new Map();

/** Test-only: clears the module-level cache so tests don't leak state into each other. */
export function _resetLinkPreviewCacheForTests() {
  previewCache.clear();
}

function fetchPreview(url) {
  let entry = previewCache.get(url);
  if (entry) return entry;
  entry = fetch(`/link-preview?url=${encodeURIComponent(url)}`)
    .then((res) => (res.ok ? res.json() : null))
    // Mirrors `link-preview.js`'s own "nothing title/description/image at
    // all -> null" rule - the relay already applies this server-side, but a
    // future relay version (or a differently-configured one) isn't
    // guaranteed to, so this element enforces its OWN "never render an
    // empty card" contract rather than trusting the response shape blindly.
    .then((data) => (data && (data.title || data.description || data.image) ? data : null))
    .catch(() => null);
  if (!previewCache.has(url) && previewCache.size >= MAX_CACHE_ENTRIES) previewCache.delete(previewCache.keys().next().value);
  previewCache.set(url, entry);
  return entry;
}

export class QuLinkPreviewElement extends HTMLElement {
  static get observedAttributes() { return ['url']; }

  connectedCallback() { this._mount(); }

  // No download-then-revoke lifecycle to unwind here (unlike <qu-asset>'s
  // object-URL cache) - `image` is just a plain remote URL the browser
  // fetches directly once set as an <img src>, nothing this element itself
  // holds onto. Only the mount-token needs bumping, to invalidate any
  // still-in-flight fetchPreview() from landing after this element's
  // already gone.
  disconnectedCallback() { this._mountToken = (this._mountToken ?? 0) + 1; }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  async _mount() {
    // Same monotonic-token guard `<qu-asset>`'s own `_mount()` uses - an
    // attribute change (or disconnect) while a previous call's fetch is
    // still in flight must never let that older call's result land after a
    // newer one already did, or after the element left the document.
    const token = (this._mountToken = (this._mountToken ?? 0) + 1);
    injectStyle(STYLE_ID, STYLE);
    this.textContent = '';
    this.hidden = true;

    const url = this.getAttribute('url');
    if (!url) return;

    const data = await fetchPreview(url);
    if (token !== this._mountToken || !this.isConnected) return; // stale - see this method's own doc comment
    if (!data) return; // nothing preview-worthy - stays hidden/empty, see this file's own top doc comment

    this.hidden = false;
    const card = document.createElement('a');
    card.className = 'qu-link-preview';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    if (data.image) {
      const img = document.createElement('img');
      img.className = 'qu-link-preview-image';
      img.src = data.image;
      img.alt = '';
      img.loading = 'lazy';
      card.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'qu-link-preview-body';
    if (data.siteName) {
      const site = document.createElement('span');
      site.className = 'qu-link-preview-site';
      site.textContent = data.siteName;
      body.appendChild(site);
    }
    if (data.title) {
      const title = document.createElement('span');
      title.className = 'qu-link-preview-title';
      title.textContent = data.title;
      body.appendChild(title);
    }
    if (data.description) {
      const description = document.createElement('span');
      description.className = 'qu-link-preview-description';
      description.textContent = data.description;
      body.appendChild(description);
    }
    card.appendChild(body);
    this.appendChild(card);
  }
}

if (!customElements.get('qu-link-preview')) customElements.define('qu-link-preview', QuLinkPreviewElement);
