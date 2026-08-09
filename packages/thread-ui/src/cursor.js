/**
 * CURSOR — caret-aware text insertion into a `<textarea>`/`<input>`, the one
 * primitive this whole package is built around. Confirmed missing anywhere
 * in this repo before this package (grepped every app's own `client.js` and
 * all of `packages/ui/src` for `selectionStart`/`setRangeText`/anything similar -
 * every existing textarea usage only ever reads/replaces `.value` wholesale,
 * e.g. `apps/forum/client.js`'s edit-row `textarea.value = ...`). Both
 * `renderEmojiPicker()`'s `onPick` and `mountMentionAutocomplete()`'s own
 * completion-insert are built on this.
 */

/**
 * Inserts `text` at the given range (defaulting to the CURRENT selection -
 * a collapsed selection is just the caret position), moves the caret to the
 * end of the inserted text, and fires a real `input` event afterward so any
 * listener already attached to the field (e.g. `mountMentionAutocomplete()`'s
 * own detector) sees the change exactly as if the user had typed it.
 * @param {HTMLTextAreaElement|HTMLInputElement} el
 * @param {string} text
 * @param {{start?: number, end?: number}} [range] - Explicit replace range
 *   (e.g. "replace the `@ab` fragment just typed", not just "insert at the
 *   caret") - omit both to use the field's current selection.
 */
export function insertAtCursor(el, text, { start, end } = {}) {
  const from = start ?? el.selectionStart ?? el.value.length;
  const to = end ?? el.selectionEnd ?? from;
  el.focus();
  if (typeof el.setRangeText === 'function') {
    el.setRangeText(text, from, to, 'end');
  } else {
    // No realistic target lacks setRangeText (standard since long before
    // any browser/jsdom version this repo supports) - kept only so a
    // future exotic host environment fails soft instead of throwing.
    el.value = el.value.slice(0, from) + text + el.value.slice(to);
    const caret = from + text.length;
    el.selectionStart = el.selectionEnd = caret;
  }
  // `CustomEvent`, not the plain `Event` constructor - `installDom()`
  // (`@qu/ui/testing`) only puts jsdom's own `CustomEvent` on `globalThis`,
  // not `Event` (Node has its own built-in `Event` since v15, a DIFFERENT
  // class jsdom's `dispatchEvent()` rejects) - same reasoning
  // `packages/ui/src/components.js`'s own event dispatches already follow.
  el.dispatchEvent(new CustomEvent('input', { bubbles: true }));
}
