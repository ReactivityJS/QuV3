/**
 * TRIGGER AUTOCOMPLETE — the generic engine `mention-autocomplete.js` and
 * `emoji-autocomplete.js` are both thin configs over: caret-aware trigger
 * detection, a lazily-built + cached candidate pool, synchronous per-
 * keystroke filtering, a keyboard-navigable dropdown, and caret-safe
 * insertion via `insertAtCursor()`. Pulled out once two real, genuinely
 * different consumers existed (`@`-mention-by-actor and `:`-emoji-by-
 * shortcode) - the only things that differ between them are the trigger
 * character/pattern, where candidates come from, and what gets inserted;
 * everything else (open/close/nav/positioning/the re-entrant-insert guard)
 * was byte-for-byte duplicate logic worth sharing exactly once, not a
 * speculative "maybe someone else needs this" abstraction.
 *
 * RE-ENTRANT INSERT GUARD: selecting a candidate's `insertText()` result
 * may itself still match `triggerRe` (verbatim case: a mention's own
 * `@<pub>` - a pub is exactly the base64url alphabet the trigger regex
 * matches). `insertAtCursor()` always fires a synthetic, SYNCHRONOUS
 * `input` event so other listeners see the change as if typed - without a
 * guard, that re-enters `onInput()` before `closeList()` ever runs, which
 * re-opens the dropdown one microtask later. `suppressInput` closes this
 * for every consumer at the source rather than each one reinventing it.
 */
import { insertAtCursor } from './cursor.js';

