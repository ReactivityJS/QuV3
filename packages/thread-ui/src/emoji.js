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
 * Either way, clicking the trigger opens a small panel of `extended`
 * choices anchored to the trigger itself (not a single shared global
 * popup singleton like QuV2's chat) - matching `apps/forum/client.js`'s
 * own documented "no popup-menu" line by making the panel structurally
 * belong to its own trigger button instead of being a floating overlay.
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
  /* A genuinely OPAQUE background (--qu-color-surface, see @qu/ui's theme.js
     own doc comment on why this token exists at all) - a floating panel
     sitting on top of arbitrary content behind it needs real opacity, not
     an alpha-blended token or the canvas system-color keyword this used
     to fall back to (unsupported on some engines, silently dropping the
     WHOLE declaration and leaving the panel blended into whatever's behind
     it - confirmed real, reported as "too transparent"). The -flip-up class
     is added by flipUpIfNeeded() (see @qu/thread-ui's popup-position.js)
     when there isn't room below the trigger - same panel, anchored from
     the bottom instead of the top. */
  .qu-thread-ui-emoji-panel { position: absolute; z-index: 20; top: 100%; left: 0; margin-top: 0.2rem; display: grid; grid-template-columns: repeat(10, 1.6rem); gap: 0.1rem; max-height: 12rem; overflow-y: auto; padding: 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); background: var(--qu-color-surface, #ffffff); box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.2); }
  .qu-thread-ui-emoji-panel-flip-up { top: auto; bottom: 100%; margin-top: 0; margin-bottom: 0.2rem; }
  .qu-thread-ui-emoji-panel button { border: none; background: transparent; cursor: pointer; font-size: 1.1em; line-height: 1.6rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-thread-ui-emoji-panel button:hover { background: var(--qu-color-border, #8884); }
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
  function openPanel() {
    if (panel) { closePanel(); return; }
    panel = document.createElement('div');
    panel.className = 'qu-thread-ui-emoji-panel';
    for (const emoji of extended) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', () => { onPick(emoji); closePanel(); });
      panel.appendChild(btn);
    }
    root.appendChild(panel);
    flipUpIfNeeded(panel, triggerBtn, 'qu-thread-ui-emoji-panel-flip-up');
    // Deferred one tick so THIS same click (the one that just called
    // openPanel()) doesn't immediately bubble into onDocClick and close
    // what it just opened.
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKeydown);
    }, 0);
  }
  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPanel();
  });

  return root;
}
