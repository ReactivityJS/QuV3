import { renderEmojiPicker, mountMentionAutocomplete } from '@qu/thread-ui';

/**
 * EDITOR EXTENSIONS — the first real `EditorExtension`s a `ContentEditor`
 * (see `content-editor.js`'s own doc comment for the contract) can plug in,
 * thin adapters over `@qu/thread-ui`'s existing, already-proven composer
 * primitives - not reimplementations. Exactly the two functions
 * `apps/forum/client.js` already calls by hand for its own composer
 * (`renderEmojiPicker()`, `mountMentionAutocomplete()`); wrapping them here
 * is what lets a NEW composer opt into the same behavior with one entry in
 * an `extensions[]` array instead of repeating that hand-assembly.
 *
 * Attachment/Location/Voice live in their own files (`attachment-extension.js`/
 * `location-extension.js`/`voice-extension.js`) given their real size -
 * generalized from `apps/chat/client.js`'s own proven implementations, see
 * each file's own doc comment. A Markdown-toolbar extension now also lives
 * in its own file (`markdown-toolbar-extension.js`) - an earlier version of
 * this comment said one was blocked on "no precise caret/selection-
 * coordinate measurement utility" (`mention-autocomplete.js`'s own doc
 * comment); that gap is real but only applies to a FLOATING popup tracking
 * the caret's exact pixel position - a fixed-row toolbar (what that file
 * builds, registered via `content-editor.js`'s own toolbar slot) only ever
 * needs `textarea.selectionStart`/`selectionEnd` plus the existing
 * `insertAtCursor()` primitive, neither of which was ever missing.
 */

/**
 * A visible emoji-insert trigger, appended into `ctx.actionsEl` - a UI-slot
 * extension (see `content-editor.js`'s doc comment for that distinction).
 * @param {{trigger?: string, triggerTitle?: string}} [options]
 * @returns {{id: string, mount: (ctx: object) => void}}
 */
export function emojiExtension({ trigger = '😀', triggerTitle } = {}) {
  return {
    id: 'emoji',
    mount(ctx) {
      ctx.actionsEl.appendChild(renderEmojiPicker({ onPick: (emoji) => ctx.insertText(emoji), trigger, triggerTitle }));
    },
  };
}

/**
 * `@`-mention autocomplete - a pure input-hook extension with no visible
 * control of its own (see `content-editor.js`'s doc comment for that
 * distinction): it only ever touches `ctx.textarea` directly, never
 * `ctx.actionsEl`.
 * @param {{services: object, subscribe?: (prefix: string) => void}} deps - passed straight through to `mountMentionAutocomplete()`.
 * @returns {{id: string, mount: (ctx: object) => (() => void)}}
 */
export function mentionExtension({ services, subscribe } = {}) {
  return {
    id: 'mention',
    mount: (ctx) => mountMentionAutocomplete(ctx.textarea, { services, subscribe }),
  };
}
