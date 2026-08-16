import { injectStyle } from './style.js';

/**
 * ACTOR PICKER — a standalone (not textarea-trigger) search-and-pick input
 * for "invite this actor", extracted from `apps/calendar/client.js`'s own
 * `mountActorPicker()` (its first real caller) so a second app (ToDo lists)
 * doesn't have to re-implement the same dropdown/keyboard-nav/pub-paste-
 * fallback logic a second time. Deliberately dependency-free of
 * `@qu/services` (unlike `@qu/thread-ui`) - matching every other widget in
 * this package (see `renderFlagToggle()`'s own `flags` param, `renderAvatar()`'s
 * pre-resolved `avatarValue`), it takes already-resolved formatting/matching
 * functions rather than importing `formatActorLabel`/`matchesActorQuery`
 * itself, and a `loadPool()` the caller controls entirely - the CANDIDATE
 * POOL (who's even offered) is an app-level policy decision (Calendar offers
 * directory + contacts; a more restrictive app can offer contacts only), not
 * something this widget should hardcode.
 */
const STYLE_ID = 'qu-actor-picker-style';
const STYLE = `
  .qu-actor-picker { position: relative; }
  .qu-actor-picker-row { display: flex; gap: 0.4rem; align-items: center; }
  .qu-actor-picker-row input { flex: 1; min-width: 0; }
  .qu-actor-picker-dropdown { position: absolute; left: 0; right: 0; top: 100%; margin-top: 0.2rem; background: var(--qu-color-surface, Canvas); border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); max-height: 13rem; overflow-y: auto; z-index: 5; box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.15); }
  .qu-actor-picker-option { padding: 0.55rem 0.7rem; cursor: pointer; font-size: 0.9em; }
  .qu-actor-picker-option:hover, .qu-actor-picker-option[data-active="true"] { background: #8882; }
  .qu-actor-picker-empty { padding: 0.55rem 0.7rem; font-size: 0.85em; opacity: 0.65; }
`;

/** A query that looks like a real actor pubkey (long enough, no whitespace) even if it matched no known candidate. */
export function looksLikeActorPub(query) {
  return query.length >= 32 && !/\s/.test(query);
}

/**
 * @param {HTMLElement} container - Gets one `.qu-actor-picker` block appended.
 * @param {object} opts
 * @param {() => Promise<Array<{actorPub: string, profile: object|null}>>} opts.loadPool -
 *   Resolves the full candidate pool once (cached for the life of this
 *   mount) - e.g. `() => services.contacts.listContacts()` for a
 *   contacts-only picker, or a directory+contacts union like Calendar's own.
 * @param {(actorPub: string, profile: object|null, query: string) => boolean} opts.matchesQuery -
 *   e.g. `@qu/services`' `matchesActorQuery`.
 * @param {(actorPub: string, profile: object|null) => string} opts.formatLabel -
 *   e.g. `@qu/services`' `formatActorLabel`, wrapped with the caller's own
 *   "unknown person" fallback (`formatActorLabel` alone returns falsy when
 *   no alias is set).
 * @param {(actorPub: string, label: string) => void} opts.onPick
 * @param {Set<string>} [opts.excludePubs] - Candidates to hide (already a member, etc).
 * @param {{placeholder: string, noMatches: string, pasteAsIs: (pubPrefix: string) => string}} opts.labels
 * @param {boolean} [opts.allowPastedPub] - Offer a literal "invite ~pub…" option
 *   when nothing in the pool matches but the typed text looks like a real
 *   pubkey. Default `true` (Calendar's existing behavior); a picker scoped to
 *   a closed pool (e.g. "assign within this list's current members") should
 *   pass `false`.
 * @returns {() => void} destroy
 */
export function mountActorPicker(container, {
  loadPool, matchesQuery, formatLabel, onPick,
  excludePubs = new Set(), labels, allowPastedPub = true,
}) {
  injectStyle(STYLE_ID, STYLE);

  const wrap = document.createElement('div');
  wrap.className = 'qu-actor-picker';
  const row = document.createElement('div');
  row.className = 'qu-actor-picker-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = labels.placeholder;
  row.appendChild(input);
  wrap.appendChild(row);
  const dropdown = document.createElement('div');
  dropdown.className = 'qu-actor-picker-dropdown';
  dropdown.hidden = true;
  wrap.appendChild(dropdown);
  container.appendChild(wrap);

  let pool = null; // [{actorPub, profile}] - resolved once, lazily
  let activeIndex = -1;
  let destroyed = false;

  async function ensurePool() {
    if (pool) return pool;
    pool = await loadPool();
    return pool;
  }

  function closeDropdown() {
    dropdown.hidden = true;
    dropdown.textContent = '';
    activeIndex = -1;
  }

  function choose(actorPub, label) {
    input.value = '';
    closeDropdown();
    onPick(actorPub, label);
  }

  async function renderDropdown() {
    if (destroyed) return;
    const query = input.value.trim();
    const candidates = await ensurePool();
    const matches = candidates
      .filter((c) => !excludePubs.has(c.actorPub) && (query ? matchesQuery(c.actorPub, c.profile, query) : false))
      .slice(0, 8);

    dropdown.textContent = '';
    activeIndex = -1;
    if (!query) { closeDropdown(); return; }

    if (matches.length === 0 && !(allowPastedPub && looksLikeActorPub(query))) {
      const empty = document.createElement('div');
      empty.className = 'qu-actor-picker-empty';
      empty.textContent = labels.noMatches;
      dropdown.appendChild(empty);
      dropdown.hidden = false;
      return;
    }
    for (const c of matches) {
      const opt = document.createElement('div');
      opt.className = 'qu-actor-picker-option';
      opt.textContent = formatLabel(c.actorPub, c.profile);
      opt.addEventListener('click', () => choose(c.actorPub, formatLabel(c.actorPub, c.profile)));
      dropdown.appendChild(opt);
    }
    if (matches.length === 0 && allowPastedPub && looksLikeActorPub(query) && !excludePubs.has(query)) {
      const opt = document.createElement('div');
      opt.className = 'qu-actor-picker-option';
      opt.textContent = labels.pasteAsIs(query.slice(0, 12));
      opt.addEventListener('click', () => choose(query, `~${query.slice(0, 10)}…`));
      dropdown.appendChild(opt);
    }
    dropdown.hidden = dropdown.children.length === 0;
  }

  input.addEventListener('input', () => { renderDropdown(); });
  input.addEventListener('focus', () => { if (input.value.trim()) renderDropdown(); });
  input.addEventListener('keydown', (e) => {
    const options = [...dropdown.querySelectorAll('.qu-actor-picker-option')];
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, options.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); }
    else if (e.key === 'Escape') { closeDropdown(); return; }
    else if (e.key === 'Enter' && activeIndex >= 0) { e.preventDefault(); options[activeIndex]?.click(); return; }
    else return;
    options.forEach((el, i) => { el.dataset.active = String(i === activeIndex); });
  });
  const onDocClick = (e) => { if (!wrap.contains(e.target)) closeDropdown(); };
  document.addEventListener('click', onDocClick);

  return () => {
    destroyed = true;
    document.removeEventListener('click', onDocClick);
    wrap.remove();
  };
}
