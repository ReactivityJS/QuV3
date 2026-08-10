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
 * Now a thin config over `trigger-autocomplete.js`'s generic engine (open/
 * close/nav/positioning/the re-entrant-insert guard) - this file's own job
 * is only: WHERE candidates come from, and what gets inserted. See
 * `emoji-autocomplete.js` for the engine's other real consumer.
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
import { mountTriggerAutocomplete } from './trigger-autocomplete.js';

const TRIGGER_RE = /@([A-Za-z0-9_-]{2,})$/;

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
  async function loadPool() {
    // Optional-chained + defaulted, not assumed present - a host that
    // wires only SOME of directory/contacts/profile (or none, e.g. a
    // minimal test harness) degrades to "no candidates" rather than
    // throwing synchronously the moment a user types "@ab" for real.
    const [visible, contacts] = await Promise.all([
      services.directory?.listVisible().catch(() => []) ?? [],
      services.contacts?.listContacts().catch(() => []) ?? [],
    ]);
    const pubs = new Set([...visible.map((e) => e.actorPub), ...contacts.map((e) => e.actorPub)]);
    return Promise.all([...pubs].map(async (actorPub) => {
      const contact = contacts.find((c) => c.actorPub === actorPub);
      const profile = contact?.profile ?? await services.profile?.getPublicProfile(actorPub).catch(() => null) ?? null;
      return { actorPub, profile };
    }));
  }

  return mountTriggerAutocomplete(textareaEl, {
    triggerRe: TRIGGER_RE,
    loadPool,
    filter: (pool, query) => pool.filter((c) => matchesActorQuery(c.actorPub, c.profile, query)),
    renderLabel: (candidate) => formatActorLabel(candidate.actorPub, candidate.profile),
    insertText: (candidate) => `@${candidate.actorPub}`,
    itemClass: 'qu-thread-ui-mention-item',
    listClass: 'qu-thread-ui-mention-list',
    subscribe: () => subscribe?.('/store/directory'),
  });
}
