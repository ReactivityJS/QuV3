/**
 * RICHTEXT EDITOR — the WYSIWYG counterpart to `mountContentEditor()`'s
 * plain/markdown textarea, added so a `ContentEditor` consumer (`apps/cms`,
 * the first real caller) can offer "richtext" as one of its admin-allowed
 * `editor` choices (docs/v4-concept.md §10.2 records that richtext wasn't
 * needed yet at the time that section was written - this is the app that
 * needed it).
 *
 * Deliberately NOT built on `mountContentEditor()` - that primitive's whole
 * shape (a `<textarea>`, the leading/toolbar/submit slot machinery, extension
 * contracts) is designed around an interactive posting composer (Chat/Forum:
 * type, hit Send, the editor clears itself). A CMS page edit is a save-button
 * FORM instead - one editor surface, filled once from existing content, read
 * back once on Save - so this file is intentionally smaller: a
 * `contenteditable` surface + a small fixed toolbar, `getHtml()`/`setHtml()`
 * instead of `onSubmit()`/`clearContributions()`.
 *
 * `document.execCommand()` is deprecated but still functional in every
 * evergreen browser (including the Chromium this repo already tests
 * against) - used here deliberately rather than hand-rolling Range-based
 * formatting commands or adding a rich-text-editor dependency (none exists
 * anywhere in this repo today). An honest, minimal-scope choice, same spirit
 * as `thread-formatting.js`'s own "honest subset, not a full parser" framing
 * for markdown.
 *
 * SECURITY: `sanitizeRichTextHtml()` is the real safety boundary, and is
 * applied on every `getHtml()` (what a caller stores) AND every `setHtml()`
 * (what a caller loads back in) - never assume content handed to `setHtml()`
 * is already safe, since it may have been written by a peer/relay outside
 * this editor's own control. A page's stored HTML is served to arbitrary
 * readers, so re-sanitizing on render (not just once at save time) is the
 * actual contract - `apps/cms/client.js` calls this same function again at
 * render time for exactly that reason, never trusting "it was sanitized when
 * it was saved" alone.
 */

const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'CODE', 'PRE']);
// Dropped ENTIRELY, including their text content - unlike an unrecognized-but-
// benign tag (e.g. a stray `<div>`/`<span>`/`<font>`), which is unwrapped
// (its children kept, see sanitizeNode() below): a <script>'s "text" is code,
// not prose, and printing it verbatim would be confusing at best; an
// <iframe>/<object>/<embed> is itself a live, potentially-dangerous surface
// regardless of what's "inside" it as text.
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH', 'TEMPLATE']);
const SAFE_HREF_RE = /^https?:\/\//i;

/**
 * @param {Node} node - A node from the SOURCE (untrusted) parsed document.
 * @param {Node} out - The DESTINATION node (in the current document) new,
 *   sanitized nodes are appended to.
 */
function sanitizeNode(node, out) {
  if (node.nodeType === 3) {
    out.appendChild(out.ownerDocument.createTextNode(node.textContent));
    return;
  }
  if (node.nodeType !== 1) return; // comments, etc. - dropped silently, nothing meaningful lost
  const tag = node.tagName;
  if (DROP_TAGS.has(tag)) return; // dropped entirely - see class doc comment
  if (!ALLOWED_TAGS.has(tag)) {
    // Not on the allow-list, but not actively dangerous either (a stray
    // <div>/<span>/<font>/...) - unwrap: keep its children's content, drop
    // the element itself and every one of ITS attributes.
    for (const child of node.childNodes) sanitizeNode(child, out);
    return;
  }
  const el = out.ownerDocument.createElement(tag.toLowerCase());
  if (tag === 'A') {
    const href = node.getAttribute('href') || '';
    // http(s) only - a javascript:/data: URL here would be a stored-XSS
    // vector once rendered, same reasoning thread-formatting.js's own
    // formatMarkdown() already documents for its own link handling.
    if (SAFE_HREF_RE.test(href)) {
      el.setAttribute('href', href);
      el.setAttribute('rel', 'noopener noreferrer');
      el.setAttribute('target', '_blank');
    }
  }
  // No other attribute survives on ANY allowed tag - no `style`, no `class`,
  // no `on*` handler, no `src`. Deliberately conservative: this editor never
  // produces attributes beyond `href` on `<a>` itself, so there is nothing
  // legitimate being lost here, only an attack surface being closed.
  for (const child of node.childNodes) sanitizeNode(child, el);
  out.appendChild(el);
}