const STYLE_ID = 'qu-thread-ui-autocomplete-style';
const STYLE = `
  .qu-thread-ui-autocomplete-list { position: absolute; z-index: 20; list-style: none; margin: 0.2rem 0 0; padding: 0.2rem; max-height: 10rem; overflow-y: auto; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); background: var(--qu-color-surface, canvas); box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.2); min-width: 12rem; }
  .qu-thread-ui-autocomplete-item { padding: 0.3rem 0.5rem; border-radius: var(--qu-radius-sm, 0.3rem); cursor: pointer; font-size: 0.9em; }
  .qu-thread-ui-autocomplete-item:hover, .qu-thread-ui-autocomplete-active { background: var(--qu-color-border, #8884); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {HTMLTextAreaElement} textareaEl - Must have a positioned (or
 *   default static-but-relatively-wrapped) ancestor for the dropdown's
 *   `position: absolute` to anchor sensibly.
 * @param {object} options
 * @param {RegExp} options.triggerRe - Tested against the text BEFORE the
 *   caret on every `input`; must end in `$` and capture the query in
 *   group 1 (e.g. `/@([A-Za-z0-9_-]{2,})$/`).
 * @param {() => Promise<any>} [options.loadPool] - Builds the candidate
 *   pool ONCE per mount, lazily (not called until the trigger first
 *   fires), and caches the result - mirrors `matchesActorQuery()`'s own
 *   "resolve once, filter per keystroke" split. Omit if `filter` needs no
 *   pool (e.g. a static, already-in-memory list - pass it as a closure
 *   over `filter` instead).
 * @param {(pool: any, query: string) => any[]} options.filter - Synchronous;
 *   returns the (unsliced) matches for `query` against `pool` (the
 *   resolved value of `loadPool()`, or `undefined` if `loadPool` was
 *   omitted).
 * @param {(candidate: any) => string} options.renderLabel - Dropdown item text.
 * @param {(candidate: any) => string} options.insertText - Exact text that
 *   replaces the matched trigger fragment on selection.
 * @param {number} [options.maxResults=8]
 * @param {string} [options.itemClass] - Extra class appended to each `<li>`
 *   (on top of the shared `.qu-thread-ui-autocomplete-item`) - lets a
 *   consumer keep its own pre-existing selector (e.g. mention's own
 *   `.qu-thread-ui-mention-item`, already asserted on by other tests/apps)
 *   working unchanged after this extraction.
 * @param {string} [options.listClass] - Same, for the `<ul>`.
 * @param {(prefix: string) => void} [options.subscribe]
 * @returns {() => void} stop function - removes listeners, closes any open dropdown
 */
export function mountTriggerAutocomplete(textareaEl, {
  triggerRe,
  loadPool,
  filter,
  renderLabel,
  insertText,
  maxResults = 8,
  itemClass = '',
  listClass = '',
  subscribe,
} = {}) {
  ensureStyle();
  let stopped = false;
  let pool = null;
  let poolPromise = null;
  let list = null; // the open dropdown, or null
  let activeIndex = -1;
  let currentRange = null; // {start, end} of the trigger fragment currently being completed
  let suppressInput = false; // true only while a synthetic 'input' fired by selectCandidate()'s own insertAtCursor() is in flight

  async function ensurePool() {
    if (!loadPool) return undefined;
    if (pool) return pool;
    if (!poolPromise) poolPromise = loadPool();
    pool = await poolPromise;
    return pool;
  }

  function closeList() {
    list?.remove();
    list = null;
    activeIndex = -1;
    currentRange = null;
  }

  function selectCandidate(candidate) {
    if (!currentRange) return;
    suppressInput = true;
    insertAtCursor(textareaEl, insertText(candidate), currentRange);
    suppressInput = false;
    closeList();
  }

  function renderList(candidates) {
    list?.remove();
    list = document.createElement('ul');
    list.className = `qu-thread-ui-autocomplete-list ${listClass}`.trim();
    activeIndex = 0;
    candidates.forEach((candidate, i) => {
      const li = document.createElement('li');
      li.className = `qu-thread-ui-autocomplete-item ${itemClass}${i === 0 ? ' qu-thread-ui-autocomplete-active' : ''}`.trim();
      li.textContent = renderLabel(candidate);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep textarea focus - a plain click would blur it first
        selectCandidate(candidate);
      });
      list.appendChild(li);
    });
    (textareaEl.parentNode ?? document.body).appendChild(list);
  }

  async function onInput() {
    if (suppressInput) return; // re-entrant call from selectCandidate()'s own insertAtCursor() - see this module's doc comment
    const caret = textareaEl.selectionStart ?? textareaEl.value.length;
    const before = textareaEl.value.slice(0, caret);
    const match = before.match(triggerRe);
    if (!match) {
      closeList();
      return;
    }
    const query = match[1];
    currentRange = { start: match.index, end: caret };
    const resolvedPool = await ensurePool();
    if (stopped) return;
    // The trigger fragment may have changed (or disappeared) while
    // ensurePool()'s awaits were in flight - re-check against the CURRENT
    // value rather than trusting the closure's now-possibly-stale `query`.
    const stillCaret = textareaEl.selectionStart ?? textareaEl.value.length;
    const stillBefore = textareaEl.value.slice(0, stillCaret);
    const stillMatch = stillBefore.match(triggerRe);
    if (!stillMatch || stillMatch[1] !== query || stillMatch.index !== match.index) return;

    const matches = filter(resolvedPool, query).slice(0, maxResults);
    if (matches.length === 0) {
      closeList();
      return;
    }
    renderList(matches);
  }

  function onKeydown(e) {
    if (!list) return;
    const items = [...list.children];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      // CustomEvent, not Event - see cursor.js's own doc comment on why.
      items[activeIndex]?.dispatchEvent(new CustomEvent('mousedown', { bubbles: true, cancelable: true }));
      return;
    } else if (e.key === 'Escape') {
      closeList();
      return;
    } else {
      return;
    }
    items.forEach((el, i) => el.classList.toggle('qu-thread-ui-autocomplete-active', i === activeIndex));
  }

  subscribe?.();
  textareaEl.addEventListener('input', onInput);
  textareaEl.addEventListener('keydown', onKeydown);
  textareaEl.addEventListener('blur', () => setTimeout(closeList, 150)); // deferred so a mousedown-select above still lands first

  return () => {
    stopped = true;
    textareaEl.removeEventListener('input', onInput);
    textareaEl.removeEventListener('keydown', onKeydown);
    closeList();
  };
}
