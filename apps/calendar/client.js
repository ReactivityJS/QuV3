/**
 * CALENDAR — a shared calendar app, mobile-first (Google/Outlook-mobile
 * inspired: an off-canvas calendar list, a compact segmented view switcher,
 * a floating "+" action button, an Agenda/List view as the mobile default),
 * ported onto V3's primitives from QuV2's own `apps/calendar` (see that
 * file's git history for the original desktop-first version this rebuilds).
 *
 * STORAGE SHAPE — everything lives under ONE fixed app space (`SPACE_ID`,
 * this app's own `manifest.spaceId`), the same "one space, many
 * independently-owned rooms" shape `apps/chat` already uses for its rooms,
 * NOT QuV2's per-calendar `calendar-<id>` space - see index.js's own doc
 * comment for exactly why (so `@qu/relay`'s manifest-driven push resolver
 * needs zero bespoke routing code). Each calendar `<calId>` (a fresh
 * `crypto.randomUUID()`) gets two Documents, both real, per-resource ACL
 * protected via `AccessService` (genuine writer enforcement at the relay,
 * not just a UI-level filter - see `README`/`docs/api-reference.md`'s own
 * `AccessService` section):
 *   - `cal-<calId>-meta`: `{id, title, color, ownerPub, members: [{actorPub,
 *     role, addedAt}], createdAt}` - OWNER-ONLY writer (`role` changes,
 *     rename, color, delete all go through this one document).
 *   - `cal-<calId>-events`: `{events: [{id, title, description, start, end,
 *     allDay, guests: [{actorPub, invitedAt}]}]}` - writers = owner + every
 *     current `editor`, grown/shrunk as roles change (`syncEventsAcl()`).
 * Deleting a calendar TOMBSTONES the meta document (`qu.put(path, null,
 * ...)`, the same convention every other entity kind in this codebase uses
 * for "gone" - `QuStore` has no `delete()`) rather than QuV2's `members: []`
 * soft-clear - `roleOf()` already treats a missing/null meta the same as an
 * empty member list, so every access check collapses to "no access" either
 * way, just via the more idiomatic tombstone.
 *
 * NOTIFICATIONS - three real, independently-toggleable `pushActions` (see
 * manifest.quapp), each a Thread under the SAME shared space:
 *   - `invite-<actorPub>` (`MessageService.notify()`, a generic per-actor
 *     mailbox - shared across every calendar this actor is ever invited to,
 *     same as `apps/chat`'s own invite mailbox) - calendar-level shares.
 *   - `activity-<calId>` (`THREAD_PRESETS.activity(memberPubs)`, grown via
 *     `addReader()` as membership grows) - one message per create/update/
 *     delete, for every OTHER member to see "this calendar changed".
 *   - `guest-<eventId>-<actorPub>` (`THREAD_PRESETS.mail(actorPub)`) - a
 *     single EVENT invited to someone who isn't (yet) a calendar member -
 *     `inviteGuest()` grants them viewer access the same way `inviteMember()`
 *     does, via the shared `ensureCalendarMembership()` helper.
 *
 * ROUTING - everything beyond `#/calendar` is a real, addressable, back/
 * forward-navigable PAGE (`segments`-based, see docs/building-an-app.md
 * §4.2), never a modal:
 *   - `#/calendar` - My Calendars (an off-canvas drawer on mobile, a
 *     persistent sidebar from ~880px up) + the combined Day/Week/Month/List view.
 *   - `#/calendar/<calId>` - open an invited calendar (stars it if this
 *     identity is actually a member, else explains why it can't).
 *   - `#/calendar/<calId>/share` - owner-only: rename, color, members,
 *     invite by alias/pub with live autocomplete (`mountActorPicker()`).
 *   - `#/calendar/<calId>/new` / `.../new/<startMs>` - New Event.
 *   - `#/calendar/from-message` - New Event, pre-filled from a chat/forum
 *     message via `createEventMenuItem()` (the `content.messageMenu`
 *     contribution below) - a one-shot `sessionStorage` handoff, consumed
 *     and cleared on read (see `PREFILL_KEY`).
 *   - `#/calendar/<calId>/<eventId>` - Event Detail (view, with Edit toggled
 *     in place - no separate URL) + guest list/invite.
 *
 * No recurring-event (RRULE) support, no true multi-day event bar spanning
 * beyond what `layoutSpanningEvents()` already draws - same documented scope
 * cut QuV2's own calendar carried; every event occurs on its `start` date
 * unless `allDay`/multi-day, laid out as a spanning banner not an hourly slot.
 */
import { watch } from '@qu/reactive';
import { paths, THREAD_PRESETS, formatActorLabel, matchesActorQuery } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const SPACE_ID = 'ff73365b-144a-4285-8e98-ac7f9928a95f'; // this app's own manifest.spaceId - see index.js's own copy of this constant
const PALETTE = ['#e0483e', '#3e7fe0', '#3ea05e', '#d0a02a', '#9a4fe0', '#e0648a', '#2ab3a6', '#c47a2a'];
const HOUR_PX = 48;
const GRID_PX = HOUR_PX * 24;
const MIN_EVENT_MINUTES = 20; // a very short event still gets a click-able sliver in the time grid
const DEFAULT_DURATION_MS = 30 * 60 * 1000; // a fresh event, or a start-time change with no prior custom duration, defaults to 30 minutes
const MOBILE_QUERY = '(max-width: 719px)';
const PREFILL_KEY = 'qu-calendar-prefill'; // one-shot handoff from createEventMenuItem() - see this file's own top doc comment

