/**
 * COMPOSER AUTOGROW — makes a composer `<textarea>` start at ONE visual
 * line and grow with typed content up to `maxRows`, then scroll internally
 * instead of growing further. Both `apps/chat/client.js` and
 * `apps/forum/client.js` create their composer `<textarea>` with no `rows`
 * attribute set, which leaves the browser's own UA default (`rows="2"`) in
 * effect until SOMETHING sets an explicit height - confirmed live as the
 * composer visibly opening two lines tall even when empty, on both apps,
 * worse on mobile where that second line is pure wasted vertical space
 * above the keyboard. Ported into `@qu/thread-ui` (rather than duplicated
 * in each app) for the same reason `insertAtCursor()`/`renderEmojiPicker()`
 * already live here: one composer textarea behavior, shared by every
 * Thread-backed composer.
 *
 * `COMPOSER_MIN_ROWS`/`COMPOSER_MAX_ROWS` are exported, not hardcoded
 * inline, so a future per-app or admin-configurable override stays a one-
 * line change at the call site (`mountComposerAutogrow(el, {minRows,
 * maxRows})`) rather than a hunt through each app's own composer code.
 */

/** Visual height when the composer is empty/short - one real line, not two. */
export const COMPOSER_MIN_ROWS = 1;
/** Height it grows to before switching to an internal scrollbar instead of growing further. */
export const COMPOSER_MAX_ROWS = 3;

function lineHeightPx(el) {
  const cs = window.getComputedStyle(el);
  const parsed = parseFloat(cs.lineHeight);
  // `line-height: normal` (unset) computes to the string 'normal', not a
  // px value - browsers render that as roughly 1.2x the font size, the
  // same fallback ratio used everywhere else this repo estimates it.
  return Number.isFinite(parsed) ? parsed : parseFloat(cs.fontSize) * 1.2;
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {{minRows?: number, maxRows?: number}} [options]
 * @returns {() => void} Stop function - removes the input listener.
 */
export function mountComposerAutogrow(textarea, { minRows = COMPOSER_MIN_ROWS, maxRows = COMPOSER_MAX_ROWS } = {}) {
  textarea.rows = minRows;

  function resize() {
    const lh = lineHeightPx(textarea);
    const minHeight = lh * minRows;
    const maxHeight = lh * maxRows;
    // Collapse first so a DELETED line's height is picked up too - scrollHeight
    // only ever grows to fit content, it never shrinks back on its own.
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }

  resize();
  textarea.addEventListener('input', resize);
  return () => textarea.removeEventListener('input', resize);
}