/**
 * @param {string} html - Untrusted HTML (from this editor's own surface, or
 *   from stored content that may have been written by any peer/relay).
 * @returns {string} HTML containing only the allow-listed tags/attributes.
 */
export function sanitizeRichTextHtml(html) {
  const doc = new window.DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const out = document.createElement('div');
  for (const child of [...doc.body.childNodes]) sanitizeNode(child, out);
  return out.innerHTML;
}

const STYLE_ID = 'qu-content-ui-richtext-style';
const STYLE = `
  .qu-richtext-editor { display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-richtext-toolbar { display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .qu-richtext-toolbar button { font: inherit; min-width: 1.8rem; padding: 0.2rem 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); background: none; cursor: pointer; }
  .qu-richtext-surface { min-height: 8rem; padding: 0.5rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); overflow-y: auto; }
  .qu-richtext-surface:empty::before { content: attr(data-placeholder); opacity: 0.55; }
  .qu-richtext-surface p { margin: 0 0 0.6em; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/** The fixed toolbar - see class doc comment for why `document.execCommand()`, deliberately. */
const TOOLBAR_ITEMS = [
  { id: 'bold', icon: 'B', label: 'Bold', command: 'bold' },
  { id: 'italic', icon: 'I', label: 'Italic', command: 'italic' },
  { id: 'underline', icon: 'U', label: 'Underline', command: 'underline' },
  { id: 'h2', icon: 'H2', label: 'Heading 2', command: 'formatBlock', value: 'h2' },
  { id: 'h3', icon: 'H3', label: 'Heading 3', command: 'formatBlock', value: 'h3' },
  { id: 'ul', icon: '•', label: 'Bulleted list', command: 'insertUnorderedList' },
  { id: 'ol', icon: '1.', label: 'Numbered list', command: 'insertOrderedList' },
  { id: 'link', icon: '🔗', label: 'Link', link: true },
];

/**
 * @param {HTMLElement} container - Appended into; left otherwise untouched.
 * @param {{initialHtml?: string, placeholder?: string}} [options]
 * @returns {{getHtml: () => string, setHtml: (html: string) => void, focus: () => void, stop: () => void}}
 */
export function mountRichTextEditor(container, { initialHtml = '', placeholder = '' } = {}) {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'qu-richtext-editor';

  const toolbar = document.createElement('div');
  toolbar.className = 'qu-richtext-toolbar';

  const surface = document.createElement('div');
  surface.className = 'qu-richtext-surface';
  surface.contentEditable = 'true';
  surface.setAttribute('role', 'textbox');
  surface.setAttribute('aria-multiline', 'true');
  if (placeholder) {
    surface.dataset.placeholder = placeholder;
    surface.setAttribute('aria-label', placeholder);
  }
  surface.innerHTML = sanitizeRichTextHtml(initialHtml);

  for (const item of TOOLBAR_ITEMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.icon;
    btn.title = item.label;
    btn.setAttribute('aria-label', item.label);
    btn.addEventListener('click', () => {
      surface.focus();
      // Guarded, not assumed: `execCommand` is deprecated and genuinely
      // absent in some environments (e.g. jsdom, this file's own test env) -
      // a real browser has it, but a caller here should never crash a click
      // handler over it either way.
      if (typeof document.execCommand !== 'function') return;
      if (item.link) {
        const url = window.prompt('Link URL'); // eslint-disable-line no-alert -- same direct-browser-API pattern markdownToolbarExtension()'s insertLink() already uses
        if (url && SAFE_HREF_RE.test(url)) document.execCommand('createLink', false, url);
        return;
      }
      document.execCommand(item.command, false, item.value ?? null);
    });
    toolbar.appendChild(btn);
  }

  root.append(toolbar, surface);
  container.appendChild(root);

  return {
    getHtml: () => sanitizeRichTextHtml(surface.innerHTML),
    setHtml: (html) => { surface.innerHTML = sanitizeRichTextHtml(html); },
    focus: () => surface.focus(),
    stop: () => { root.remove(); },
  };
}
