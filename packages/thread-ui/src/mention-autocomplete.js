/**
 * MENTION AUTOCOMPLETE — `@`-triggered actor completion, by alias OR pub,
 * from the 2nd typed character onward (e.g. `@ab` already narrows). Purely
 * a compose-time UX convenience: the WIRE format is unchanged -
 * `@qu/services`' `thread-formatting.js`'s `MENTION_RE`/`extractMentions()`
 * already only ever look for a full `@<pub>` token in a posted body, and
 * still do; this only helps a user find and insert the right one instead of
 * typing a 16-64 character pub blind. Selecting a candidate replaces the
 * just-typed `@ab...` fragment with `@<fullPub>` via `insertAtCursor()`.
 *
 * Candidate pool: `services.directory.listVisible()` (public opt-in
 * directory) + `services.contacts.listContacts()` (this identity's own
 * contacts - reachable even if unlisted), deduplicated by `actorPub`,
 * resolved to a real profile ONCE per mount via
 * `services.profile.getPublicProfile()` (mirrors `apps/forum/client.js`'s
 * own `resolveAuthor()` per-author cache) rather than per keystroke -
 * filtering on every keystroke then reuses that cached pool synchronously
 * via `matchesActorQuery()`/`formatActorLabel()` (`@qu/services`'
 * `actor-format.js`, unchanged, already used by every other actor-listing
 * app in this repo).
 *
 * Positioning is a deliberate simplification: the dropdown anchors to the
 * textarea's own bottom-left corner, not the exact pixel position of the
 * caret (a precise caret-coordinate measurement needs a hidden mirror-div
 * technique this repo has no precedent for) - functionally complete, not
 * pixel-perfect, matching this codebase's own "honest subset" scope-cut
 * philosophy (see e.g. `thread-formatting.js`'s own doc comment).
 */
import { matchesActorQuery, formatActorLabel } from '@qu/services';
import { insertAtCursor } from './cursor.js';

const TRIGGER_RE = /@([A-Za-z0-9_-]{2,})$/;
const MAX_RESULTS = 8;

const STYLE_ID = 'qu-thread-ui-mention-style';
const STYLE = `
  .qu-thread-ui-mention-list { position: absolute; z-index: 20; list-style: none; margin: 0.2rem 0 0; padding: 0.2rem; max-height: 10rem; overflow-y: auto; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); background: var(--qu-color-surface, canvas); box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.2); min-width: 12rem; }
  .qu-thread-ui-mention-item { padding: 0.3rem 0.5rem; border-radius: var(--qu-radius-sm, 0.3rem); cursor: pointer; font-size: 0.9em; }
  .qu-thread-ui-mention-item:hover, .qu-thread-ui-mention-item.qu-thread-ui-mention-active { background: var(--qu-color-border, #8884); }
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
 *   `position: absolute` to anchor sensibly - wrap the textarea in a
 *   `position: relative` container if it doesn't already have one nearby.
 * @param {{services: object, subscribe?: (prefix: string) => void}} deps
 *   `subscribe` - defense in depth, same reasoning `apps/user-list/client.js`'s
 *   own `subscribe?.('/store/directory')` call already documents: without
 *   it, a viewer who never happened to open User List this session (the
 *   only OTHER app that currently subscribes to the shared directory) may
 *   never see a candidate who only just became visible - `DirectoryService.
 *   listVisible()` is a DERIVED list with no `syncFetch` backfill-on-miss
 *   of its own (see its own doc comment: "a caller subscribe()-ing already
 *   catches this up" - it assumes SOMEONE does). This call doesn't
 *   backfill anything ALREADY-existing-but-never-locally-synced by itself
 *   (`subscribe()` only ever covers FUTURE writes, see `SyncEngine.
 *   subscribe()`'s own doc comment) - it only ensures this composer stops
 *   missing directory changes from the moment it mounts onward. A contact
 *   (private, always locally available, no subscribe needed) remains the
 *   more dependable candidate source either way.
 * @returns {() => void} stop function - removes listeners, closes any open dropdown
 */
export function mountMentionAutocomplete(textareaEl, { services, subscribe }) {
  subscribe?.('/store/directory');
  ensureStyle();
  let stopped = false;
  let pool = null; // [{actorPub, profile}] - built once, lazily
  let poolPromise = null;
  let list = null; // the open dropdown, or null
  let activeIndex = -1;
  let currentRange = null; // {start, end} of the @fragment currently being completed

  async function ensurePool() {
    if (pool) return pool;
    if (!poolPromise) {
      poolPromise = (async () => {
        // Optional-chained + defaulted, not assumed present - a host that
        // wires only SOME of directory/contacts/profile (or none, e.g. a
        // minimal test harness) degrades to "no candidates" rather than
        // throwing synchronously the moment a user types "@ab" for real.
        const [visible, contacts] = await Promise.all([
          services.directory?.listVisible().catch(() => []) ?? [],
          services.contacts?.listContacts().catch(() => []) ?? [],
        ]);
        const pubs = new Set([...visible.map((e) => e.actorPub), ...contacts.map((e) => e.actorPub)]);
        const resolved = await Promise.all([...pubs].map(async (actorPub) => {
          const contact = contacts.find((c) => c.actorPub === actorPub);
          const profile = contact?.profile ?? await services.profile?.getPublicProfile(actorPub).catch(() => null) ?? null;
          return { actorPub, profile };
        }));
        return resolved;
      })();
    }
    pool = await poolPromise;
    return pool;
  }

  function closeList() {
    list?.remove();
    list = null;
    activeIndex = -1;
    currentRange = null;
  }

  function selectCandidate(actorPub) {
    if (!currentRange) return;
    insertAtCursor(textareaEl, `@${actorPub}`, currentRange);
    closeList();
  }

  function renderList(candidates) {
    list?.remove();
    list = document.createElement('ul');
    list.className = 'qu-thread-ui-mention-list';
    activeIndex = 0;
    candidates.forEach((candidate, i) => {
      const li = document.createElement('li');
      li.className = 'qu-thread-ui-mention-item' + (i === 0 ? ' qu-thread-ui-mention-active' : '');
      li.textContent = formatActorLabel(candidate.actorPub, candidate.profile);
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep textarea focus - a plain click would blur it first
        selectCandidate(candidate.actorPub);
      });
      list.appendChild(li);
    });
    (textareaEl.parentNode ?? document.body).appendChild(list);
  }

  async function onInput() {
    const caret = textareaEl.selectionStart ?? textareaEl.value.length;
    const before = textareaEl.value.slice(0, caret);
    const match = before.match(TRIGGER_RE);
    if (!match) {
      closeList();
      return;
    }
    const query = match[1];
    currentRange = { start: match.index, end: caret };
    const candidates = await ensurePool();
    if (stopped) return;
    // The trigger fragment may have changed (or disappeared) while
    // ensurePool()'s awaits were in flight - re-check against the CURRENT
    // value rather than trusting the closure's now-possibly-stale `query`.
    const stillCaret = textareaEl.selectionStart ?? textareaEl.value.length;
    const stillBefore = textareaEl.value.slice(0, stillCaret);
    const stillMatch = stillBefore.match(TRIGGER_RE);
    if (!stillMatch || stillMatch[1] !== query || stillMatch.index !== match.index) return;

    const matches = candidates
      .filter((c) => matchesActorQuery(c.actorPub, c.profile, query))
      .slice(0, MAX_RESULTS);
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
    items.forEach((el, i) => el.classList.toggle('qu-thread-ui-mention-active', i === activeIndex));
  }

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
