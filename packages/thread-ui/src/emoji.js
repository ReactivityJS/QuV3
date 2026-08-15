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
 * Either way, clicking the trigger lazy-`import()`s `./emoji-panel.js` -
 * this package's OWN grid (bigger buttons, pagination, a search filter -
 * see that module's own doc comment) - and opens it, on EVERY platform,
 * touch included. This is deliberate, not a missed "use the OS's native
 * emoji keyboard on mobile" opportunity: that was tried (an earlier
 * revision of this file focused the composer's textarea directly, and
 * opened a hidden off-screen `<input>` for triggers with no text field of
 * their own, like a reactions row's "+", so the OS software keyboard's
 * emoji key would come up) and dropped again, because it doesn't match
 * how Telegram/Signal/WhatsApp actually solve this - and for good reason:
 *   - The OS keyboard isn't guaranteed to open on its emoji tab, or to
 *     even have an easily reachable one - it varies by Android version,
 *     OEM keyboard, and installed IME.
 *   - A real text field accepts ANY character, not just emoji - the
 *     hidden-`<input>` trick had no way to reject a stray letter typed
 *     into it, so it could silently hand `onPick()` plain text instead of
 *     an emoji.
 *   - No skin tones, no search, no consistent behavior across devices.
 * Real messengers all ship their OWN in-app picker for every explicit
 * emoji button (composer AND reactions alike) for exactly these reasons,
 * and only lean on the OS keyboard's native emoji key as an incidental
 * bonus while a user is already typing in a real text field - never as
 * what an explicit UI button depends on. This component follows the same
 * pattern: one picker, used everywhere, sized for touch as much as mouse
 * (see emoji-panel.js's own doc comment).
 */
import { flipUpIfNeeded } from './popup-position.js';

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
 * @param {string[]} [options.extended] - The panel's full grid, shown when
 *   the trigger is clicked. Defaults to `EMOJI_EXTENDED`.
 * @param {string} [options.trigger] - Trigger button glyph/label - `'+'`
 *   for a reaction row's expand button, an emoji like `'😀'` for a
 *   composer's insert button.
 * @param {string} [options.triggerTitle]
 * @returns {HTMLElement}
 */
export function renderEmojiPicker({ onPick, quick = [], extended = EMOJI_EXTENDED, trigger = '+', triggerTitle = 'More emoji' }) {
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

  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPanel();
  });

  return root;
}
