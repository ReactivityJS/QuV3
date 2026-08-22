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
 * Attachments/Voice/Location/Markdown-toolbar extensions are deliberately
 * NOT included yet - see docs/v4-concept.md's ContentEditor-layer plan for
 * why each is a separate, later decision, not bundled into this file.
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
