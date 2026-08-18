/**
 * CHAT — a Telegram/WhatsApp/Signal-style messenger: a room list (1:1 rooms
 * derived from Contacts, plus groups this identity has been invited to) and
 * a room view with message bubbles. Ported from QuV2's `apps/chat/client.js`
 * (2600+ lines - room list, 1:1/group rooms, reactions, pins, replies,
 * forwarding, attachments, voice messages, location sharing, search) onto
 * V3's primitives, deliberately LEANER where V3 already gives a real, free
 * substitute rather than re-implementing the same feature twice - see SCOPE
 * below for exactly what that trades away.
 *
 * ENCRYPTION IS THE DEFAULT for both room kinds, not an opt-in: a 1:1 room
 * (`THREAD_PRESETS.chat`, via `ChatService.ensureRoom()`) and a group
 * (`THREAD_PRESETS.group`, via `ChatService.createGroup()`) both set
 * `readers` to the fixed member list, which makes every message body AND
 * every attachment end-to-end encrypted for exactly those members - a relay
 * operator, or anyone else syncing the space, sees ciphertext only. See
 * `ChatService`'s own doc comment for the 1:1 room-id derivation and the
 * group-invite-mailbox mechanism.
 *
 * GROUP MEMBERSHIP IS FIXED AT CREATION - `THREAD_PRESETS.group()`'s own
 * doc comment already states why (re-keying history for a changed member
 * set is real future work, not implemented here or in QuV2).
 *
 * MESSAGE CHROME: one "⋮" context menu (`content.messageMenu`,
 * `@qu/thread-ui`'s `renderContextMenu()`) instead of a row of always-
 * visible buttons - this app's own native items are Edit (own messages)
 * and Reply (any message), merged with whatever `apps/pins`/`apps/bookmarks`
 * contribute. The per-message footer ROW (`content.messageFooter`) is that
 * menu's own trigger + timestamp + this identity's read-tick (own messages
 * only) + Reactions' own live widget, side by side - see
 * `buildMessageFooter()`. BOTH the row's own item order and the menu's own
 * item order come from `@qu/foundation`'s `rankFor()` against
 * `extensionPoints.order` (relay-settings' admin-edited `extensionOrder`,
 * edited via `apps/relay-admin`), falling back to this file's own
 * `FOOTER_ORDER_DEFAULT`/`MENU_ORDER_DEFAULT` - the SAME two default maps
 * `apps/forum/client.js` uses, so the two apps render identically ordered
 * chrome out of the box without either importing the other.
 *
 * REUSE OVER RE-IMPLEMENTATION, V3's actual advantage over the QuV2 port:
 *   - Reactions/pins/bookmarks are NOT reimplemented here at all - this
 *     file renders the SAME `content.messageFooter`/`content.messageMenu`
 *     extension points `apps/forum` already defines, so `apps/reactions`/
 *     `apps/pins`/`apps/bookmarks` (admin-toggleable via relay-settings'
 *     `disabledApps`, zero chat-specific code) render/contribute directly.
 *     `ExtensionPointHost` is keyed purely by point NAME (see
 *     `@qu/foundation`'s `extension-points.js`), not by which app's own
 *     manifest happens to declare it first - nothing stops a second
 *     consumer app from rendering into an already-declared point.
 *   - Mention/emoji autocomplete reuse `@qu/thread-ui`'s
 *     `mountMentionAutocomplete()`/`mountEmojiAutocomplete()`/
 *     `renderEmojiPicker()`/`insertAtCursor()` unchanged - the exact
 *     primitives `apps/forum`'s own composer already uses, and the reason
 *     that package's own doc comment names "a future apps/chat port" as
 *     its second real consumer.
 *   - Attachments reuse `@qu/ui`'s `<qu-asset-upload>`/`<qu-asset>` over
 *     `services.assets` unchanged - same pattern as `apps/forum`'s own
 *     attachment integration, with this room's `readers` passed as
 *     `readerPubs` so an attachment gets the SAME end-to-end encryption as
 *     the message body sitting next to it.
 *   - Per-user settings (see `renderChatSettings()` at the bottom of this
 *     file) are contributed to `apps/profile`'s `userSettings.contributions`
 *     extension point instead of a chat-local settings screen QuV2 had to
 *     build itself - reachable at `#/~<pub>/settings`, discoverable in the
 *     one place every other app's per-user preferences already live.
 *   - Group-creation policy is admin-configurable via relay-settings' own
 *     `chat.allowMemberCreateGroup` (see `packages/relay/src/relay-settings.js`)
 *     and a Relay Admin UI section, mirroring `apps/forum`'s own
 *     `channels.allowMemberCreate` - CLIENT-SIDE gating only, matching that
 *     field's own documented scope (hides the UI, doesn't yet stop a
 *     modified client from calling `services.chat.createGroup()` directly).
 *
 * READ STATE: `PresenceService.publishReadReceipt()` (PUBLIC, visible to
 * other members - what powers the "read" tick on a SENDER's own messages)
 * is published whenever this identity views a room's newest message;
 * `MessageService.markRead()` (PRIVATE) drives this identity's OWN unread
 * dot in the room list. Presence (online/last-seen) is polled on a fixed
 * interval while a room view is mounted - `PresenceService.getPresence()`
 * is explicitly a STALENESS check, not a push mechanism (see its own doc
 * comment), so polling is the intended usage, not a shortcut.
 *
 * Routes: `#/chat` (room list), `#/chat/<peerActorPub>` (1:1 room),
 * `#/chat/g/<groupId>` (group room), `#/chat/new-group` (create-group form),
 * plus an optional trailing `/m/<messageId>` on either room route - a
 * message PERMALINK (see `mount()`'s own route-parsing comment).
 *
 * NAVIGATION (`docs/app-navigation-standard.md` Rule 5): both the room list
 * (`mountRoomListView()`) and an open room (`mountRoomView()`) mount through
 * `@qu/ui`'s `mountAppTemplate()` - `primaryAction` is "+ New group" (the
 * global header's `shell.headerNavPoints` contributor this app used to
 * ship is gone, superseded by this), and an open room ALSO gets
 * `navigation`: every room (1:1 + group), the current one marked active - a
 * real room-switcher sidebar on wide screens, a pill+popup in the mobile
 * footer, so switching rooms no longer means going back to `#/chat` first.
 * Both fields depend on an async fetch (contacts/groups, and the
 * group-creation policy check `fetchChatPolicy()` already did) that isn't
 * ready at the one synchronous `mountAppTemplate()` call - `stopTemplate.
 * update({...})` (see that function's own "LATE-ARRIVING CHROME DATA" doc
 * comment) fills them in once resolved, same "build immediately, fill in via
 * your own async IIFE" shape every other async render in this file already
 * follows. `listRooms()` (shared by both views) is the one place that
 * computes "what rooms exist, in what order, with what unread/muted state".
 *
 * PERMALINKS + SCROLL-FOLLOW: a message's timestamp (see
 * `buildMessageFooter()`) IS its permalink - clicking it (or landing on one
 * from Search/a notification, see `searchChat()`/`resolveChatReference()`)
 * scrolls that message to the TOP of the view and briefly highlights it
 * (`.qu-chat-bubble-row-highlight`). `mountRoomView()` also tracks whether
 * the user is currently scrolled to the bottom (`stuckToBottom`): true by
 * default, false when landing on an older permalink so the jump-to isn't
 * immediately overridden. Scrolling back down to the bottom re-engages it
 * (AND strips a lingering `/m/<id>` back out of the URL, see
 * `releasePermalinkAnchor()`); scrolling away releases it. A new message
 * (re-run on every write via `watchChildren()`) only force-scrolls the view
 * when `stuckToBottom` is still true - otherwise a small "↓ New message"
 * banner appears instead (`newMessageBanner`, click-to-catch-up), never an
 * automatic jump away from whatever the user was reading. See
 * `renderMessages()`'s own doc comment for HOW a new message is applied
 * without disturbing the current scroll position (incremental append, not
 * a full rebuild, for the common case).
 *
 * COMPOSER: a rounded "pill" (textarea + emoji trigger) plus a "+" action-
 * menu trigger (`content.composerActions` - Attach/Share location, plus
 * whatever plugin apps contribute, e.g. a Calendar/Gallery app's own entry
 * or a game's own "share a challenge" - see that menu's own doc comment in
 * `mountRoomView()`) and ONE circular action button that MORPHS between
 * 🎙️ (composer empty) and ➤ send (composer has text) - Telegram/WhatsApp's
 * own composer language, not a flat text-input row with a line of plain
 * buttons after it. See `updateActionBtn()`. The textarea itself starts at
 * ONE visual line and grows up to `COMPOSER_MAX_ROWS` before scrolling
 * internally (`@qu/thread-ui`'s `mountComposerAutogrow()`), rather than
 * opening two lines tall by default the way an un-sized `<textarea>`'s own
 * UA-default `rows="2"` otherwise would.
 *
 * VOICE MESSAGES: `MediaRecorder` (feature-detected - silently falls back
 * to a `voiceNotSupported` hint on a browser/device without it), with a real
 * Start/Pause/Resume/Finish/Preview/Send flow ported from QuV2
 * (https://github.com/ReactivityJS/QuV2) - tapping the mic starts recording
 * and swaps the whole composer row for `voiceRecorderEl` (a pause/resume
 * toggle, a finish button, a live elapsed-time readout, and a discard
 * escape hatch); Finish does NOT send immediately, it stops into a PREVIEW
 * state with a real `<audio controls>` player over the recorded `Blob` so
 * the user can listen back before committing, with Send and Discard as the
 * only two ways out. See the state machine starting at `recorderState`
 * (near `startRecording()`). Only on Send is the `Blob` uploaded, through
 * the EXACT SAME `services.assets.upload()` + `message.extra.attachment`
 * shape a file attachment already uses (see `attachUpload`'s own
 * `qu-asset-uploaded` handler) - so `<qu-asset kind="auto">`'s existing MIME
 * sniff (`@qu/ui`'s `asset-components.js`) picks `audio` and renders a
 * native `<audio controls>` player for the SENT message too, zero new
 * rendering code needed there. `message.extra.voice: true` only suppresses
 * the redundant placeholder body text (`t('voiceMessage')`) next to the
 * player - see `renderMessageText()`.
 *
 * LOCATION SHARING: one-time position (`navigator.geolocation`, also
 * feature-detected), sent as `message.extra.location: {lat, lng}` - a
 * message-list entry like any other, not a special view. Deliberately NO
 * embedded map-TILE preview image: rendering one would mean fetching from a
 * third-party tile server on every view of the message, leaking this room's
 * location to a party beyond the relay/its members - just a link out to
 * OpenStreetMap plus the raw coordinates as text.
 *
 * SCOPE - deliberately NOT ported from QuV2's messenger, left for a real
 * follow-up round rather than half-built here: forwarding, per-chat/global
 * search with link/file/image/date filters, a three-state (sent/relay-
 * confirmed/read) tick - this app renders a simpler two-state (sent/read)
 * tick instead, since no client-side hook into `SyncEngine.waitForAck()` is
 * wired through `services` yet. A recorded voice message has no waveform
 * scrubber (the native `<audio controls>` element's own scrubber covers
 * playback position, both live during recording/preview and once sent) and
 * no press-and-hold-to-record/slide-to-cancel gesture (tap-to-start, plus
 * explicit Pause/Finish/Discard buttons, instead) - both real, valid
 * follow-ups, not attempted half-way here. Visual `@mention` highlighting inside a
 * message body is also not rendered (the underlying `mentions` field still
 * drives push notification routing via this app's own `pushActions`, which
 * is the part that actually matters functionally) - bare `http(s)://` links
 * are auto-linked via `@qu/services`' shared `detectLinks()`, and the FIRST
 * link in a message also gets a preview card (`<qu-link-preview>`, `@qu/ui`'s
 * `link-preview-components.js`) fetched relay-side from `@qu/relay`'s own
 * `/link-preview` route - see that route's own doc comment
 * (`packages/relay/src/link-preview.js`) for the SSRF-guarded server-side
 * Open Graph unfurling this is built on.
 */
import { watch, watchChildren } from '@qu/reactive';
import { paths, formatActorLabel, getPrivate, putPrivate, getPrivateChildren, detectLinks, ChatService } from '@qu/services';
import { rankFor } from '@qu/foundation';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderAvatarOrAsset, renderSubpage, mountAppTemplate } from '@qu/ui';
import {
  renderEmojiPicker, renderContextMenu, mountMentionAutocomplete, mountEmojiAutocomplete, insertAtCursor, copyToClipboard,
  mountComposerAutogrow, COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS, flipUpIfNeeded,
} from '@qu/thread-ui';

// See this file's own top doc comment's "MESSAGE CHROME" section - the
// SAME two default-order maps `apps/forum/client.js` uses (keep both files'
// copies identical if either ever changes), so `content.messageFooter`/
// `content.messageMenu` render in the same default order in both apps
// before an admin configures relay-settings' own `extensionOrder`.
const FOOTER_ORDER_DEFAULT = { reactions: 0, 'core.menu': 10, 'core.timestamp': 20, 'core.readReceipt': 30 };
const MENU_ORDER_DEFAULT = { edit: 0, reply: 5, pin: 10, bookmark: 20, copyText: 30, copyLink: 40 };
// The composer's own "+" action menu (content.composerActions - see this
// file's own top doc comment) - SAME default-order convention as the two
// maps above, kept identical to apps/forum/client.js's own copy (minus
// 'location', which forum's composer has no equivalent of).
const COMPOSER_ACTIONS_ORDER_DEFAULT = { attach: 0, location: 10 };

