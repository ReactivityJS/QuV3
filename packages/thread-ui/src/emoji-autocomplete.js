/**
 * EMOJI AUTOCOMPLETE — `:`-triggered emoji completion by shortcode name
 * (e.g. `:fire` -> 🔥), from the 2nd typed character onward, same
 * threshold as `mention-autocomplete.js`. A thin config over
 * `trigger-autocomplete.js`'s generic engine, exactly like that file - the
 * only real content here is the trigger pattern, the (static, in-memory,
 * no async load needed) candidate list, and what gets inserted (the glyph
 * itself, no colons - typing `:fire` then selecting leaves `🔥`, not
 * `:fire:`, matching how this repo's messages already render plain Unicode
 * emoji with no server-side `:shortcode:` -> glyph substitution pass).
 */
import { EMOJI_SHORTCODE_LIST } from './emoji-shortcodes.js';
import { mountTriggerAutocomplete } from './trigger-autocomplete.js';

const TRIGGER_RE = /:([a-z0-9_+-]{2,})$/i;

/**
 * @param {HTMLTextAreaElement} textareaEl - Same positioning requirement as
 *   `mountMentionAutocomplete()` - see its own doc comment.
 * @returns {() => void} stop function
 */
export function mountEmojiAutocomplete(textareaEl) {
  return mountTriggerAutocomplete(textareaEl, {
    triggerRe: TRIGGER_RE,
    filter: (_pool, query) => {
      const q = query.toLowerCase();
      return EMOJI_SHORTCODE_LIST.filter((c) => c.name.includes(q));
    },
    renderLabel: (candidate) => `${candidate.emoji} :${candidate.name}:`,
    insertText: (candidate) => candidate.emoji,
    itemClass: 'qu-thread-ui-emoji-ac-item',
    listClass: 'qu-thread-ui-emoji-ac-list',
  });
}
