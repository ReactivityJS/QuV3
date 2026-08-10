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
 * `#/chat/g/<groupId>` (group room), `#/chat/new-group` (create-group form).
 *
 * COMPOSER: a rounded "pill" (textarea + emoji trigger) plus a tool
 * cluster (attach/location) and ONE circular action button that MORPHS
 * between 🎙️ (composer empty) and ➤ send (composer has text) - Telegram/
 * WhatsApp's own composer language, not a flat text-input row with a line
 * of plain buttons after it. See `updateActionBtn()`.
 *
 * VOICE MESSAGES: `MediaRecorder` (feature-detected - silently falls back
 * to a `voiceNotSupported` hint on a browser/device without it) records to
 * a `Blob`, uploaded through the EXACT SAME `services.assets.upload()` +
 * `message.extra.attachment` shape a file attachment already uses (see
 * `attachUpload`'s own `qu-asset-uploaded` handler) - so `<qu-asset
 * kind="auto">`'s existing MIME sniff (`@qu/ui`'s `asset-components.js`)
 * picks `audio` and renders a native `<audio controls>` player for it, zero
 * new rendering code needed. `message.extra.voice: true` only suppresses
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
 * wired through `services` yet. A recorded voice message has no waveform/
 * duration preview (the native `<audio controls>` element's own scrubber
 * covers playback position) and no press-and-hold-to-record/slide-to-cancel
 * gesture (tap-to-start, tap-to-stop instead) - both real, valid follow-ups,
 * not attempted half-way here. Visual `@mention` highlighting inside a
 * message body is also not rendered (the underlying `mentions` field still
 * drives push notification routing via this app's own `pushActions`, which
 * is the part that actually matters functionally) - only bare `http(s)://`
 * links are auto-linked, via `@qu/services`' shared `detectLinks()`.
 */
import { watch, watchChildren } from '@qu/reactive';
import { paths, formatActorLabel, getPrivate, putPrivate, detectLinks, ChatService } from '@qu/services';
import { rankFor } from '@qu/foundation';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderAvatarOrAsset, renderSubpage } from '@qu/ui';
import { renderEmojiPicker, renderContextMenu, mountMentionAutocomplete, mountEmojiAutocomplete, insertAtCursor } from '@qu/thread-ui';

// See this file's own top doc comment's "MESSAGE CHROME" section - the
// SAME two default-order maps `apps/forum/client.js` uses (keep both files'
// copies identical if either ever changes), so `content.messageFooter`/
// `content.messageMenu` render in the same default order in both apps
// before an admin configures relay-settings' own `extensionOrder`.
const FOOTER_ORDER_DEFAULT = { reactions: 0, 'core.menu': 10, 'core.timestamp': 20, 'core.readReceipt': 30 };
const MENU_ORDER_DEFAULT = { edit: 0, reply: 5, pin: 10, bookmark: 20 };