const DICT = {
  en: {
    title: 'Chats',
    empty: 'No chats yet - add a contact from the User List, or start a group.',
    online: 'online',
    lastSeen: 'last seen {time}',
    membersOnline: '{count} members, {online} online',
    composerPlaceholder: 'Message',
    send: 'Send',
    edit: 'Edit', save: 'Save', cancel: 'Cancel',
    reply: 'Reply', replyingTo: 'Replying to {name}',
    moreActions: 'More actions',
    roomMenu: 'Chat options',
    muteChat: 'Mute notifications',
    unmuteChat: 'Unmute notifications',
    copyText: 'Copy text',
    copyLink: 'Copy link',
    attachRemove: 'Remove attachment',
    addAttachment: 'Add',
    attachFile: 'Attach file',
    insertEmoji: 'Insert emoji',
    recordVoice: 'Record a voice message',
    voicePause: 'Pause recording',
    voiceResume: 'Resume recording',
    voiceFinish: 'Finish recording',
    voiceDiscard: 'Discard recording',
    voiceNotSupported: 'Voice messages aren\'t supported in this browser.',
    voiceMessage: '🎙️ Voice message',
    shareLocation: 'Share my location',
    locationMessage: 'Location',
    newChatGroup: 'New chat group',
    createGroup: 'Create group',
    groupName: 'Group name',
    selectMembers: 'Add members',
    noContacts: 'No contacts yet - add some from the User List first.',
    groupNotFound: 'This group doesn\'t exist, or you\'re not a member.',
    you: 'You',
    read: 'Read', sent: 'Sent',
    showAliasIn1to1: 'Show sender name in 1:1 chats',
    ownColor: 'Your message color',
    saved: 'Saved.',
    searchResultIn: 'in "{room}"',
    permalink: 'Link to this message',
    messageRequests: 'Message requests',
    accept: 'Accept',
    decline: 'Decline',
    newMessagesBelow: '↓ New message',
    scrollToBottomButton: '↓',
    originalMessageUnavailable: 'Original message',
  },
  de: {
    title: 'Chats',
    empty: 'Noch keine Chats - Kontakt aus der Nutzerliste hinzufügen oder eine Gruppe starten.',
    online: 'online',
    lastSeen: 'zuletzt online {time}',
    membersOnline: '{count} Mitglieder, {online} online',
    composerPlaceholder: 'Nachricht',
    send: 'Senden',
    edit: 'Bearbeiten', save: 'Speichern', cancel: 'Abbrechen',
    reply: 'Antworten', replyingTo: 'Antwort an {name}',
    moreActions: 'Weitere Aktionen',
    roomMenu: 'Chat-Optionen',
    muteChat: 'Benachrichtigungen stummschalten',
    unmuteChat: 'Stummschaltung aufheben',
    copyText: 'Text kopieren',
    copyLink: 'Link kopieren',
    attachRemove: 'Anhang entfernen',
    addAttachment: 'Hinzufügen',
    attachFile: 'Datei anhängen',
    insertEmoji: 'Emoji einfügen',
    recordVoice: 'Sprachnachricht aufnehmen',
    voicePause: 'Aufnahme pausieren',
    voiceResume: 'Aufnahme fortsetzen',
    voiceFinish: 'Aufnahme abschließen',
    voiceDiscard: 'Aufnahme verwerfen',
    voiceNotSupported: 'Sprachnachrichten werden in diesem Browser nicht unterstützt.',
    voiceMessage: '🎙️ Sprachnachricht',
    shareLocation: 'Meinen Standort teilen',
    locationMessage: 'Standort',
    newChatGroup: 'Neue Chat-Gruppe',
    createGroup: 'Gruppe erstellen',
    groupName: 'Gruppenname',
    selectMembers: 'Mitglieder hinzufügen',
    noContacts: 'Noch keine Kontakte - zuerst in der Nutzerliste hinzufügen.',
    groupNotFound: 'Diese Gruppe existiert nicht, oder du bist kein Mitglied.',
    you: 'Du',
    read: 'Gelesen', sent: 'Gesendet',
    showAliasIn1to1: 'Absendername in 1:1-Chats anzeigen',
    ownColor: 'Deine Nachrichtenfarbe',
    saved: 'Gespeichert.',
    searchResultIn: 'in „{room}“',
    permalink: 'Link zu dieser Nachricht',
    messageRequests: 'Nachrichtenanfragen',
    accept: 'Annehmen',
    decline: 'Ablehnen',
    newMessagesBelow: '↓ Neue Nachricht',
    scrollToBottomButton: '↓',
    originalMessageUnavailable: 'Ursprüngliche Nachricht',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-chat-style';
const STYLE = `
  .qu-chat-rooms { list-style: none; margin: 0 0 0.8rem; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; max-width: 34rem; }
  .qu-chat-room-row a { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.6rem; border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-chat-room-row a:hover { background: var(--qu-color-border, #8884); }
  .qu-chat-room-main { flex: 1; min-width: 0; }
  .qu-chat-room-name-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .qu-chat-room-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-room-ts { font-size: 0.75em; opacity: 0.6; flex-shrink: 0; }
  .qu-chat-room-preview { font-size: 0.85em; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-room-unread { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--qu-color-accent, #5b5bd6); flex-shrink: 0; }
  /* MESSAGE REQUESTS - see ChatService's own "1:1 DISCOVERY" doc comment.
     A visually separate block ABOVE the normal room list (not just another
     room row) - accepting/declining is a decision, not navigation, so it
     deliberately doesn't look clickable-into-a-conversation the way an
     ordinary room row does. */
  .qu-chat-requests-heading { font-size: 0.85em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.6; margin: 0 0 0.4rem; }
  .qu-chat-requests { list-style: none; margin: 0 0 1rem; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; max-width: 34rem; }
  .qu-chat-request-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.6rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); }
  .qu-chat-request-main { flex: 1; min-width: 0; }
  .qu-chat-request-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-request-pub { font-size: 0.78em; opacity: 0.6; font-family: var(--qu-font-mono, ui-monospace, monospace); }
  .qu-chat-request-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
  .qu-chat-request-actions button { padding: 0.3rem 0.7rem; border-radius: var(--qu-radius-sm, 0.3rem); border: 1px solid var(--qu-color-border, #8884); background: transparent; cursor: pointer; font: inherit; }
  .qu-chat-request-actions button:first-child { background: var(--qu-color-accent, #5b5bd6); color: white; border-color: transparent; }
  .qu-chat-empty { padding: 1.5rem; text-align: center; opacity: 0.7; }
  /* ROOM VIEW LAYOUT - mounted with mountAppTemplate({fullHeight: true, ...})
     now (see this file's own top doc comment and @qu/ui's app-template.js
     own "FULL HEIGHT MODE" doc comment for the full "why fixed, not
     calc(100vh)" reasoning, which now lives there instead of here - the
     Core's .qu-apptpl-root--full-height/.qu-apptpl-content already do
     the real, viewport-relative position: fixed sizing this room view
     used to do entirely on its own). This element is now just a plain flex
     COLUMN filling whatever height .qu-apptpl-content hands it - flex: 1;
     min-height: 0 is what makes it actually stretch, the same "only the
     messages-scroll element scrolls internally, header/composer-wrap are
     flex-shrink: 0 siblings" structure as before, unchanged. */
  .qu-chat-room-view { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--qu-color-surface, #ffffff); }
  .qu-chat-header { flex-shrink: 0; display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 1rem; border-bottom: 1px solid var(--qu-color-border, #8884); background: var(--qu-color-surface, #ffffff); }
  .qu-chat-header-namewrap { min-width: 0; overflow: hidden; }
  .qu-chat-header-nameline { display: flex; align-items: center; gap: 0.35rem; min-width: 0; }
  .qu-chat-header-name { font-weight: 700; font-size: 1.1em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-chat-header-status { font-size: 0.8em; opacity: 0.65; }
  .qu-chat-header-muted, .qu-chat-room-muted { flex-shrink: 0; font-size: 0.9em; opacity: 0.75; }
  .qu-chat-header-menu-btn { margin-left: auto; }
  .qu-chat-messages-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 1rem; }
  /* NEW MESSAGE BANNER - see mountRoomView()'s own creation site and
     renderMessages()'s "NO SPURIOUS JUMPS" doc comment. position: sticky
     (not absolute/fixed) pins it near the bottom of the CURRENTLY VISIBLE
     scroll area with zero JS position math - its natural in-flow position
     is right after every message (the very end of messagesScroll's
     content), so "stuck" at bottom: 1rem only ever actually applies while
     that natural position is below the visible viewport, i.e. exactly
     while there's unseen content to scroll down to. Hidden (display:none
     via [hidden]) removes it from flow entirely, so it never reserves
     space or affects scrollHeight while not shown. */
  .qu-chat-scroll-bottom-btn { position: sticky; bottom: 1rem; left: 50%; transform: translateX(-50%); display: block; width: fit-content; padding: 0.4rem 0.9rem; border: none; border-radius: 999px; background: var(--qu-color-accent, #5b5bd6); color: white; font: inherit; font-size: 0.85em; cursor: pointer; box-shadow: 0 0.2rem 0.6rem rgba(0,0,0,0.25); }
  .qu-chat-scroll-bottom-btn:hover { filter: brightness(1.08); }
  .qu-chat-scroll-bottom-btn[hidden] { display: none; }
  .qu-chat-scroll-bottom-btn-unseen { background: var(--qu-color-danger, #d64545); }
  .qu-chat-messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; max-width: 40rem; }
  .qu-chat-bubble-row { display: flex; }
  .qu-chat-bubble-row-mine { justify-content: flex-end; }
  /* PERMALINKS - see this file's own top doc comment. Landing on
     #/chat/.../m/<id> scrollIntoView()s this row (block: 'center', so the
     target isn't glued to the very top edge, right under the fixed header)
     then briefly highlights it so "here it is" is obvious even once the
     scroll settles - matching apps/forum/client.js's own identical
     treatment for a topic permalink. A CSS animation (not a transition)
     fades it out on its own timeline; the JS side just removes the class
     once, after the same duration, so nothing has to track animation-end. */
  @keyframes qu-chat-bubble-row-highlight-fade { from { outline-color: var(--qu-color-accent, #5b5bd6); } to { outline-color: transparent; } }
  .qu-chat-bubble-row-highlight .qu-chat-bubble { outline: 2px solid var(--qu-color-accent, #5b5bd6); outline-offset: 2px; animation: qu-chat-bubble-row-highlight-fade 2s ease forwards; }
  /* A soft "tail" via asymmetric corners - the corner nearest the avatar
     side stays sharp, matching Telegram/WhatsApp's own bubble language -
     plus a faint shadow so bubbles read as distinct surfaces, not just
     flat-colored text blocks. */
  .qu-chat-bubble { max-width: 75%; padding: 0.45rem 0.7rem; border-radius: var(--qu-radius-lg, 0.9rem) var(--qu-radius-lg, 0.9rem) var(--qu-radius-lg, 0.9rem) var(--qu-radius-sm, 0.25rem); background: var(--qu-color-surface, #8882); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  .qu-chat-bubble-mine { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 25%, transparent); border-radius: var(--qu-radius-lg, 0.9rem) var(--qu-radius-lg, 0.9rem) var(--qu-radius-sm, 0.25rem) var(--qu-radius-lg, 0.9rem); }
  .qu-chat-bubble-author { font-size: 0.78em; font-weight: 600; opacity: 0.8; margin-bottom: 0.1rem; }
  .qu-chat-bubble-reply { display: block; border-left: 2px solid var(--qu-color-accent, #5b5bd6); padding-left: 0.4rem; margin-bottom: 0.25rem; font-size: 0.82em; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-decoration: none; cursor: pointer; }
  .qu-chat-bubble-reply:hover { opacity: 1; text-decoration: underline; }
  .qu-chat-bubble-text { overflow-wrap: anywhere; white-space: pre-wrap; }
  .qu-chat-bubble-text a { color: inherit; }
  .qu-chat-bubble-location { margin-top: 0.2rem; }
  .qu-chat-bubble-location a { color: inherit; font-weight: 600; text-decoration: none; }
  .qu-chat-bubble-location a:hover { text-decoration: underline; }
  .qu-chat-bubble-location-coords { font-size: 0.78em; opacity: 0.7; margin-top: 0.1rem; }
  /* The per-message footer ROW (content.messageFooter) - menu trigger,
     timestamp, read-tick, reactions, in whatever order rankFor() resolves
     (admin-configurable, see this file's own top doc comment and
     FOOTER_ORDER_DEFAULT above). Each segment renders into its own <span>
     child, laid out by this one flex rule - mirrors
     apps/forum/client.js's own .qu-forum-message-footer exactly: NO
     font-size/opacity here, only on the timestamp text itself (below).
     Shrinking the whole row (a previous version of this rule did) also
     shrinks the "+" reaction/"⋮" menu triggers it contains, since
     @qu/thread-ui's own CSS sizes both in em units - well under a
     comfortable touch target. Forum never had that bug (its own message
     footer rule never set font-size), which is why its message row always
     felt more touch-friendly than Chat's despite both rendering the exact
     same @qu/thread-ui components (renderContextMenu()/renderEmojiPicker())
     into content.messageMenu/content.messageFooter. */
  .qu-chat-bubble-footer { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.3rem; flex-wrap: wrap; }
  .qu-chat-bubble-timestamp-link { font-size: 0.75em; opacity: 0.6; color: inherit; text-decoration: none; }
  .qu-chat-bubble-timestamp-link:hover { text-decoration: underline; }
  /* The read-tick segment is its own tap target (see buildMessageFooter()'s
     own doc comment on the read-time popover) - position: relative so the
     popover it opens can anchor to it via position: absolute. */
  .qu-chat-bubble-footer [data-segment="core.readReceipt"] { position: relative; font-size: 0.85em; opacity: 0.6; }
  .qu-chat-bubble-tick-read { color: var(--qu-color-accent, #5b5bd6); opacity: 1; cursor: pointer; }
  .qu-chat-bubble-tick-popover { position: absolute; z-index: 20; bottom: 100%; right: 0; margin-bottom: 0.3rem; padding: 0.3rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); background: var(--qu-color-surface, #ffffff); border: 1px solid var(--qu-color-border, #8884); box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.2); font-size: 0.85em; white-space: nowrap; }
  .qu-chat-bubble-tick-popover-flip-up { bottom: 100%; }
  .qu-chat-bubble-attachment { margin-top: 0.4rem; max-width: 16rem; }
  .qu-chat-edit-row { display: flex; flex-direction: column; gap: 0.3rem; position: relative; }
  .qu-chat-edit-row textarea { font: inherit; padding: 0.35rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; }
  .qu-chat-edit-row-buttons { display: flex; gap: 0.4rem; }
  .qu-chat-reply-banner { display: flex; justify-content: space-between; align-items: center; padding: 0.3rem 0.6rem; border-left: 3px solid var(--qu-color-accent, #5b5bd6); background: var(--qu-color-surface, #8882); border-radius: var(--qu-radius-sm, 0.3rem); font-size: 0.85em; margin-bottom: 0.3rem; }
  .qu-chat-reply-banner button { background: none; border: none; cursor: pointer; opacity: 0.7; font: inherit; }
  /* Without this, replyBanner.hidden = true (its initial/cleared state) never
     actually hides anything - the class rule above is an author-stylesheet
     rule, which always beats the UA's own [hidden] rule regardless of
     specificity, so the empty banner stayed rendered as a bare rounded
     left-accent stripe above the composer (looked like a stray "(" sitting
     on its own line) whenever no reply was active. Same fix, same root
     cause, as .qu-asset-upload-progress[hidden] in @qu/ui's
     asset-components.js and apps/forum/client.js's own
     .qu-forum-reply-banner[hidden] (forum never had this bug - chat did). */
  .qu-chat-reply-banner[hidden] { display: none; }
  .qu-chat-composer-wrap { flex-shrink: 0; display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem 1rem; border-top: 1px solid var(--qu-color-border, #8884); background: var(--qu-color-surface, #ffffff); }
  /* The composer: a "+" action-menu trigger (Attach/Share location/plugin
     items - content.composerActions, see mountRoomView()'s own doc comment -
     rather than always-visible icons per action), a rounded PILL holding the
     textarea + emoji trigger, and one circular action button that morphs
     mic <-> send (see updateActionBtn() in mountRoomView()) - Telegram/
     WhatsApp's own composer language, not a single flat text-input row with
     a row of plain buttons after it. */
  .qu-chat-composer { display: flex; align-items: flex-end; gap: 0.4rem; position: relative; }
  .qu-chat-composer-tools { display: flex; align-items: center; gap: 0.2rem; padding-bottom: 0.35rem; }
  .qu-chat-tool-btn { background: none; border: none; cursor: pointer; font-size: 1.1em; padding: 0.3rem; border-radius: 999px; opacity: 0.75; }
  .qu-chat-tool-btn:hover { opacity: 1; background: var(--qu-color-border, #8884); }
  .qu-chat-tool-btn:disabled { opacity: 0.35; cursor: default; }
  /* Sized to match .qu-chat-tool-btn (the button it replaced) - @qu/thread-ui's
     own .qu-thread-ui-context-menu-trigger default is tuned for the smaller
     per-message "⋮" menu, not a composer-height tool cluster. */
  .qu-chat-composer-plus .qu-thread-ui-context-menu-trigger { font-size: 1.1em; padding: 0.3rem; border-radius: 999px; opacity: 0.75; }
  .qu-chat-composer-plus .qu-thread-ui-context-menu-trigger:hover { opacity: 1; background: var(--qu-color-border, #8884); }
  /* min-height/max-height are a defensive fallback only (e.g. before
     mountComposerAutogrow()'s first synchronous resize() call) - the actual
     1-to-COMPOSER_MAX_ROWS growth is driven by @qu/thread-ui's
     mountComposerAutogrow(), not this CSS. */
  .qu-chat-composer-input-wrap { flex: 1; min-width: 0; display: flex; align-items: flex-end; gap: 0.3rem; background: var(--qu-color-surface, #8882); border: 1px solid var(--qu-color-border, #8884); border-radius: 1.3rem; padding: 0.4rem 0.6rem; }
  .qu-chat-composer-input-wrap textarea { flex: 1; min-width: 0; font: inherit; border: none; background: transparent; resize: none; min-height: 1.4rem; max-height: 8rem; padding: 0.15rem 0; }
  .qu-chat-composer-input-wrap textarea:focus { outline: none; }
  .qu-chat-composer-action { flex-shrink: 0; width: 2.6rem; height: 2.6rem; border-radius: 50%; border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font-size: 1.1em; line-height: 1; }
  .qu-chat-composer-action:disabled { opacity: 0.6; cursor: default; }
  .qu-chat-pending-attachment { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; opacity: 0.85; }
  .qu-chat-pending-attachment[hidden] { display: none; }
  .qu-chat-pending-attachment button { background: none; border: none; cursor: pointer; opacity: 0.7; font: inherit; padding: 0; }
  /* Voice recorder panel - REPLACES .qu-chat-composer (see mountRoomView()'s
     own syncVoiceRecorderUI()) while recording/paused/previewing, same row
     height/alignment as the normal composer so nothing jumps when it swaps
     in and back out. */
  .qu-chat-voice-recorder { display: flex; align-items: center; gap: 0.6rem; }
  .qu-chat-voice-recorder[hidden] { display: none; }
  .qu-chat-voice-recorder-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--qu-color-danger, #d64545); flex-shrink: 0; animation: qu-chat-voice-dot-pulse 1.2s ease-in-out infinite; }
  .qu-chat-voice-recorder-dot[hidden] { display: none; }
  @keyframes qu-chat-voice-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  .qu-chat-voice-recorder-time { font-variant-numeric: tabular-nums; opacity: 0.8; min-width: 2.6em; }
  .qu-chat-voice-recorder-time[hidden] { display: none; }
  .qu-chat-voice-preview-player { flex: 1; min-width: 0; height: 2.2rem; }
  .qu-chat-voice-preview-player[hidden] { display: none; }
  .qu-chat-voice-recorder .qu-chat-tool-btn[hidden] { display: none; }
  .qu-chat-voice-recorder .qu-chat-composer-action[hidden] { display: none; }
  .qu-chat-new-group-form { display: flex; flex-direction: column; gap: 0.5rem; max-width: 26rem; }
  .qu-chat-new-group-form input[type="text"] { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-chat-member-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; max-height: 16rem; overflow-y: auto; }
  .qu-chat-member-list label { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0; }
  .qu-chat-new-group-form button[type="submit"] { align-self: flex-start; padding: 0.4rem 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font: inherit; }
  .qu-chat-new-group-form button:disabled { opacity: 0.6; cursor: default; }
  .qu-chat-settings { display: flex; flex-direction: column; gap: 0.4rem; max-width: 24rem; }
  .qu-chat-settings label { display: flex; align-items: center; gap: 0.5rem; }
  .qu-chat-settings-status { font-size: 0.85em; opacity: 0.75; }
  .qu-chat-search-result { display: block; padding: 0.6rem 0.8rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-chat-search-result:hover { background: var(--qu-color-surface, #8882); }
  .qu-chat-search-result-link { display: block; text-decoration: none; color: inherit; }
  .qu-chat-search-result-meta { font-size: 0.8em; opacity: 0.7; }
  .qu-chat-search-result-snippet { margin: 0.25rem 0 0; overflow-wrap: anywhere; }
  /* See apps/forum/client.js's own identical rule on
     .qu-forum-search-result-attachment for why this is a SIBLING of the
     link, never nested inside it. */
  .qu-chat-search-result-attachment { display: block; margin-top: 0.4rem; max-width: 16rem; max-height: 12rem; }
  .qu-chat-search-result-attachment img, .qu-chat-search-result-attachment video { max-width: 100%; max-height: 12rem; border-radius: var(--qu-radius-sm, 0.3rem); }
`;

function formatTs(ts) {
  return new Date(ts).toLocaleString();
}

// ===================================================================
// PER-USER CHAT SETTINGS - private, self-encrypted (see @qu/services'
// private-storage.js). Read/written from both the room view (to decide
// whether to show a sender name in a 1:1 bubble, and what color to paint
// this identity's own bubbles) and renderChatSettings() below (the
// userSettings.contributions extension-point contributor apps/profile
// renders at #/~<pub>/settings) - both live in THIS file/bundle, so no
// cross-app import is needed either way.
// ===================================================================

function chatSettingsPath(myPub) {
  return `/store/actors/~${myPub}/private/chat-settings`;
}

const DEFAULT_CHAT_SETTINGS = { showAliasIn1to1: false, ownColor: '' };

async function getChatSettings(qu, identity, myPub) {
  const stored = await getPrivate(qu, identity, chatSettingsPath(myPub));
  return { ...DEFAULT_CHAT_SETTINGS, ...stored };
}

async function setChatSettings(qu, identity, myPub, patch) {
  const merged = { ...(await getChatSettings(qu, identity, myPub)), ...patch };
  await putPrivate(qu, identity, chatSettingsPath(myPub), merged);
  return merged;
}

/**
 * The `userSettings.contributions` contributor (see `apps/profile/client.js`'s
 * own doc comment for the point's full payload contract - `{myPub, services}`,
 * rendered once inside Settings' `.qu-profile-ext-settings` container).
 * @param {HTMLElement} container
 * @param {{myPub: string, services: object}} payload
 */
export async function renderChatSettings(container, { myPub, services }) {
  const qu = services.messages?.qu;
  const identity = services.messages?.identity;
  if (!qu || !identity) return; // defensive - every real host wires both, see MessageService's own constructor

  const heading = document.createElement('h3');
  heading.textContent = 'Chat';
  const form = document.createElement('form');
  form.className = 'qu-chat-settings';

  const current = await getChatSettings(qu, identity, myPub);

  const aliasLabel = document.createElement('label');
  const aliasInput = document.createElement('input');
  aliasInput.type = 'checkbox';
  aliasInput.checked = current.showAliasIn1to1;
  aliasLabel.append(aliasInput, document.createTextNode(t('showAliasIn1to1')));

  const colorLabel = document.createElement('label');
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = current.ownColor || '#5b5bd6';
  colorLabel.append(document.createTextNode(t('ownColor')), colorInput);

  const status = document.createElement('div');
  status.className = 'qu-chat-settings-status';
  status.hidden = true;

  form.append(aliasLabel, colorLabel, status);

  async function save() {
    await setChatSettings(qu, identity, myPub, { showAliasIn1to1: aliasInput.checked, ownColor: colorInput.value });
    status.textContent = t('saved');
    status.hidden = false;
  }
  aliasInput.addEventListener('change', save);
  colorInput.addEventListener('change', save);

  container.append(heading, form);
}

// ===================================================================
// ROUTER
// ===================================================================

export function mount(container, ctx) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  const { qu, services, apps, subscribe, segments = [] } = ctx;

  const SPACE_ID = apps?.find((a) => a.name === 'chat')?.spaceId;
  if (!SPACE_ID) throw new Error('[chat] no "spaceId" found in the apps catalog for "chat" - check manifest.quapp');

  container.assetService = services.assets; // see apps/forum/client.js's own doc comment - <qu-asset-upload>/<qu-asset> resolve this via an ancestor walk

  subscribe?.(paths.spacePath(SPACE_ID)); // every room's thread lives under this ONE app space
  subscribe?.(`/blob/${SPACE_ID}`); // attachment chunks - separate top-level mount, see AssetEngine's own doc comment

  // A trailing /m/<messageId> (`#/chat/<peerPub>/m/<id>` or `#/chat/g/<groupId>/m/<id>`)
  // is a message PERMALINK - see mountRoomView()'s own doc comment on
  // "PERMALINKS" for what it does once there.
  const [, seg1, seg2, seg3, seg4] = segments;
  const viewCtx = { ...ctx, SPACE_ID };
  let stopView;
  if (seg1 === 'new-group') {
    stopView = mountNewGroupView(container, viewCtx);
  } else if (seg1 === 'g' && seg2) {
    stopView = mountRoomView(container, viewCtx, { kind: 'group', roomId: seg2, messageId: seg3 === 'm' ? seg4 : null });
  } else if (seg1) {
    stopView = mountRoomView(container, viewCtx, { kind: 'dm', peerPub: seg1, messageId: seg2 === 'm' ? seg3 : null });
  } else {
    stopView = mountRoomListView(container, viewCtx);
  }
  return () => stopView?.();
}

/**
 * Resolves this identity's group-creation policy (relay-settings' `chat.
 * allowMemberCreateGroup`) + whether it's one of this relay's own admins -
 * same CLIENT-SIDE-only shape as `apps/forum/client.js`'s own
 * `fetchChannelPolicy()`, see that function's own doc comment for why.
 * @param {object} services
 * @returns {Promise<{allowMemberCreateGroup: boolean, isAdmin: boolean}>}
 */
async function fetchChatPolicy(services) {
  let allowMemberCreateGroup = true;
  let isAdmin = false;
  try {
    const res = await fetch('/config.json');
    if (res.ok) {
      const data = await res.json();
      if (typeof data.settings?.chat?.allowMemberCreateGroup === 'boolean') {
        allowMemberCreateGroup = data.settings.chat.allowMemberCreateGroup;
      }
      const myPub = await services.actors.whoAmI();
      isAdmin = (data.adminPubs ?? []).includes(myPub);
    }
  } catch { /* offline/unreachable - falls back to the permissive default */ }
  return { allowMemberCreateGroup, isAdmin };
}

/**
 * The full room list (1:1 + group) - kind, id, href, display name, avatar,
 * last message, unread/muted state - shared between the rich room-list view
 * (`mountRoomListView()`'s own `roomRow()`) and the lightweight room-
 * switcher `navigation` items an open room's own `mountAppTemplate()`
 * sidebar shows (`mountRoomView()`, via `roomsToNavItems()` below). ONE
 * place computes "what rooms exist and are they unread", not two - see this
 * file's own top doc comment's "NAVIGATION" section.
 * @param {{services: object, SPACE_ID: string, myPub: string}} deps
 * @returns {Promise<Array<{kind: 'dm'|'group', roomId: string, href: string, name: string, avatarSeed: string, avatar: *, lastMessage: *, unread: boolean, muted: boolean}>>}
 */
async function listRooms({ services, SPACE_ID, myPub }) {
  const [contacts, groupIds, prefs] = await Promise.all([
    services.contacts.listContacts(),
    services.chat.listMyGroups(),
    services.notificationPrefs.getOwnPrefs(),
  ]);
  const mutedThreads = new Set(prefs.apps?.chat?.mutedThreads ?? []);

  const dmRooms = await Promise.all(contacts.map(async (c) => {
    const roomId = await ChatService.roomId([myPub, c.actorPub]);
    const { messages } = await services.messages.listMessages(SPACE_ID, roomId, { order: 'desc', limit: 1 });
    const lastReadAt = await services.messages.getLastReadAt(SPACE_ID, roomId);
    const last = messages[0] ?? null;
    return {
      kind: 'dm', roomId, href: `#/chat/${c.actorPub}`,
      name: formatActorLabel(c.actorPub, c.profile), avatarSeed: c.actorPub, avatar: c.profile?.avatar,
      lastMessage: last, unread: !!last && last.author !== myPub && last.ts > lastReadAt,
      muted: mutedThreads.has(roomId),
    };
  }));
  const groupRooms = (await Promise.all(groupIds.map(async (groupId) => {
    const config = await services.messages.getConfig(SPACE_ID, groupId);
    if (!config) return null; // invited but the group thread itself hasn't synced in yet
    const { messages } = await services.messages.listMessages(SPACE_ID, groupId, { order: 'desc', limit: 1 });
    const lastReadAt = await services.messages.getLastReadAt(SPACE_ID, groupId);
    const last = messages[0] ?? null;
    return {
      kind: 'group', roomId: groupId, href: `#/chat/g/${groupId}`,
      name: config.name ?? groupId, avatarSeed: groupId, avatar: null,
      lastMessage: last, unread: !!last && last.author !== myPub && last.ts > lastReadAt,
      muted: mutedThreads.has(groupId),
    };
  }))).filter(Boolean);

  return [...dmRooms, ...groupRooms].sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
}

/**
 * `listRooms()`'s rich room objects, reduced to `mountAppTemplate()`'s
 * plain `{id, label, href, icon, badge}` link-item shape (see
 * `@qu/ui`'s `app-template.js` own `AppTemplateLinkItem` typedef) - a
 * sidebar/pill entry has no room for a last-message preview or a real
 * timestamp, only an icon (kind) and a badge (unread), same reduction
 * `apps/forum/client.js`'s own channel sidebar already accepts relative to
 * its board view's richer channel rows.
 * @param {Awaited<ReturnType<typeof listRooms>>} rooms
 */
function roomsToNavItems(rooms) {
  return rooms.map((room) => ({
    id: room.roomId,
    label: room.name,
    href: room.href,
    icon: room.kind === 'group' ? '👥' : '👤',
    badge: room.unread ? '●' : undefined,
  }));
}

// ===================================================================
// ROOM LIST VIEW - #/chat
// ===================================================================

function mountRoomListView(container, { qu, services, subscribe, syncFetch, SPACE_ID }) {
  let stopped = false;

  const requestsRoot = document.createElement('div');
  const listRoot = document.createElement('div');
  const stopTemplate = mountAppTemplate(container, {
    render: (content) => {
      const heading = document.createElement('h1');
      heading.textContent = t('title');
      content.append(heading, requestsRoot, listRoot);
    },
  });
  // primaryAction ("+ New group") depends on an async policy check - see
  // mountAppTemplate()'s own "LATE-ARRIVING CHROME DATA" doc comment.
  (async () => {
    const { allowMemberCreateGroup, isAdmin } = await fetchChatPolicy(services);
    if (stopped || !(isAdmin || allowMemberCreateGroup)) return;
    stopTemplate.update({ primaryAction: { label: t('newChatGroup'), href: '#/chat/new-group', icon: '✏️' } });
  })();

  let renderToken = 0;
  async function render() {
    const token = ++renderToken;
    if (stopped) return;
    const myPub = await services.actors.whoAmI();
    const identity = services.messages.identity;
    if (stopped || token !== renderToken) return;

    const [rooms, dmRequests, dismissed] = await Promise.all([
      listRooms({ services, SPACE_ID, myPub }),
      services.chat.listMyDmRequests(),
      getPrivateChildren(qu, identity, paths.privateFlagParentPath(myPub, 'dismissed', 'chat-request')),
    ]);
    if (stopped || token !== renderToken) return;

    // MESSAGE REQUESTS - see ChatService's own "1:1 DISCOVERY" doc comment.
    // A request is worth SHOWING only while it's neither already accepted
    // (the sender is a Contact - they already show up as an ordinary dmRoom
    // below, would be redundant/confusing to ALSO list them here) nor
    // already declined (a dismissed flag, see the `Decline` button below).
    const contactPubs = new Set(rooms.filter((r) => r.kind === 'dm').map((r) => r.avatarSeed));
    const dismissedPubs = new Set(dismissed.map(({ path }) => path.slice(path.lastIndexOf('/') + 1)));
    const pendingRequests = dmRequests.filter((r) => !contactPubs.has(r.fromPub) && !dismissedPubs.has(r.fromPub));
    requestsRoot.textContent = '';
    if (pendingRequests.length > 0) {
      const requestsHeading = document.createElement('h2');
      requestsHeading.className = 'qu-chat-requests-heading';
      requestsHeading.textContent = t('messageRequests');
      const ul = document.createElement('ul');
      ul.className = 'qu-chat-requests';
      for (const request of pendingRequests) {
        const profile = await services.profile.getPublicProfile(request.fromPub);
        if (stopped || token !== renderToken) return;
        ul.appendChild(requestRow(request, profile));
      }
      requestsRoot.append(requestsHeading, ul);
    }

    listRoot.textContent = '';
    if (rooms.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-chat-empty';
      empty.textContent = t('empty');
      listRoot.appendChild(empty);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'qu-chat-rooms';
      for (const room of rooms) ul.appendChild(roomRow(room));
      listRoot.appendChild(ul);
    }
    // No inline "+ New group" link here - it's `primaryAction` on this
    // view's own `mountAppTemplate()` call above (see this file's own top
    // doc comment's "NAVIGATION" section), same policy check.
  }

  function roomRow(room) {
    const li = document.createElement('li');
    li.className = 'qu-chat-room-row';
    const a = document.createElement('a');
    a.href = room.href;
    a.appendChild(renderAvatarOrAsset(room.avatarSeed, room.name, room.avatar, { size: '2.4rem' }));

    const main = document.createElement('div');
    main.className = 'qu-chat-room-main';
    const nameRow = document.createElement('div');
    nameRow.className = 'qu-chat-room-name-row';
    const nameEl = document.createElement('span');
    nameEl.className = 'qu-chat-room-name';
    nameEl.textContent = room.name;
    nameRow.appendChild(nameEl);
    if (room.muted) {
      const mutedIcon = document.createElement('span');
      mutedIcon.className = 'qu-chat-room-muted';
      mutedIcon.textContent = '🔕';
      nameRow.appendChild(mutedIcon);
    }
    if (room.lastMessage) {
      const tsEl = document.createElement('span');
      tsEl.className = 'qu-chat-room-ts';
      tsEl.textContent = formatTs(room.lastMessage.ts);
      nameRow.appendChild(tsEl);
    }
    const preview = document.createElement('div');
    preview.className = 'qu-chat-room-preview';
    preview.textContent = room.lastMessage?.body ?? '';
    main.append(nameRow, preview);
    a.appendChild(main);

    if (room.unread) {
      const dot = document.createElement('span');
      dot.className = 'qu-chat-room-unread';
      a.appendChild(dot);
    }
    li.appendChild(a);
    return li;
  }

  /**
   * One pending DM request row (see ChatService's own "1:1 DISCOVERY" doc
   * comment): the sender's identity (avatar/alias/pub - exactly what the
   * user asked a request should show, so accepting is an informed choice,
   * never a blind one) plus Accept/Decline. Deliberately NOT a link to the
   * room itself - viewing the conversation before deciding isn't offered
   * here, matching how a request inbox works elsewhere (Signal/Telegram):
   * accept or decline first, read after.
   * @param {{fromPub: string, spaceId: string|number, roomId: string}} request
   * @param {object|null} profile
   */
  function requestRow(request, profile) {
    const li = document.createElement('li');
    li.className = 'qu-chat-request-row';
    li.appendChild(renderAvatarOrAsset(request.fromPub, formatActorLabel(request.fromPub, profile), profile?.avatar, { size: '2.4rem' }));

    const main = document.createElement('div');
    main.className = 'qu-chat-request-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'qu-chat-request-name';
    nameEl.textContent = formatActorLabel(request.fromPub, profile);
    const pubEl = document.createElement('div');
    pubEl.className = 'qu-chat-request-pub';
    pubEl.textContent = `~${request.fromPub.slice(0, 16)}…`;
    main.append(nameEl, pubEl);

    const actions = document.createElement('div');
    actions.className = 'qu-chat-request-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.textContent = t('accept');
    acceptBtn.addEventListener('click', async () => {
      await services.contacts.addContact(request.fromPub);
      window.location.hash = `#/chat/${request.fromPub}`;
    });
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.textContent = t('decline');
    declineBtn.addEventListener('click', async () => {
      const myPub = await services.actors.whoAmI();
      await putPrivate(qu, services.messages.identity, paths.privateFlagPath(myPub, 'dismissed', 'chat-request', request.fromPub), true);
      render();
    });
    actions.append(acceptBtn, declineBtn);

    li.append(main, actions);
    return li;
  }

  render();
  // Structural changes (a new contact added, a new group invite arriving)
  // re-render the whole list - see this file's own top doc comment on why
  // per-message live re-sorting across every room is out of scope, same
  // "cheap at conversational scale, fully live once you're INSIDE a room"
  // trade-off apps/forum's own board view already documents.
  let offContacts = () => {};
  let offInvites = () => {};
  (async () => {
    const myPub = await services.actors.whoAmI();
    if (stopped) return;
    subscribe?.(paths.privateFlagParentPath(myPub, 'favorite', 'user'));
    offContacts = watchChildren(qu, paths.privateFlagParentPath(myPub, 'favorite', 'user'), () => render(), { syncFetch });

    const inviteSpace = await services.chat.myInviteSpace();
    if (stopped) { offContacts(); return; }
    subscribe?.(paths.threadMessagesParentPath(inviteSpace, 'groups'));
    offInvites = watchChildren(qu, paths.threadMessagesParentPath(inviteSpace, 'groups'), () => render(), { syncFetch });
  })();

  return () => {
    stopped = true;
    offContacts();
    offInvites();
    stopTemplate();
  };
}

// ===================================================================
// NEW GROUP VIEW - #/chat/new-group
// ===================================================================

function mountNewGroupView(container, { services, SPACE_ID }) {
  let stopped = false;
  const formRoot = document.createElement('div');
  const heading = document.createElement('h1');
  heading.textContent = t('createGroup');

  renderSubpage(container, {
    // The shell header's own Back/Forward already covers this - see
    // docs/app-navigation-standard.md Rule 1 (same reasoning apps/forum's
    // own renderSubpage() calls already document).
    showBackLink: false,
    render: (content) => content.append(heading, formRoot),
  });

  (async () => {
    const contacts = await services.contacts.listContacts();
    if (stopped) return;

    const form = document.createElement('form');
    form.className = 'qu-chat-new-group-form';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = t('groupName');
    nameInput.required = true;

    const membersLabel = document.createElement('div');
    membersLabel.textContent = t('selectMembers');
    const memberList = document.createElement('ul');
    memberList.className = 'qu-chat-member-list';
    const checkboxes = [];
    if (contacts.length === 0) {
      const p = document.createElement('p');
      p.className = 'qu-chat-empty';
      p.textContent = t('noContacts');
      memberList.appendChild(p);
    }
    for (const contact of contacts) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = contact.actorPub;
      label.append(checkbox, document.createTextNode(formatActorLabel(contact.actorPub, contact.profile)));
      li.appendChild(label);
      memberList.appendChild(li);
      checkboxes.push(checkbox);
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('createGroup');
    submit.disabled = contacts.length === 0;
    form.append(nameInput, membersLabel, memberList, submit);
    formRoot.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      const memberPubs = checkboxes.filter((c) => c.checked).map((c) => c.value);
      if (!name || memberPubs.length === 0) return;
      submit.disabled = true;
      try {
        const { groupId } = await services.chat.createGroup(SPACE_ID, { name, memberPubs });
        window.location.hash = `#/chat/g/${groupId}`;
      } finally {
        submit.disabled = false;
      }
    });
  })();

  return () => { stopped = true; };
}