const DICT = {
  en: {
    title: 'Calendar', myCalendars: 'My calendars', sharedWithMe: 'Shared with me', untitled: 'Untitled calendar',
    newCalendar: 'New calendar name…', create: 'Create',
    day: 'Day', week: 'Week', month: 'Month', list: 'Agenda',
    today: 'Today', prev: 'Previous', next: 'Next', backToCalendar: '← Calendar',
    filterPlaceholder: 'Filter by title or description…',
    newEvent: 'New event', eventTitle: 'Title', eventDescription: 'Description (optional)',
    start: 'Start', end: 'End', allDay: 'All day', calendarLabel: 'Calendar', add: 'Add event', save: 'Save', cancel: 'Cancel',
    delete: 'Delete', edit: 'Edit', noEvents: 'No events.', more: '+{count} more',
    noCalendars: 'No calendars yet — create one below, or wait for an invite.',
    allHidden: 'Every calendar is hidden — check one below to see its events.',
    calendarsMenu: 'Calendars', close: 'Close',
    share: 'Share', shareTitle: 'Share "{title}"', people: 'People', role_owner: 'Owner', role_editor: 'Editor', role_viewer: 'Viewer',
    invite: 'Invite', invitePlaceholder: 'Search by alias or paste a public key…',
    noMatches: 'No matches.', pasteAsIs: 'Invite "~{pub}…"',
    remove: 'Remove', leave: 'Leave', leaveConfirm: 'Leave "{title}"? You will lose access unless invited again, and the owner will be notified.',
    sharedBadge: 'Shared', showOwner: 'Show owner', ownedBy: 'Owned by {name}',
    deleteCalendar: 'Delete calendar', deleteCalendarConfirm: 'Delete "{title}"? This removes it for everyone and cannot be undone.',
    renameLabel: 'Name', colorLabel: 'Color', viewOnly: 'View only',
    noAccessTitle: 'No access', noAccessBody: 'You don’t have access to "{title}" — ask the owner to invite you.',
    noEditableCalendars: 'No calendar you can add events to — create one first.',
    invalidLink: 'This calendar link is invalid, or the calendar isn’t reachable right now.',
    inviteFailed: 'Could not invite {name}: {message}',
    unknownPerson: '~{pub}…', youSuffix: '{name} (you)',
    eventNotFound: 'This event no longer exists.', eventNoAccess: 'You don’t have access to this event.',
    guests: 'Guests', noGuestsYet: 'No guests yet.', inviteGuest: 'Invite a guest',
    fromMessagePrefillNotice: 'Pre-filled from a chat message.',
    createEventFromMessage: 'Create calendar event',
  },
  de: {
    title: 'Kalender', myCalendars: 'Meine Kalender', sharedWithMe: 'Für mich freigegeben', untitled: 'Unbenannter Kalender',
    newCalendar: 'Name des neuen Kalenders…', create: 'Erstellen',
    day: 'Tag', week: 'Woche', month: 'Monat', list: 'Liste',
    today: 'Heute', prev: 'Zurück', next: 'Weiter', backToCalendar: '← Kalender',
    filterPlaceholder: 'Nach Titel oder Beschreibung filtern…',
    newEvent: 'Neuer Termin', eventTitle: 'Titel', eventDescription: 'Beschreibung (optional)',
    start: 'Start', end: 'Ende', allDay: 'Ganztägig', calendarLabel: 'Kalender', add: 'Termin hinzufügen', save: 'Speichern', cancel: 'Abbrechen',
    delete: 'Löschen', edit: 'Bearbeiten', noEvents: 'Keine Termine.', more: '+{count} weitere',
    noCalendars: 'Noch keine Kalender — unten einen anlegen oder auf eine Einladung warten.',
    allHidden: 'Alle Kalender sind ausgeblendet — unten einen anhaken, um Termine zu sehen.',
    calendarsMenu: 'Kalender', close: 'Schließen',
    share: 'Teilen', shareTitle: '"{title}" teilen', people: 'Personen', role_owner: 'Besitzer', role_editor: 'Bearbeiter', role_viewer: 'Betrachter',
    invite: 'Einladen', invitePlaceholder: 'Nach Alias suchen oder Public Key einfügen…',
    noMatches: 'Keine Treffer.', pasteAsIs: '"~{pub}…" einladen',
    remove: 'Entfernen', leave: 'Verlassen', leaveConfirm: '"{title}" verlassen? Der Zugriff geht verloren, bis erneut eingeladen wird, und der Besitzer wird benachrichtigt.',
    sharedBadge: 'Geteilt', showOwner: 'Besitzer anzeigen', ownedBy: 'Besitzer: {name}',
    deleteCalendar: 'Kalender löschen', deleteCalendarConfirm: '"{title}" löschen? Das entfernt ihn für alle und kann nicht rückgängig gemacht werden.',
    renameLabel: 'Name', colorLabel: 'Farbe', viewOnly: 'Nur Ansicht',
    noAccessTitle: 'Kein Zugriff', noAccessBody: 'Kein Zugriff auf "{title}" — bitte vom Besitzer einladen lassen.',
    noEditableCalendars: 'Kein Kalender, dem du Termine hinzufügen kannst — zuerst einen anlegen.',
    invalidLink: 'Dieser Kalender-Link ist ungültig, oder der Kalender ist gerade nicht erreichbar.',
    inviteFailed: '{name} konnte nicht eingeladen werden: {message}',
    unknownPerson: '~{pub}…', youSuffix: '{name} (Du)',
    eventNotFound: 'Dieser Termin existiert nicht mehr.', eventNoAccess: 'Kein Zugriff auf diesen Termin.',
    guests: 'Gäste', noGuestsYet: 'Noch keine Gäste.', inviteGuest: 'Gast einladen',
    fromMessagePrefillNotice: 'Aus einer Chat-Nachricht vorausgefüllt.',
    createEventFromMessage: 'Als Termin erstellen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-calendar-style';
const STYLE = `
  .qu-cal-root { position: relative; }
  .qu-cal-topbar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.6rem; }
  .qu-cal-menu-btn { flex-shrink: 0; border: 1px solid var(--qu-color-border, #8884); background: none; border-radius: var(--qu-radius-md, 0.4rem); padding: 0.45rem 0.6rem; cursor: pointer; font-size: 1.1em; line-height: 1; }
  .qu-cal-title-h1 { margin: 0; font-size: 1.3em; flex: 1; }

  .qu-cal-layout { display: flex; align-items: flex-start; }
  .qu-cal-main { flex: 1; min-width: 0; }

  /* ---- Off-canvas sidebar (mobile default) / persistent sidebar (wide) ---- */
  .qu-cal-scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 20; opacity: 0; pointer-events: none; transition: opacity 0.15s; }
  .qu-cal-scrim[data-open="true"] { opacity: 1; pointer-events: auto; }
  .qu-cal-sidebar { position: fixed; top: 0; bottom: 0; left: 0; width: 17rem; max-width: 84vw; background: var(--qu-color-surface, Canvas); z-index: 21; transform: translateX(-100%); transition: transform 0.18s ease-out; display: flex; flex-direction: column; gap: 0.9rem; padding: 1rem; box-sizing: border-box; overflow-y: auto; box-shadow: 0.4rem 0 1rem rgba(0,0,0,0.15); }
  .qu-cal-sidebar[data-open="true"] { transform: translateX(0); }
  .qu-cal-sidebar-head { display: flex; align-items: center; justify-content: space-between; }
  .qu-cal-sidebar-head h2 { margin: 0; font-size: 1em; }
  .qu-cal-sidebar-close { border: none; background: none; font-size: 1.3em; line-height: 1; cursor: pointer; padding: 0.2rem 0.4rem; }

  .qu-cal-section-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0.6rem 0 0.3rem; }
  .qu-cal-calendars { display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-cal-row { display: flex; align-items: center; gap: 0.3rem; }
  .qu-cal-row label { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; cursor: pointer; padding: 0.3rem 0.1rem; }
  .qu-cal-row input[type="checkbox"] { width: 1.15rem; height: 1.15rem; flex-shrink: 0; }
  .qu-cal-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* A SHARED calendar's own title is a button (not plain text) - clicking
     it reveals who owns it (see calendarsSection()'s own doc comment) - a
     ".qu-cal-owner-line" row appended right after this one. */
  .qu-cal-row-title-btn { background: none; border: none; padding: 0.3rem 0.1rem; font: inherit; text-align: left; color: inherit; cursor: pointer; }
  .qu-cal-row-title-btn:hover { text-decoration: underline; }
  /* Marks a shared (non-owned) calendar AS SUCH beyond just which section
     heading it's grouped under - see calendarsSection()'s own doc comment. */
  .qu-cal-shared-badge { flex-shrink: 0; font-size: 0.85em; opacity: 0.55; }
  .qu-cal-owner-line { font-size: 0.78em; opacity: 0.7; padding: 0 0.5rem 0.3rem 2.3rem; }
  .qu-cal-owner-line[hidden] { display: none; }
  .qu-cal-swatch { width: 0.8rem; height: 0.8rem; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .qu-cal-row button, .qu-cal-row a { flex-shrink: 0; opacity: 0.65; background: none; border: none; cursor: pointer; font-size: 1.05em; padding: 0.35rem 0.4rem; text-decoration: none; }
  .qu-cal-row button:hover, .qu-cal-row a:hover { opacity: 1; }
  .qu-cal-new { display: flex; gap: 0.4rem; }
  .qu-cal-new input { flex: 1; min-width: 0; padding: 0.5rem; font-size: 1em; }
  .qu-cal-new button { padding: 0.5rem 0.7rem; }

  /* ---- Toolbar ---- */
  .qu-cal-toolbar { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.6rem; flex-wrap: wrap; }
  .qu-cal-toolbar-navrow { display: flex; align-items: center; gap: 0.5rem; width: 100%; }
  .qu-cal-nav { display: inline-flex; gap: 0.3rem; align-items: center; flex-shrink: 0; }
  .qu-cal-nav button { border: 1px solid var(--qu-color-border, #8884); background: none; border-radius: var(--qu-radius-md, 0.4rem); padding: 0.4rem 0.65rem; cursor: pointer; min-width: 2.2rem; }
  .qu-cal-heading { font-weight: 600; margin: 0 0.2rem; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.95em; }
  .qu-cal-primary { border: none; border-radius: var(--qu-radius-md, 0.4rem); padding: 0.5rem 1rem; background: var(--qu-color-accent, #5b5bd6); color: #fff; cursor: pointer; font-weight: 600; text-decoration: none; display: inline-block; }
  .qu-cal-new-event-inline { display: none; }
  .qu-cal-filter { padding: 0.5rem; width: 100%; box-sizing: border-box; font-size: 1em; }

  /* Segmented view switcher - full-width, thumb-friendly on mobile */
  .qu-cal-viewswitch { display: flex; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; overflow: hidden; width: 100%; }
  .qu-cal-viewswitch button { flex: 1; border: none; background: none; padding: 0.5rem 0.4rem; cursor: pointer; font-size: 0.85em; }
  .qu-cal-viewswitch button[data-active="true"] { background: var(--qu-color-accent, #5b5bd6); color: #fff; font-weight: 600; }

  /* Floating action button - mobile primary "New event" affordance */
  .qu-cal-fab { position: fixed; right: 1.1rem; bottom: calc(1.1rem + env(safe-area-inset-bottom, 0px)); width: 3.4rem; height: 3.4rem; border-radius: 50%; background: var(--qu-color-accent, #5b5bd6); color: #fff; border: none; font-size: 1.6em; line-height: 1; cursor: pointer; box-shadow: 0 0.3rem 0.9rem rgba(0,0,0,0.3); z-index: 15; display: flex; align-items: center; justify-content: center; text-decoration: none; }

  .qu-cal-month-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.2rem; }
  .qu-cal-month-cell { min-width: 0; border: 1px solid var(--qu-color-border, #8884); border-radius: 0.25rem; padding: 0.25rem; min-height: 3.6rem; font-size: 0.82em; cursor: pointer; transition: background-color 0.1s; }
  .qu-cal-month-cell:hover { background: #8881; }
  .qu-cal-month-cell[data-dim="true"] { opacity: 0.4; }
  .qu-cal-month-cell[data-today="true"] { border-color: var(--qu-color-accent, #5b5bd6); border-width: 2px; }
  .qu-cal-day-num { font-weight: 600; }
  .qu-cal-chip { display: block; max-width: 100%; box-sizing: border-box; border-radius: 0.2rem; padding: 0.05rem 0.3rem; margin-top: 0.15rem; color: #fff; font-size: 0.82em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; text-decoration: none; }
  .qu-cal-chip[data-continues-from="true"] { border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .qu-cal-chip[data-continues-to="true"] { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .qu-cal-day-list, .qu-cal-flat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-cal-agenda-daygroup { margin-bottom: 0.3rem; }
  .qu-cal-agenda-daylabel { font-size: 0.82em; font-weight: 600; opacity: 0.75; margin: 0.7rem 0 0.3rem; text-transform: capitalize; }
  .qu-cal-event-row { border-left: 4px solid #888; border-radius: 0.3rem; padding: 0.5rem 0.6rem; background: #8881; cursor: pointer; text-decoration: none; color: inherit; display: block; }
  .qu-cal-event-row * { display: block; }
  .qu-cal-event-time { font-size: 0.8em; opacity: 0.7; }
  .qu-cal-allday-wrap { display: flex; margin: 0.4rem 0 0.6rem; }
  .qu-cal-allday-gutter { width: 3rem; flex-shrink: 0; }
  .qu-cal-allday-grid { flex: 1; min-width: 0; display: grid; grid-auto-rows: 1.6rem; gap: 0.2rem; }
  .qu-cal-allday-bar { grid-row: 1; min-width: 0; display: flex; align-items: center; border-radius: 0.25rem; padding: 0 0.4rem; color: #fff; font-size: 0.78em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; text-decoration: none; box-sizing: border-box; }
  .qu-cal-allday-bar[data-continues-from="true"] { border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .qu-cal-allday-bar[data-continues-to="true"] { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .qu-cal-timegrid-wrap { display: flex; border-top: 1px solid var(--qu-color-border, #8884); overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .qu-cal-hours { width: 2.7rem; flex-shrink: 0; }
  .qu-cal-hour-label { height: ${HOUR_PX}px; box-sizing: border-box; font-size: 0.7em; opacity: 0.6; transform: translateY(-0.6em); text-align: right; padding-right: 0.35rem; }
  .qu-cal-daycols { flex: 1; display: flex; }
  .qu-cal-daycolwrap { flex: 1; min-width: 0; }
  .qu-cal-daycol { position: relative; border-left: 1px solid var(--qu-color-border, #8884); background-image: repeating-linear-gradient(to bottom, transparent, transparent ${HOUR_PX - 1}px, #8882 ${HOUR_PX - 1}px, #8882 ${HOUR_PX}px); height: ${GRID_PX}px; cursor: pointer; }
  .qu-cal-daycol-head { text-align: center; font-size: 0.82em; padding-bottom: 0.3rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-cal-daycol-head[data-today="true"] { color: var(--qu-color-accent, #5b5bd6); }
  .qu-cal-time-event { position: absolute; border-radius: 0.3rem; padding: 0.15rem 0.35rem; color: #fff; font-size: 0.76em; overflow: hidden; cursor: pointer; box-sizing: border-box; text-decoration: none; }
  .qu-cal-now-line { position: absolute; left: 0; right: 0; height: 2px; background: var(--qu-color-danger, #c00); z-index: 2; pointer-events: none; }
  .qu-cal-now-line::before { content: ''; position: absolute; left: -4px; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--qu-color-danger, #c00); }

  .qu-cal-page { max-width: 34rem; padding-bottom: 5rem; }
  .qu-cal-back-link { display: inline-block; margin-bottom: 0.6rem; text-decoration: none; opacity: 0.8; }
  .qu-cal-back-link:hover { opacity: 1; }
  .qu-cal-notice { font-size: 0.85em; opacity: 0.75; border: 1px dashed var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.5rem 0.7rem; margin-bottom: 0.6rem; }
  .qu-cal-form { display: flex; flex-direction: column; gap: 0.7rem; }
  .qu-cal-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9em; }
  .qu-cal-form input, .qu-cal-form select, .qu-cal-form textarea { padding: 0.55rem; font: inherit; font-size: 1rem; box-sizing: border-box; border-radius: var(--qu-radius-sm, 0.3rem); border: 1px solid var(--qu-color-border, #8884); }
  .qu-cal-form-row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .qu-cal-form-row > * { flex: 1; min-width: 9rem; }
  .qu-cal-page-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.4rem; }
  .qu-cal-page-actions button, .qu-cal-page-actions a { padding: 0.55rem 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: none; cursor: pointer; font: inherit; text-decoration: none; color: inherit; }
  .qu-cal-page-actions .qu-cal-danger { color: var(--qu-color-danger, #c00); border-color: var(--qu-color-danger, #c00); }
  .qu-cal-member-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-cal-member-row:last-child { border-bottom: none; }
  .qu-cal-member-row .qu-cal-member-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-cal-status { font-size: 0.85em; opacity: 0.75; min-height: 1.2em; }
  .qu-cal-detail-desc { white-space: pre-wrap; margin: 0.4rem 0; }
  .qu-cal-badge { font-size: 0.75em; opacity: 0.65; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; padding: 0.1rem 0.55rem; }
  .qu-cal-noaccess { max-width: 28rem; }

  /* ---- Actor picker (alias/pub autocomplete) - Share + Guest invite ---- */
  .qu-cal-picker { position: relative; }
  .qu-cal-picker-row { display: flex; gap: 0.4rem; align-items: center; }
  .qu-cal-picker-row input { flex: 1; min-width: 0; }
  .qu-cal-picker-dropdown { position: absolute; left: 0; right: 0; top: 100%; margin-top: 0.2rem; background: var(--qu-color-surface, Canvas); border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); max-height: 13rem; overflow-y: auto; z-index: 5; box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.15); }
  .qu-cal-picker-option { padding: 0.55rem 0.7rem; cursor: pointer; font-size: 0.9em; }
  .qu-cal-picker-option:hover, .qu-cal-picker-option[data-active="true"] { background: #8882; }
  .qu-cal-picker-empty { padding: 0.55rem 0.7rem; font-size: 0.85em; opacity: 0.65; }

  /* ---- ≥720px: persistent sidebar, back to a desktop-style layout ---- */
  @media (min-width: 720px) {
    .qu-cal-menu-btn { display: none; }
    .qu-cal-scrim { display: none; }
    .qu-cal-layout { gap: 1.3rem; align-items: flex-start; }
    .qu-cal-sidebar { position: static; transform: none; width: 16rem; max-width: none; flex-shrink: 0; box-shadow: none; padding: 0; overflow-y: visible; }
    .qu-cal-sidebar-head { display: none; }
    .qu-cal-toolbar { flex-wrap: nowrap; }
    .qu-cal-toolbar-navrow { width: auto; flex: 1; min-width: 0; }
    .qu-cal-viewswitch { width: auto; flex-shrink: 0; }
    .qu-cal-viewswitch button { flex: initial; padding: 0.35rem 0.8rem; }
    .qu-cal-filter { width: 14rem; }
    .qu-cal-fab { display: none; }
    .qu-cal-new-event-inline { display: inline-block; }
    .qu-cal-month-cell { min-height: 5.2rem; padding: 0.35rem; font-size: 0.85em; }
  }
`;

function colorFor(calendarId) {
  let hash = 0;
  for (let i = 0; i < calendarId.length; i++) hash = (hash * 31 + calendarId.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeekMon(d) { const x = startOfDay(d); const day = (x.getDay() + 6) % 7; return addDays(x, -day); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtDate(d) { return d.toLocaleDateString(); }
function minutesIntoDay(ms, day) { return Math.max(0, Math.min(1440, (ms - startOfDay(day).getTime()) / 60000)); }
function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function roundToHalfHour(d) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() < 30 ? 0 : 30, 0, 0);
  return x;
}
function shortPerson(actorPub, profile) {
  return formatActorLabel(actorPub, profile) || t('unknownPerson', { pub: actorPub.slice(0, 10) });
}
function eventHash(calId, eventId) { return `#/calendar/${calId}/${eventId}`; }
function shareHash(calId) { return `#/calendar/${calId}/share`; }
function newEventHash(calId, startMs) { return startMs ? `#/calendar/${calId}/new/${startMs}` : `#/calendar/${calId}/new`; }
function metaResourceId(calId) { return `cal-${calId}-meta`; }
function eventsResourceId(calId) { return `cal-${calId}-events`; }
function activityThreadId(calId) { return `activity-${calId}`; }
function guestThreadId(eventId, actorPub) { return `guest-${eventId}-${actorPub}`; }

/** Greedy side-by-side layout for overlapping timed events on one day. */
function layoutTimedEvents(events) {
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const colEnds = [];
  const flush = () => {
    if (!cluster.length) return;
    const maxCols = Math.max(...cluster.map((c) => c.col)) + 1;
    for (const c of cluster) result.push({ ev: c.ev, col: c.col, cols: maxCols });
    cluster = [];
  };
  for (const ev of sorted) {
    if (ev.start >= clusterEnd) { flush(); colEnds.length = 0; clusterEnd = ev.end; }
    else clusterEnd = Math.max(clusterEnd, ev.end);
    let col = 0;
    while (colEnds[col] !== undefined && colEnds[col] > ev.start) col++;
    colEnds[col] = ev.end;
    cluster.push({ ev, col });
  }
  flush();
  return result;
}

/**
 * Greedy row-stacking for events spanning one or more of `days` (the
 * Day/Week view's all-day + genuinely multi-day banner) - keyed by
 * DAY-INDEX overlap within `days` instead of minute overlap within one day.
 * `continuesFrom`/`continuesTo` flag an event whose real start/end falls
 * outside this page's visible window, so the caller can draw it flush to
 * that edge instead of rounded - the one visual cue a paginated grid can
 * give for "this keeps going".
 */
function layoutSpanningEvents(events, days) {
  const dayMs = 24 * 60 * 60 * 1000;
  const windowStart = days[0].getTime();
  const lastIdx = days.length - 1;
  const windowEnd = days[lastIdx].getTime();
  const items = [];
  for (const ev of events) {
    const evStartDay = startOfDay(new Date(ev.start)).getTime();
    const evEndDay = startOfDay(new Date(ev.end || ev.start)).getTime();
    if (evEndDay < windowStart || evStartDay > windowEnd) continue;
    const startIdx = Math.max(0, Math.round((evStartDay - windowStart) / dayMs));
    const endIdx = Math.min(lastIdx, Math.round((evEndDay - windowStart) / dayMs));
    items.push({ ev, startIdx, endIdx, continuesFrom: evStartDay < windowStart, continuesTo: evEndDay > windowEnd });
  }
  items.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);

  const rowEnds = []; // rowEnds[row] = last day-index already occupied in that row
  const result = [];
  for (const item of items) {
    let row = 0;
    while (rowEnds[row] !== undefined && rowEnds[row] >= item.startIdx) row++;
    rowEnds[row] = item.endIdx;
    result.push({ ...item, row });
  }
  return result;
}

function isMultiDay(ev) {
  return ev.allDay || !sameDay(new Date(ev.start), new Date(ev.end || ev.start));
}
function eventsOn(events, day) {
  return events.filter((ev) => sameDay(new Date(ev.start), day)).sort((a, b) => a.start - b.start);
}
/** Like eventsOn(), but includes an event on every day it SPANS - used by Month/Agenda so a multi-day event shows on each day it covers. */
function eventsTouching(events, day) {
  return events
    .filter((ev) => {
      const s = startOfDay(new Date(ev.start));
      const e = startOfDay(new Date(ev.end || ev.start));
      return day >= s && day <= e;
    })
    .sort((a, b) => a.start - b.start);
}

// ===========================================================================
// Actor picker - alias/pub search-as-you-type with live autocomplete,
// shared by the Share page's "invite a member" row and the Event Detail
// page's "invite a guest" row (requirements: share by alias/pub with
// autocomplete; guest invites use the identical mechanism). Candidate pool
// mirrors @qu/thread-ui's mountMentionAutocomplete(): DirectoryService.
// listVisible() + ContactsService.listContacts(), deduped by actorPub,
// resolved to a profile ONCE per mount, filtered synchronously per
// keystroke via matchesActorQuery()/formatActorLabel() (both @qu/services).
// A query that matches no candidate but looks like a real actor pubkey
// (long enough, no whitespace) still offers a literal "invite ~xyz…" option
// - the "or paste a public key" half of the requirement, for someone not
// (yet) in the directory or contacts.
// ===========================================================================
function looksLikeActorPub(query) {
  return query.length >= 32 && !/\s/.test(query);
}

/**
 * @param {HTMLElement} container - Gets one `.qu-cal-picker` block appended.
 * @param {{services: object, subscribe?: Function, excludePubs?: Set<string>, onPick: (actorPub: string, label: string) => void}} opts
 * @returns {() => void} destroy
 */
function mountActorPicker(container, { services, subscribe, excludePubs = new Set(), onPick }) {
  subscribe?.(paths.directoryEntriesParentPath());

  const wrap = document.createElement('div');
  wrap.className = 'qu-cal-picker';
  const row = document.createElement('div');
  row.className = 'qu-cal-picker-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('invitePlaceholder');
  row.appendChild(input);
  wrap.appendChild(row);
  const dropdown = document.createElement('div');
  dropdown.className = 'qu-cal-picker-dropdown';
  dropdown.hidden = true;
  wrap.appendChild(dropdown);
  container.appendChild(wrap);

  let pool = null; // [{actorPub, profile}] - resolved once, lazily
  let activeIndex = -1;
  let destroyed = false;

  async function ensurePool() {
    if (pool) return pool;
    const [visible, contacts] = await Promise.all([
      services.directory.listVisible().catch(() => []),
      services.contacts.listContacts().catch(() => []),
    ]);
    const byPub = new Map();
    for (const entry of visible) byPub.set(entry.actorPub, null);
    for (const c of contacts) byPub.set(c.actorPub, c.profile ?? null);
    pool = await Promise.all([...byPub.keys()].map(async (actorPub) => ({
      actorPub,
      profile: byPub.get(actorPub) ?? (await services.profile.getPublicProfile(actorPub).catch(() => null)),
    })));
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
      .filter((c) => !excludePubs.has(c.actorPub) && (query ? matchesActorQuery(c.actorPub, c.profile, query) : false))
      .slice(0, 8);

    dropdown.textContent = '';
    activeIndex = -1;
    if (!query) { closeDropdown(); return; }

    if (matches.length === 0 && !looksLikeActorPub(query)) {
      const empty = document.createElement('div');
      empty.className = 'qu-cal-picker-empty';
      empty.textContent = t('noMatches');
      dropdown.appendChild(empty);
      dropdown.hidden = false;
      return;
    }
    for (const c of matches) {
      const opt = document.createElement('div');
      opt.className = 'qu-cal-picker-option';
      opt.textContent = shortPerson(c.actorPub, c.profile);
      opt.addEventListener('click', () => choose(c.actorPub, shortPerson(c.actorPub, c.profile)));
      dropdown.appendChild(opt);
    }
    if (matches.length === 0 && looksLikeActorPub(query) && !excludePubs.has(query)) {
      const opt = document.createElement('div');
      opt.className = 'qu-cal-picker-option';
      opt.textContent = t('pasteAsIs', { pub: query.slice(0, 12) });
      opt.addEventListener('click', () => choose(query, `~${query.slice(0, 10)}…`));
      dropdown.appendChild(opt);
    }
    dropdown.hidden = dropdown.children.length === 0;
  }

  input.addEventListener('input', () => { renderDropdown(); });
  input.addEventListener('focus', () => { if (input.value.trim()) renderDropdown(); });
  input.addEventListener('keydown', (e) => {
    const options = [...dropdown.querySelectorAll('.qu-cal-picker-option')];
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

// ===========================================================================
// mount()
// ===========================================================================
export function mount(container, { qu, services, segments, subscribe, syncFetch }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let unwatches = [];
  let nowTimer = null;
  let checked = null; // Set<calendarId> - null until first populated (defaults to "all")
  let view = window.matchMedia?.(MOBILE_QUERY)?.matches ? 'list' : 'month';
  let cursor = startOfDay(new Date());
  let filterText = '';
  let myActorPub = null;
  let sidebarOpen = false;
  let pickerCleanups = [];
  let pendingInvitesChecked = false; // discoverPendingInvites() - see its own doc comment; runs once per mount

  const calId = segments[1] ?? null;
  const sub = segments[2] ?? null; // null | 'share' | 'new' | <eventId>
  const extra = segments[3] ?? null; // 'new'-only: an optional pre-filled start time (ms)

  (async () => {
    myActorPub = await services.actors.whoAmI();
    if (stopped) return;
    if (calId === 'from-message') { await renderNewEventPage(null, null, readAndClearPrefill()); return; }
    if (!calId) { await renderMain(); return; }
    if (!sub) { await handleInviteLink(calId); return; }
    if (sub === 'share') { await renderSharePage(calId); return; }
    if (sub === 'new') { await renderNewEventPage(calId, extra ? Number(extra) : null, null); return; }
    await renderEventDetailPage(calId, sub);
  })();

  function clearWatches() {
    for (const u of unwatches) u();
    unwatches = [];
    for (const cleanup of pickerCleanups) cleanup();
    pickerCleanups = [];
    if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
  }

  function readAndClearPrefill() {
    try {
      const raw = window.sessionStorage.getItem(PREFILL_KEY);
      if (!raw) return null;
      window.sessionStorage.removeItem(PREFILL_KEY);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function fetchDoc(docId, fallback) {
    const path = paths.documentPath(SPACE_ID, docId);
    let quBit = await qu.get(path);
    if (!quBit?.val) {
      if (syncFetch) { try { await syncFetch(path); } catch { /* unreachable, or genuinely absent */ } }
      quBit = await qu.get(path);
    }
    return quBit?.val ?? fallback;
  }
  const fetchMeta = (id) => fetchDoc(metaResourceId(id), null);
  const fetchEvents = (id) => fetchDoc(eventsResourceId(id), { events: [] });

  function roleOf(meta, actorPub) {
    return meta?.members?.find((m) => m.actorPub === actorPub)?.role ?? null;
  }
  function canEdit(role) { return role === 'owner' || role === 'editor'; }
  function canManage(role) { return role === 'owner'; }

  async function listMine() {
    return services.flags.listPrivate('calendar', 'calendar');
  }

  async function starIfMember(id, meta) {
    if (!roleOf(meta, myActorPub)) return false;
    if (await services.flags.hasPrivate('calendar', 'calendar', id)) return false;
    await services.flags.setPrivate('calendar', 'calendar', id, true, {});
    return true;
  }

  /**
   * `inviteMember()` posts `{calendarId, calendarTitle}` into this identity's
   * own `invite-<myActorPub>` mailbox (see that function's own doc comment)
   * purely to trigger a push/in-app notification - but a notification's own
   * click-through URL is always the GENERIC, manifest-driven `#/calendar`
   * (`@qu/relay`'s `createManifestNotificationResolver()` only ever knows an
   * app's fixed `manifest.spaceId` -> `#/<name>` route, nothing about a
   * specific calendar id inside it), so following it alone never reaches the
   * one THIS-invite-specific route (`#/calendar/<calId>`) that would
   * actually star the calendar in on its own (`handleInviteLink()`). Without
   * this, an invited member sees the notification (real, delivered) but the
   * shared calendar itself never appears anywhere they can click - it was
   * never discoverable other than by guessing/being told its raw UUID.
   *
   * Run once per mount (`renderMain()`'s own `pendingInvitesChecked` guard):
   * re-reads this identity's own invite mailbox, and stars every calendar
   * mentioned there that this identity is CURRENTLY a member of (mirroring
   * `handleInviteLink()`'s own real-membership check - an invite message is
   * just a notification trace, not proof of standing access; the owner may
   * since have removed them). Already-starred calendars are skipped
   * (`starIfMember()`'s own `hasPrivate` check) - O(1) per invite on every
   * later visit, not a growing re-scan cost.
   */
  async function discoverPendingInvites() {
    const threadId = `invite-${myActorPub}`;
    if (syncFetch) await syncFetch(paths.threadMessagesParentPath(SPACE_ID, threadId)).catch(() => {});
    const { messages } = await services.messages.listMessages(SPACE_ID, threadId).catch(() => ({ messages: [] }));
    const calIds = [...new Set(messages.map((m) => m.calendarId).filter(Boolean))];
    for (const calId of calIds) {
      const meta = await fetchMeta(calId);
      await starIfMember(calId, meta);
    }
  }

  function backLink() {
    const a = document.createElement('a');
    a.className = 'qu-cal-back-link';
    a.href = '#/calendar';
    a.textContent = t('backToCalendar');
    return a;
  }

  // ---------------------------------------------------------------------
  // Invite-link handling - `#/calendar/<id>` checks real membership before
  // starring, instead of unconditionally joining on sight.
  // ---------------------------------------------------------------------
  async function handleInviteLink(id) {
    const meta = await fetchMeta(id);
    if (stopped) return;
    container.textContent = '';
    if (!meta) {
      const p = document.createElement('p');
      p.textContent = t('invalidLink');
      container.appendChild(p);
      return;
    }
    if (roleOf(meta, myActorPub)) {
      await starIfMember(id, meta);
      window.location.hash = '#/calendar';
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'qu-cal-noaccess';
    const h = document.createElement('h1');
    h.textContent = t('noAccessTitle');
    const p = document.createElement('p');
    p.textContent = t('noAccessBody', { title: meta.title || t('untitled') });
    wrap.append(h, p);
    container.appendChild(wrap);
  }

  // ---------------------------------------------------------------------
  // Main view
  // ---------------------------------------------------------------------
  async function renderMain() {
    if (stopped) return;
    subscribe?.(paths.spacePath(SPACE_ID)); // every calendar's docs/threads live under this ONE app space
    if (!pendingInvitesChecked) {
      pendingInvitesChecked = true;
      await discoverPendingInvites();
      if (stopped) return;
    }
    const mine = await listMine();
    if (stopped) return;

    if (checked === null) checked = new Set(mine.map((c) => c.id));

    clearWatches();
    const infos = [];
    for (const cal of mine) {
      unwatches.push(watch(qu, paths.documentPath(SPACE_ID, eventsResourceId(cal.id)), () => renderMain(), { initial: false, syncFetch }));
      unwatches.push(watch(qu, paths.documentPath(SPACE_ID, metaResourceId(cal.id)), () => renderMain(), { initial: false, syncFetch }));

      const meta = await fetchMeta(cal.id);
      const eventsDoc = await fetchEvents(cal.id);
      infos.push({ id: cal.id, meta: meta ?? { title: t('untitled'), members: [], ownerPub: null, color: null }, events: eventsDoc.events ?? [], role: roleOf(meta, myActorPub), color: meta?.color || colorFor(cal.id) });
    }
    if (stopped) return;

    const events = [];
    for (const info of infos) {
      // A calendar this identity no longer has a role on (removed, or
      // deleted by its owner) still lingers in `mine` until this identity's
      // own star list gets cleaned up, but shouldn't keep contributing
      // events to the combined view or a sidebar section.
      if (!checked.has(info.id) || !info.role) continue;
      for (const ev of info.events) {
        events.push({ ...ev, calendarId: info.id, calendarTitle: info.meta.title || t('untitled'), color: info.color });
      }
    }

    container.textContent = '';
    const root = document.createElement('div');
    root.className = 'qu-cal-root';

    const topbar = document.createElement('div');
    topbar.className = 'qu-cal-topbar';
    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'qu-cal-menu-btn';
    menuBtn.textContent = '☰';
    menuBtn.title = t('calendarsMenu');
    menuBtn.addEventListener('click', () => setSidebarOpen(true));
    const h1 = document.createElement('h1');
    h1.className = 'qu-cal-title-h1';
    h1.textContent = t('title');
    topbar.append(menuBtn, h1);
    root.appendChild(topbar);

    const layout = document.createElement('div');
    layout.className = 'qu-cal-layout';

    const scrim = document.createElement('div');
    scrim.className = 'qu-cal-scrim';
    scrim.addEventListener('click', () => setSidebarOpen(false));

    const sidebar = document.createElement('div');
    sidebar.className = 'qu-cal-sidebar';
    const sideHead = document.createElement('div');
    sideHead.className = 'qu-cal-sidebar-head';
    const sideH2 = document.createElement('h2');
    sideH2.textContent = t('calendarsMenu');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'qu-cal-sidebar-close';
    closeBtn.textContent = '✕';
    closeBtn.title = t('close');
    closeBtn.addEventListener('click', () => setSidebarOpen(false));
    sideHead.append(sideH2, closeBtn);
    sidebar.appendChild(sideHead);
    sidebar.appendChild(calendarsSection(infos.filter((i) => i.role === 'owner'), t('myCalendars')));
    const shared = infos.filter((i) => i.role && i.role !== 'owner');
    if (shared.length) sidebar.appendChild(calendarsSection(shared, t('sharedWithMe')));
    sidebar.appendChild(newCalendarForm());

    function setSidebarOpen(open) {
      sidebarOpen = open;
      sidebar.dataset.open = String(open);
      scrim.dataset.open = String(open);
    }
    sidebar.dataset.open = String(sidebarOpen);
    scrim.dataset.open = String(sidebarOpen);

    layout.append(scrim, sidebar);

    const main = document.createElement('div');
    main.className = 'qu-cal-main';
    if (infos.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-cal-empty';
      empty.textContent = t('noCalendars');
      main.appendChild(empty);
    } else if (checked.size === 0) {
      // Nothing to filter with every calendar hidden - just keep the typed
      // text (no re-render needed, the empty message doesn't depend on it),
      // so the filter input stays usable instead of throwing on the
      // otherwise-required onFilterChange callback.
      main.appendChild(toolbar(infos, (value) => { filterText = value; }));
      const empty = document.createElement('p');
      empty.className = 'qu-cal-empty';
      empty.textContent = t('allHidden');
      main.appendChild(empty);
    } else {
      // The filter input lives inside toolbar(infos), rendered ONCE per
      // renderMain() call - typing into it must NOT trigger a full
      // renderMain() rebuild (that recreates the <input> element itself
      // from scratch on every keystroke, dropping focus/cursor position
      // after every single character, confirmed live). Only the view
      // portion below the toolbar is swapped on a filter change instead,
      // via this closure's own onFilterChange callback - the toolbar
      // (and its input) is never touched again until the next REAL
      // renderMain() (a view/nav/calendar-visibility change).
      const viewContainer = document.createElement('div');
      main.appendChild(toolbar(infos, (value) => {
        filterText = value;
        viewContainer.textContent = '';
        viewContainer.appendChild(viewEl(events, infos));
      }));
      viewContainer.appendChild(viewEl(events, infos));
      main.appendChild(viewContainer);
    }
    layout.appendChild(main);

    root.appendChild(layout);

    const editableCals = infos.filter((i) => canEdit(i.role));
    if (editableCals.length) {
      const fab = document.createElement('a');
      fab.className = 'qu-cal-fab';
      fab.href = newEventHash(editableCals[0].id);
      fab.textContent = '+';
      fab.title = t('newEvent');
      root.appendChild(fab);
    }

    container.appendChild(root);
  }

  /**
   * One calendar section (owner) - "My calendars" for those this identity
   * OWNS, "Shared with me" for the rest. A calendar in the latter group
   * gets marked AS SUCH beyond just that section heading (a real 🔗 badge
   * per row - a row scrolled past the heading, or read out of context, e.g.
   * a screen reader stepping row by row, otherwise carries no per-row
   * signal it isn't one of "my" own calendars), and its title becomes a
   * button: clicking it reveals who owns it (an ".qu-cal-owner-line" row
   * appended right after, resolved the same alias-lookup way
   * `renderMembers()`'s own per-member name does) - previously nowhere in
   * this app did a non-owner ever see WHO shared a calendar with them.
   * `canManage()`/`canEdit()` (both already gate every actual
   * write - `renderSharePage()`'s own guard, `deleteCalendar()`'s ACL, see
   * either's doc comment) mean a shared calendar was already never
   * deletable/editable here; this only changes what's SHOWN, never a
   * permission decision.
   */
  function calendarsSection(infos, heading) {
    const wrap = document.createElement('div');
    const h = document.createElement('div');
    h.className = 'qu-cal-section-heading';
    h.textContent = heading;
    wrap.appendChild(h);

    const list = document.createElement('div');
    list.className = 'qu-cal-calendars';
    for (const info of infos) {
      const shared = !canManage(info.role);
      const row = document.createElement('div');
      row.className = 'qu-cal-row';

      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked.has(info.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) checked.add(info.id);
        else checked.delete(info.id);
        renderMain();
      });
      const swatch = document.createElement('span');
      swatch.className = 'qu-cal-swatch';
      swatch.style.background = info.color;
      label.append(checkbox, swatch);
      row.appendChild(label);

      // A shared row's own owner line - built either way (cheap, plain
      // DOM), only ever shown once its title is clicked.
      const ownerLine = document.createElement('div');
      ownerLine.className = 'qu-cal-owner-line';
      ownerLine.hidden = true;

      if (shared) {
        const titleBtn = document.createElement('button');
        titleBtn.type = 'button';
        titleBtn.className = 'qu-cal-row-title qu-cal-row-title-btn';
        titleBtn.textContent = info.meta.title || t('untitled');
        titleBtn.title = t('showOwner');
        titleBtn.addEventListener('click', () => {
          const opening = ownerLine.hidden;
          ownerLine.hidden = !opening;
          if (!opening || !info.meta.ownerPub) return;
          ownerLine.textContent = t('ownedBy', { name: shortPerson(info.meta.ownerPub, null) });
          services.profile.getPublicProfile(info.meta.ownerPub).then((profile) => {
            if (profile) ownerLine.textContent = t('ownedBy', { name: shortPerson(info.meta.ownerPub, profile) });
          }).catch(() => {});
        });
        row.appendChild(titleBtn);

        const badge = document.createElement('span');
        badge.className = 'qu-cal-shared-badge';
        badge.textContent = '🔗';
        badge.title = t('sharedBadge');
        row.appendChild(badge);
      } else {
        const titleSpan = document.createElement('span');
        titleSpan.className = 'qu-cal-row-title';
        titleSpan.textContent = info.meta.title || t('untitled');
        row.appendChild(titleSpan);
      }

      if (canManage(info.role)) {
        const shareLink = document.createElement('a');
        shareLink.href = shareHash(info.id);
        shareLink.title = t('share');
        shareLink.textContent = '👥';
        row.appendChild(shareLink);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.title = t('deleteCalendar');
        deleteBtn.textContent = '🗑';
        deleteBtn.addEventListener('click', async () => {
          if (!window.confirm(t('deleteCalendarConfirm', { title: info.meta.title || t('untitled') }))) return;
          await deleteCalendar(info.id);
          await renderMain();
        });
        row.appendChild(deleteBtn);
      } else {
        const leaveBtn = document.createElement('button');
        leaveBtn.type = 'button';
        leaveBtn.title = t('leave');
        leaveBtn.textContent = '✕';
        leaveBtn.addEventListener('click', async () => {
          if (!window.confirm(t('leaveConfirm', { title: info.meta.title || t('untitled') }))) return;
          // "Ending the subscription" = un-starring (hides it from THIS
          // identity's own list, below) - a plain member/viewer/editor has
          // no write access to the owner-only meta document, so there is
          // no ACL membership for them to revoke here even in principle
          // (see this file's own top doc comment on `cal-<calId>-meta`
          // being OWNER-ONLY writer). The owner (and every other current
          // member) still gets told, via the SAME already-wired
          // activity-thread notification every real create/update/delete
          // already uses - see notifyActivity()'s own doc comment.
          await services.flags.setPrivate('calendar', 'calendar', info.id, false);
          await notifyActivity(info.id, 'left');
          await renderMain();
        });
        row.appendChild(leaveBtn);
      }
      list.appendChild(row);
      if (shared) list.appendChild(ownerLine);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function newCalendarForm() {
    const wrap = document.createElement('div');
    const form = document.createElement('form');
    form.className = 'qu-cal-new';
    const input = document.createElement('input');
    input.placeholder = t('newCalendar');
    input.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('create');
    form.append(input, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      submit.disabled = true;
      try {
        const newId = await createCalendar(title);
        checked?.add(newId);
        await renderMain();
      } finally {
        submit.disabled = false;
      }
    });
    wrap.appendChild(form);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------
  function toolbar(infos, onFilterChange) {
    const bar = document.createElement('div');
    bar.className = 'qu-cal-toolbar';

    if (view === 'list') {
      const filterInput = document.createElement('input');
      filterInput.className = 'qu-cal-filter';
      filterInput.placeholder = t('filterPlaceholder');
      filterInput.value = filterText;
      // Updates only the view below the toolbar in place - see this
      // function's own caller (renderMain()) for why a full renderMain()
      // rebuild here would drop focus on every keystroke.
      filterInput.addEventListener('input', () => onFilterChange(filterInput.value));
      bar.appendChild(filterInput);
    }

    const navRow = document.createElement('div');
    navRow.className = 'qu-cal-toolbar-navrow';

    const nav = document.createElement('div');
    nav.className = 'qu-cal-nav';
    const todayBtn = document.createElement('button');
    todayBtn.type = 'button';
    todayBtn.textContent = t('today');
    todayBtn.addEventListener('click', () => { cursor = startOfDay(new Date()); renderMain(); });
    nav.appendChild(todayBtn);
    if (view !== 'list') {
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.textContent = '←';
      prevBtn.title = t('prev');
      prevBtn.addEventListener('click', () => { shiftCursor(-1); renderMain(); });
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.textContent = '→';
      nextBtn.title = t('next');
      nextBtn.addEventListener('click', () => { shiftCursor(1); renderMain(); });
      nav.append(prevBtn, nextBtn);
    }
    navRow.appendChild(nav);

    const heading = document.createElement('span');
    heading.className = 'qu-cal-heading';
    heading.textContent = headingLabel();
    navRow.appendChild(heading);

    const editableCals = infos.filter((i) => canEdit(i.role));
    if (editableCals.length) {
      // Hidden below 720px (`.qu-cal-new-event-inline` - see STYLE): the FAB
      // is the mobile "new event" affordance instead, so this inline button
      // only reappears once the sidebar itself goes persistent.
      const newLink = document.createElement('a');
      newLink.className = 'qu-cal-primary qu-cal-new-event-inline';
      newLink.href = newEventHash(editableCals[0].id);
      newLink.textContent = `+ ${t('newEvent')}`;
      navRow.appendChild(newLink);
    }
    bar.appendChild(navRow);

    const switcher = document.createElement('div');
    switcher.className = 'qu-cal-viewswitch';
    for (const [key, label] of [['day', t('day')], ['week', t('week')], ['month', t('month')], ['list', t('list')]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.active = String(view === key);
      btn.addEventListener('click', () => { view = key; renderMain(); });
      switcher.appendChild(btn);
    }
    bar.appendChild(switcher);

    return bar;
  }

  function headingLabel() {
    if (view === 'day') return cursor.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    if (view === 'week') {
      const start = startOfWeekMon(cursor);
      const end = addDays(start, 6);
      return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    if (view === 'month') return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return '';
  }

  function shiftCursor(dir) {
    if (view === 'day') cursor = addDays(cursor, dir);
    else if (view === 'week') cursor = addDays(cursor, dir * 7);
    else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
  }

  function viewEl(events, infos) {
    const editableCals = infos.filter((i) => canEdit(i.role));
    if (view === 'day') return timeGridView([cursor], events, editableCals);
    if (view === 'week') return timeGridView(Array.from({ length: 7 }, (_, i) => addDays(startOfWeekMon(cursor), i)), events, editableCals);
    if (view === 'list') return listView(events);
    return monthView(events);
  }

  function eventChip(ev, { compact = false } = {}) {
    const el = document.createElement('a');
    el.href = eventHash(ev.calendarId, ev.id);
    el.className = compact ? 'qu-cal-chip' : 'qu-cal-event-row';
    if (compact) {
      el.style.background = ev.color;
      el.textContent = ev.title;
    } else {
      el.style.borderLeftColor = ev.color;
      const time = document.createElement('span');
      time.className = 'qu-cal-event-time';
      time.textContent = ev.allDay ? `${t('allDay')} · ${ev.calendarTitle}` : `${fmtTime(ev.start)} · ${ev.calendarTitle}`;
      const title = document.createElement('span');
      title.textContent = ev.title;
      el.append(time, title);
    }
    return el;
  }

  function monthView(events) {
    const grid = document.createElement('div');
    grid.className = 'qu-cal-month-grid';
    const monthStart = startOfMonth(cursor);
    const gridStart = startOfWeekMon(monthStart);
    const today = startOfDay(new Date());
    const isNarrow = window.matchMedia?.(MOBILE_QUERY)?.matches;
    const maxChips = isNarrow ? 2 : 3;
    for (let i = 0; i < 42; i++) {
      const day = addDays(gridStart, i);
      const cell = document.createElement('div');
      cell.className = 'qu-cal-month-cell';
      cell.dataset.dim = String(day.getMonth() !== cursor.getMonth());
      cell.dataset.today = String(sameDay(day, today));
      const num = document.createElement('div');
      num.className = 'qu-cal-day-num';
      num.textContent = String(day.getDate());
      cell.appendChild(num);

      const dayEvents = eventsTouching(events, day);
      const shown = dayEvents.slice(0, maxChips);
      for (const ev of shown) {
        const chip = eventChip(ev, { compact: true });
        if (startOfDay(new Date(ev.start)).getTime() < day.getTime()) chip.dataset.continuesFrom = 'true';
        if (startOfDay(new Date(ev.end || ev.start)).getTime() > day.getTime()) chip.dataset.continuesTo = 'true';
        cell.appendChild(chip);
      }
      if (dayEvents.length > shown.length) {
        const more = document.createElement('div');
        more.textContent = t('more', { count: dayEvents.length - shown.length });
        cell.appendChild(more);
      }
      cell.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // let a chip's own link navigate instead of also jumping to day view
        cursor = day;
        view = 'day';
        renderMain();
      });
      grid.appendChild(cell);
    }
    return grid;
  }

  function timeGridView(days, events, editableCals) {
    const wrap = document.createElement('div');

    const spanning = layoutSpanningEvents(events.filter(isMultiDay), days);
    if (spanning.length) {
      const allDayWrap = document.createElement('div');
      allDayWrap.className = 'qu-cal-allday-wrap';
      const gutter = document.createElement('div');
      gutter.className = 'qu-cal-allday-gutter';
      const grid = document.createElement('div');
      grid.className = 'qu-cal-allday-grid';
      grid.style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
      const rowCount = Math.max(...spanning.map((s) => s.row)) + 1;
      grid.style.gridTemplateRows = `repeat(${rowCount}, 1.6rem)`;
      for (const { ev, startIdx, endIdx, row, continuesFrom, continuesTo } of spanning) {
        const bar = document.createElement('a');
        bar.href = eventHash(ev.calendarId, ev.id);
        bar.className = 'qu-cal-allday-bar';
        bar.style.gridColumn = `${startIdx + 1} / ${endIdx + 2}`;
        bar.style.gridRow = String(row + 1);
        bar.style.background = ev.color;
        bar.textContent = ev.title;
        if (continuesFrom) bar.dataset.continuesFrom = 'true';
        if (continuesTo) bar.dataset.continuesTo = 'true';
        grid.appendChild(bar);
      }
      allDayWrap.append(gutter, grid);
      wrap.appendChild(allDayWrap);
    }

    const gridWrap = document.createElement('div');
    gridWrap.className = 'qu-cal-timegrid-wrap';

    const hours = document.createElement('div');
    hours.className = 'qu-cal-hours';
    const headSpacer = document.createElement('div');
    headSpacer.style.height = '1.3rem';
    hours.appendChild(headSpacer);
    for (let h = 0; h < 24; h++) {
      const lbl = document.createElement('div');
      lbl.className = 'qu-cal-hour-label';
      lbl.textContent = h === 0 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
      hours.appendChild(lbl);
    }
    gridWrap.appendChild(hours);

    const daycols = document.createElement('div');
    daycols.className = 'qu-cal-daycols';
    daycols.style.minWidth = days.length > 1 ? '30rem' : '0';
    const today = startOfDay(new Date());
    const nowLines = [];
    for (const day of days) {
      const colWrap = document.createElement('div');
      colWrap.className = 'qu-cal-daycolwrap';
      const head = document.createElement('div');
      head.className = 'qu-cal-daycol-head';
      head.dataset.today = String(sameDay(day, today));
      head.textContent = days.length > 1 ? day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : '';
      colWrap.appendChild(head);

      const col = document.createElement('div');
      col.className = 'qu-cal-daycol';
      const timed = eventsOn(events, day).filter((e) => !isMultiDay(e));
      for (const { ev, col: c, cols } of layoutTimedEvents(timed)) {
        const startMin = minutesIntoDay(ev.start, day);
        const endMin = Math.max(startMin + MIN_EVENT_MINUTES, minutesIntoDay(ev.end || ev.start, day));
        const el = document.createElement('a');
        el.href = eventHash(ev.calendarId, ev.id);
        el.className = 'qu-cal-time-event';
        el.style.top = `${(startMin / 1440) * GRID_PX}px`;
        el.style.height = `${((endMin - startMin) / 1440) * GRID_PX}px`;
        el.style.left = `${(c / cols) * 100}%`;
        el.style.width = `${100 / cols}%`;
        el.style.background = ev.color;
        el.textContent = `${fmtTime(ev.start)} ${ev.title}`;
        el.addEventListener('click', (e) => e.stopPropagation());
        col.appendChild(el);
      }

      if (sameDay(day, today)) {
        const nowLine = document.createElement('div');
        nowLine.className = 'qu-cal-now-line';
        positionNowLine(nowLine, day);
        col.appendChild(nowLine);
        nowLines.push({ el: nowLine, day });
      }

      if (editableCals.length) {
        col.addEventListener('click', (e) => {
          const rect = col.getBoundingClientRect();
          const minutes = ((e.clientY - rect.top) / GRID_PX) * 1440;
          const start = new Date(day);
          start.setHours(0, 0, 0, 0);
          start.setMinutes(Math.round(minutes / 30) * 30);
          window.location.hash = newEventHash(editableCals[0].id, start.getTime());
        });
      }

      colWrap.appendChild(col);
      daycols.appendChild(colWrap);
    }
    gridWrap.appendChild(daycols);
    wrap.appendChild(gridWrap);

    if (nowLines.length) {
      nowTimer = setInterval(() => { for (const { el, day } of nowLines) positionNowLine(el, day); }, 60000);
    }
    return wrap;
  }

  function positionNowLine(el, day) {
    el.style.top = `${(minutesIntoDay(Date.now(), day) / 1440) * GRID_PX}px`;
  }

  /** Agenda/List view - grouped by day, the mobile-default view (matches Google Calendar's own mobile "Schedule" default). */
  function listView(events) {
    const needle = filterText.trim().toLowerCase();
    const filtered = events
      .filter((ev) => !needle || ev.title.toLowerCase().includes(needle) || (ev.description ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a.start - b.start);
    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-cal-empty';
      empty.textContent = t('noEvents');
      return empty;
    }

    const wrap = document.createElement('div');
    let lastDayKey = null;
    let currentGroup = null;
    for (const ev of filtered) {
      const day = startOfDay(new Date(ev.start));
      const dayKey = day.getTime();
      if (dayKey !== lastDayKey) {
        lastDayKey = dayKey;
        const group = document.createElement('div');
        group.className = 'qu-cal-agenda-daygroup';
        const label = document.createElement('div');
        label.className = 'qu-cal-agenda-daylabel';
        label.textContent = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
        group.appendChild(label);
        currentGroup = document.createElement('ul');
        currentGroup.className = 'qu-cal-flat-list';
        group.appendChild(currentGroup);
        wrap.appendChild(group);
      }
      const li = document.createElement('li');
      const row = eventChip(ev);
      const time = row.querySelector('.qu-cal-event-time');
      if (time) time.textContent = `${ev.allDay ? t('allDay') : fmtTime(ev.start)} · ${ev.calendarTitle}`;
      li.appendChild(row);
      currentGroup.appendChild(li);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Shared event-form field builder - New Event page + Event Detail's
  // in-place Edit mode. `prefill` (only from `#/calendar/from-message`)
  // pre-populates title/description from a chat/forum message - see
  // createEventMenuItem() below.
  // ---------------------------------------------------------------------
  function buildEventForm({ mode, editableCals, startMs, existing, prefill, onSubmit, onCancel }) {
    const form = document.createElement('form');
    form.className = 'qu-cal-form';

    if (prefill) {
      const notice = document.createElement('div');
      notice.className = 'qu-cal-notice';
      notice.textContent = t('fromMessagePrefillNotice');
      form.appendChild(notice);
    }

    const titleInput = document.createElement('input');
    titleInput.placeholder = t('eventTitle');
    titleInput.required = true;
    titleInput.value = existing?.title ?? prefill?.title ?? '';
    const titleLabel = document.createElement('label');
    titleLabel.append(t('eventTitle'), titleInput);

    const descInput = document.createElement('textarea');
    descInput.placeholder = t('eventDescription');
    descInput.value = existing?.description ?? prefill?.description ?? '';
    const descLabel = document.createElement('label');
    descLabel.append(t('eventDescription'), descInput);

    const allDayInput = document.createElement('input');
    allDayInput.type = 'checkbox';
    allDayInput.checked = existing?.allDay ?? false;
    const allDayLabel = document.createElement('label');
    allDayLabel.style.flexDirection = 'row';
    allDayLabel.style.alignItems = 'center';
    allDayLabel.append(allDayInput, t('allDay'));

    const startBase = existing?.start ?? startMs ?? Date.now();
    let durationMs = existing ? Math.max(existing.end - existing.start, 0) || DEFAULT_DURATION_MS : DEFAULT_DURATION_MS;

    const startInput = document.createElement('input');
    startInput.type = 'datetime-local';
    startInput.required = true;
    startInput.value = toLocalInputValue(existing ? startBase : roundToHalfHour(new Date(startBase)).getTime());
    const startLabel = document.createElement('label');
    startLabel.append(t('start'), startInput);

    const endInput = document.createElement('input');
    endInput.type = 'datetime-local';
    endInput.value = toLocalInputValue(new Date(startInput.value).getTime() + durationMs);
    const endLabel = document.createElement('label');
    endLabel.append(t('end'), endInput);

    startInput.addEventListener('change', () => {
      const s = new Date(startInput.value).getTime();
      if (Number.isNaN(s)) return;
      endInput.value = toLocalInputValue(s + durationMs);
    });
    endInput.addEventListener('change', () => {
      const s = new Date(startInput.value).getTime();
      const eVal = new Date(endInput.value).getTime();
      if (!Number.isNaN(s) && !Number.isNaN(eVal) && eVal > s) durationMs = eVal - s;
    });

    const row = document.createElement('div');
    row.className = 'qu-cal-form-row';
    row.append(startLabel, endLabel);

    const calSelect = document.createElement('select');
    for (const cal of editableCals) {
      const option = document.createElement('option');
      option.value = cal.id;
      option.textContent = cal.meta.title || t('untitled');
      if (cal.id === existing?.calendarId) option.selected = true;
      calSelect.appendChild(option);
    }
    const calLabel = document.createElement('label');
    calLabel.append(t('calendarLabel'), calSelect);

    form.append(titleLabel, descLabel, allDayLabel, row, calLabel);

    const actions = document.createElement('div');
    actions.className = 'qu-cal-page-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => onCancel());
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'qu-cal-primary';
    submitBtn.textContent = mode === 'edit' ? t('save') : t('add');
    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) return;
      const payload = {
        id: existing?.id ?? crypto.randomUUID(),
        title,
        description: descInput.value.trim(),
        start: new Date(startInput.value).getTime(),
        end: new Date(endInput.value || startInput.value).getTime(),
        allDay: allDayInput.checked,
        guests: existing?.guests ?? [],
      };
      submitBtn.disabled = true;
      try {
        await onSubmit(payload, calSelect.value);
      } finally {
        submitBtn.disabled = false;
      }
    });

    return form;
  }

  async function editableCalendars() {
    const mine = await listMine();
    const result = [];
    for (const cal of mine) {
      const meta = await fetchMeta(cal.id);
      if (canEdit(roleOf(meta, myActorPub))) result.push({ id: cal.id, meta });
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // New Event page - `#/calendar/<calId>/new` (or `.../new/<startMs>`), or
  // `#/calendar/from-message` (landingCalId null, `prefill` from a message).
  // ---------------------------------------------------------------------
  async function renderNewEventPage(landingCalId, startMs, prefill) {
    if (stopped) return;
    const editableCals = await editableCalendars();
    if (stopped) return;

    container.textContent = '';
    container.appendChild(backLink());

    if (editableCals.length === 0) {
      const p = document.createElement('p');
      p.textContent = t('noEditableCalendars');
      container.appendChild(p);
      return;
    }

    const page = document.createElement('div');
    page.className = 'qu-cal-page';
    const h = document.createElement('h1');
    h.textContent = t('newEvent');
    page.appendChild(h);

    const targetCalId = editableCals.some((c) => c.id === landingCalId) ? landingCalId : editableCals[0].id;
    const form = buildEventForm({
      mode: 'create',
      editableCals,
      startMs,
      existing: null,
      prefill,
      onCancel: () => { window.location.hash = '#/calendar'; },
      onSubmit: async (payload, calSelectedId) => {
        await upsertEvent(calSelectedId, payload, { isNew: true });
        window.location.hash = '#/calendar';
      },
    });
    form.querySelector('select').value = targetCalId;
    page.appendChild(form);
    container.appendChild(page);
  }

  // ---------------------------------------------------------------------
  // Event Detail page - `#/calendar/<calId>/<eventId>`.
  // ---------------------------------------------------------------------
  async function renderEventDetailPage(id, eventId) {
    if (stopped) return;
    clearWatches();
    subscribe?.(paths.spacePath(SPACE_ID));
    unwatches.push(watch(qu, paths.documentPath(SPACE_ID, eventsResourceId(id)), () => renderEventDetailPage(id, eventId), { initial: false, syncFetch }));
    unwatches.push(watch(qu, paths.documentPath(SPACE_ID, metaResourceId(id)), () => renderEventDetailPage(id, eventId), { initial: false, syncFetch }));

    const meta = await fetchMeta(id);
    const eventsDoc = await fetchEvents(id);
    const ev = (eventsDoc.events ?? []).find((e) => e.id === eventId);
    if (stopped) return;

    container.textContent = '';
    container.appendChild(backLink());

    if (!meta || !ev) {
      const p = document.createElement('p');
      p.textContent = t('eventNotFound');
      container.appendChild(p);
      return;
    }
    const role = roleOf(meta, myActorPub);
    if (!role) {
      const p = document.createElement('p');
      p.textContent = t('eventNoAccess');
      container.appendChild(p);
      return;
    }

    const calendarTitle = meta.title || t('untitled');
    const withContext = { ...ev, calendarId: id, calendarTitle, color: meta.color || colorFor(id) };

    const page = document.createElement('div');
    page.className = 'qu-cal-page';
    renderEventView(page, withContext, meta, role, id);
    container.appendChild(page);
  }

  function renderEventView(page, ev, meta, role, id) {
    page.textContent = '';
    const h = document.createElement('h1');
    h.textContent = ev.title;
    page.appendChild(h);

    const metaLine = document.createElement('div');
    metaLine.className = 'qu-cal-event-time';
    metaLine.textContent = ev.allDay
      ? `${t('allDay')} · ${fmtDate(new Date(ev.start))} · ${ev.calendarTitle}`
      : `${fmtDate(new Date(ev.start))} ${fmtTime(ev.start)} – ${fmtTime(ev.end || ev.start)} · ${ev.calendarTitle}`;
    page.appendChild(metaLine);

    if (ev.description) {
      const desc = document.createElement('p');
      desc.className = 'qu-cal-detail-desc';
      desc.textContent = ev.description;
      page.appendChild(desc);
    }

    const guestsHeading = document.createElement('h3');
    guestsHeading.textContent = t('guests');
    page.appendChild(guestsHeading);
    const guestsList = document.createElement('div');
    page.appendChild(guestsList);
    renderGuests(guestsList, ev, id, canEdit(role));

    const actions = document.createElement('div');
    actions.className = 'qu-cal-page-actions';
    if (canEdit(role)) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = t('edit');
      editBtn.addEventListener('click', async () => {
        const editableCals = await editableCalendars();
        renderEventEditForm(page, ev, editableCals, id);
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'qu-cal-danger';
      delBtn.textContent = t('delete');
      delBtn.addEventListener('click', async () => {
        if (!window.confirm(t('deleteCalendarConfirm', { title: ev.title }))) return;
        await removeEvent(id, ev.id);
        window.location.hash = '#/calendar';
      });
      actions.append(editBtn, delBtn);
    } else {
      const badge = document.createElement('span');
      badge.className = 'qu-cal-badge';
      badge.textContent = t('viewOnly');
      actions.prepend(badge);
    }
    page.appendChild(actions);
  }

  function renderEventEditForm(page, ev, editableCals, id) {
    page.textContent = '';
    const h = document.createElement('h1');
    h.textContent = t('edit');
    page.appendChild(h);

    const form = buildEventForm({
      mode: 'edit',
      editableCals,
      existing: ev,
      prefill: null,
      onCancel: () => renderEventDetailPage(id, ev.id),
      onSubmit: async (payload, calSelectedId) => {
        if (calSelectedId !== id) {
          await removeEvent(id, ev.id);
          await upsertEvent(calSelectedId, payload, { isNew: true });
        } else {
          await upsertEvent(calSelectedId, payload, { isNew: false });
        }
        window.location.hash = eventHash(calSelectedId, payload.id);
        if (calSelectedId === id) await renderEventDetailPage(id, payload.id);
      },
    });
    page.appendChild(form);
  }

  function renderGuests(listEl, ev, id, editable) {
    listEl.textContent = '';
    const guests = ev.guests ?? [];
    if (guests.length === 0) {
      const p = document.createElement('p');
      p.className = 'qu-cal-status';
      p.textContent = t('noGuestsYet');
      listEl.appendChild(p);
    } else {
      for (const guest of guests) {
        const row = document.createElement('div');
        row.className = 'qu-cal-member-row';
        const name = document.createElement('span');
        name.className = 'qu-cal-member-name';
        name.textContent = shortPerson(guest.actorPub, null);
        services.profile.getPublicProfile(guest.actorPub).then((profile) => {
          if (profile?.alias) name.textContent = profile.alias;
        });
        row.appendChild(name);
        if (editable) {
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.textContent = t('remove');
          removeBtn.addEventListener('click', async () => {
            await removeGuest(id, ev.id, guest.actorPub);
            const updatedEvents = (await fetchEvents(id)).events ?? [];
            const updatedEv = updatedEvents.find((e) => e.id === ev.id) ?? ev;
            renderGuests(listEl, updatedEv, id, editable);
          });
          row.appendChild(removeBtn);
        }
        listEl.appendChild(row);
      }
    }

    if (!editable) return;
    const status = document.createElement('p');
    status.className = 'qu-cal-status';

    const pickerHost = document.createElement('div');
    listEl.appendChild(pickerHost);
    listEl.appendChild(status);
    const cleanup = mountActorPicker(pickerHost, {
      services,
      subscribe,
      excludePubs: new Set(guests.map((g) => g.actorPub)),
      onPick: async (actorPub, label) => {
        status.textContent = '';
        try {
          await inviteGuest(id, ev.id, actorPub);
          const updatedEvents = (await fetchEvents(id)).events ?? [];
          const updatedEv = updatedEvents.find((e) => e.id === ev.id) ?? { ...ev, guests: [...guests, { actorPub, invitedAt: Date.now() }] };
          renderGuests(listEl, updatedEv, id, editable);
        } catch (err) {
          status.textContent = t('inviteFailed', { name: label, message: err.message });
        }
      },
    });
    pickerCleanups.push(cleanup);
  }

  async function upsertEvent(id, payload, { isNew }) {
    const doc = await fetchEvents(id);
    const events = doc.events ?? [];
    const next = isNew ? [...events, payload] : events.map((e) => (e.id === payload.id ? payload : e));
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', eventsResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, eventsResourceId(id)), { events: next }, writeOptions);
    await notifyActivity(id, isNew ? 'created' : 'updated');
  }

  async function removeEvent(id, eventId) {
    const doc = await fetchEvents(id);
    const remaining = (doc.events ?? []).filter((e) => e.id !== eventId);
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', eventsResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, eventsResourceId(id)), { events: remaining }, writeOptions);
    await notifyActivity(id, 'deleted');
  }

  /**
   * Posts into the calendar's `activity-<calId>` Thread purely to give
   * `@qu/relay`'s push-delivery pipeline something to react to (see this
   * file's own top doc comment, and index.js's `notify.threadCandidates`
   * hook) - every OTHER current member gets an in-app notice + push, gated
   * by their own notification prefs. A no-op for a solo (owner-only) calendar.
   */
  async function notifyActivity(id, kind) {
    const meta = await fetchMeta(id);
    if (!meta || (meta.members?.length ?? 0) < 2) return;
    try {
      await services.messages.postMessage(SPACE_ID, activityThreadId(id), { body: kind, extra: { calendarId: id } });
    } catch {
      // activity thread missing (shouldn't happen post-creation) - not worth failing the actual event write over
    }
  }

  // ---------------------------------------------------------------------
  // Share page - `#/calendar/<calId>/share` - owner-only.
  // ---------------------------------------------------------------------
  async function renderSharePage(id) {
    if (stopped) return;
    clearWatches();
    subscribe?.(paths.spacePath(SPACE_ID));
    unwatches.push(watch(qu, paths.documentPath(SPACE_ID, metaResourceId(id)), () => renderSharePage(id), { initial: false, syncFetch }));

    const meta = await fetchMeta(id);
    if (stopped) return;

    container.textContent = '';
    container.appendChild(backLink());

    if (!meta || !canManage(roleOf(meta, myActorPub))) {
      window.location.hash = '#/calendar';
      return;
    }
    const color = meta.color || colorFor(id);

    const page = document.createElement('div');
    page.className = 'qu-cal-page';
    const h = document.createElement('h1');
    h.textContent = t('shareTitle', { title: meta.title || t('untitled') });
    page.appendChild(h);

    const renameForm = document.createElement('form');
    renameForm.className = 'qu-cal-form';
    const nameInput = document.createElement('input');
    nameInput.value = meta.title || '';
    const nameLabel = document.createElement('label');
    nameLabel.append(t('renameLabel'), nameInput);

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = color;
    const colorLabel = document.createElement('label');
    colorLabel.append(t('colorLabel'), colorInput);

    const renameRow = document.createElement('div');
    renameRow.className = 'qu-cal-form-row';
    renameRow.append(nameLabel, colorLabel);
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'qu-cal-primary';
    saveBtn.textContent = t('save');
    renameForm.append(renameRow, saveBtn);
    renameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(id));
      await qu.put(paths.documentPath(SPACE_ID, metaResourceId(id)), { ...meta, title: nameInput.value.trim() || t('untitled'), color: colorInput.value }, writeOptions);
    });
    page.appendChild(renameForm);

    const peopleHeading = document.createElement('h3');
    peopleHeading.textContent = t('people');
    page.appendChild(peopleHeading);

    const memberList = document.createElement('div');
    page.appendChild(memberList);
    const info = { id, meta, color };
    renderMembers(memberList, info);

    const roleSelect = document.createElement('select');
    for (const [val, label] of [['editor', t('role_editor')], ['viewer', t('role_viewer')]]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      roleSelect.appendChild(opt);
    }
    const pickerRow = document.createElement('div');
    pickerRow.className = 'qu-cal-form-row';
    const roleLabel = document.createElement('label');
    roleLabel.append(t('invite'), roleSelect);
    pickerRow.appendChild(roleLabel);
    page.appendChild(pickerRow);

    const pickerHost = document.createElement('div');
    page.appendChild(pickerHost);
    const status = document.createElement('p');
    status.className = 'qu-cal-status';
    page.appendChild(status);

    const cleanup = mountActorPicker(pickerHost, {
      services,
      subscribe,
      excludePubs: new Set(meta.members.map((m) => m.actorPub)),
      onPick: async (actorPub, label) => {
        status.textContent = '';
        try {
          await inviteMember(id, actorPub, roleSelect.value);
          const refreshedMeta = await fetchMeta(id);
          renderMembers(memberList, { ...info, meta: refreshedMeta });
        } catch (err) {
          status.textContent = t('inviteFailed', { name: label, message: err.message });
        }
      },
    });
    pickerCleanups.push(cleanup);

    container.appendChild(page);
  }

  function renderMembers(listEl, info) {
    listEl.textContent = '';
    for (const member of info.meta.members) {
      const row = document.createElement('div');
      row.className = 'qu-cal-member-row';
      const name = document.createElement('span');
      name.className = 'qu-cal-member-name';
      name.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: shortPerson(member.actorPub, null) }) : shortPerson(member.actorPub, null);
      services.profile.getPublicProfile(member.actorPub).then((profile) => {
        if (profile?.alias) name.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: profile.alias }) : profile.alias;
      });
      row.appendChild(name);

      if (member.role === 'owner') {
        const badge = document.createElement('span');
        badge.className = 'qu-cal-badge';
        badge.textContent = t('role_owner');
        row.appendChild(badge);
      } else {
        const roleSelect = document.createElement('select');
        for (const [val, label] of [['editor', t('role_editor')], ['viewer', t('role_viewer')]]) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          if (val === member.role) opt.selected = true;
          roleSelect.appendChild(opt);
        }
        roleSelect.addEventListener('change', async () => {
          await changeMemberRole(info.id, member.actorPub, roleSelect.value);
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = t('remove');
        removeBtn.addEventListener('click', async () => {
          await removeMember(info.id, member.actorPub);
          const refreshedMeta = await fetchMeta(info.id);
          renderMembers(listEl, { ...info, meta: refreshedMeta });
        });
        row.append(roleSelect, removeBtn);
      }
      listEl.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------
  // CRUD + sharing primitives
  // ---------------------------------------------------------------------

  async function createCalendar(title) {
    const calId = crypto.randomUUID();
    const members = [{ actorPub: myActorPub, role: 'owner', addedAt: Date.now() }];

    await services.access.protect(SPACE_ID, 'docs', metaResourceId(calId), { writers: [myActorPub] });
    const metaWriteOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(calId));
    await qu.put(paths.documentPath(SPACE_ID, metaResourceId(calId)), {
      id: calId, title, color: null, ownerPub: myActorPub, members, createdAt: Date.now(),
    }, metaWriteOptions);

    await services.access.protect(SPACE_ID, 'docs', eventsResourceId(calId), { writers: [myActorPub] });
    const eventsWriteOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', eventsResourceId(calId));
    await qu.put(paths.documentPath(SPACE_ID, eventsResourceId(calId)), { events: [] }, eventsWriteOptions);

    await services.messages.createThread(SPACE_ID, activityThreadId(calId), THREAD_PRESETS.activity([myActorPub]));
    await services.flags.setPrivate('calendar', 'calendar', calId, true, {});
    return calId;
  }

  /** Grows/shrinks the `events` document's writer ACL to exactly "owner + every current editor" - called after any membership/role change. */
  async function syncEventsAcl(id, members) {
    const writers = members.filter((m) => m.role === 'owner' || m.role === 'editor').map((m) => m.actorPub);
    await services.access.protect(SPACE_ID, 'docs', eventsResourceId(id), { writers }, { includeSelfAsWriter: false });
  }

  /**
   * Adds `actorPub` to the calendar's member list at `role` - a no-op if
   * already a member (existing role untouched, never silently downgraded by
   * a later invite of any kind). Shared by `inviteMember()` (a calendar-level
   * share) and `inviteGuest()` (inviting someone to one EVENT who isn't a
   * calendar member yet needs at least viewer access to see it at all).
   */
  async function ensureCalendarMembership(id, actorPub, role) {
    const meta = await fetchMeta(id);
    if (meta.members.some((m) => m.actorPub === actorPub)) return meta;
    const members = [...meta.members, { actorPub, role, addedAt: Date.now() }];
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, metaResourceId(id)), { ...meta, members }, writeOptions);
    await syncEventsAcl(id, members);
    await services.messages.addReader(SPACE_ID, activityThreadId(id), actorPub);
    return { ...meta, members };
  }

  async function inviteMember(id, actorPub, role) {
    const meta = await fetchMeta(id);
    // Attempted FIRST, before any membership state is written: a resolvable-
    // key failure aborts the whole invite instead of silently granting
    // access nobody was actually notified about (same ordering QuV2's own
    // calendar used, and every other real-invite flow in this codebase).
    try {
      await services.messages.notify(SPACE_ID, actorPub, 'invited', { calendarId: id, calendarTitle: meta?.title ?? t('untitled') });
    } catch {
      throw new Error('their profile hasn’t synced yet - try again shortly');
    }
    await ensureCalendarMembership(id, actorPub, role);
  }

  /**
   * Invites `actorPub` to ONE event rather than the whole calendar - grants
   * viewer access if not already a member, records them on the event's own
   * `guests` list. Notified via the separate `guestInvite` pushAction (see
   * index.js's own `notify.threadCandidates` hook), so "invited to a
   * calendar" and "invited to one event" stay independently toggleable.
   */
  async function inviteGuest(id, eventId, actorPub) {
    try {
      await services.messages.createThread(SPACE_ID, guestThreadId(eventId, actorPub), THREAD_PRESETS.mail(actorPub));
      await services.messages.postMessage(SPACE_ID, guestThreadId(eventId, actorPub), { body: 'invited', extra: { calendarId: id, eventId } });
    } catch {
      throw new Error('their profile hasn’t synced yet - try again shortly');
    }

    await ensureCalendarMembership(id, actorPub, 'viewer');

    const doc = await fetchEvents(id);
    const events = (doc.events ?? []).map((e) => (e.id === eventId ? { ...e, guests: [...(e.guests ?? []), { actorPub, invitedAt: Date.now() }] } : e));
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', eventsResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, eventsResourceId(id)), { events }, writeOptions);
  }

  async function removeGuest(id, eventId, actorPub) {
    const doc = await fetchEvents(id);
    const events = (doc.events ?? []).map((e) => (e.id === eventId ? { ...e, guests: (e.guests ?? []).filter((g) => g.actorPub !== actorPub) } : e));
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', eventsResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, eventsResourceId(id)), { events }, writeOptions);
  }

  async function changeMemberRole(id, actorPub, role) {
    const meta = await fetchMeta(id);
    const members = meta.members.map((m) => (m.actorPub === actorPub ? { ...m, role } : m));
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, metaResourceId(id)), { ...meta, members }, writeOptions);
    await syncEventsAcl(id, members);
  }

  async function removeMember(id, actorPub) {
    const meta = await fetchMeta(id);
    const members = meta.members.filter((m) => m.actorPub !== actorPub);
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, metaResourceId(id)), { ...meta, members }, writeOptions);
    await syncEventsAcl(id, members);
    try { await services.messages.removeReader(SPACE_ID, activityThreadId(id), actorPub); } catch { /* no activity thread yet - nothing to revoke */ }
  }

  /**
   * Owner-only calendar deletion - tombstones the `meta` document (`null`,
   * the same "QuStore has no delete()" convention every other entity kind in
   * this codebase uses). Every `roleOf()` check anywhere in this file then
   * resolves to `null` for EVERYONE including the owner, which is what
   * actually makes a deleted calendar disappear/become inert everywhere it's
   * rendered. Only unstars it from THIS identity's own "My Calendars" - other
   * members' stars are locally theirs to manage and self-heal the moment
   * they next open the app (`renderMain()`'s own `role`-less skip).
   */
  async function deleteCalendar(id) {
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, metaResourceId(id)), null, writeOptions);
    await services.flags.setPrivate('calendar', 'calendar', id, false);
    checked?.delete(id);
  }

  return () => {
    stopped = true;
    clearWatches();
  };
}

