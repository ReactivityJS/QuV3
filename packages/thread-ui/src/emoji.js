/**
 * EMOJI — a curated Unicode set (no picker library, no custom sprite/font
 * asset) plus one small, reusable "+"-style trigger that reveals it,
 * ported from QuV2's `apps/chat/client.js` (`REACTION_CHOICES`/
 * `EXTENDED_EMOJI_SET`) - the exact same proven 8+160 lists, unchanged.
 * Plain Unicode codepoints render via whatever emoji font the host OS/
 * browser already provides - under Android that's Android's own system
 * emoji font automatically, no separate "use Android's emoji" integration
 * needed, and no divergence from what any other platform shows for the
 * same codepoint.
 *
 * ONE component, two call shapes:
 *   - `quick` non-empty: renders a row of plain quick-pick buttons plus a
 *     trailing trigger (e.g. Forum's reaction row's own "+" expand).
 *   - `quick` omitted: renders just the trigger button on its own (e.g. a
 *     composer's single 😀 "insert emoji" button).
 *
 * What the trigger DOES depends on `platform.js`'s
 * `prefersNativeEmojiKeyboard()` (a coarse-pointer/touch session - see that
 * module's own doc comment):
 *   - Touch, with an `inputEl` (a composer's own textarea): the trigger
 *     just focuses `inputEl`. The OS's own software keyboard (GBoard,
 *     iOS, ...) already puts a native emoji key right on it, complete
 *     with the OS's own "recently used" row - genuinely native, and
 *     costs this app NOTHING to get: the emoji the user picks lands in
 *     `inputEl` exactly like any other keystroke, no `onPick` involved.
 *   - Touch, with no `inputEl` (a reactions row - nothing to focus): the
 *     trigger opens a hidden, off-screen real `<input>` and focuses IT
 *     instead, so the OS keyboard (and its emoji key) still comes up even
 *     though there's no visible text field for this to react to. Every
 *     character typed into it is handed to `onPick()` and the hidden
 *     input is cleared and eventually removed on blur. This is the
 *     closest a plain web page can get to "open the native emoji picker"
 *     outside of a real text field - the web platform has no API to jump
 *     straight to an OS emoji picker or force a keyboard open on its
 *     emoji tab, so the user still takes one extra tap (the keyboard's
 *     own emoji/smiley key) to get there.
 *   - Non-touch (mouse/trackpad primary - "Desktop"): the trigger lazy-
 *     `import()`s `./emoji-panel.js` - the bigger, paginated, searchable
 *     panel - and opens THAT. Nothing in that module is even requested
 *     on a touch session, matching the two bullets above: mobile sessions
 *     defer entirely to the OS's own picker and never load this package's
 *     own panel code at all.
 */
import { flipUpIfNeeded } from './popup-position.js';
import { prefersNativeEmojiKeyboard } from './platform.js';

/** Ported verbatim from QuV2 `apps/chat/client.js`'s `REACTION_CHOICES`. */
export const EMOJI_QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅'];

/** Ported verbatim from QuV2 `apps/chat/client.js`'s `EXTENDED_EMOJI_SET`. */
export const EMOJI_EXTENDED = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
  '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🫡', '🤐',
  '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒',
  '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕',
  '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱',
  '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '👻', '👽',
  '🤖', '💩', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '👍', '👎', '👏', '🙌', '🤝',
  '🙏', '💪', '👋', '✌️', '🤞', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
  '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💯', '✅', '❌', '⭐', '🌟', '✨', '🔥', '🎉',
  '🎊', '🎈', '🎁', '🏆', '⚡', '☀️', '🌈', '☕', '🍕', '🍔', '🍎', '🍺', '🎂', '📌', '🔗', '📎',
];