// ===================================================================
// ROOM VIEW - #/chat/<peerPub> (1:1) / #/chat/g/<groupId> (group)
// ===================================================================

function mountRoomView(container, { qu, services, subscribe, syncFetch, extensionPoints, SPACE_ID }, target) {
  let stopped = false;

  // A flex COLUMN filling the viewport height below the shell's own fixed
  // top header, via `mountAppTemplate({fullHeight: true, ...})` below (see
  // this file's own top doc comment's "NAVIGATION" section and `@qu/ui`'s
  // `app-template.js` own "FULL HEIGHT MODE" doc comment) -
  // `heading`/`composerWrap` are flex-shrink:0 (pinned), only
  // `.qu-chat-messages-scroll` (wrapping `messagesRoot`) scrolls. Doesn't use
  // `renderSubpage()` for the same reason it never did - no bespoke back
  // link either (see docs/app-navigation-standard.md Rule 1): the shell
  // header's own Back/Forward already covers "return to the room list",
  // so this row is just avatar + name/status, one fixed top bar total.
  const roomView = document.createElement('div');
  roomView.className = 'qu-chat-room-view';

  const heading = document.createElement('div');
  heading.className = 'qu-chat-header';
  const headerAvatarSlot = document.createElement('div');
  const headerName = document.createElement('div');
  headerName.className = 'qu-chat-header-namewrap';
  const headerNameLine = document.createElement('div');
  headerNameLine.className = 'qu-chat-header-nameline';
  const headerNameEl = document.createElement('div');
  headerNameEl.className = 'qu-chat-header-name';
  const headerMutedIcon = document.createElement('span');
  headerMutedIcon.className = 'qu-chat-header-muted';
  headerMutedIcon.textContent = '🔕';
  headerMutedIcon.title = t('muteChat');
  headerMutedIcon.hidden = true;
  headerNameLine.append(headerNameEl, headerMutedIcon);
  const headerStatusEl = document.createElement('div');
  headerStatusEl.className = 'qu-chat-header-status';
  headerName.append(headerNameLine, headerStatusEl);

  async function refreshHeaderMuted() {
    if (!roomId) return;
    const prefs = await services.notificationPrefs.getOwnPrefs();
    headerMutedIcon.hidden = !(prefs.apps?.chat?.mutedThreads?.includes(roomId) ?? false);
  }
  // The room's own "⋮" context menu (content.chatRoomMenu) - this app's own
  // native "Mute" toggle, merged with whatever a plugin app contributes
  // (apps/phone's Audio-Call/Video-Call, 1:1 rooms only - see
  // renderCallMenuItems()'s own doc comment). Same trigger/panel/outside-
  // click-close shape as the composer's own "+" menu just above and the
  // message "⋮" menu (buildMessageFooter()'s own content.messageMenu) - one
  // `renderContextMenu()` call, items built lazily on each open since
  // `roomId`/`memberPubs`/`target` aren't resolved yet at header-build time
  // (same reasoning the composer's own `getItems()` doc comment already
  // gives for `roomId`).
  const roomMenuBtn = renderContextMenu({
    trigger: '⋮',
    triggerTitle: t('roomMenu'),
    getItems: async () => {
      // "Mute" is chat's own native item, not a plugin contribution - built
      // inline here exactly like the composer menu's own Attach/Share
      // location native items above, not routed through `collect()` (that's
      // for OTHER apps plugging in, e.g. apps/phone's call actions below).
      const prefs = await services.notificationPrefs.getOwnPrefs();
      const muted = prefs.apps?.chat?.mutedThreads?.includes(roomId) ?? false;
      const nativeItems = [
        {
          id: 'mute',
          label: muted ? t('unmuteChat') : t('muteChat'),
          icon: muted ? '🔔' : '🔕',
          onClick: async () => {
            const current = await services.notificationPrefs.getOwnPrefs();
            const chatPrefs = current.apps?.chat ?? {};
            const mutedThreads = new Set(chatPrefs.mutedThreads ?? []);
            if (muted) mutedThreads.delete(roomId); else mutedThreads.add(roomId);
            await services.notificationPrefs.savePrefs({
              ...current,
              apps: { ...current.apps, chat: { ...chatPrefs, mutedThreads: [...mutedThreads] } },
            });
            headerMutedIcon.hidden = muted; // toggled, so the icon shows the NEW state - no need to re-fetch prefs
          },
        },
      ];
      const payload = {
        services, qu, syncFetch, spaceId: SPACE_ID, threadId: roomId, memberPubs,
        contactPub: target.kind === 'dm' ? target.peerPub : null,
      };
      const pluginItems = extensionPoints ? await extensionPoints.collect('content.chatRoomMenu', payload) : [];
      return [...nativeItems, ...pluginItems];
    },
  });
  roomMenuBtn.classList.add('qu-chat-header-menu-btn');
  heading.append(headerAvatarSlot, headerName, roomMenuBtn);

  const messagesScroll = document.createElement('div');
  messagesScroll.className = 'qu-chat-messages-scroll';
  const messagesRoot = document.createElement('div');
  // A SIBLING of messagesRoot, never touched by renderMessages()'s own
  // clear-and-rebuild of messagesRoot - see mountRoomView()'s own
  // syncScrollToBottomButton() for what shows/hides/labels it. position:
  // sticky (see STYLE) keeps it pinned near the bottom of the VISIBLE
  // scroll area regardless of where messagesRoot's own content currently
  // scrolls to. Shown whenever the user isn't at the bottom (scrolled up,
  // OR landed on a permalink further up) - not just when a new message
  // happens to arrive - per explicit ask: a persistent, always-available
  // way back down, not a one-shot toast.
  const scrollToBottomBtn = document.createElement('button');
  scrollToBottomBtn.type = 'button';
  scrollToBottomBtn.className = 'qu-chat-scroll-bottom-btn';
  scrollToBottomBtn.hidden = true;
  messagesScroll.append(messagesRoot, scrollToBottomBtn);
  const composerWrap = document.createElement('div');
  composerWrap.className = 'qu-chat-composer-wrap';
  const replyBanner = document.createElement('div');
  replyBanner.className = 'qu-chat-reply-banner';
  replyBanner.hidden = true;

  // The composer is a rounded "pill" (textarea + emoji trigger) plus a
  // tool cluster (attach/location) and one circular action button on the
  // right that MORPHS between mic (empty composer) and send (composer has
  // text) - see this file's own top doc comment's "COMPOSER" section.
  const composerRow = document.createElement('div');
  composerRow.className = 'qu-chat-composer';
  const composerTools = document.createElement('div');
  composerTools.className = 'qu-chat-composer-tools';
  const attachUpload = document.createElement('qu-asset-upload');
  attachUpload.setAttribute('space-id', SPACE_ID);
  attachUpload.setAttribute('hide-picker', ''); // its own picker button is replaced by the "+" action menu below
  // The composer's "+" action menu (content.composerActions) - Attach/
  // Share location plus whatever plugin apps contribute (a Calendar/
  // Gallery app's own entry, a game's own "share a challenge", ...),
  // behind ONE trigger instead of always-visible icons - same trigger/
  // panel/outside-click-close shape as the message "⋮" menu
  // (buildMessageFooter()'s own `content.messageMenu`), just for the
  // composer instead of a message.
  const composerActionsBtn = renderContextMenu({
    trigger: '+',
    triggerTitle: t('addAttachment'),
    getItems: async () => {
      const nativeItems = [
        { id: 'attach', label: t('attachFile'), icon: '📎', onClick: () => attachUpload.openPicker() },
        { id: 'location', label: t('shareLocation'), icon: '📍', onClick: shareLocation },
      ];
      // Built fresh on each open (not hoisted to a captured const) - roomId
      // isn't resolved yet at composer-build time (see mountRoomView()'s own
      // async room-resolution below), same "getItems is a function, not a
      // plain array, so it's built lazily every open" reasoning
      // context-menu.js's own doc comment already gives for messageMenu.
      const payload = { services, qu, syncFetch, spaceId: SPACE_ID, threadId: roomId };
      const pluginItems = extensionPoints ? await extensionPoints.collect('content.composerActions', payload) : [];
      return [...nativeItems, ...pluginItems].sort(
        (a, b) => rankFor(extensionPoints?.order, 'content.composerActions', a.id, COMPOSER_ACTIONS_ORDER_DEFAULT[a.id] ?? 50)
          - rankFor(extensionPoints?.order, 'content.composerActions', b.id, COMPOSER_ACTIONS_ORDER_DEFAULT[b.id] ?? 50)
      );
    },
  });
  composerActionsBtn.classList.add('qu-chat-composer-plus');
  composerTools.append(composerActionsBtn, attachUpload);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'qu-chat-composer-input-wrap';
  const composerInput = document.createElement('textarea');
  composerInput.placeholder = t('composerPlaceholder');
  const stopComposerAutogrow = mountComposerAutogrow(composerInput, { minRows: COMPOSER_MIN_ROWS, maxRows: COMPOSER_MAX_ROWS });
  const emojiPicker = renderEmojiPicker({
    onPick: (emoji) => insertAtCursor(composerInput, emoji),
    trigger: '😀',
    triggerTitle: t('insertEmoji'),
  });
  inputWrap.append(composerInput, emojiPicker);

  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.className = 'qu-chat-composer-action';

  composerRow.append(composerTools, inputWrap, actionBtn);
  const pendingAttachmentEl = document.createElement('div');
  pendingAttachmentEl.className = 'qu-chat-pending-attachment';
  pendingAttachmentEl.hidden = true;
  // ABOVE the input row, not below it - a pending attachment is context
  // for what's about to be sent, not a footnote after the fact; keeping it
  // above also means it never visually competes with (or gets squeezed by)
  // the input row itself the way <qu-asset-upload>'s own IN-PROGRESS status
  // used to (see that element's own doc comment in @qu/ui's
  // asset-components.js for the "text input barely visible" bug this and
  // that fix together close).

  // ---- voice recorder panel: REPLACES composerRow (not layered over it)
  // while recording/paused/previewing - see the "voice messages" section
  // below (near startRecording()) for the actual MediaRecorder state
  // machine this panel is just the view for. Ported UX from QuV2
  // (https://github.com/ReactivityJS/QuV2): Start (the normal mic
  // actionBtn), Pause/Resume, Finish (stop into a PREVIEW, not an
  // immediate send), a real playback preview, and an explicit Discard -
  // never V3's old tap-to-record/tap-to-stop-and-send-immediately, which
  // gave no chance to listen back or bail out before something already
  // went out.
  const voiceRecorderEl = document.createElement('div');
  voiceRecorderEl.className = 'qu-chat-voice-recorder';
  voiceRecorderEl.hidden = true;
  const voiceDiscardBtn = document.createElement('button');
  voiceDiscardBtn.type = 'button';
  voiceDiscardBtn.className = 'qu-chat-tool-btn qu-chat-voice-discard-btn';
  voiceDiscardBtn.textContent = '🗑️';
  voiceDiscardBtn.title = t('voiceDiscard');
  const voiceRecorderDot = document.createElement('span');
  voiceRecorderDot.className = 'qu-chat-voice-recorder-dot';
  const voiceRecorderTime = document.createElement('span');
  voiceRecorderTime.className = 'qu-chat-voice-recorder-time';
  voiceRecorderTime.textContent = '00:00';
  const voicePreviewPlayer = document.createElement('audio');
  voicePreviewPlayer.className = 'qu-chat-voice-preview-player';
  voicePreviewPlayer.controls = true;
  const voicePauseBtn = document.createElement('button');
  voicePauseBtn.type = 'button';
  voicePauseBtn.className = 'qu-chat-tool-btn qu-chat-voice-pause-btn';
  const voiceFinishBtn = document.createElement('button');
  voiceFinishBtn.type = 'button';
  voiceFinishBtn.className = 'qu-chat-tool-btn qu-chat-voice-finish-btn';
  voiceFinishBtn.textContent = '⏹';
  voiceFinishBtn.title = t('voiceFinish');
  const voiceSendBtn = document.createElement('button');
  voiceSendBtn.type = 'button';
  voiceSendBtn.className = 'qu-chat-composer-action qu-chat-voice-send-btn';
  voiceSendBtn.textContent = '➤';
  voiceSendBtn.title = t('send');
  voiceRecorderEl.append(
    voiceDiscardBtn, voiceRecorderDot, voiceRecorderTime, voicePreviewPlayer,
    voicePauseBtn, voiceFinishBtn, voiceSendBtn,
  );

  composerWrap.append(replyBanner, pendingAttachmentEl, composerRow, voiceRecorderEl);

  roomView.append(heading, messagesScroll, composerWrap);
  const stopTemplate = mountAppTemplate(container, {
    fullHeight: true,
    render: (content) => content.appendChild(roomView),
  });

  const stopComposerMentions = mountMentionAutocomplete(composerInput, { services, subscribe });
  const stopComposerEmoji = mountEmojiAutocomplete(composerInput);

  let roomId = null;
  let memberPubs = [];
  let roomReady = false;

  // ---- PERMALINKS + scroll-follow (see this file's own top doc comment) ----
  // `target.messageId` (set by mount()'s own `/m/<id>` route parsing) is a
  // ONE-TIME scroll target consumed by the very first renderMessages() call
  // after mount, then cleared - exactly like a URL fragment scroll.
  // `stuckToBottom` mirrors "is the user currently looking at the newest
  // message": true by default (a freshly opened room always shows the
  // bottom), but NOT when landing on an older permalinked message - that
  // must not get yanked away from immediately. The scroll listener below
  // re-engages it the moment the user scrolls back down to the bottom
  // themselves, and releases it the moment they scroll away - this is what
  // makes a new incoming message auto-scroll only when the user was already
  // at the bottom to see it, never interrupting whatever they were reading.
  let pendingScrollTarget = target.messageId || null;
  let stuckToBottom = !pendingScrollTarget;
  // The message id we're currently "stuck" to after landing on a permalink
  // (mirrors `stuckToBottom`, just anchored to a message instead of the
  // bottom) - ported from apps/forum/client.js's own identical fix (see
  // that file's own doc comment for the full "why"): a permalinked message
  // with an attachment still loading landed the viewport short of the
  // actual target, because nothing ever re-corrected the scroll position
  // once that attachment grew the layout ABOVE it. Set right after the
  // initial scrollIntoView() below, released the moment `messagesScroll`'s
  // own 'scroll' listener sees the viewport move away from where our own
  // last correction (`correctStuckMessageScroll()` below, or the initial
  // scrollIntoView() itself) put it - see `lastKnownAnchorScrollTop`'s own
  // doc comment for exactly why a geometry comparison, not an event-timing
  // guard flag.
  let stuckToMessageId = null;
  let lastKnownAnchorScrollTop = null;
  // The scrollTop a RESIZE- or VIEWPORT-triggered bottom correction
  // (`scrollToBottom(_, true)` below) last set - ALSO ported from
  // apps/forum/client.js's own identical fix (see that file's own doc
  // comment on `lastKnownBottomScrollTop` for the full "why": a
  // late-loading attachment growing `messagesRoot` across MULTIPLE steps
  // can race the native 'scroll' event for our OWN correction, reading a
  // stale-but-still-ours scrollTop against the NOW-larger scrollHeight as
  // "the user scrolled away" - permanently disabling further corrections
  // and stranding the newest message off-screen). Narrower in scope than
  // `lastKnownAnchorScrollTop` on purpose - only tracked for a `correcting:
  // true` call, never the plain first-render jump or an explicit smooth
  // catch-up.
  let lastKnownBottomScrollTop = null;
  // Whether a message arrived while NOT stuck to the bottom - purely
  // cosmetic (see syncScrollToBottomButton()'s own doc comment for what it
  // changes about the button), never what decides the button's visibility.
  let hasUnseenMessage = false;
  // See renderMessages()'s own doc comment at the publishReadReceipt() call
  // site - guards against a self-published read receipt re-triggering the
  // read-receipts watch below, which would re-run renderMessages(), forever.
  let lastPublishedReadUpto = 0;
  // The currently-rendered messages, by id - kept up to date at the top of
  // every renderMessages() call, so refreshReadTicks() (below) can update
  // an ALREADY-rendered row's tick in place without needing its own copy of
  // the message list.
  let renderedMessagesById = new Map();
  // {id, editedAt}[] snapshot of the last successfully rendered message
  // list, oldest-first - see renderMessages()'s own "INCREMENTAL APPEND"
  // doc comment for what this drives. Empty until the first render.
  let lastRenderedSnapshot = [];
  let hasRenderedOnce = false;
  const BOTTOM_FOLLOW_THRESHOLD_PX = 80;
  /**
   * @param {boolean} smooth
   * @param {boolean} [correcting] - true for a RESIZE-triggered correction
   *   (see the ResizeObserver below), never a caller-visible "scroll to
   *   bottom" action in its own right - skipped entirely once the user has
   *   since scrolled away again, so a slow-loading image two messages back
   *   can't yank them back down to "now" after they've already moved on.
   */
  function scrollToBottom(smooth, correcting = false) {
    if (correcting && !stuckToBottom) return;
    if (messagesScroll.scrollTo) messagesScroll.scrollTo({ top: messagesScroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    else messagesScroll.scrollTop = messagesScroll.scrollHeight; // jsdom (this repo's test DOM) has no scrollTo() at all
    // Only a RESIZE/VIEWPORT-triggered correction is tracked - see
    // `lastKnownBottomScrollTop`'s own doc comment for exactly why.
    if (correcting) lastKnownBottomScrollTop = messagesScroll.scrollTop;
  }
  /**
   * Re-aligns the viewport back on `stuckToMessageId`'s own row (if still
   * stuck to one) - the permalink counterpart of `scrollToBottom(...,
   * true)` above, invoked by the SAME ResizeObserver/viewport-resize
   * handler below whenever `messagesRoot`'s size (or the visible viewport)
   * changes. Ported from apps/forum/client.js's own identical helper - see
   * that file's own doc comment on `stuckToMessageId`.
   */
  function correctStuckMessageScroll() {
    if (!stuckToMessageId) return;
    const anchorEl = messagesRoot.querySelector(`[data-message-id="${CSS.escape(stuckToMessageId)}"]`);
    if (!anchorEl?.scrollIntoView) return;
    anchorEl.scrollIntoView({ block: 'start' });
    lastKnownAnchorScrollTop = messagesScroll.scrollTop;
  }
  // TRUE BOTTOM, EVEN WITH LATE-LOADING CONTENT - scrollToBottom() above
  // reads messagesScroll.scrollHeight AT CALL TIME, which understates the
  // real total height whenever an attachment (an image, a video's first
  // frame) is still downloading/decoding at that moment - <qu-asset>
  // resolves and inserts its actual <img>/<video> asynchronously (see
  // @qu/ui's own asset-components.js), well after this room's own
  // renderMessage() already returned and appended the row. Confirmed live
  // as "scrolling down doesn't reach all the way to the bottom" whenever an
  // image message was involved. A ResizeObserver on messagesRoot catches
  // ANY later height change - an image finishing layout, a video's
  // metadata arriving, anything - without needing to know what caused it,
  // and re-corrects the scroll position (instantly, not animated a second
  // time) whenever that happens while still stuck to the bottom. Guarded
  // for a host with no ResizeObserver at all (jsdom, this repo's test DOM,
  // included) - the position is still CORRECT for text-only messages
  // either way, this only ever matters for the async-attachment case.
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { correctStuckMessageScroll(); scrollToBottom(false, true); })
    : null;
  resizeObserver?.observe(messagesRoot);
  // VISUAL-VIEWPORT SHRINK (mobile on-screen keyboard opening - most
  // commonly the instant the composer autofocuses on room entry - or a
  // mobile browser's own chrome collapsing/expanding) - a SEPARATE, real
  // gap the ResizeObserver above can't cover: it only watches messagesRoot's
  // own CONTENT height, never the SCROLL CONTAINER's available (client)
  // height. When the visual viewport shrinks, `messagesScroll.scrollTop`
  // stays numerically the same but `clientHeight` shrinks with it, so
  // "distance from bottom" silently grows and the newest message(s) end up
  // scrolled out of view (or hidden behind the now-relatively-taller fixed
  // composer) with nothing ever correcting it - confirmed live (and via a
  // simulated viewport resize in this app's own test) as exactly "entering
  // a room lands one message short of the bottom." `visualViewport` (not
  // the bare `window` 'resize' event) is the correct, purpose-built API for
  // this - it fires precisely when the KEYBOARD (or pinch-zoom) changes the
  // visible area, independent of the LAYOUT viewport `position: fixed`
  // itself already tracks (see `@qu/ui`'s `app-template.js` own "FULL
  // HEIGHT MODE" doc comment - this room view mounts with `fullHeight:
  // true`) - falls back to `window` for a host with no `visualViewport`
  // at all (jsdom, this repo's test DOM, included). Same `correcting: true`
  // guard as the image-driven case above: only re-snaps while already stuck
  // to the bottom, never yanking the view while the user is reading further up.
  const viewportResizeTarget = window.visualViewport ?? window;
  const onViewportResize = () => { correctStuckMessageScroll(); scrollToBottom(false, true); };
  viewportResizeTarget.addEventListener('resize', onViewportResize);
  /**
   * Shows/hides/labels the persistent "scroll to bottom" button - visible
   * whenever the user ISN'T at the bottom, for ANY reason (scrolled up
   * themselves, or landed on a permalink further up), not just reactively
   * when a new message happens to arrive - a persistent, always-available
   * way back down, matching how every mainstream chat app already does
   * this, rather than a one-shot "new message" toast that only appears
   * sometimes. `hasUnseenMessage` only changes its LABEL/styling (a plain
   * "↓" vs "↓ new message") - never its visibility, which is `stuckToBottom`
   * alone.
   */
  function syncScrollToBottomButton() {
    scrollToBottomBtn.hidden = stuckToBottom;
    scrollToBottomBtn.textContent = hasUnseenMessage ? t('newMessagesBelow') : t('scrollToBottomButton');
    scrollToBottomBtn.classList.toggle('qu-chat-scroll-bottom-btn-unseen', hasUnseenMessage);
  }
  function roomHash() {
    return target.kind === 'group' ? `#/chat/g/${roomId}` : `#/chat/${target.peerPub}`;
  }
  function messagePermalink(message) {
    return `${roomHash()}/m/${message.id}`;
  }
  // See apps/forum/client.js's own identical helper - the "Copy link" menu
  // item needs a link that still works pasted elsewhere, not just a bare
  // hash meaningful only relative to this tab's current page.
  function absoluteMessagePermalink(message) {
    return new URL(messagePermalink(message), window.location.href).href;
  }
  // Landing back at the very bottom RELEASES a permalink anchor still
  // sitting in the URL, the same way stuckToBottom itself already releases
  // the IN-MEMORY "don't auto-scroll away from this" behavior - without
  // this, reloading this same tab later would jump back to the old
  // permalinked message instead of showing the latest one, even though
  // the user had already scrolled past it and moved on.
  function releasePermalinkAnchor() {
    const plainHash = roomHash();
    if (window.location.hash !== plainHash) window.history.replaceState(null, '', plainHash);
  }
  scrollToBottomBtn.addEventListener('click', () => {
    stuckToBottom = true;
    stuckToMessageId = null;
    lastKnownAnchorScrollTop = null;
    lastKnownBottomScrollTop = null; // scrollToBottom(true) below is smooth - never tracked, see that function's own doc comment
    hasUnseenMessage = false;
    syncScrollToBottomButton();
    scrollToBottom(true);
    releasePermalinkAnchor();
  });
  messagesScroll.addEventListener('scroll', () => {
    // A resize/viewport-correction echo (see `lastKnownBottomScrollTop`'s
    // own doc comment) - skip recomputing ANYTHING here, unlike the
    // anchor-echo check below (which only decides whether to release the
    // anchor; `stuckToBottom` still recomputes normally either way).
    if (lastKnownBottomScrollTop !== null && Math.abs(messagesScroll.scrollTop - lastKnownBottomScrollTop) <= 1) return;
    lastKnownBottomScrollTop = null;
    // Releases `stuckToMessageId` only when THIS scroll moved the viewport
    // away from where our own last correction put it - see that variable's
    // own doc comment for why a geometry comparison, not an event-timing
    // guard flag.
    if (lastKnownAnchorScrollTop !== null && Math.abs(messagesScroll.scrollTop - lastKnownAnchorScrollTop) > 1) {
      stuckToMessageId = null;
      lastKnownAnchorScrollTop = null;
    }
    const nowAtBottom = messagesScroll.scrollHeight - messagesScroll.scrollTop - messagesScroll.clientHeight < BOTTOM_FOLLOW_THRESHOLD_PX;
    if (nowAtBottom && !stuckToBottom) {
      // The user just scrolled themselves back down to "now" - see
      // releasePermalinkAnchor()'s own doc comment.
      releasePermalinkAnchor();
      hasUnseenMessage = false;
    }
    stuckToBottom = nowAtBottom;
    syncScrollToBottomButton();
  });

  let pendingAttachment = null;
  function clearPendingAttachment() {
    pendingAttachment = null;
    pendingAttachmentEl.hidden = true;
    pendingAttachmentEl.textContent = '';
    updateActionBtn();
  }
  attachUpload.addEventListener('qu-asset-uploaded', (e) => {
    pendingAttachment = { assetId: e.detail.assetId, ...e.detail.meta };
    pendingAttachmentEl.textContent = '';
    pendingAttachmentEl.hidden = false;
    const label = document.createElement('span');
    label.textContent = `📎 ${pendingAttachment.name}`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.title = t('attachRemove');
    removeBtn.addEventListener('click', clearPendingAttachment);
    pendingAttachmentEl.append(label, removeBtn);
    updateActionBtn(); // an attachment alone is now enough to make the action button "Send", not just typed text
  });

  let replyingTo = null; // {id, author, body} or null
  function setReplyingTo(message, authorLabel) {
    replyingTo = message ? { id: message.id, body: message.body } : null;
    replyBanner.textContent = '';
    if (!message) { replyBanner.hidden = true; return; }
    replyBanner.hidden = false;
    const label = document.createElement('span');
    label.textContent = t('replyingTo', { name: authorLabel });
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '✕';
    cancelBtn.addEventListener('click', () => setReplyingTo(null));
    replyBanner.append(label, cancelBtn);
  }

  const profileCache = new Map();
  async function resolveAuthor(pub) {
    if (!profileCache.has(pub)) profileCache.set(pub, services.profile.getPublicProfile(pub).catch(() => null));
    return profileCache.get(pub);
  }

  async function sendTextMessage() {
    if (!roomReady) return;
    const body = composerInput.value.trim();
    // A caption is optional whenever there's an attachment to send instead
    // - the same "content doesn't have to be text" rule voice messages
    // already get (see sendVoiceRecording()); only a genuinely empty
    // send (no text AND no attachment) is refused.
    if (!body && !pendingAttachment) return;
    actionBtn.disabled = true;
    try {
      const attachment = pendingAttachment;
      const extra = attachment ? { attachment } : {};
      stuckToBottom = true; // sending a message always means "show me what I just sent" - see the scroll-follow doc comment above
      await services.messages.postMessage(SPACE_ID, roomId, { body, replyTo: replyingTo?.id ?? null, extra });
      composerInput.value = '';
      clearPendingAttachment();
      setReplyingTo(null);
      updateActionBtn();
      // Only now, once the attachment is genuinely part of a sent message,
      // does the (deferred) sync-out verification phase start - see
      // <qu-asset-upload>'s own doc comment on confirmSent() for why.
      if (attachment) attachUpload.confirmSent(attachment.assetId);
    } finally {
      actionBtn.disabled = false;
    }
  }

  // ---- voice messages: MediaRecorder -> the SAME AssetService upload +
  // message.extra.attachment shape a file attachment already uses, so
  // <qu-asset>'s own kind="auto" MIME sniff (AssetService.download()'s
  // meta.mime, see @qu/ui's asset-components.js) picks "audio" and renders
  // a native <audio controls> player - zero new rendering code needed.
  //
  // STATE MACHINE (ported UX from QuV2 - see voiceRecorderEl's own doc
  // comment above): 'idle' -> 'recording' -> 'paused' <-> 'recording' ->
  // (finish) -> 'preview' -> (send, which posts the message, or discard)
  // -> 'idle'. 'recording'/'paused' can also go straight to 'idle' via
  // discard, bypassing 'preview' entirely - the whole point of Pause/Stop
  // being SEPARATE actions is that finishing a recording no longer sends
  // it immediately; the user always gets a listen-back-or-bail-out step
  // first. ----
  let recorderState = 'idle'; // 'idle' | 'recording' | 'paused' | 'preview'
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let recordedBlob = null;
  let recordedObjectUrl = null;
  // Elapsed recording time is tracked as (accumulated ms from prior
  // recording spans) + (time since the CURRENT span started), rather than
  // just "time since start()", so pausing genuinely freezes the displayed
  // timer instead of it continuing to climb while paused.
  let recordingElapsedMs = 0;
  let recordingSpanStartedAt = 0;
  let recordingTimerHandle = null;
  // Set right before calling mediaRecorder.stop() to discard the in-progress
  // take entirely (see discardVoiceRecording()) - distinguishes that from a
  // normal "finish -> preview" stop() inside the shared onstop handler,
  // since MediaRecorder only ever exposes the one event either way.
  let discardingOnStop = false;

  function formatVoiceElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function currentVoiceElapsedMs() {
    return recordingElapsedMs + (recorderState === 'recording' ? Date.now() - recordingSpanStartedAt : 0);
  }

  function startVoiceTimer() {
    stopVoiceTimer();
    voiceRecorderTime.textContent = formatVoiceElapsed(currentVoiceElapsedMs());
    recordingTimerHandle = setInterval(() => {
      voiceRecorderTime.textContent = formatVoiceElapsed(currentVoiceElapsedMs());
    }, 250);
  }

  function stopVoiceTimer() {
    clearInterval(recordingTimerHandle);
    recordingTimerHandle = null;
  }

  function syncVoiceRecorderUI() {
    const active = recorderState !== 'idle';
    voiceRecorderEl.hidden = !active;
    composerRow.hidden = active;
    const isPreview = recorderState === 'preview';
    voiceRecorderDot.hidden = recorderState !== 'recording';
    voiceRecorderTime.hidden = isPreview;
    voicePreviewPlayer.hidden = !isPreview;
    voicePauseBtn.hidden = isPreview;
    voiceFinishBtn.hidden = isPreview;
    voiceSendBtn.hidden = !isPreview;
    if (recorderState === 'paused') {
      voicePauseBtn.textContent = '▶️';
      voicePauseBtn.title = t('voiceResume');
    } else {
      voicePauseBtn.textContent = '⏸️';
      voicePauseBtn.title = t('voicePause');
    }
  }

  function resetVoiceRecorder() {
    if (recordedObjectUrl) URL.revokeObjectURL(recordedObjectUrl);
    recordedObjectUrl = null;
    recordedBlob = null;
    recordedChunks = [];
    recordingElapsedMs = 0;
    mediaRecorder = null;
    voicePreviewPlayer.removeAttribute('src');
    voiceRecorderTime.textContent = '00:00';
    stopVoiceTimer();
    recorderState = 'idle';
    syncVoiceRecorderUI();
  }

  function updateActionBtn() {
    if (composerInput.value.trim() || pendingAttachment) {
      actionBtn.textContent = '➤';
      actionBtn.title = t('send');
    } else {
      actionBtn.textContent = '🎙️';
      actionBtn.title = t('recordVoice');
    }
  }
  composerInput.addEventListener('input', updateActionBtn);
  updateActionBtn();

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      pendingAttachmentEl.hidden = false;
      pendingAttachmentEl.textContent = t('voiceNotSupported');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return; // permission denied / no device - stays idle, nothing to recover
    }
    mediaStream = stream;
    recordedChunks = [];
    recordingElapsedMs = 0;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
      if (discardingOnStop) {
        discardingOnStop = false;
        resetVoiceRecorder();
        return;
      }
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (recordedBlob.size === 0) {
        resetVoiceRecorder();
        return;
      }
      recordedObjectUrl = URL.createObjectURL(recordedBlob);
      voicePreviewPlayer.src = recordedObjectUrl;
      stopVoiceTimer();
      recorderState = 'preview';
      syncVoiceRecorderUI();
    };
    mediaRecorder.start();
    recordingSpanStartedAt = Date.now();
    recorderState = 'recording';
    startVoiceTimer();
    syncVoiceRecorderUI();
  }

  function togglePauseRecording() {
    if (recorderState === 'recording') {
      recordingElapsedMs += Date.now() - recordingSpanStartedAt;
      mediaRecorder?.pause();
      stopVoiceTimer();
      recorderState = 'paused';
      syncVoiceRecorderUI();
    } else if (recorderState === 'paused') {
      recordingSpanStartedAt = Date.now();
      mediaRecorder?.resume();
      recorderState = 'recording';
      startVoiceTimer();
      syncVoiceRecorderUI();
    }
  }

  function finishRecording() {
    if (recorderState !== 'recording' && recorderState !== 'paused') return;
    mediaRecorder?.stop(); // onstop above moves recorderState to 'preview'
  }

  function discardVoiceRecording() {
    if (recorderState === 'recording' || recorderState === 'paused') {
      discardingOnStop = true;
      stopVoiceTimer();
      mediaRecorder?.stop();
      return;
    }
    if (recorderState === 'preview') resetVoiceRecorder();
  }

  async function sendVoiceRecording() {
    if (recorderState !== 'preview' || !recordedBlob || !roomReady) return;
    voiceSendBtn.disabled = true;
    try {
      const assetId = globalThis.crypto.randomUUID();
      const file = new File([recordedBlob], `voice-${Date.now()}.webm`, { type: recordedBlob.type });
      const meta = await services.assets.upload(SPACE_ID, assetId, file, { readerPubs: memberPubs });
      stuckToBottom = true;
      await services.messages.postMessage(SPACE_ID, roomId, {
        body: t('voiceMessage'), replyTo: replyingTo?.id ?? null,
        extra: { attachment: { assetId, ...meta }, voice: true },
      });
      setReplyingTo(null);
      resetVoiceRecorder();
    } finally {
      voiceSendBtn.disabled = false;
    }
  }

  voicePauseBtn.addEventListener('click', togglePauseRecording);
  voiceFinishBtn.addEventListener('click', finishRecording);
  voiceDiscardBtn.addEventListener('click', discardVoiceRecording);
  voiceSendBtn.addEventListener('click', sendVoiceRecording);

  actionBtn.addEventListener('click', () => {
    if (composerInput.value.trim() || pendingAttachment) { sendTextMessage(); return; }
    startRecording();
  });

  // ---- location sharing: one-time position, sent as its own message.extra
  // field - deliberately no embedded map-tile PREVIEW image (that would mean
  // fetching from a third-party tile server on every render, leaking this
  // room's location data to a party beyond the relay/its members) - just a
  // link out to OpenStreetMap plus the raw coordinates, see
  // renderMessageText(). Invoked from the composer's "+" action menu (see
  // that menu's own doc comment) rather than its own always-visible button -
  // `shareLocationBusy` replaces the old per-button `.disabled` toggle as the
  // re-entrancy guard against a second click firing while a position request
  // is already in flight, since a closed menu has no button left to disable. ----
  let shareLocationBusy = false;
  function shareLocation() {
    if (!roomReady || !navigator.geolocation || shareLocationBusy) return;
    shareLocationBusy = true;
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          stuckToBottom = true;
          await services.messages.postMessage(SPACE_ID, roomId, {
            body: t('locationMessage'),
            replyTo: replyingTo?.id ?? null,
            extra: { location: { lat: position.coords.latitude, lng: position.coords.longitude } },
          });
          setReplyingTo(null);
        } finally {
          shareLocationBusy = false;
        }
      },
      () => { shareLocationBusy = false; }
    );
  }

  const editingDrafts = new Map();
  let messageWatchers = [];
  function clearMessageWatchers() {
    for (const off of messageWatchers) off();
    messageWatchers = [];
  }

  let renderToken = 0;
  let myPub = null;
  let chatSettings = DEFAULT_CHAT_SETTINGS;

  /** @param {object[]} messages @returns {{id: string, editedAt: number|null}[]} */
  function snapshotOf(messages) {
    return messages.map((m) => ({ id: m.id, editedAt: m.editedAt ?? null }));
  }
  /**
   * True when `current` is `previous` with ONLY new messages appended after
   * it - same ids, same `editedAt`, in the same order, for the whole
   * `previous` prefix. False for a first render (`previous` empty), an
   * edit/deletion anywhere in the existing range, or a reordering - any of
   * which needs the full rebuild path below to render correctly.
   */
  function isSimpleAppend(previous, current) {
    if (previous.length === 0 || current.length <= previous.length) return false;
    for (let i = 0; i < previous.length; i++) {
      if (previous[i].id !== current[i].id || previous[i].editedAt !== current[i].editedAt) return false;
    }
    return true;
  }

  /**
   * NO SPURIOUS JUMPS: `messagesRoot.textContent = ''` (the full-rebuild
   * path below) collapses `messagesScroll`'s own `scrollHeight` to ~0 for
   * one frame - if the user was scrolled anywhere below that, the BROWSER
   * itself force-clamps `scrollTop` down to fit the (momentarily empty)
   * content, and that clamp does NOT reverse itself once the content
   * regrows a moment later - confirmed live as "scrolling jumps down, then
   * back to the previous post" (down to wherever the clamp landed, then
   * back up/down again once something - a stray `stuckToBottom` read
   * during that same collapsed frame - kicks off a second, corrective
   * scroll). Two changes fix this together, not just one:
   *   1. INCREMENTAL APPEND (`isSimpleAppend()` above) - the overwhelmingly
   *      common case (a plain new message, nothing else changed) never
   *      touches `messagesRoot` at all; only the new tail messages are
   *      appended to the EXISTING <ul>, so nothing above them ever moves,
   *      collapses, or gets re-clamped in the first place.
   *   2. For the remaining, rarer full-rebuild cases (first mount, an edit,
   *      a deletion, a fresh permalink target to locate), `stuckToBottom`
   *      is snapshotted into `wasStuckToBottom` BEFORE touching the DOM at
   *      all, and `messagesScroll.scrollTop` is captured/explicitly
   *      restored afterward whenever this render must NOT move the view -
   *      never trusting the LIVE `stuckToBottom` (which the collapse's own
   *      spurious 'scroll' event could have just corrupted) or the
   *      browser's own post-collapse resting scrollTop (which is simply
   *      wrong, not "close enough").
   *
   * NEW MESSAGE BANNER: when NOT stuck to the bottom, a newly arrived
   * message never auto-scrolls the view at all (per explicit ask - jumping
   * away from whatever the user is reading is worse than not scrolling)
   * - `newMessageBanner` (a sticky-positioned pill, see its own creation
   * site) appears instead, click-to-catch-up.
   */
  async function renderMessages() {
    const token = ++renderToken;
    if (stopped || !roomReady) return;
    myPub = await services.actors.whoAmI();
    chatSettings = await getChatSettings(qu, services.messages.identity, myPub);
    if (stopped || token !== renderToken) return;
    const { messages } = await services.messages.listMessages(SPACE_ID, roomId);
    if (stopped || token !== renderToken) return;

    const otherMembers = memberPubs.filter((p) => p !== myPub);
    const readReceipts = await services.presence.getReadReceipts(SPACE_ID, roomId, otherMembers);
    if (stopped || token !== renderToken) return;

    if (messages.length) {
      const newestTs = messages[messages.length - 1].ts;
      // Guarded to fire only when the read position actually ADVANCES, not
      // on every renderMessages() call: publishReadReceipt() writes under
      // threadReadReceiptsParentPath(), which this function's OWN
      // watchChildren() (below, near offReadReceipts) re-renders on - an
      // unconditional publish here would re-trigger that watch, which
      // re-runs renderMessages(), which republishes, forever (an actual
      // infinite tear-down/rebuild loop, caught only by a test that opens
      // the context menu and finds it destroyed a tick after opening).
      // Comparing against the last value THIS session already published
      // (not what's stored - a fresh mount has nothing to compare against,
      // hence 0) breaks the cycle: the receipt is a monotonic "read up to"
      // marker, republishing the same value has no effect other than being
      // a wasted (here, dangerous) write.
      if (newestTs > lastPublishedReadUpto) {
        lastPublishedReadUpto = newestTs;
        services.presence.publishReadReceipt(SPACE_ID, roomId, newestTs).catch(() => {});
        services.messages.markRead(SPACE_ID, roomId).catch(() => {});
      }
    }

    // See this function's own "NO SPURIOUS JUMPS" doc comment.
    const wasStuckToBottom = stuckToBottom;
    const currentSnapshot = snapshotOf(messages);

    if (!pendingScrollTarget && isSimpleAppend(lastRenderedSnapshot, currentSnapshot)) {
      const appended = messages.slice(lastRenderedSnapshot.length);
      const ul = messagesRoot.querySelector('.qu-chat-messages');
      for (const message of appended) {
        renderedMessagesById.set(message.id, message);
        const li = await renderMessage(message, renderedMessagesById, readReceipts);
        if (stopped || token !== renderToken) return;
        ul.appendChild(li);
      }
      lastRenderedSnapshot = currentSnapshot;
      hasRenderedOnce = true;
      if (wasStuckToBottom) {
        hasUnseenMessage = false;
        syncScrollToBottomButton();
        scrollToBottom(true);
      } else {
        hasUnseenMessage = true;
        syncScrollToBottomButton();
      }
      return;
    }

    const previousScrollTop = messagesScroll.scrollTop; // see "NO SPURIOUS JUMPS" - restored below when this render must not move the view
    const isFirstRender = !hasRenderedOnce;
    clearMessageWatchers();
    messagesRoot.textContent = '';
    renderedMessagesById = new Map(messages.map((m) => [m.id, m])); // see refreshReadTicks()'s own doc comment
    lastRenderedSnapshot = currentSnapshot;
    hasRenderedOnce = true;
    if (messages.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'qu-chat-messages';
      for (const message of messages) {
        const li = await renderMessage(message, renderedMessagesById, readReceipts);
        if (stopped || token !== renderToken) return;
        ul.appendChild(li);
      }
      messagesRoot.appendChild(ul);
    }

    // See mountRoomView()'s own doc comment on "PERMALINKS + scroll-follow".
    let effectiveStuck = wasStuckToBottom;
    if (pendingScrollTarget) {
      const targetRow = [...messagesRoot.querySelectorAll('.qu-chat-bubble-row')].find((li) => li.dataset.messageId === pendingScrollTarget);
      pendingScrollTarget = null;
      if (targetRow) {
        // A permalink target is, by definition, not the bottom - the button
        // must show (not hide) here so there's a way back down. See
        // syncScrollToBottomButton()'s own doc comment: hasUnseenMessage
        // only controls the label, never the visibility.
        hasUnseenMessage = false;
        // jsdom (this repo's test DOM) has no layout engine and doesn't
        // implement scrollIntoView() at all - optional-chained so tests
        // exercise every line above/below it without stubbing it out.
        // block: 'start' (not 'center') - the message someone followed a
        // link to should land clearly at the TOP of the visible area, not
        // buried in the middle where it's easy to miss which one it was.
        targetRow.scrollIntoView?.({ block: 'start' });
        lastKnownAnchorScrollTop = messagesScroll.scrollTop;
        targetRow.classList.add('qu-chat-bubble-row-highlight');
        setTimeout(() => targetRow.classList.remove('qu-chat-bubble-row-highlight'), 2000);
        stuckToBottom = false;
        // Stays "stuck" to this message (re-corrected by the ResizeObserver/
        // viewport-resize handler above) until the user scrolls on their
        // own - see `stuckToMessageId`'s own doc comment.
        stuckToMessageId = targetRow.dataset.messageId;
        syncScrollToBottomButton();
        return;
      }
      effectiveStuck = true; // the permalinked message is gone (deleted?) - fall through to "show latest" below
    }
    stuckToBottom = effectiveStuck;
    if (effectiveStuck) {
      hasUnseenMessage = false;
      // A smooth scroll (not an instant scrollTop jump) - most noticeable
      // right after returning from a permalink/highlighted message further
      // up: without this, "catching up" to the latest message read as an
      // abrupt jump rather than a natural scroll. Instant on the very
      // first render of this mount instead - opening a room should show it
      // already resting at the bottom, not visibly scroll there.
      scrollToBottom(!isFirstRender);
    } else {
      messagesScroll.scrollTop = previousScrollTop;
    }
    syncScrollToBottomButton();
  }

  /**
   * A peer's read receipt (PresenceService.publishReadReceipt()) changing
   * is a FREQUENT, routine event (fires on every render of every OTHER
   * member's own room view) - reusing renderMessages() for it would tear
   * down and rebuild the entire message list, including any row an actual
   * person happens to have an in-progress interaction with right at that
   * moment (an open "⋮" context menu, an in-progress edit textarea) purely
   * because someone else's read position moved. This does the ONE thing
   * that actually changed - each own message's read-tick footer segment -
   * in place, touching nothing else. Bound to the read-receipts watch (see
   * mountRoomView()'s own offReadReceipts wiring below) instead of
   * renderMessages() itself.
   */
  async function refreshReadTicks() {
    if (stopped || !roomReady || !myPub) return;
    const otherMembers = memberPubs.filter((p) => p !== myPub);
    const readReceipts = await services.presence.getReadReceipts(SPACE_ID, roomId, otherMembers);
    if (stopped) return;
    for (const row of messagesRoot.querySelectorAll('.qu-chat-bubble-row')) {
      const tickEl = row.querySelector('[data-segment="core.readReceipt"]');
      if (!tickEl) continue; // not one of THIS identity's own messages - no tick segment was rendered for it at all
      const message = renderedMessagesById.get(row.dataset.messageId);
      if (!message) continue;
      renderReadReceiptTick(tickEl, message, readReceipts);
    }
  }

  // Closes whichever read-time popover (see renderReadReceiptTick() below)
  // is currently open, if any - at most one open at a time, same shape as
  // @qu/thread-ui's own renderContextMenu()/renderEmojiPicker() single-panel
  // convention, just hand-rolled here since this popover is chat-specific
  // (a shared component wasn't worth it for one tap target).
  let closeReadTimePopover = null;

  /**
   * Renders (or, called again from refreshReadTicks(), updates in place) the
   * `core.readReceipt` footer segment: the ✓/✓✓ tick, PLUS - once read - a
   * click/tap handler that briefly reveals WHEN it was read, via
   * `PresenceService.getReadReceipts()`'s own `readAt` (the receipt QuBit's
   * real write timestamp, distinct from `upto`, which is only WHICH message
   * was read up to - see that method's own doc comment).
   * @param {HTMLElement} el @param {object} message @param {Record<string, {upto: number, readAt: number}>} readReceipts
   */
  function renderReadReceiptTick(el, message, readReceipts) {
    const readers = Object.entries(readReceipts).filter(([, r]) => r.upto >= message.ts);
    const isRead = readers.length > 0;
    // The glyph lives in its OWN child span, never directly in `el.textContent`
    // - refreshReadTicks() calls this again on every read-receipts watch
    // notification (including harmless duplicate/echo ones - see
    // refreshReadTicks()'s own doc comment), and a plain `el.textContent =`
    // there would silently wipe out an open read-time popover (also a
    // child of `el` - see toggleReadTimePopover() below) out from under
    // the person who just tapped it open.
    let glyph = el.querySelector('.qu-chat-bubble-tick-glyph');
    if (!glyph) {
      glyph = document.createElement('span');
      glyph.className = 'qu-chat-bubble-tick-glyph';
      el.appendChild(glyph);
    }
    glyph.textContent = isRead ? '✓✓' : '✓';
    el.title = isRead ? t('read') : t('sent');
    el.classList.toggle('qu-chat-bubble-tick-read', isRead);
    // Rebinding onclick (not addEventListener) on every render/refresh is
    // deliberate - it always closes over the CURRENT `readers`, and never
    // accumulates duplicate listeners across refreshReadTicks() calls the
    // way addEventListener would.
    el.onclick = isRead ? (e) => { e.stopPropagation(); toggleReadTimePopover(el, message, readers); } : null;
  }

  /**
   * Toggles a small popover anchored to the tick showing exactly when each
   * reader read this message (one line per reader in a group; a single
   * time in a 1:1, where there's only ever one other reader). Clicking the
   * SAME tick again closes it - same "tap to reveal, tap to dismiss" shape
   * WhatsApp/Telegram use for their own read-time popovers.
   */
  async function toggleReadTimePopover(el, message, readers) {
    const wasOpenForThisTick = el.dataset.popoverOpen === '1';
    closeReadTimePopover?.();
    if (wasOpenForThisTick) return;

    const lines = await Promise.all(
      readers
        .sort((a, b) => a[1].readAt - b[1].readAt)
        .map(async ([pub, { readAt }]) => {
          if (target.kind !== 'group') return formatTs(readAt);
          const label = formatActorLabel(pub, await resolveAuthor(pub));
          return `${label}: ${formatTs(readAt)}`;
        })
    );
    if (stopped || el.dataset.popoverOpen === '1') return; // closed again while resolving author labels

    const panel = document.createElement('div');
    panel.className = 'qu-chat-bubble-tick-popover';
    for (const line of lines) {
      const row = document.createElement('div');
      row.textContent = line;
      panel.appendChild(row);
    }
    el.appendChild(panel);
    flipUpIfNeeded(panel, el, 'qu-chat-bubble-tick-popover-flip-up');
    el.dataset.popoverOpen = '1';

    function onDocClick(e) {
      if (!panel.contains(e.target) && e.target !== el) close();
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    function close() {
      panel.remove();
      delete el.dataset.popoverOpen;
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeydown);
      closeReadTimePopover = null;
    }
    closeReadTimePopover = close;
    // Deferred one tick - same reasoning as renderContextMenu()'s own
    // openPanel(): without it, THIS click would immediately bubble into
    // onDocClick and close the popover it just opened.
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKeydown);
    }, 0);
  }

  async function renderMessage(message, byId, readReceipts) {
    const mine = message.author === myPub;
    const row = document.createElement('li');
    row.className = 'qu-chat-bubble-row' + (mine ? ' qu-chat-bubble-row-mine' : '');
    // The permalink scroll target (see mountRoomView()'s own doc comment on
    // "PERMALINKS + scroll-follow") - `id` for a real, shareable DOM anchor,
    // `dataset` so renderMessages() can find this row by message id without
    // needing to CSS-escape an arbitrary id string into a selector.
    row.id = `m-${message.id}`;
    row.dataset.messageId = message.id;
    const bubble = document.createElement('div');
    bubble.className = 'qu-chat-bubble' + (mine ? ' qu-chat-bubble-mine' : '');
    if (mine && chatSettings.ownColor) bubble.style.background = chatSettings.ownColor;

    const showAuthor = target.kind === 'group' || chatSettings.showAliasIn1to1;
    if (showAuthor && !mine) {
      const profile = await resolveAuthor(message.author);
      const authorEl = document.createElement('div');
      authorEl.className = 'qu-chat-bubble-author';
      authorEl.textContent = formatActorLabel(message.author, profile);
      bubble.appendChild(authorEl);
    }

    if (message.replyTo) {
      // Clickable, not just a text snippet - the SAME permalink route the
      // timestamp link below already uses (messagePermalink()), so it reuses
      // the exact same, already-working "jump to this message and scroll it
      // into view" mechanism (mountRoomView()'s own pendingScrollTarget +
      // highlight - see that doc comment) rather than a second, parallel
      // implementation. `parent` may be unresolved (paginated out of the
      // currently-loaded window) - still links to `message.replyTo`'s own
      // id either way; renderMessages() itself already falls back to
      // "show latest" if the target row turns out not to be locally
      // rendered (see its own `effectiveStuck` fallback).
      const parent = byId.get(message.replyTo);
      const replyEl = document.createElement('a');
      replyEl.className = 'qu-chat-bubble-reply';
      replyEl.href = messagePermalink({ id: message.replyTo });
      replyEl.textContent = parent?.body ?? t('originalMessageUnavailable');
      bubble.appendChild(replyEl);
    }

    const textWrap = document.createElement('div');
    if (editingDrafts.has(message.id)) renderMessageEdit(textWrap, message);
    else renderMessageText(textWrap, message);
    bubble.appendChild(textWrap);

    const footer = await buildMessageFooter(message, mine, readReceipts, textWrap);
    bubble.appendChild(footer);

    row.appendChild(bubble);
    return row;
  }

  /**
   * The per-message footer ROW (`content.messageMenu`/`content.messageFooter`
   * - see this file's own top doc comment). Mirrors
   * `apps/forum/client.js`'s own `buildMessageFooter()` almost exactly -
   * two differences: a native "Reply" menu item (any message, not just
   * `mine`), and a native `core.readReceipt` footer segment (own messages
   * only - the ✓/✓✓ tick, see `renderMessages()`'s own `readReceipts` lookup).
   * @param {object} message @param {boolean} mine @param {Record<string, {upto: number, readAt: number}>} readReceipts
   * @param {HTMLElement} textWrap - re-rendered in place by the native "Edit" menu item.
   * @returns {Promise<HTMLElement>}
   */
  async function buildMessageFooter(message, mine, readReceipts, textWrap) {
    const menuPayload = {
      services, qu, syncFetch, spaceId: SPACE_ID, threadId: roomId, messageId: message.id, myPub, mine,
      body: message.body, author: message.author,
    };

    const segments = [
      {
        id: 'core.menu',
        render: (el) => {
          el.appendChild(renderContextMenu({
            trigger: '⋮',
            triggerTitle: t('moreActions'),
            getItems: async () => {
              const nativeItems = [];
              if (mine) nativeItems.push({ id: 'edit', label: t('edit'), icon: '✏️', onClick: () => renderMessageEdit(textWrap, message) });
              nativeItems.push({
                id: 'reply', label: t('reply'), icon: '↩️',
                onClick: async () => {
                  const authorLabel = mine ? t('you') : formatActorLabel(message.author, await resolveAuthor(message.author));
                  setReplyingTo(message, authorLabel);
                  composerInput.focus();
                },
              });
              nativeItems.push({ id: 'copyText', label: t('copyText'), icon: '📋', onClick: () => copyToClipboard(message.body) });
              nativeItems.push({ id: 'copyLink', label: t('copyLink'), icon: '🔗', onClick: () => copyToClipboard(absoluteMessagePermalink(message)) });
              const pluginItems = extensionPoints ? await extensionPoints.collect('content.messageMenu', menuPayload) : [];
              return [...nativeItems, ...pluginItems].sort(
                (a, b) => rankFor(extensionPoints?.order, 'content.messageMenu', a.id, MENU_ORDER_DEFAULT[a.id] ?? 50)
                  - rankFor(extensionPoints?.order, 'content.messageMenu', b.id, MENU_ORDER_DEFAULT[b.id] ?? 50)
              );
            },
          }));
        },
      },
      {
        id: 'core.timestamp',
        render: (el) => {
          // The timestamp doubles as this message's permalink (see
          // mountRoomView()'s own "PERMALINKS + scroll-follow" doc comment) -
          // a plain in-app hash link, not a copy-to-clipboard action, so it
          // works the same whether shared externally or clicked right here.
          const link = document.createElement('a');
          link.className = 'qu-chat-bubble-timestamp-link';
          link.href = messagePermalink(message);
          link.title = t('permalink');
          link.textContent = message.editedAt ? `${formatTs(message.ts)} (${t('edit').toLowerCase()})` : formatTs(message.ts);
          el.appendChild(link);
        },
      },
      {
        id: 'reactions',
        render: (el) => (extensionPoints ? extensionPoints.renderSlot('content.messageFooter', el, menuPayload) : null),
      },
    ];
    if (mine) {
      segments.push({
        id: 'core.readReceipt',
        render: (el) => renderReadReceiptTick(el, message, readReceipts),
      });
    }

    const footer = document.createElement('div');
    footer.className = 'qu-chat-bubble-footer';
    const ranked = segments
      .map((seg) => ({ ...seg, rank: rankFor(extensionPoints?.order, 'content.messageFooter', seg.id, FOOTER_ORDER_DEFAULT[seg.id] ?? 50) }))
      .sort((a, b) => a.rank - b.rank);
    for (const seg of ranked) {
      const wrap = document.createElement('span');
      // Lets refreshReadTicks() (see mountRoomView()'s own doc comment)
      // find and update the 'core.readReceipt' segment of an ALREADY
      // rendered row directly, without renderMessages() tearing down and
      // rebuilding the whole message list just because a receipt changed.
      wrap.dataset.segment = seg.id;
      await seg.render(wrap);
      footer.appendChild(wrap);
    }
    return footer;
  }

  function renderMessageText(root, message) {
    root.textContent = '';
    // A voice message's `body` is just the placeholder t('voiceMessage')
    // string (see startRecording()'s own onstop handler) - the <audio>
    // player below is the actual content, so the redundant text line is
    // skipped entirely, same reasoning a location message's own coordinate
    // block below replaces its placeholder body text rather than showing both.
    if (!message.voice && !message.location && message.body) {
      const p = document.createElement('p');
      p.className = 'qu-chat-bubble-text';
      const linkSegments = detectLinks(message.body);
      for (const segment of linkSegments) {
        if (segment.type === 'link') {
          const a = document.createElement('a');
          a.href = segment.value;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = segment.value;
          p.appendChild(a);
        } else {
          p.appendChild(document.createTextNode(segment.value));
        }
      }
      root.appendChild(p);
      // Only the FIRST link in a message gets a preview card - Telegram/
      // Slack/etc. all do this too, never one card per link (a message with
      // several links would otherwise turn into a wall of cards). Renders
      // nothing at all if the relay has nothing preview-worthy for it - see
      // <qu-link-preview>'s own doc comment (@qu/ui's
      // link-preview-components.js).
      const firstLink = linkSegments.find((seg) => seg.type === 'link');
      if (firstLink) {
        const preview = document.createElement('qu-link-preview');
        preview.setAttribute('url', firstLink.value);
        root.appendChild(preview);
      }
    }
    if (message.attachment) {
      const assetEl = document.createElement('qu-asset');
      assetEl.className = 'qu-chat-bubble-attachment';
      assetEl.setAttribute('space-id', SPACE_ID);
      assetEl.setAttribute('asset-id', message.attachment.assetId);
      root.appendChild(assetEl);
    }
    if (message.location) {
      const { lat, lng } = message.location;
      const box = document.createElement('div');
      box.className = 'qu-chat-bubble-location';
      const link = document.createElement('a');
      link.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `📍 ${t('locationMessage')}`;
      const coords = document.createElement('div');
      coords.className = 'qu-chat-bubble-location-coords';
      coords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      box.append(link, coords);
      root.appendChild(box);
    }
  }

  function renderMessageEdit(root, message) {
    root.textContent = '';
    const row = document.createElement('div');
    row.className = 'qu-chat-edit-row';
    const textarea = document.createElement('textarea');
    textarea.value = editingDrafts.get(message.id) ?? message.body;
    editingDrafts.set(message.id, textarea.value);
    textarea.addEventListener('input', () => editingDrafts.set(message.id, textarea.value));
    messageWatchers.push(mountMentionAutocomplete(textarea, { services, subscribe }));
    messageWatchers.push(mountEmojiAutocomplete(textarea));
    const buttons = document.createElement('div');
    buttons.className = 'qu-chat-edit-row-buttons';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = t('save');
    saveBtn.addEventListener('click', async () => {
      const body = textarea.value.trim();
      if (!body) return;
      await services.messages.editMessage(SPACE_ID, roomId, message.id, { body });
      editingDrafts.delete(message.id);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => {
      editingDrafts.delete(message.id);
      renderMessageText(root, message);
    });
    buttons.append(saveBtn, cancelBtn);
    row.append(textarea, buttons);
    root.appendChild(row);
  }

  // ---- presence: polled, not pushed - see this file's own top doc comment ----
  let presenceTimer = null;
  async function renderPresence() {
    if (stopped || !roomReady) return;
    const otherMembers = memberPubs.filter((p) => p !== myPub);
    const presence = await services.presence.getPresence(SPACE_ID, roomId, otherMembers);
    if (stopped) return;
    if (target.kind === 'dm') {
      const p = presence[target.peerPub];
      headerStatusEl.textContent = p?.online ? t('online') : (p ? t('lastSeen', { time: formatTs(p.lastSeen) }) : '');
    } else {
      const online = Object.values(presence).filter((p) => p.online).length;
      headerStatusEl.textContent = t('membersOnline', { count: memberPubs.length, online });
    }
  }

  let stopHeartbeat = null;

  (async () => {
    myPub = await services.actors.whoAmI();
    if (stopped) return;

    if (target.kind === 'dm') {
      roomId = await services.chat.ensureRoom(SPACE_ID, target.peerPub);
      if (stopped) return;
      memberPubs = [myPub, target.peerPub];
      attachUpload.readerPubs = memberPubs;
      const profile = await resolveAuthor(target.peerPub);
      if (stopped) return;
      headerNameEl.textContent = formatActorLabel(target.peerPub, profile);
      headerAvatarSlot.appendChild(renderAvatarOrAsset(target.peerPub, headerNameEl.textContent, profile?.avatar, { size: '2.6rem' }));
    } else {
      roomId = target.roomId;
      const config = await services.messages.getConfig(SPACE_ID, roomId);
      if (stopped) return;
      if (!config) {
        const p = document.createElement('p');
        p.className = 'qu-chat-empty';
        p.textContent = t('groupNotFound');
        messagesRoot.appendChild(p);
        composerWrap.hidden = true;
        return;
      }
      memberPubs = Array.isArray(config.readers) ? config.readers : [];
      attachUpload.readerPubs = memberPubs;
      headerNameEl.textContent = config.name ?? roomId;
      headerAvatarSlot.appendChild(renderAvatarOrAsset(roomId, headerNameEl.textContent, null, { size: '2.6rem' }));
    }
    roomReady = true;
    await refreshHeaderMuted();
    if (stopped) return;

    stopHeartbeat = services.presence.startHeartbeat(SPACE_ID, roomId);
    renderPresence();
    presenceTimer = setInterval(renderPresence, 5_000);

    subscribe?.(paths.threadMessagesParentPath(SPACE_ID, roomId));
    offMessages = watchChildren(qu, paths.threadMessagesParentPath(SPACE_ID, roomId), () => renderMessages(), { syncFetch });
    // Read receipts (PresenceService.publishReadReceipt()) live under a
    // SIBLING of .../msgs (see threadReadReceiptsParentPath()'s own doc
    // comment), so the watch above never fires for one arriving via sync -
    // without this second watch, a peer's receipt lands in the local store
    // just fine but the read-tick footer segment (built from a one-time
    // getReadReceipts() snapshot in renderMessages()) never re-renders to
    // reflect it, silently freezing at whatever it showed on first render.
    // Bound to refreshReadTicks() (see its own doc comment), NOT
    // renderMessages() itself - THIS identity's own receipt-publishing
    // inside renderMessages() would otherwise retrigger this same watch on
    // every single render (bounded by lastPublishedReadUpto's guard, but
    // still a real full-list rebuild racing whatever the user is doing at
    // that exact moment, e.g. a just-opened context menu getting torn down
    // out from under them a tick after opening).
    offReadReceipts = watchChildren(qu, paths.threadReadReceiptsParentPath(SPACE_ID, roomId), () => refreshReadTicks(), { syncFetch });
    renderMessages();
  })();

  // Room-switcher `navigation` + "+ New group" `primaryAction` - see this
  // file's own top doc comment's "NAVIGATION" section. Independent of the
  // main setup IIFE above (its own `services.actors.whoAmI()` call, not a
  // shared await) so a group-not-found early return up there still leaves
  // the sidebar/footer usable to get to a DIFFERENT room. `roomId` (read
  // once this resolves) is set synchronously at the very top of both
  // branches up there, well before either can bail out.
  (async () => {
    const myPubForNav = await services.actors.whoAmI();
    if (stopped) return;
    const [rooms, { allowMemberCreateGroup, isAdmin }] = await Promise.all([
      listRooms({ services, SPACE_ID, myPub: myPubForNav }),
      fetchChatPolicy(services),
    ]);
    if (stopped) return;
    stopTemplate.update({
      navigation: { items: roomsToNavItems(rooms), activeId: roomId, heading: t('title') },
      primaryAction: (isAdmin || allowMemberCreateGroup)
        ? { label: t('newChatGroup'), href: '#/chat/new-group', icon: '✏️' }
        : undefined,
    });
  })();

  let offMessages = () => {};
  let offReadReceipts = () => {};

  return () => {
    stopped = true;
    clearMessageWatchers();
    offMessages();
    offReadReceipts();
    stopHeartbeat?.();
    if (presenceTimer) clearInterval(presenceTimer);
    stopComposerMentions();
    stopComposerEmoji();
    stopComposerAutogrow();
    resizeObserver?.disconnect();
    viewportResizeTarget.removeEventListener('resize', onViewportResize);
    stopVoiceTimer();
    for (const track of mediaStream?.getTracks() ?? []) track.stop();
    if (recordedObjectUrl) URL.revokeObjectURL(recordedObjectUrl);
    stopTemplate();
  };
}