// ===========================================================================
// `content.messageMenu` contributor - lets a chat/forum message become a
// calendar event: the message BODY becomes the new event's description, and
// (when the message lives in a forum topic - "a Topic IS its Thread", see
// @qu/services' ChannelService doc comment) the topic's own title is offered
// as the event's suggested TITLE, falling back to a truncated snippet of the
// body for a chat message (no topic concept there). This only demonstrates
// the cross-app wiring the task asked for - the resulting New Event page is
// the exact same real, editable form every other route uses, nothing here
// writes a calendar event directly.
// ===========================================================================
function suggestedTitleFromBody(body) {
  const oneLine = body.trim().split('\n')[0];
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/**
 * @param {{services: object, qu: object, spaceId: string, threadId: string, messageId: string, myPub: string, mine: boolean, body: string, author: string}} payload
 * @returns {Promise<{id: string, label: string, icon: string, onClick: () => void}>}
 */
export async function createEventMenuItem({ qu, spaceId, threadId, body }) {
  return {
    id: 'createCalendarEvent',
    label: t('createEventFromMessage'),
    icon: '📅',
    onClick: async () => {
      let title = suggestedTitleFromBody(body || '');
      try {
        // Works when `threadId` is a forum Topic (its id IS its own Thread
        // id - see ChannelService's own doc comment); a plain chat room id
        // simply won't resolve to a document here, so `title` stays the
        // body-derived fallback above.
        const topicBit = await qu.get(paths.documentPath(spaceId, threadId));
        if (topicBit?.val?.title) title = topicBit.val.title;
      } catch { /* not a forum topic, or unreachable - fall back to the body-derived title */ }

      try {
        window.sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ title, description: body || '' }));
      } catch { /* private browsing / storage disabled - the New Event page just opens blank */ }
      window.location.hash = '#/calendar/from-message';
    },
  };
}
