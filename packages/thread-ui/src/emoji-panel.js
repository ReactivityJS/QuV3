/**
 * EMOJI PANEL — the desktop-only extended emoji grid: bigger buttons, a
 * name/glyph search filter, and pagination instead of one tall scrolling
 * grid of tiny buttons. Lives in its own module SPECIFICALLY so
 * `emoji.js`'s `renderEmojiPicker()` can reach it via a dynamic
 * `import('./emoji-panel.js')` gated behind `platform.js`'s
 * `prefersNativeEmojiKeyboard()` - a coarse-pointer (touch) session takes
 * the OS's own native emoji keyboard instead (see emoji.js's own doc
 * comment) and never even requests this module's code.
 */
import { EMOJI_SHORTCODE_LIST } from './emoji-shortcodes.js';

const STYLE_ID = 'qu-thread-ui-emoji-panel-style';

/** 8 columns x 4 rows - big enough to feel like a real picker, small enough to fit without scrolling. */
const PAGE_SIZE = 32;

const STYLE = `
  .qu-thread-ui-emoji-panel { position: absolute; z-index: 20; top: 100%; left: 0; margin-top: 0.2rem; display: flex; flex-direction: column; gap: 0.4rem; width: 21rem; max-width: calc(100vw - 1rem); padding: 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); background: var(--qu-color-surface, #ffffff); box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.2); }
  .qu-thread-ui-emoji-panel-flip-up { top: auto; bottom: 100%; margin-top: 0; margin-bottom: 0.2rem; }
  .qu-thread-ui-emoji-panel-search { font: inherit; font-size: 0.9rem; padding: 0.35rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); background: transparent; color: inherit; }
  .qu-thread-ui-emoji-panel-grid { display: grid; grid-template-columns: repeat(8, 2.4rem); gap: 0.2rem; }
  .qu-thread-ui-emoji-panel-grid button { border: none; background: transparent; cursor: pointer; font-size: 1.6rem; line-height: 2.4rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-thread-ui-emoji-panel-grid button:hover { background: var(--qu-color-border, #8884); }
  .qu-thread-ui-emoji-panel-empty { grid-column: 1 / -1; padding: 1.4rem 0; text-align: center; opacity: 0.6; font-size: 0.85rem; }
  .qu-thread-ui-emoji-panel-pager { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; font-size: 0.8rem; opacity: 0.8; }
  .qu-thread-ui-emoji-panel-pager button { border: none; background: transparent; cursor: pointer; padding: 0.2rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); color: inherit; font-size: 0.95rem; }
  .qu-thread-ui-emoji-panel-pager button:hover:not(:disabled) { background: var(--qu-color-border, #8884); }
  .qu-thread-ui-emoji-panel-pager button:disabled { opacity: 0.35; cursor: default; }
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
 * @param {string[]} options.extended - Same glyph list `renderEmojiPicker()`
 *   was given (defaults to `EMOJI_EXTENDED`) - matched against
 *   `EMOJI_SHORTCODE_LIST` for search-by-name, falling back to the glyph
 *   itself for any entry `emoji-shortcodes.js` doesn't cover.
 * @param {(emoji: string) => void} options.onPick
 * @returns {HTMLElement}
 */
export function buildEmojiPanel({ extended, onPick }) {
  ensureStyle();
  const panel = document.createElement('div');
  panel.className = 'qu-thread-ui-emoji-panel';

  const names = new Map(EMOJI_SHORTCODE_LIST.map((e) => [e.emoji, e.name]));
  const entries = extended.map((emoji) => ({ emoji, name: names.get(emoji) ?? emoji }));

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'qu-thread-ui-emoji-panel-search';
  search.placeholder = 'Search emoji…';
  search.setAttribute('aria-label', 'Search emoji');

  const grid = document.createElement('div');
  grid.className = 'qu-thread-ui-emoji-panel-grid';

  const pager = document.createElement('div');
  pager.className = 'qu-thread-ui-emoji-panel-pager';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.textContent = '‹ Prev';
  const pageLabel = document.createElement('span');
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.textContent = 'Next ›';
  pager.append(prevBtn, pageLabel, nextBtn);

  let filtered = entries;
  let page = 0;

  function render() {
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (page >= pageCount) page = pageCount - 1;
    grid.textContent = '';
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qu-thread-ui-emoji-panel-empty';
      empty.textContent = 'No matching emoji';
      grid.appendChild(empty);
    } else {
      const start = page * PAGE_SIZE;
      for (const { emoji, name } of filtered.slice(start, start + PAGE_SIZE)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = emoji;
        btn.title = name;
        btn.addEventListener('click', () => onPick(emoji));
        grid.appendChild(btn);
      }
    }
    pageLabel.textContent = `${page + 1} / ${pageCount}`;
    prevBtn.disabled = page === 0;
    nextBtn.disabled = page >= pageCount - 1;
  }

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    filtered = q ? entries.filter(({ emoji, name }) => emoji.includes(q) || name.toLowerCase().includes(q)) : entries;
    page = 0;
    render();
  });
  prevBtn.addEventListener('click', () => { page -= 1; render(); });
  nextBtn.addEventListener('click', () => { page += 1; render(); });

  render();
  panel.append(search, grid, pager);
  return panel;
}