const STYLE_ID = 'qu-thread-ui-emoji-style';
const STYLE = `
  .qu-thread-ui-emoji-picker { position: relative; display: inline-flex; align-items: center; gap: 0.3rem; }
  .qu-thread-ui-emoji-quick, .qu-thread-ui-emoji-trigger { border: none; background: transparent; cursor: pointer; font-size: 1em; padding: 0.1rem 0.3rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-thread-ui-emoji-quick:hover, .qu-thread-ui-emoji-trigger:hover { background: var(--qu-color-border, #8884); }
  /* Visually hidden but still focusable/typeable - unlike display:none or
     visibility:hidden (both of which make an element unfocusable, and
     some engines skip bringing up the software keyboard for it), this
     stays a real, focusable, off-screen text field so tapping the trigger
     on a touch session still raises the OS's own emoji-capable keyboard
     (see this file's own top doc comment's "no inputEl" bullet). */
  .qu-thread-ui-emoji-native-input { position: fixed; top: -1000px; left: -1000px; width: 1px; height: 1px; opacity: 0.01; border: none; padding: 0; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {object} options
 * @param {(emoji: string) => void} options.onPick
 * @param {string[]} [options.quick] - Plain quick-pick buttons before the
 *   trigger. Omit (default `[]`) for a standalone trigger button only (a
 *   composer's single emoji-insert button).
 * @param {string[]} [options.extended] - The desktop panel's full grid,
 *   shown when the trigger is clicked on a non-touch session. Defaults to
 *   `EMOJI_EXTENDED`. Unused on a touch session (see this file's own top
 *   doc comment) since the OS's own keyboard supplies the choices there.
 * @param {string} [options.trigger] - Trigger button glyph/label - `'+'`
 *   for a reaction row's expand button, an emoji like `'😀'` for a
 *   composer's insert button.
 * @param {string} [options.triggerTitle]
 * @param {HTMLTextAreaElement|HTMLInputElement} [options.inputEl] - The
 *   composer field this picker sits next to, if any. When set AND the
 *   session prefers the native emoji keyboard (see this file's own top
 *   doc comment), the trigger simply focuses `inputEl` instead of opening
 *   any picker of this component's own - omit for a picker with no
 *   associated text field (e.g. a reactions row).
 * @returns {HTMLElement}
 */
export function renderEmojiPicker({ onPick, quick = [], extended = EMOJI_EXTENDED, trigger = '+', triggerTitle = 'More emoji', inputEl = null }) {
  ensureStyle();
  const root = document.createElement('span');
  root.className = 'qu-thread-ui-emoji-picker';

  for (const emoji of quick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qu-thread-ui-emoji-quick';
    btn.textContent = emoji;
    btn.addEventListener('click', () => onPick(emoji));
    root.appendChild(btn);
  }

  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'qu-thread-ui-emoji-trigger';
  triggerBtn.textContent = trigger;
  triggerBtn.title = triggerTitle;
  root.appendChild(triggerBtn);

  let panel = null;
  let opening = false;
  function onDocClick(e) {
    if (panel && !root.contains(e.target)) closePanel();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') closePanel();
  }
  function closePanel() {
    panel?.remove();
    panel = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeydown);
  }
  async function openPanel() {
    if (panel) { closePanel(); return; }
    if (opening) return; // a second click landed while the lazy import below was still in flight
    opening = true;
    try {
      const { buildEmojiPanel } = await import('./emoji-panel.js');
      panel = buildEmojiPanel({ extended, onPick: (emoji) => { onPick(emoji); closePanel(); } });
      root.appendChild(panel);
      flipUpIfNeeded(panel, triggerBtn, 'qu-thread-ui-emoji-panel-flip-up');
      // Deferred one tick so THIS same click (the one that just called
      // openPanel()) doesn't immediately bubble into onDocClick and close
      // what it just opened.
      setTimeout(() => {
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKeydown);
      }, 0);
    } finally {
      opening = false;
    }
  }

  // See this file's own top doc comment's "no inputEl" bullet: a hidden,
  // off-screen, real <input> so a touch session's software keyboard (and
  // its own emoji key) still comes up for a picker with no text field of
  // its own to focus (a reactions row's "+").
  let nativeInput = null;
  function closeNativeInput() {
    nativeInput?.remove();
    nativeInput = null;
  }
  function openNativeReactionInput() {
    if (nativeInput) { closeNativeInput(); return; }
    nativeInput = document.createElement('input');
    nativeInput.type = 'text';
    nativeInput.autocomplete = 'off';
    nativeInput.className = 'qu-thread-ui-emoji-native-input';
    nativeInput.setAttribute('aria-label', triggerTitle);
    root.appendChild(nativeInput);
    nativeInput.addEventListener('input', () => {
      const value = nativeInput.value;
      if (value) {
        onPick(value);
        nativeInput.value = '';
      }
    });
    nativeInput.addEventListener('blur', closeNativeInput);
    nativeInput.focus();
  }

  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (prefersNativeEmojiKeyboard()) {
      if (inputEl) inputEl.focus();
      else openNativeReactionInput();
      return;
    }
    openPanel();
  });

  return root;
}
