/**
 * MARKDOWN TOOLBAR EXTENSION — Bold/Italic/Link/Inline-code/Spoiler buttons
 * for a `ContentEditor`, covering exactly the markdown subset
 * `@qu/services`' `thread-formatting.js` `formatMarkdown()` already renders
 * (**bold**, *italic*, [text](url), `code`, ||spoiler||) - no new syntax
 * invented, matching this codebase's own "honest subset" philosophy (see
 * that file's own doc comment).
 *
 * A FIXED-ROW toolbar, not a floating one that follows the caret's pixel
 * position - it registers into `ContentEditor`'s own toolbar slot via
 * `ctx.registerToolbarItem()` (see `content-editor.js`'s doc comment for why
 * that's a separate slot from `ctx.registerAction()`). This sidesteps the
 * real gap `extensions.js` used to cite for why no markdown toolbar existed
 * yet ("no precise caret/selection-coordinate measurement utility") - that
 * gap is specifically about a FLOATING popup tracking the caret's exact
 * pixel position (see `mention-autocomplete.js`'s own doc comment); a
 * fixed-position button row only ever needs `textarea.selectionStart`/
 * `selectionEnd` (already used elsewhere, e.g. `trigger-autocomplete.js`)
 * plus the existing `insertAtCursor()` primitive, which already replaces
 * exactly the current selection - nothing new to measure.
 *
 * Deliberate, honest simplifications (not full editor behavior):
 *   - Wrapping always ADDS the marker pair - it never detects "this
 *     selection is already bold" and un-wraps it. A second click on an
 *     already-bold selection produces `****already bold****`, not a toggle
 *     off. A real toggle would need parsing the surrounding text, which
 *     this "honest subset" scope deliberately skips, same as elsewhere in
 *     this codebase.
 *   - With NOTHING selected, the marker pair is inserted empty (e.g.
 *     `****`) with the caret left AFTER it (`insertAtCursor()`'s own
 *     'end' behavior), not re-positioned between the two markers - a user
 *     typing right after clicking Bold types after the closing `**`, not
 *     inside it. A minor, known rough edge, not a functional gap.
 *
 * Independent, standalone module - nothing in `content-editor.js` treats
 * this as "the" editor toolbar. A composer opts in by listing it in its own
 * `extensions[]`, exactly like `emojiExtension()`/`locationExtension()`;
 * swapping it for an alternative (or none) is a one-line change at any call
 * site. Letting an admin and/or a user CHOOSE between registered
 * alternatives at runtime is separate, later work (see docs/v4-concept.md
 * §10.2) - this module is the first thing such a mechanism would select
 * between, not that mechanism itself.
 */

function wrapSelection(ctx, before, after = before) {
  const { textarea } = ctx;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const selected = textarea.value.slice(start, end);
  ctx.insertText(`${before}${selected}${after}`);
}

function insertLink(ctx) {
  const { textarea } = ctx;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const selected = textarea.value.slice(start, end);
  const url = window.prompt('Link URL'); // eslint-disable-line no-alert -- simplest possible interaction, matches locationExtension()'s direct browser-API-call pattern
  if (!url) return; // cancelled - leave the selection untouched
  ctx.insertText(`[${selected || 'link text'}](${url})`);
}

/**
 * @returns {{id: string, mount: (ctx: object) => (() => void)}}
 */
export function markdownToolbarExtension() {
  return {
    id: 'markdown-toolbar',
    mount(ctx) {
      const items = [
        { id: 'md-bold', icon: 'B', label: 'Bold', onClick: () => wrapSelection(ctx, '**') },
        { id: 'md-italic', icon: 'I', label: 'Italic', onClick: () => wrapSelection(ctx, '*') },
        { id: 'md-link', icon: '🔗', label: 'Link', onClick: () => insertLink(ctx) },
        { id: 'md-code', icon: '</>', label: 'Code', onClick: () => wrapSelection(ctx, '`') },
        { id: 'md-spoiler', icon: '🙈', label: 'Spoiler', onClick: () => wrapSelection(ctx, '||') },
      ];
      for (const item of items) ctx.registerToolbarItem(item);
      return () => { for (const item of items) ctx.unregisterToolbarItem(item.id); };
    },
  };
}