// ===================================================================
// SEARCH - `content.search`/`content.searchResultTemplate` contributor
// (apps/search's own extension points, see that app's manifest.quapp for
// the full payload contract) - closes part of this file's own "SCOPE" doc
// comment gap ("per-chat/global search ... left for a real follow-up
// round"). Chat never imports apps/search; apps/search never imports Chat -
// both only agree on these two point strings, same shape apps/forum's own
// identically-named contributors already establish (see that file's own
// doc comment). Chat's composer DOES attach files/images/videos and record
// voice messages (`<qu-asset-upload>` - see this file's own top doc
// comment's "Attachments" bullet) - `classifyMessageContentType()` below
// classifies every one of them (a voice message is just an audio
// attachment with `message.extra.voice: true` layered on top, same
// `message.attachment.mime` this already reads), so the `'image'`/
// `'video'`/`'audio'`/`'file'` filters all genuinely match real chat
// content, not just Forum's.
// ===================================================================

/** @param {object} message @returns {'post'|'image'|'video'|'audio'|'file'|'link'} */
function classifyMessageContentType(message) {
  const mime = message.attachment?.mime ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (message.attachment) return 'file';
  if (detectLinks(message.body ?? '').some((seg) => seg.type === 'link')) return 'link';
  return 'post';
}