const DICT = {
  en: {
    title: 'Chats',
    empty: 'No chats yet - add a contact from the User List, or start a group.',
    backToChats: '← Chats',
    online: 'online',
    lastSeen: 'last seen {time}',
    membersOnline: '{count} members, {online} online',
    composerPlaceholder: 'Message',
    send: 'Send',
    edit: 'Edit', save: 'Save', cancel: 'Cancel',
    reply: 'Reply', replyingTo: 'Replying to {name}',
    moreActions: 'More actions',
    attachRemove: 'Remove attachment',
    insertEmoji: 'Insert emoji',
    recordVoice: 'Record a voice message',
    voiceStop: 'Stop recording and send',
    voiceNotSupported: 'Voice messages aren\'t supported in this browser.',
    voiceMessage: '🎙️ Voice message',
    shareLocation: 'Share my location',
    locationMessage: 'Location',
    newGroup: '+ New group',
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
  },
  de: {
    title: 'Chats',
    empty: 'Noch keine Chats - Kontakt aus der Nutzerliste hinzufügen oder eine Gruppe starten.',
    backToChats: '← Chats',
    online: 'online',
    lastSeen: 'zuletzt online {time}',
    membersOnline: '{count} Mitglieder, {online} online',
    composerPlaceholder: 'Nachricht',
    send: 'Senden',
    edit: 'Bearbeiten', save: 'Speichern', cancel: 'Abbrechen',
    reply: 'Antworten', replyingTo: 'Antwort an {name}',
    moreActions: 'Weitere Aktionen',
    attachRemove: 'Anhang entfernen',
    insertEmoji: 'Emoji einfügen',
    recordVoice: 'Sprachnachricht aufnehmen',
    voiceStop: 'Aufnahme beenden und senden',
    voiceNotSupported: 'Sprachnachrichten werden in diesem Browser nicht unterstützt.',
    voiceMessage: '🎙️ Sprachnachricht',
    shareLocation: 'Meinen Standort teilen',
    locationMessage: 'Standort',
    newGroup: '+ Neue Gruppe',
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
  .qu-chat-empty { padding: 1.5rem; text-align: center; opacity: 0.7; }
  .qu-chat-new-group { display: block; margin-top: 0.4rem; opacity: 0.85; }
  .qu-chat-new-group:hover { opacity: 1; }
  .qu-chat-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; }
  .qu-chat-header-name { font-weight: 700; font-size: 1.1em; }
  .qu-chat-header-status { font-size: 0.8em; opacity: 0.65; }
  .qu-chat-messages { list-style: none; margin: 0 0 0.8rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; max-width: 40rem; }
  .qu-chat-bubble-row { display: flex; }
  .qu-chat-bubble-row-mine { justify-content: flex-end; }
  /* A soft "tail" via asymmetric corners - the corner nearest the avatar
     side stays sharp, matching Telegram/WhatsApp's own bubble language -
     plus a faint shadow so bubbles read as distinct surfaces, not just
     flat-colored text blocks. */
  .qu-chat-bubble { max-width: 75%; padding: 0.45rem 0.7rem; border-radius: var(--qu-radius-lg, 0.9rem) var(--qu-radius-lg, 0.9rem) var(--qu-radius-lg, 0.9rem) var(--qu-radius-sm, 0.25rem); background: var(--qu-color-surface, #8882); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  .qu-chat-bubble-mine { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 25%, transparent); border-radius: var(--qu-radius-lg, 0.9rem) var(--qu-radius-lg, 0.9rem) var(--qu-radius-sm, 0.25rem) var(--qu-radius-lg, 0.9rem); }
  .qu-chat-bubble-author { font-size: 0.78em; font-weight: 600; opacity: 0.8; margin-bottom: 0.1rem; }
  .qu-chat-bubble-reply { border-left: 2px solid var(--qu-color-accent, #5b5bd6); padding-left: 0.4rem; margin-bottom: 0.25rem; font-size: 0.82em; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
     apps/forum/client.js's own .qu-forum-message-footer exactly. */
  .qu-chat-bubble-footer { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.3rem; font-size: 0.7em; opacity: 0.75; flex-wrap: wrap; }
  .qu-chat-bubble-tick-read { color: var(--qu-color-accent, #5b5bd6); opacity: 1; }
  .qu-chat-bubble-attachment { margin-top: 0.4rem; max-width: 16rem; }
  .qu-chat-edit-row { display: flex; flex-direction: column; gap: 0.3rem; position: relative; }
  .qu-chat-edit-row textarea { font: inherit; padding: 0.35rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; }
  .qu-chat-edit-row-buttons { display: flex; gap: 0.4rem; }
  .qu-chat-reply-banner { display: flex; justify-content: space-between; align-items: center; padding: 0.3rem 0.6rem; border-left: 3px solid var(--qu-color-accent, #5b5bd6); background: var(--qu-color-surface, #8882); border-radius: var(--qu-radius-sm, 0.3rem); font-size: 0.85em; margin-bottom: 0.3rem; }
  .qu-chat-reply-banner button { background: none; border: none; cursor: pointer; opacity: 0.7; font: inherit; }
  .qu-chat-composer-wrap { display: flex; flex-direction: column; gap: 0.4rem; max-width: 40rem; }
  /* The composer: a tool cluster (attach/location), a rounded PILL holding
     the textarea + emoji trigger, and one circular action button that
     morphs mic <-> send (see updateActionBtn() in mountRoomView()) -
     Telegram/WhatsApp's own composer language, not a single flat text-input
     row with a row of plain buttons after it. */
  .qu-chat-composer { display: flex; align-items: flex-end; gap: 0.4rem; position: relative; }
  .qu-chat-composer-tools { display: flex; align-items: center; gap: 0.2rem; padding-bottom: 0.35rem; }
  .qu-chat-tool-btn { background: none; border: none; cursor: pointer; font-size: 1.1em; padding: 0.3rem; border-radius: 999px; opacity: 0.75; }
  .qu-chat-tool-btn:hover { opacity: 1; background: var(--qu-color-border, #8884); }
  .qu-chat-tool-btn:disabled { opacity: 0.35; cursor: default; }
  .qu-chat-composer-input-wrap { flex: 1; min-width: 0; display: flex; align-items: flex-end; gap: 0.3rem; background: var(--qu-color-surface, #8882); border: 1px solid var(--qu-color-border, #8884); border-radius: 1.3rem; padding: 0.4rem 0.6rem; }
  .qu-chat-composer-input-wrap textarea { flex: 1; min-width: 0; font: inherit; border: none; background: transparent; resize: none; min-height: 1.4rem; max-height: 8rem; padding: 0.15rem 0; }
  .qu-chat-composer-input-wrap textarea:focus { outline: none; }
  .qu-chat-composer-action { flex-shrink: 0; width: 2.6rem; height: 2.6rem; border-radius: 50%; border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font-size: 1.1em; line-height: 1; }
  .qu-chat-composer-action:disabled { opacity: 0.6; cursor: default; }
  .qu-chat-composer-action-recording { background: var(--qu-color-danger, #d64545); }
  .qu-chat-pending-attachment { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; opacity: 0.85; }
  .qu-chat-pending-attachment[hidden] { display: none; }
  .qu-chat-pending-attachment button { background: none; border: none; cursor: pointer; opacity: 0.7; font: inherit; padding: 0; }
  .qu-chat-new-group-form { display: flex; flex-direction: column; gap: 0.5rem; max-width: 26rem; }
  .qu-chat-new-group-form input[type="text"] { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-chat-member-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; max-height: 16rem; overflow-y: auto; }
  .qu-chat-member-list label { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0; }
  .qu-chat-new-group-form button[type="submit"] { align-self: flex-start; padding: 0.4rem 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font: inherit; }
  .qu-chat-new-group-form button:disabled { opacity: 0.6; cursor: default; }
  .qu-chat-settings { display: flex; flex-direction: column; gap: 0.4rem; max-width: 24rem; }
  .qu-chat-settings label { display: flex; align-items: center; gap: 0.5rem; }
  .qu-chat-settings-status { font-size: 0.85em; opacity: 0.75; }
  .qu-chat-search-result { display: block; padding: 0.6rem 0.8rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-chat-search-result:hover { background: var(--qu-color-surface, #8882); }
  .qu-chat-search-result-meta { font-size: 0.8em; opacity: 0.7; }
  .qu-chat-search-result-snippet { margin: 0.25rem 0 0; overflow-wrap: anywhere; }
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

  const [, seg1, seg2] = segments;
  const viewCtx = { ...ctx, SPACE_ID };
  let stopView;
  if (seg1 === 'new-group') {
    stopView = mountNewGroupView(container, viewCtx);
  } else if (seg1 === 'g' && seg2) {
    stopView = mountRoomView(container, viewCtx, { kind: 'group', roomId: seg2 });
  } else if (seg1) {
    stopView = mountRoomView(container, viewCtx, { kind: 'dm', peerPub: seg1 });
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

// ===================================================================
// ROOM LIST VIEW - #/chat
// ===================================================================

function mountRoomListView(container, { qu, services, subscribe, syncFetch, SPACE_ID }) {
  let stopped = false;
  container.textContent = '';

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const listRoot = document.createElement('div');
  container.append(heading, listRoot);

  let renderToken = 0;
  async function render() {
    const token = ++renderToken;
    if (stopped) return;
    const myPub = await services.actors.whoAmI();
    if (stopped || token !== renderToken) return;

    const [contacts, groupIds] = await Promise.all([
      services.contacts.listContacts(),
      services.chat.listMyGroups(),
    ]);
    if (stopped || token !== renderToken) return;

    const dmRooms = await Promise.all(contacts.map(async (c) => {
      const roomId = await ChatService.roomId([myPub, c.actorPub]);
      const { messages } = await services.messages.listMessages(SPACE_ID, roomId, { order: 'desc', limit: 1 });
      const lastReadAt = await services.messages.getLastReadAt(SPACE_ID, roomId);
      const last = messages[0] ?? null;
      return {
        kind: 'dm', roomId, href: `#/chat/${c.actorPub}`,
        name: formatActorLabel(c.actorPub, c.profile), avatarSeed: c.actorPub, avatar: c.profile?.avatar,
        lastMessage: last, unread: !!last && last.author !== myPub && last.ts > lastReadAt,
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
      };
    }))).filter(Boolean);

    if (stopped || token !== renderToken) return;
    const rooms = [...dmRooms, ...groupRooms].sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));

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

    const { allowMemberCreateGroup, isAdmin } = await fetchChatPolicy(services);
    if (stopped || token !== renderToken) return;
    if (isAdmin || allowMemberCreateGroup) {
      const newGroupLink = document.createElement('a');
      newGroupLink.href = '#/chat/new-group';
      newGroupLink.className = 'qu-chat-new-group';
      newGroupLink.textContent = t('newGroup');
      listRoot.appendChild(newGroupLink);
    }
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
    backHref: '#/chat',
    backLabel: t('backToChats'),
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
  container.textContent = '';

  const mainRoot = document.createElement('div');
  const heading = document.createElement('div');
  heading.className = 'qu-chat-header';
  const headerName = document.createElement('div');
  const headerNameEl = document.createElement('div');
  headerNameEl.className = 'qu-chat-header-name';
  const headerStatusEl = document.createElement('div');
  headerStatusEl.className = 'qu-chat-header-status';
  headerName.append(headerNameEl, headerStatusEl);
  const headerAvatarSlot = document.createElement('div');
  heading.append(headerAvatarSlot, headerName);

  const messagesRoot = document.createElement('div');
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
  attachUpload.setAttribute('label', '📎');
  const locationBtn = document.createElement('button');
  locationBtn.type = 'button';
  locationBtn.className = 'qu-chat-tool-btn';
  locationBtn.textContent = '📍';
  locationBtn.title = t('shareLocation');
  composerTools.append(attachUpload, locationBtn);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'qu-chat-composer-input-wrap';
  const composerInput = document.createElement('textarea');
  composerInput.placeholder = t('composerPlaceholder');
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
  composerWrap.append(replyBanner, composerRow, pendingAttachmentEl);

  renderSubpage(mainRoot, {
    backHref: '#/chat',
    backLabel: t('backToChats'),
    render: (content) => content.append(heading, messagesRoot, composerWrap),
  });
  container.appendChild(mainRoot);

  const stopComposerMentions = mountMentionAutocomplete(composerInput, { services, subscribe });
  const stopComposerEmoji = mountEmojiAutocomplete(composerInput);

  let roomId = null;
  let memberPubs = [];
  let roomReady = false;

  let pendingAttachment = null;
  function clearPendingAttachment() {
    pendingAttachment = null;
    pendingAttachmentEl.hidden = true;
    pendingAttachmentEl.textContent = '';
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
    if (!body) return;
    actionBtn.disabled = true;
    try {
      const extra = pendingAttachment ? { attachment: pendingAttachment } : {};
      await services.messages.postMessage(SPACE_ID, roomId, { body, replyTo: replyingTo?.id ?? null, extra });
      composerInput.value = '';
      clearPendingAttachment();
      setReplyingTo(null);
      updateActionBtn();
    } finally {
      actionBtn.disabled = false;
    }
  }

  // ---- voice messages: MediaRecorder -> the SAME AssetService upload +
  // message.extra.attachment shape a file attachment already uses, so
  // <qu-asset>'s own kind="auto" MIME sniff (AssetService.download()'s
  // meta.mime, see @qu/ui's asset-components.js) picks "audio" and renders
  // a native <audio controls> player - zero new rendering code needed. ----
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];

  function updateActionBtn() {
    actionBtn.classList.toggle('qu-chat-composer-action-recording', isRecording);
    if (isRecording) {
      actionBtn.textContent = '⏹';
      actionBtn.title = t('voiceStop');
    } else if (composerInput.value.trim()) {
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
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size === 0 || !roomReady) return;
      const assetId = globalThis.crypto.randomUUID();
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
      const meta = await services.assets.upload(SPACE_ID, assetId, file, { readerPubs: memberPubs });
      await services.messages.postMessage(SPACE_ID, roomId, {
        body: t('voiceMessage'), replyTo: replyingTo?.id ?? null,
        extra: { attachment: { assetId, ...meta }, voice: true },
      });
      setReplyingTo(null);
    };
    mediaRecorder.start();
    isRecording = true;
    updateActionBtn();
  }

  function stopRecording() {
    isRecording = false;
    mediaRecorder?.stop();
    mediaRecorder = null;
    updateActionBtn();
  }

  actionBtn.addEventListener('click', () => {
    if (isRecording) { stopRecording(); return; }
    if (composerInput.value.trim()) { sendTextMessage(); return; }
    startRecording();
  });

  // ---- location sharing: one-time position, sent as its own message.extra
  // field - deliberately no embedded map-tile PREVIEW image (that would mean
  // fetching from a third-party tile server on every render, leaking this
  // room's location data to a party beyond the relay/its members) - just a
  // link out to OpenStreetMap plus the raw coordinates, see renderMessageText(). ----
  locationBtn.addEventListener('click', () => {
    if (!roomReady || !navigator.geolocation) return;
    locationBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          await services.messages.postMessage(SPACE_ID, roomId, {
            body: t('locationMessage'),
            replyTo: replyingTo?.id ?? null,
            extra: { location: { lat: position.coords.latitude, lng: position.coords.longitude } },
          });
          setReplyingTo(null);
        } finally {
          locationBtn.disabled = false;
        }
      },
      () => { locationBtn.disabled = false; }
    );
  });

  const editingDrafts = new Map();
  let messageWatchers = [];
  function clearMessageWatchers() {
    for (const off of messageWatchers) off();
    messageWatchers = [];
  }

  let renderToken = 0;
  let myPub = null;
  let chatSettings = DEFAULT_CHAT_SETTINGS;

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
      services.presence.publishReadReceipt(SPACE_ID, roomId, newestTs).catch(() => {});
      services.messages.markRead(SPACE_ID, roomId).catch(() => {});
    }

    clearMessageWatchers();
    messagesRoot.textContent = '';
    if (messages.length > 0) {
      const byId = new Map(messages.map((m) => [m.id, m]));
      const ul = document.createElement('ul');
      ul.className = 'qu-chat-messages';
      for (const message of messages) {
        const li = await renderMessage(message, byId, readReceipts);
        if (stopped || token !== renderToken) return;
        ul.appendChild(li);
      }
      messagesRoot.appendChild(ul);
    }
  }

  async function renderMessage(message, byId, readReceipts) {
    const mine = message.author === myPub;
    const row = document.createElement('li');
    row.className = 'qu-chat-bubble-row' + (mine ? ' qu-chat-bubble-row-mine' : '');
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
      const parent = byId.get(message.replyTo);
      const replyEl = document.createElement('div');
      replyEl.className = 'qu-chat-bubble-reply';
      replyEl.textContent = parent?.body ?? '…';
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
   * @param {object} message @param {boolean} mine @param {Record<string, number>} readReceipts
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
          el.textContent = message.editedAt ? `${formatTs(message.ts)} (${t('edit').toLowerCase()})` : formatTs(message.ts);
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
        render: (el) => {
          const isRead = Object.values(readReceipts).some((upto) => upto >= message.ts);
          el.textContent = isRead ? '✓✓' : '✓';
          el.title = isRead ? t('read') : t('sent');
          if (isRead) el.classList.add('qu-chat-bubble-tick-read');
        },
      });
    }

    const footer = document.createElement('div');
    footer.className = 'qu-chat-bubble-footer';
    const ranked = segments
      .map((seg) => ({ ...seg, rank: rankFor(extensionPoints?.order, 'content.messageFooter', seg.id, FOOTER_ORDER_DEFAULT[seg.id] ?? 50) }))
      .sort((a, b) => a.rank - b.rank);
    for (const seg of ranked) {
      const wrap = document.createElement('span');
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
    if (!message.voice && !message.location) {
      const p = document.createElement('p');
      p.className = 'qu-chat-bubble-text';
      for (const segment of detectLinks(message.body)) {
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

    stopHeartbeat = services.presence.startHeartbeat(SPACE_ID, roomId);
    renderPresence();
    presenceTimer = setInterval(renderPresence, 5_000);

    subscribe?.(paths.threadMessagesParentPath(SPACE_ID, roomId));
    offMessages = watchChildren(qu, paths.threadMessagesParentPath(SPACE_ID, roomId), () => renderMessages(), { syncFetch });
    renderMessages();
  })();

  let offMessages = () => {};

  return () => {
    stopped = true;
    clearMessageWatchers();
    offMessages();
    stopHeartbeat?.();
    if (presenceTimer) clearInterval(presenceTimer);
    stopComposerMentions();
    stopComposerEmoji();
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
// doc comment). Chat's composer never attaches files (see this file's own
// top doc comment's SCOPE note - no `<qu-asset-upload>` here, unlike
// Forum), so `classifyMessageContentType()` below only ever returns
// `'post'`/`'link'` for a chat message - the `'image'`/`'video'`/`'file'`
// filters simply never match here, not a bug.
// ===================================================================

/** @param {object} message @returns {'post'|'image'|'video'|'file'|'link'} */
function classifyMessageContentType(message) {
  const mime = message.attachment?.mime ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
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
  if (!SPACE_ID || !q) return [];
  myPub ??= await services.actors.whoAmI();
  const [, seg1, seg2] = segments;

  async function messagesOfRoom(roomId, href, roomName) {
    const { messages } = await services.messages.listMessages(SPACE_ID, roomId);
    const out = [];
    for (const message of messages) {
      if (!message.body?.toLowerCase().includes(q)) continue;
      const contentType = classifyMessageContentType(message);
      if (types?.length && !types.includes(contentType)) continue;
      out.push({ contentType, ts: message.ts, author: message.author, snippet: buildSnippet(message.body, q), href, roomId, roomName });
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

  return {
    contentType: classifyMessageContentType(message), ts: message.ts, author: message.author,
    snippet: buildSnippet(message.body, ''),
    href, roomId: threadId, roomName,
  };
}

/**
 * The `content.searchResultTemplate` contributor - renders one row for an
 * entry THIS SAME app returned from `searchChat()`/`resolveChatReference()`
 * above (both callers, Search and Notifications, share this one template).
 * @param {HTMLElement} container
 * @param {{entry: object, services: object}} payload
 */
export async function renderSearchResult(container, { entry, services }) {
  const wrap = document.createElement('a');
  wrap.className = 'qu-chat-search-result';
  wrap.href = entry.href;

  let authorLabel = entry.author ?? '';
  try {
    const profile = entry.author ? await services.profile.getPublicProfile(entry.author) : null;
    if (profile) authorLabel = formatActorLabel(entry.author, profile);
  } catch { /* offline/unresolvable - falls back to the raw pubkey */ }

  const meta = document.createElement('div');
  meta.className = 'qu-chat-search-result-meta';
  meta.textContent = `${authorLabel} · ${t('searchResultIn', { room: entry.roomName ?? entry.roomId ?? '' })} · ${new Date(entry.ts).toLocaleString()}`;

  const snippet = document.createElement('p');
  snippet.className = 'qu-chat-search-result-snippet';
  snippet.textContent = entry.snippet ?? '';

  wrap.append(meta, snippet);
  container.appendChild(wrap);
}
