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
 * each file's own doc comment. A Markdown-toolbar extension is still
 * deliberately NOT included - blocked on a real gap this codebase doesn't
 * have a fix for yet (no precise caret/selection-coordinate measurement
 * utility - see `mention-autocomplete.js`'s own doc comment).
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