/**
 * A short excerpt centered on the first match, so a long message's result
 * row doesn't dump its entire body. An empty/falsy `query` (e.g. resolving a
 * notification's reference, where there's no search term to center on - see
 * `resolveChatReference()` below) is treated the same as "no match found":
 * `String.prototype.indexOf('')` returns `0`, not `-1`, so this is checked
 * explicitly rather than relying on that quirk.
 */
function buildSnippet(body, query, radius = 60) {
  if (!body) return '';
  const idx = query ? body.toLowerCase().indexOf(query) : -1;
  if (idx === -1) return body.length > 140 ? `${body.slice(0, 140)}…` : body;
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + query.length + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

/**
 * The `content.search` contributor.
 * @param {{services: object, apps: object[], myPub?: string, query: string, types: string[]|null, scope: 'global'|'app'|'subpage', segments?: string[]}} payload -
 *   `segments` is the ORIGINAL `#/chat/...` route's segments (see
 *   `mount()`'s own `[, seg1, seg2] = segments` above) - only consulted for
 *   `scope: 'subpage'`; `'app'`/`'global'` both mean "search every room this
 *   identity is in" from THIS contributor's point of view.
 * @returns {Promise<Array<object>>}
 */
export async function searchChat({ services, apps, myPub, query, types, scope, segments = [] }) {
  const SPACE_ID = apps?.find((a) => a.name === 'chat')?.spaceId;
  const q = (query ?? '').trim().toLowerCase();
  // A TYPE filter with no text query is a real, useful search on its own -
  // "show me every image in this chat" - not something a body-text match
  // could ever satisfy (an image message's own body is just a placeholder
  // string, never the image's content). Only bail when NEITHER narrows
  // anything - `apps/search/client.js`'s own guard mirrors this (it never
  // even calls a content.search contributor for a genuinely empty query
  // with no type selected either).
  if (!SPACE_ID || (!q && !types?.length)) return [];
  myPub ??= await services.actors.whoAmI();
  const [, seg1, seg2] = segments;

  async function messagesOfRoom(roomId, href, roomName) {
    const { messages } = await services.messages.listMessages(SPACE_ID, roomId);
    const out = [];
    for (const message of messages) {
      const contentType = classifyMessageContentType(message);
      if (types?.length && !types.includes(contentType)) continue;
      if (q && !message.body?.toLowerCase().includes(q)) continue;
      out.push({
        contentType, ts: message.ts, author: message.author, snippet: buildSnippet(message.body, q),
        href: `${href}/m/${message.id}`, roomId, roomName,
        // See apps/forum/client.js's own identical fields on its own
        // messagesOfTopic() - carried through so renderSearchResult() below
        // can render a real <qu-asset> preview/player, not just text.
        spaceId: SPACE_ID, attachment: message.attachment ?? null,
      });
    }
    return out;
  }

  if (scope === 'subpage' && seg1 === 'g' && seg2) {
    const config = await services.messages.getConfig(SPACE_ID, seg2);
    return messagesOfRoom(seg2, `#/chat/g/${seg2}`, config?.name ?? seg2);
  }
  if (scope === 'subpage' && seg1 && seg1 !== 'new-group') {
    const roomId = await ChatService.roomId([myPub, seg1]);
    const profile = await services.profile.getPublicProfile(seg1);
    return messagesOfRoom(roomId, `#/chat/${seg1}`, formatActorLabel(seg1, profile ?? {}));
  }

  // 'app'/'global', or 'subpage' with no specific room (the room list) - every room this identity is in.
  const [contacts, groupIds] = await Promise.all([services.contacts.listContacts(), services.chat.listMyGroups()]);
  const dmResults = await Promise.all(contacts.map(async (c) => {
    const roomId = await ChatService.roomId([myPub, c.actorPub]);
    return messagesOfRoom(roomId, `#/chat/${c.actorPub}`, formatActorLabel(c.actorPub, c.profile));
  }));
  const groupResults = await Promise.all(groupIds.map(async (groupId) => {
    const config = await services.messages.getConfig(SPACE_ID, groupId);
    if (!config) return []; // invited but the group thread itself hasn't synced in yet - same guard mountRoomListView() itself uses
    return messagesOfRoom(groupId, `#/chat/g/${groupId}`, config.name ?? groupId);
  }));
  return [...dmResults.flat(), ...groupResults.flat()];
}

/**
 * The `content.resolveReference` contributor (see `apps/notifications/
 * manifest.quapp`'s own doc comment for the full payload contract) -
 * resolves a stored notification's bare `{spaceId, threadId, messageId}`
 * reference back into a `content.search`-shaped entry, so the SAME
 * `renderSearchResult()` below (Search's own template) can render it. A
 * single `getMessage()` lookup, not a full `listMessages()` scan.
 * `threadId` here is a room id - `g-...` (group) or `r-...` (1:1, see
 * `ChatService.roomId()`'s own doc comment on the prefix) - a 1:1 room's
 * `getConfig().readers` is always exactly `[myPub, peerPub]` (see
 * `ChatService.ensureRoom()`), so the peer is simply "whichever reader isn't
 * me", no reverse hash lookup needed.
 * @param {{services: object, syncFetch?: Function, myPub?: string, spaceId: string|number, threadId: string, messageId: string}} payload
 * @returns {Promise<object|null>} One entry, or `null` if unresolvable.
 */
export async function resolveChatReference({ services, syncFetch, myPub, spaceId, threadId, messageId }) {
  await syncFetch?.(paths.threadMessagePath(spaceId, threadId, messageId)).catch(() => {});
  const message = await services.messages.getMessage(spaceId, threadId, messageId);
  if (!message) return null;

  const config = await services.messages.getConfig(spaceId, threadId);
  let href, roomName;
  if (threadId.startsWith('g-')) {
    href = `#/chat/g/${threadId}`;
    roomName = config?.name ?? threadId;
  } else {
    myPub ??= await services.actors.whoAmI();
    const peerPub = (config?.readers ?? []).find((pub) => pub !== myPub) ?? null;
    const profile = peerPub ? await services.profile.getPublicProfile(peerPub) : null;
    href = peerPub ? `#/chat/${peerPub}` : '#/chat';
    roomName = peerPub ? formatActorLabel(peerPub, profile ?? {}) : threadId;
  }
  // Deep-link straight to the referenced message itself (see mountRoomView()'s
  // own "PERMALINKS + scroll-follow" doc comment), not just the room it's in -
  // `href === '#/chat'` only when the 1:1 peer couldn't be resolved at all, in
  // which case there's no room to land in either, so the /m/ suffix is skipped.
  if (href !== '#/chat') href = `${href}/m/${messageId}`;

  return {
    contentType: classifyMessageContentType(message), ts: message.ts, author: message.author,
    snippet: buildSnippet(message.body, ''),
    href, roomId: threadId, roomName,
    spaceId, attachment: message.attachment ?? null,
  };
}

/**
 * The `content.searchResultTemplate` contributor - renders one row for an
 * entry THIS SAME app returned from `searchChat()`/`resolveChatReference()`
 * above (both callers, Search and Notifications, share this one template).
 * See apps/forum/client.js's own identical `renderSearchResult()` for the
 * full "RENDERS MEDIA AS SUCH" reasoning - this is that same fix, ported.
 * @param {HTMLElement} container
 * @param {{entry: object, services: object}} payload
 */
export async function renderSearchResult(container, { entry, services }) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-chat-search-result';

  const link = document.createElement('a');
  link.className = 'qu-chat-search-result-link';
  link.href = entry.href;

  let authorLabel = entry.author ?? '';
  try {
    const profile = entry.author ? await services.profile.getPublicProfile(entry.author) : null;
    if (profile) authorLabel = formatActorLabel(entry.author, profile);
  } catch { /* offline/unresolvable - falls back to the raw pubkey */ }

  const meta = document.createElement('div');
  meta.className = 'qu-chat-search-result-meta';
  meta.textContent = `${authorLabel} · ${t('searchResultIn', { room: entry.roomName ?? entry.roomId ?? '' })} · ${new Date(entry.ts).toLocaleString()}`;
  link.appendChild(meta);

  if (entry.snippet) {
    const snippet = document.createElement('p');
    snippet.className = 'qu-chat-search-result-snippet';
    snippet.textContent = entry.snippet;
    link.appendChild(snippet);
  }
  wrap.appendChild(link);

  if (entry.attachment && entry.spaceId) {
    const assetEl = document.createElement('qu-asset');
    assetEl.className = 'qu-chat-search-result-attachment';
    assetEl.setAttribute('space-id', entry.spaceId);
    assetEl.setAttribute('asset-id', entry.attachment.assetId);
    wrap.appendChild(assetEl);
  }

  container.appendChild(wrap);
}
