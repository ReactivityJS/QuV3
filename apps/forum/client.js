/**
 * FORUM — a real browser client for `apps/forum/index.js`'s Channel -> Topic
 * -> per-Topic-Thread hierarchy (`@qu/services`' `ChannelService`, see its
 * own doc comment for the full data model and why it's built on
 * `ListService`'s already-hardened curated lists rather than QuV2's
 * unprotected `DocumentService`/`CollectionService` pair). `SPACE_ID` is NOT
 * a local literal - it's read at mount time off this app's own entry in
 * `ctx.apps` (the manifest catalog every mounted app already receives), i.e.
 * `manifest.quapp`'s fixed `spaceId` UUID, never a human-readable name (see
 * `@qu/foundation`'s manifest schema doc comment on why: a name/label like
 * "forum" is display metadata, not a collision-safe storage key).
 *
 * ROUTING (`ctx.segments`, `segments[0]` always `'forum'` - see
 * `docs/building-an-app.md` §5.1):
 *   - `#/forum` - a merged recent-activity topic feed across every channel,
 *     newest first.
 *   - `#/forum/c/<channelId>` - one channel's topic list, a "new topic"
 *     form, and (if restricted) an "invite member" field.
 *   - `#/forum/t/<topicId>` - one topic's thread: message list, composer,
 *     attachments, plus whatever admin-enabled plugins render into this
 *     app's own extension points (reactions/pins/bookmarks - see EXTENSION
 *     POINTS below) - everything this app already had before Channels/
 *     Topics existed, now parametrized by `topicId` instead of a single
 *     hardcoded thread id.
 *   - `#/forum/new` - the "create a channel" form, its own subpage (moved
 *     out of the board view - see `mountMiniChannelSidebar()`'s own doc
 *     comment on why), policy-gated the same way the sidebar's own "+ New
 *     channel" link is.
 *
 * EVERY view above shares ONE persistent channel list (`mountMiniChannelSidebar()`),
 * not just the board view - esoTalk's own "the channel list never disappears,
 * no matter how deep you've drilled in" idiom. A narrow/mobile viewport
 * collapses it from a sidebar into a horizontal, scrollable tab bar above
 * the content instead of stacking a tall list on top (see this file's own
 * `@media` rules) - a compact single row, not a second full-height list to
 * scroll past before reaching the actual content.
 *
 * MIGRATION: `apps/forum/index.js`'s `register()` wraps the ORIGINAL flat
 * public thread (from before this round) in a real "General" channel/topic,
 * same thread id, no data loss - see that file's own doc comment.
 *
 * RESTRICTED CHANNELS - real end-to-end encryption for exactly an explicit
 * member list, not a UI-level filter (`ChannelService`'s own doc comment
 * has the full mechanism). This app's only two jobs on top of that Service:
 * a checkbox + comma-separated pubkey list at channel-creation time, and an
 * "invite" field in an already-restricted channel's own view
 * (`ChannelService.addChannelMember()` - new members see topics going
 * forward, nothing retroactively, same documented trade-off as everywhere
 * else non-retroactive membership growth appears in this codebase).
 *
 * DOUBLE-SUBMIT: both the "create channel" and "create topic" forms disable
 * their submit button for the duration of the create call - the actual fix
 * for "clicking Create twice sometimes makes two boards" (confirmed root
 * cause: QuV2's own form had no such guard, and minted a fresh random id
 * per submit - two submits before the first finished meant two genuinely
 * different, both-valid channel documents, not a storage-layer race
 * `ListService.addCurated()`'s own retry logic was ever meant to catch).
 * Matches this file's own pre-existing `sendBtn.disabled = true` convention
 * for posting a message.
 *
 * SCOPE - what this round's board/channel views deliberately do NOT do:
 * the merged recent-activity feed on `#/forum` itself re-computes when a
 * CHANNEL is added, not on every message posted somewhere inside one - full
 * live-per-message activity only applies once you're actually inside a
 * channel or topic view (both fully reactive, watching their own relevant
 * paths). Wiring a fully live nested watcher tree (one per topic, across
 * every channel, just for the landing page) is real, valid follow-up work,
 * not blocking this round - the board view is a discovery/entry point, not
 * where a user reads or replies from.
 *
 * ATTACHMENTS (`@qu/ui`'s `<qu-asset-upload>`/`<qu-asset>`, over `@qu/services`'
 * `AssetService`) - this app's designated TEST integration for the file/
 * image/video/audio upload+sync+display mechanism (see `AssetEngine`'s own
 * doc comment for where the actual chunking/hashing/dedup/retry LOGIC
 * lives). `pendingAttachment` (per-topic-view closure state) holds the
 * result of the LAST completed upload until Send is actually clicked -
 * picking a file starts uploading it immediately (not deferred to Send) so
 * the composer can show real upload/sync PROGRESS before the message is
 * even sent, at the cost of one edge case: uploading and never sending
 * leaves an orphaned, unreferenced asset in this identity's own
 * local+relay storage - acceptable for a public forum attachment (no
 * delete primitive exists for messages either). `attachment: {assetId,
 * name, mime, size}` rides on `MessageService.postMessage()`'s existing
 * `extra` param (merged into the stored message as-is) - no new
 * Service-layer field needed. A restricted topic's `readerPubs` are passed
 * to `upload()` too, matching the thread's own membership - an open
 * topic's attachments stay unencrypted, matching the message bodies
 * sitting next to them.
 *
 * EMOJI/MENTIONS - see `@qu/thread-ui`'s own doc comment for the shared
 * `renderEmojiPicker()`/`mountMentionAutocomplete()`/`mountEmojiAutocomplete()`/
 * `insertAtCursor()` primitives this app's composer is built from - the SAME
 * package a future `apps/chat` port is meant to reuse without rework.
 *
 * REACTIONS/PINS/BOOKMARKS are NOT built into this file at all - they're
 * admin-toggleable plugins (`apps/reactions`, `apps/pins`, `apps/bookmarks`),
 * reached only through the extension points below (`content.messageFooter`,
 * `content.messageMenu`, `forum.topicToolbar`). Disabling any of them via
 * relay-settings' `disabledApps` (see `packages/relay/src/relay-settings.js`)
 * makes it render nothing, with zero change needed here.
 *
 * MESSAGE CHROME (`buildMessageFooter()`) - Edit/Pin/Bookmark used to be
 * separate always-visible buttons in an "actions" row; per this round's
 * redesign they now live in ONE "⋮" context menu (`content.messageMenu`,
 * `renderContextMenu()` - see `@qu/thread-ui`'s own doc comment), so a
 * message shows exactly ONE always-visible affordance for them, not a row
 * of icons competing with the reaction pills. The footer row itself
 * (`content.messageFooter`) is the menu trigger + timestamp + Reactions'
 * own live widget, side by side - both this row's own item order AND the
 * menu's own item order come from `@qu/foundation`'s `rankFor()` against
 * `extensionPoints.order` (relay-settings' admin-edited `extensionOrder`,
 * edited via `apps/relay-admin` - see that app's own doc comment), falling
 * back to this file's own `FOOTER_ORDER_DEFAULT`/`MENU_ORDER_DEFAULT` when
 * an admin hasn't configured a given point yet. `apps/chat/client.js`
 * builds its OWN message row/menu the identical way, with the identical
 * two default-order maps, so the two apps render identically ordered chrome
 * out of the box without either importing the other - see its own doc
 * comment.
 *
 * REACTIVITY (topic view): the message list re-fetches via `services.
 * messages.listMessages()` (not the raw watched QuBits) every time
 * `watchChildren()` fires on the topic's messages parent path - exactly
 * `apps/profile`'s own `watch()` pattern (ignore the raw callback value,
 * re-read through the Service that knows how to decrypt/format it
 * correctly). Every async render function in this file (`renderMessages()`,
 * `renderMessage()`) is guarded by a monotonic per-call token, the fix for
 * a confirmed duplicate-content race:
 * `watchChildren()`/`watch()` can fire twice in quick succession (a local
 * write's own notify, then a live relay echo, or a syncFetch backfill), and
 * without a token an OLDER, slower render finishing AFTER a newer one used
 * to clear the newer render's correct output and append stale content on
 * top. Same fix shape `apps/notifications/client.js`/`apps/profile/client.js`
 * already established.
 *
 * `formattedHtml` (already computed server/service-side by `MessageService.
 * postMessage()`/`editMessage()` via `thread-formatting.js`) is inserted
 * via `innerHTML` directly - verified safe: `formatMarkdown()` HTML-escapes
 * the raw body FIRST (`escapeHtml()`), then applies only a small whitelist
 * of its own substitutions - there is no way a message body can smuggle
 * real markup through it. Covered by an explicit regression test anyway.
 *
 * EXTENSION POINTS (declared in this app's own `manifest.quapp` under
 * `definesExtensionPoints`) - ANY app whose OWN manifest declares a matching
 * `contributes: [{point: "...", export: "..."}]` gets dynamically imported
 * and rendered/called for the point, with NO import of that app anywhere in
 * this file (see `apps/bookmarks/client.js`, the first real one):
 *   - `content.messageFooter` (`kind: 'ui'`) - the per-message footer ROW,
 *     rendered via `ctx.extensionPoints.renderSlot(...)` into ONE segment
 *     among this file's own native ones (menu trigger, timestamp) - see
 *     `buildMessageFooter()`. Payload: `{services, qu, syncFetch, spaceId,
 *     threadId, messageId, myPub, mine, body, author}` (Reactions' own
 *     live widget).
 *   - `content.messageMenu` (`kind: 'menu'`, `ExtensionPointHost.collect()`)
 *     - this message's own "⋮" context menu, gathered fresh every time it
 *     opens and merged with this file's own native "Edit" item - see
 *     `buildMessageFooter()`. Same payload shape as `content.messageFooter`.
 *     Returns `{id, label, icon, onClick}` (Pins'/Bookmarks' own entries).
 *   - `forum.topicToolbar` (`kind: 'ui'`) - rendered ONCE per topic view,
 *     above the message list. Payload: `{services, qu, syncFetch, spaceId,
 *     threadId}` (Pins' own "Pinned" bar).
 *
 * KNOWN GAPS, left for later: no delete (`MessageService` has none, author-
 * only `editMessage()` is the whole story), no channel-metadata editing UI
 * (rename/re-color an existing channel - `AccessService`/the channel
 * document already support it, no form built yet), no removing a
 * restricted channel's member (`addChannelMember()`'s inverse), no
 * pagination anywhere (fine at community-forum scale, not designed to
 * scale past it).
 */
import { watchChildren, watch } from '@qu/reactive';
import { rankFor } from '@qu/foundation';
import { paths, formatActorLabel, detectLinks } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderAvatarOrAsset, renderSubpage } from '@qu/ui';
import { renderEmojiPicker, renderContextMenu, mountMentionAutocomplete, mountEmojiAutocomplete, insertAtCursor } from '@qu/thread-ui';

// Default fallback order for `content.messageFooter`/`content.messageMenu`
// items when an admin hasn't configured `relay-settings`' `extensionOrder`
// for that point yet (see `@qu/foundation`'s `rankFor()`) - reactions
// leftmost, the "⋮" menu and timestamp after, matching `apps/chat/client.js`'s
// OWN copy of these same two maps exactly, so the two apps render identical
// default ordering without either importing the other (an admin can still
// reorder either point via Relay Admin - see that app's own doc comment).
const FOOTER_ORDER_DEFAULT = { reactions: 0, 'core.menu': 10, 'core.timestamp': 20 };
const MENU_ORDER_DEFAULT = { edit: 0, pin: 10, bookmark: 20 };

const DICT = {
  en: {
    title: 'Forum',
    empty: 'No messages yet - be the first to post.',
    composerPlaceholder: 'Write a message…',
    send: 'Send',
    edit: 'Edit', save: 'Save', cancel: 'Cancel',
    moreActions: 'More actions',
    attachRemove: 'Remove attachment',
    insertEmoji: 'Insert emoji',
    channels: 'Channels',
    allChannels: 'All channels',
    newChannelPlaceholder: 'New channel name…',
    createChannel: 'Create channel',
    newChannelLink: '+ New channel',
    notAllowedToCreateChannel: 'This relay does not allow you to create a channel right now - ask an admin.',
    restrictedChannel: 'Restricted (only invited members)',
    membersPlaceholder: 'Member pubkeys, comma-separated',
    recentActivity: 'Recent activity',
    noTopicsAnywhereYet: 'No topics yet.',
    noTopicsYet: 'No topics in this channel yet.',
    newTopicPlaceholder: 'New topic title…',
    createTopic: 'Create topic',
    invite: 'Invite',
    invitePlaceholder: 'Actor pubkey to invite',
    restrictedBadge: '🔒 Restricted',
    replies: '{count} replies', // no singular/plural distinction - @qu/i18n has no plural-rules engine by design (see its own doc comment), matches QuV2's own identical "{count} replies" convention
    lastPostBy: 'by {name}',
    searchResultIn: 'in "{topic}"',
  },
  de: {
    title: 'Forum',
    empty: 'Noch keine Nachrichten - sei die/der Erste.',
    composerPlaceholder: 'Nachricht schreiben…',
    send: 'Senden',
    edit: 'Bearbeiten', save: 'Speichern', cancel: 'Abbrechen',
    moreActions: 'Weitere Aktionen',
    attachRemove: 'Anhang entfernen',
    insertEmoji: 'Emoji einfügen',
    channels: 'Kanäle',
    allChannels: 'Alle Kanäle',
    newChannelPlaceholder: 'Name des neuen Kanals…',
    createChannel: 'Kanal erstellen',
    newChannelLink: '+ Neuer Kanal',
    notAllowedToCreateChannel: 'Auf diesem Relay darfst du aktuell keinen Kanal anlegen - wende dich an einen Admin.',
    restrictedChannel: 'Geschützt (nur eingeladene Mitglieder)',
    membersPlaceholder: 'Mitglieder-Pubkeys, kommagetrennt',
    recentActivity: 'Neueste Aktivität',
    noTopicsAnywhereYet: 'Noch keine Themen.',
    noTopicsYet: 'Noch keine Themen in diesem Kanal.',
    newTopicPlaceholder: 'Titel des neuen Themas…',
    createTopic: 'Thema erstellen',
    invite: 'Einladen',
    invitePlaceholder: 'Pubkey zum Einladen',
    restrictedBadge: '🔒 Geschützt',
    replies: '{count} Antworten',
    lastPostBy: 'von {name}',
    searchResultIn: 'in „{topic}“',
  },
};
const { t } = createI18n(DICT);

function formatReplies(count) {
  return t('replies', { count });
}

const STYLE_ID = 'qu-forum-style';
const STYLE = `
  .qu-forum-messages { list-style: none; margin: 0 0 0.8rem; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-forum-message { display: flex; gap: 0.6rem; padding: 0.55rem 0.75rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-lg, 0.7rem); background: var(--qu-color-surface, transparent); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .qu-forum-message-body { flex: 1; min-width: 0; }
  .qu-forum-message-head { display: flex; align-items: baseline; gap: 0.5rem; }
  .qu-forum-message-author { font-weight: 600; }
  .qu-forum-message-text { overflow-wrap: anywhere; }
  .qu-forum-message-text code { font-family: var(--qu-font-mono, ui-monospace, monospace); background: var(--qu-color-surface, #8882); padding: 0.05rem 0.3rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  /* The per-message footer ROW (content.messageFooter) - menu trigger,
     timestamp, reactions, in whatever order rankFor() resolves (admin-
     configurable via relay-settings' extensionOrder, see this file's own
     top doc comment and FOOTER_ORDER_DEFAULT above). Each segment renders
     into its own <span> child, laid out left-to-right by this one flex
     rule - no per-segment CSS needed beyond it. */
  .qu-forum-message-footer { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.35rem; flex-wrap: wrap; }
  .qu-forum-message-ts { font-size: 0.75em; opacity: 0.6; }
  .qu-forum-edit-row { display: flex; flex-direction: column; gap: 0.4rem; position: relative; }
  .qu-forum-edit-row textarea { font: inherit; padding: 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; }
  .qu-forum-edit-row-buttons { display: flex; gap: 0.4rem; }
  /* position: relative - @qu/thread-ui's mountMentionAutocomplete() appends
     its dropdown into the textarea's own parentNode as position: absolute;
     without this the dropdown would anchor to the nearest ANCESTOR that
     happens to be positioned instead (typically the page root), landing far
     from the composer. */
  .qu-forum-composer { display: flex; gap: 0.5rem; position: relative; }
  .qu-forum-composer textarea { flex: 1; font: inherit; padding: 0.5rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; min-height: 2.4rem; }
  .qu-forum-composer button { padding: 0 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font: inherit; }
  .qu-forum-composer button:disabled { opacity: 0.6; cursor: default; }
  .qu-forum-empty { padding: 1.5rem; text-align: center; opacity: 0.7; }
  .qu-forum-composer-wrap { display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-pending-attachment { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; opacity: 0.85; }
  /* Without this, pendingAttachmentEl.hidden = true (its default, and how
     it resets after posting/removing) would have no visual effect - a plain
     author-stylesheet class selector beats the UA's own [hidden] rule at
     equal specificity, so this row would show empty and take up composer
     layout space even with no attachment pending. */
  .qu-forum-pending-attachment[hidden] { display: none; }
  .qu-forum-pending-attachment button { background: none; border: none; cursor: pointer; opacity: 0.7; font: inherit; padding: 0; }
  .qu-forum-message-attachment { margin-top: 0.5rem; max-width: 18rem; }
  .qu-forum-restricted-badge { font-size: 0.75em; opacity: 0.75; }
  /* Board/channel/topic view layout: ONE persistent mini channel list
     alongside the main content, on every view - esoTalk's own "the channel
     list never disappears, no matter how deep you've drilled in" idiom (see
     this app's own top doc comment / mountMiniChannelSidebar()'s own doc
     comment). */
  .qu-forum-layout { display: flex; gap: 1.2rem; align-items: flex-start; }
  .qu-forum-layout > aside { flex: 0 0 12rem; min-width: 0; }
  .qu-forum-layout > div { flex: 1; min-width: 0; }
  .qu-forum-mini-sidebar h2 { font-size: 0.85em; opacity: 0.75; margin: 0 0 0.4rem; }
  .qu-forum-mini-channels { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
  .qu-forum-mini-channels a { display: flex; align-items: center; gap: 0.3rem; padding: 0.3rem 0.5rem; border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; font-size: 0.9em; }
  .qu-forum-mini-channels a:hover { background: var(--qu-color-border, #8884); }
  .qu-forum-mini-channel-active { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 15%, transparent); font-weight: 600; }
  .qu-forum-mini-new-channel { opacity: 0.8; }
  .qu-forum-mini-new-channel:hover { opacity: 1; }
  /* Below this width there's no room for a side-by-side sidebar column -
     esoTalk's own mobile pattern (tabs, not a tree) rather than a tall list
     pushing the actual content below the fold: the sidebar collapses into a
     single-row, horizontally scrollable tab bar ABOVE the content instead
     of stacking a full-height list on top of it. Same DOM either way -
     mountMiniChannelSidebar() has no separate "mobile" code path, this is
     CSS-only. */
  @media (max-width: 40rem) {
    .qu-forum-layout { flex-direction: column; gap: 0.6rem; }
    .qu-forum-layout > aside { flex-basis: auto; width: 100%; }
    .qu-forum-mini-sidebar h2 { display: none; }
    .qu-forum-mini-channels { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; gap: 0.4rem; padding-bottom: 0.2rem; -webkit-overflow-scrolling: touch; }
    .qu-forum-mini-channels li { flex: 0 0 auto; }
    .qu-forum-mini-channels a { white-space: nowrap; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; padding: 0.3rem 0.7rem; }
  }
  .qu-forum-new-channel-form, .qu-forum-new-topic-form, .qu-forum-invite-form { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.6rem; max-width: 26rem; }
  .qu-forum-new-channel-form input[type="text"], .qu-forum-new-topic-form input[type="text"], .qu-forum-invite-form input[type="text"] { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-forum-new-channel-form label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9em; }
  .qu-forum-new-channel-form button, .qu-forum-new-topic-form button, .qu-forum-invite-form button { align-self: flex-start; padding: 0.4rem 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font: inherit; }
  .qu-forum-new-channel-form button:disabled, .qu-forum-new-topic-form button:disabled, .qu-forum-invite-form button:disabled { opacity: 0.6; cursor: default; }
  .qu-forum-topics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-topic-row a { display: block; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-forum-topic-row a:hover { background: var(--qu-color-border, #8884); }
  .qu-forum-topic-title { font-weight: 600; }
  .qu-forum-topic-meta { font-size: 0.8em; opacity: 0.7; margin-top: 0.15rem; }
  .qu-forum-channel-heading { display: flex; align-items: center; gap: 0.5rem; }
  .qu-forum-search-result { display: block; padding: 0.6rem 0.8rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-forum-search-result:hover { background: var(--qu-color-surface, #8882); }
  .qu-forum-search-result-meta { font-size: 0.8em; opacity: 0.7; }
  .qu-forum-search-result-snippet { margin: 0.25rem 0 0; overflow-wrap: anywhere; }
`;

function formatTs(ts) {
  return new Date(ts).toLocaleString();
}

/**
 * Router - dispatches `#/forum`, `#/forum/c/<channelId>`, `#/forum/t/<topicId>`
 * to their own view mounter. `segments[0]` is always this app's own id
 * (`'forum'`), never part of the actual sub-route - see
 * `docs/building-an-app.md` §4.2/§5.1.
 */
export function mount(container, ctx) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  const { services, apps, subscribe, segments = [] } = ctx;

  const SPACE_ID = apps?.find((a) => a.name === 'forum')?.spaceId;
  if (!SPACE_ID) throw new Error('[forum] no "spaceId" found in the apps catalog for "forum" - check manifest.quapp');

  // Same "set on an ancestor before descendant Custom Elements connect"
  // discipline `.qu` already requires elsewhere in `@qu/ui` - both the
  // composer's `<qu-asset-upload>` and every message's `<qu-asset>`
  // (attachment display) resolve this via `findAssetService()`'s ancestor
  // walk. Set unconditionally regardless of which sub-view is active -
  // harmless where unused (board/channel views never mount either element).
  container.assetService = services.assets;

  // Defense in depth - a future shell might already subscribe broadly
  // enough to cover this, but this app shouldn't silently depend on that
  // staying true (same reasoning as apps/user-list's own subscribe() call).
  subscribe?.(paths.spacePath(SPACE_ID));
  subscribe?.(`/blob/${SPACE_ID}`); // attachment chunks live under a SEPARATE top-level mount - see AssetEngine's own doc comment

  const [, kindSeg, idSeg] = segments;
  const viewCtx = { ...ctx, SPACE_ID };
  let stopView;
  if (kindSeg === 't' && idSeg) {
    stopView = mountTopicView(container, { ...viewCtx, topicId: idSeg });
  } else if (kindSeg === 'c' && idSeg) {
    stopView = mountChannelView(container, { ...viewCtx, channelId: idSeg });
  } else if (kindSeg === 'new') {
    stopView = mountNewChannelView(container, viewCtx);
  } else {
    stopView = mountBoardView(container, viewCtx);
  }
  return () => stopView?.();
}

/**
 * Resolves this identity's channel-creation policy (relay-settings.js'
 * `channels.allowMemberCreate`/`allowMemberRestricted`) + whether it's one
 * of this relay's own admins - shared by `mountMiniChannelSidebar()` (to
 * decide whether to show the "+ New channel" link at all) and
 * `mountNewChannelView()` (to decide whether to render the form, and
 * whether the restricted-channel checkbox is available). See
 * `packages/relay/src/relay-settings.js`'s own doc comment on `channels`
 * for exactly why this is CLIENT-SIDE only - it hides/shows UI, it does not
 * (yet) stop a modified client from calling `services.channels.
 * createChannel()` directly.
 * @param {object} services
 * @returns {Promise<{channelPolicy: {allowMemberCreate: boolean, allowMemberRestricted: boolean}, isAdmin: boolean}>}
 */
async function fetchChannelPolicy(services) {
  let channelPolicy = { allowMemberCreate: true, allowMemberRestricted: false };
  let isAdmin = false;
  try {
    const res = await fetch('/config.json');
    if (res.ok) {
      const data = await res.json();
      if (data.settings?.channels) channelPolicy = data.settings.channels;
      const myPub = await services.actors.whoAmI();
      isAdmin = (data.adminPubs ?? []).includes(myPub);
    }
  } catch { /* offline/unreachable - falls back to the permissive defaults above, matching DEFAULT_RELAY_SETTINGS */ }
  return { channelPolicy, isAdmin };
}

/**
 * The "create a channel" form - a standalone builder (not a closure over
 * any one view) so both `mountNewChannelView()` (the only real caller
 * today) and any future embedding can reuse it without duplicating the
 * double-submit guard / restricted-checkbox wiring.
 * @param {{services: object, SPACE_ID: string, allowRestricted: boolean, onCreated?: (channel: object) => void}} options
 * @returns {HTMLFormElement}
 */
function buildChannelForm({ services, SPACE_ID, allowRestricted, onCreated }) {
  const form = document.createElement('form');
  form.className = 'qu-forum-new-channel-form';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = t('newChannelPlaceholder');
  titleInput.required = true;

  const restrictedLabel = document.createElement('label');
  const restrictedInput = document.createElement('input');
  restrictedInput.type = 'checkbox';
  restrictedLabel.append(restrictedInput, document.createTextNode(t('restrictedChannel')));
  restrictedLabel.hidden = !allowRestricted;

  const membersInput = document.createElement('input');
  membersInput.type = 'text';
  membersInput.placeholder = t('membersPlaceholder');
  membersInput.hidden = true;
  restrictedInput.addEventListener('change', () => { membersInput.hidden = !restrictedInput.checked; });

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = t('createChannel');
  form.append(titleInput, restrictedLabel, membersInput, submit);

  // The actual fix for "double-clicking Create sometimes makes two boards"
  // (see this file's own top doc comment) - disable for the duration of the
  // create call, same convention `sendBtn` already uses for posting a message.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) return;
    submit.disabled = true;
    try {
      const memberPubs = membersInput.value.split(',').map((s) => s.trim()).filter(Boolean);
      const channel = await services.channels.createChannel(SPACE_ID, { title, restricted: restrictedInput.checked, memberPubs });
      onCreated?.(channel);
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

// ===================================================================
// NEW CHANNEL VIEW - #/forum/new: the (policy-gated) create-channel form,
// its own subpage - moved out of the board view so browsing channels never
// has to scroll past a form most visits never touch (see
// `mountMiniChannelSidebar()`'s own doc comment).
// ===================================================================

function mountNewChannelView(container, { services, SPACE_ID }) {
  let stopped = false;
  const formRoot = document.createElement('div');
  const heading = document.createElement('h1');
  heading.textContent = t('createChannel');

  renderSubpage(container, {
    showBackLink: false, // the shell header's own Back/Forward already covers this - see this app's own top doc comment
    render: (content) => content.append(heading, formRoot),
  });

  (async () => {
    const { channelPolicy, isAdmin } = await fetchChannelPolicy(services);
    if (stopped) return;
    if (!isAdmin && !channelPolicy.allowMemberCreate) {
      const p = document.createElement('p');
      p.className = 'qu-forum-empty';
      p.textContent = t('notAllowedToCreateChannel');
      formRoot.appendChild(p);
      return;
    }
    const form = buildChannelForm({
      services, SPACE_ID, allowRestricted: isAdmin || channelPolicy.allowMemberRestricted,
      onCreated: (channel) => { window.location.hash = `#/forum/c/${channel._id}`; },
    });
    formRoot.appendChild(form);
  })();

  return () => { stopped = true; };
}

// ===================================================================
// BOARD VIEW - #/forum: every channel + a merged recent-activity feed
// ===================================================================

function mountBoardView(container, { qu, services, syncFetch, SPACE_ID }) {
  let stopped = false;
  container.textContent = '';

  const layout = document.createElement('div');
  layout.className = 'qu-forum-layout';
  const sidebarRoot = document.createElement('aside');
  const mainRoot = document.createElement('div');
  layout.append(sidebarRoot, mainRoot);
  container.appendChild(layout);
  // 'all' - the board view IS the "All channels" entry, see
  // mountMiniChannelSidebar()'s own doc comment on that sentinel.
  const stopSidebar = mountMiniChannelSidebar(sidebarRoot, { qu, services, syncFetch, SPACE_ID }, 'all');

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const activityRoot = document.createElement('div');
  mainRoot.append(heading, activityRoot);

  let renderToken = 0;
  async function render() {
    const token = ++renderToken;
    if (stopped) return;
    const channels = await services.channels.listChannels(SPACE_ID);
    if (stopped || token !== renderToken) return;
    const topicsPerChannel = await Promise.all(channels.map((c) => services.channels.listTopics(SPACE_ID, c._id)));
    if (stopped || token !== renderToken) return;

    const merged = [];
    channels.forEach((channel, i) => {
      for (const topic of topicsPerChannel[i]) merged.push({ ...topic, channelTitle: channel.title });
    });
    merged.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    renderActivityFeed(activityRoot, merged);
  }

  function renderActivityFeed(root, topics) {
    root.textContent = '';
    const title = document.createElement('h2');
    title.textContent = t('recentActivity');
    root.appendChild(title);

    if (topics.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-forum-empty';
      empty.textContent = t('noTopicsAnywhereYet');
      root.appendChild(empty);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'qu-forum-topics';
    for (const topic of topics) ul.appendChild(topicRow(topic, topic.channelTitle));
    root.appendChild(ul);
  }

  function topicRow(topic, channelTitle) {
    const li = document.createElement('li');
    li.className = 'qu-forum-topic-row';
    const a = document.createElement('a');
    a.href = `#/forum/t/${topic._id}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'qu-forum-topic-title';
    titleEl.textContent = topic.title;
    const metaEl = document.createElement('div');
    metaEl.className = 'qu-forum-topic-meta';
    const parts = [formatReplies(topic.replyCount), formatTs(topic.lastActivityAt)];
    if (channelTitle) parts.unshift(channelTitle);
    metaEl.textContent = parts.join(' · ');
    a.append(titleEl, metaEl);
    li.appendChild(a);
    return li;
  }

  const off = watch(qu, paths.listPath(SPACE_ID, 'channels'), () => render(), { syncFetch });

  return () => {
    stopped = true;
    off();
    stopSidebar();
  };
}

/**
 * THE one persistent channel list, shared by all three views (board,
 * channel, topic) - esoTalk's own "channel tabs stay visible no matter how
 * deep you've drilled in" idiom. The board view used to render its OWN,
 * separate copy of this list (with the create-channel form built directly
 * into it); now every view mounts this exact same function, and channel
 * creation lives on its own subpage (`mountNewChannelView()`, `#/forum/new`)
 * linked from the "+ New channel" affordance at the end of this list -
 * policy-gated the identical way that subpage itself is (`fetchChannelPolicy()`),
 * so a relay where members can't create channels simply never shows the
 * link, rather than showing it and then rejecting the click.
 *
 * RESPONSIVE: this same DOM (an `<h2>` + `<ul>` of links) is what collapses
 * from a vertical sidebar into a horizontal, scrollable tab bar on a narrow
 * viewport - see this file's own `@media` rules under `.qu-forum-mini-*`.
 * No separate "mobile" markup/JS path - the CSS alone reflows it.
 * @param {HTMLElement} root
 * @param {{qu: object, services: object, syncFetch?: Function, SPACE_ID: string}} deps
 * @param {string|null} [activeChannelId] - Highlighted in the list, when
 *   known. The literal sentinel `'all'` (never a real channel id -
 *   `crypto.randomUUID()` never produces it) highlights the leading
 *   "All channels" entry instead - passed by the board view, since IT is
 *   that entry's own destination (`#/forum`).
 * @returns {() => void} stop function
 */
function mountMiniChannelSidebar(root, { qu, services, syncFetch, SPACE_ID }, activeChannelId = null) {
  root.className = 'qu-forum-mini-sidebar';
  let stopped = false;

  // Resolved once per mount, independent of the (possibly repeated)
  // channel-list render() below - same reasoning as mountNewChannelView()'s
  // own fetch: a relay's policy doesn't change mid-session.
  let policy = null;
  (async () => {
    policy = await fetchChannelPolicy(services);
    if (!stopped) render();
  })();

  async function render() {
    if (stopped) return;
    const channels = await services.channels.listChannels(SPACE_ID);
    if (stopped) return;
    root.textContent = '';
    const title = document.createElement('h2');
    title.textContent = t('channels');
    root.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'qu-forum-mini-channels';

    // esoTalk's own "All Channels" entry - the merged recent-activity board
    // view (#/forum), listed alongside the individual channels rather than
    // reached only via the shell header's Back button.
    const allLi = document.createElement('li');
    const allLink = document.createElement('a');
    allLink.href = '#/forum';
    allLink.textContent = t('allChannels');
    allLink.className = 'qu-forum-mini-all-channels';
    if (activeChannelId === 'all') allLink.classList.add('qu-forum-mini-channel-active');
    allLi.appendChild(allLink);
    ul.appendChild(allLi);

    for (const channel of channels) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#/forum/c/${channel._id}`;
      a.textContent = channel.title;
      if (channel._id === activeChannelId) a.classList.add('qu-forum-mini-channel-active');
      if (channel.restricted) {
        const badge = document.createElement('span');
        badge.className = 'qu-forum-restricted-badge';
        badge.textContent = '🔒';
        a.appendChild(badge);
      }
      li.appendChild(a);
      ul.appendChild(li);
    }
    if (policy && (policy.isAdmin || policy.channelPolicy.allowMemberCreate)) {
      const newLi = document.createElement('li');
      const newLink = document.createElement('a');
      newLink.href = '#/forum/new';
      newLink.className = 'qu-forum-mini-new-channel';
      newLink.textContent = t('newChannelLink');
      newLi.appendChild(newLink);
      ul.appendChild(newLi);
    }
    root.appendChild(ul);
  }

  const off = watch(qu, paths.listPath(SPACE_ID, 'channels'), () => render(), { syncFetch });
  return () => {
    stopped = true;
    off();
  };
}

// ===================================================================
// CHANNEL VIEW - #/forum/c/<channelId>: one channel's topics
// ===================================================================

function mountChannelView(container, { qu, services, syncFetch, SPACE_ID, channelId }) {
  let stopped = false;
  container.textContent = '';
  const layout = document.createElement('div');
  layout.className = 'qu-forum-layout';
  const sidebarRoot = document.createElement('aside');
  const mainRoot = document.createElement('div');
  layout.append(sidebarRoot, mainRoot);
  container.appendChild(layout);
  const stopSidebar = mountMiniChannelSidebar(sidebarRoot, { qu, services, syncFetch, SPACE_ID }, channelId);

  const heading = document.createElement('div');
  heading.className = 'qu-forum-channel-heading';
  const headingTitle = document.createElement('h1');
  const restrictedBadge = document.createElement('span');
  restrictedBadge.className = 'qu-forum-restricted-badge';
  heading.append(headingTitle, restrictedBadge);
  const topicsRoot = document.createElement('div');
  const inviteRoot = document.createElement('div');

  renderSubpage(mainRoot, {
    showBackLink: false, // the shell header's own Back/Forward already covers this, and the persistent sidebar's own "All channels" entry covers the rest - see this app's own top doc comment
    render: (content) => content.append(heading, topicsRoot, inviteRoot),
  });

  let currentChannel = null;
  let topicsRenderToken = 0;
  async function renderTopics() {
    const token = ++topicsRenderToken;
    if (stopped) return;
    const topics = await services.channels.listTopics(SPACE_ID, channelId);
    if (stopped || token !== topicsRenderToken) return;

    topicsRoot.textContent = '';
    if (topics.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-forum-empty';
      empty.textContent = t('noTopicsYet');
      topicsRoot.appendChild(empty);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'qu-forum-topics';
      for (const topic of topics) {
        const li = document.createElement('li');
        li.className = 'qu-forum-topic-row';
        const a = document.createElement('a');
        a.href = `#/forum/t/${topic._id}`;
        const titleEl = document.createElement('div');
        titleEl.className = 'qu-forum-topic-title';
        titleEl.textContent = topic.title;
        const metaEl = document.createElement('div');
        metaEl.className = 'qu-forum-topic-meta';
        metaEl.textContent = `${formatReplies(topic.replyCount)} · ${formatTs(topic.lastActivityAt)}`;
        a.append(titleEl, metaEl);
        li.appendChild(a);
        ul.appendChild(li);
      }
      topicsRoot.appendChild(ul);
    }
    topicsRoot.appendChild(newTopicForm());
  }

  function newTopicForm() {
    const form = document.createElement('form');
    form.className = 'qu-forum-new-topic-form';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = t('newTopicPlaceholder');
    titleInput.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('createTopic');
    form.append(titleInput, submit);

    // Same double-submit guard as the board view's "create channel" form.
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) return;
      submit.disabled = true;
      try {
        await services.channels.createTopic(SPACE_ID, channelId, { title });
        titleInput.value = '';
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function renderInvite() {
    inviteRoot.textContent = '';
    if (!currentChannel?.restricted) return;
    const form = document.createElement('form');
    form.className = 'qu-forum-invite-form';
    const label = document.createElement('div');
    label.textContent = t('restrictedBadge');
    const pubInput = document.createElement('input');
    pubInput.type = 'text';
    pubInput.placeholder = t('invitePlaceholder');
    pubInput.required = true;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('invite');
    form.append(label, pubInput, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const actorPub = pubInput.value.trim();
      if (!actorPub) return;
      submit.disabled = true;
      try {
        await services.channels.addChannelMember(SPACE_ID, channelId, actorPub);
        pubInput.value = '';
      } finally {
        submit.disabled = false;
      }
    });
    inviteRoot.appendChild(form);
  }

  let channelRenderToken = 0;
  async function renderChannelHeader() {
    const token = ++channelRenderToken;
    if (stopped) return;
    currentChannel = await services.channels.getChannel(SPACE_ID, channelId);
    if (stopped || token !== channelRenderToken) return;
    headingTitle.textContent = currentChannel?.title ?? channelId;
    restrictedBadge.textContent = currentChannel?.restricted ? t('restrictedBadge') : '';
    renderInvite();
  }

  const offTopics = watch(qu, paths.listPath(SPACE_ID, `topics-${channelId}`), () => renderTopics(), { syncFetch });
  const offChannel = watch(qu, paths.documentPath(SPACE_ID, channelId), () => renderChannelHeader(), { syncFetch });

  return () => {
    stopped = true;
    offTopics();
    offChannel();
    stopSidebar();
  };
}

// ===================================================================
// TOPIC VIEW - #/forum/t/<topicId>: one topic's thread
// ===================================================================

function mountTopicView(container, { qu, services, subscribe, syncFetch, extensionPoints, SPACE_ID, topicId }) {
  let stopped = false;
  container.textContent = '';
  const layout = document.createElement('div');
  layout.className = 'qu-forum-layout';
  const sidebarRoot = document.createElement('aside');
  const mainRoot = document.createElement('div');
  layout.append(sidebarRoot, mainRoot);
  container.appendChild(layout);
  // No activeChannelId yet - a topic only knows its own parent channel
  // after the async lookup below resolves, and this list is cheap enough
  // (and rare enough to actually matter) that re-highlighting it isn't
  // worth a second render pass - it still fully works for navigation, just
  // without the active-channel highlight in a topic view specifically
  // (unlike the channel view, which has its `channelId` synchronously).
  const stopSidebar = mountMiniChannelSidebar(sidebarRoot, { qu, services, syncFetch, SPACE_ID }, null);

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const pinnedRoot = document.createElement('div');
  // Rendered ONCE - unlike the per-message slots in renderMessage(), this
  // point's own contributor (Pins' `renderPinnedBar()`) self-manages its
  // own live updates (a Custom Element watching the topic's pins path
  // itself - see that file's own doc comment), so there's no per-topic
  // watchChildren() left in THIS file for pins at all.
  if (extensionPoints) {
    extensionPoints.renderSlot('forum.topicToolbar', pinnedRoot, { services, qu, syncFetch, spaceId: SPACE_ID, threadId: topicId });
  }
  const messagesRoot = document.createElement('div');
  const composerWrap = document.createElement('div');
  composerWrap.className = 'qu-forum-composer-wrap';
  const composerRow = document.createElement('div');
  composerRow.className = 'qu-forum-composer';
  const composerInput = document.createElement('textarea');
  composerInput.placeholder = t('composerPlaceholder');
  const attachUpload = document.createElement('qu-asset-upload');
  attachUpload.setAttribute('space-id', SPACE_ID);
  attachUpload.setAttribute('label', '📎');
  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = t('send');
  const emojiPicker = renderEmojiPicker({
    onPick: (emoji) => insertAtCursor(composerInput, emoji),
    trigger: '😀',
    triggerTitle: t('insertEmoji'),
  });
  composerRow.append(composerInput, emojiPicker, attachUpload, sendBtn);

  // @mention completion (by alias or pub, from the 2nd typed character) and
  // :shortcode: emoji completion, both from the 2nd typed character - wire-
  // format unchanged, purely compose-time insert helpers. See
  // `@qu/thread-ui`'s own doc comment.
  const stopComposerMentions = mountMentionAutocomplete(composerInput, { services, subscribe });
  const stopComposerEmoji = mountEmojiAutocomplete(composerInput);

  const pendingAttachmentEl = document.createElement('div');
  pendingAttachmentEl.className = 'qu-forum-pending-attachment';
  pendingAttachmentEl.hidden = true;
  composerWrap.append(composerRow, pendingAttachmentEl);

  renderSubpage(mainRoot, {
    showBackLink: false, // the shell header's own Back/Forward already covers this - see this app's own top doc comment
    render: (content) => content.append(heading, pinnedRoot, messagesRoot, composerWrap),
  });

  // Resolves the topic's own title - doesn't block the message list itself
  // from loading, both start independently.
  (async () => {
    const topicBit = await qu.get(paths.documentPath(SPACE_ID, topicId));
    if (stopped) return;
    const topic = topicBit?.val;
    if (topic) heading.textContent = topic.title;
  })();

  // Holds the LAST completed upload until Send is clicked - see this file's
  // own top doc comment's "ATTACHMENTS" section for why uploading starts
  // immediately on file-pick rather than being deferred to Send.
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

  const profileCache = new Map();
  async function resolveAuthor(pub) {
    if (!profileCache.has(pub)) {
      profileCache.set(pub, services.profile.getPublicProfile(pub).catch(() => null));
    }
    return profileCache.get(pub);
  }

  // messageId -> in-progress, NOT-YET-SAVED edit text. renderMessages()
  // rebuilds the ENTIRE list from scratch on every write to ANY message in
  // the thread (a new post, or anyone editing anything) - without this, a
  // message someone is mid-edit on would silently revert to its read-only
  // view (discarding whatever they'd already typed) the moment any other
  // message in a busy thread changes, not just on an edit to that SAME
  // message. Cleared on save (the fresh body from the server-confirmed
  // write is used instead) and on cancel.
  const editingDrafts = new Map();

  let messageWatchers = [];
  function clearMessageWatchers() {
    for (const off of messageWatchers) off();
    messageWatchers = [];
  }

  // `watchChildren()` (see the two calls at the bottom of this function) can
  // fire twice in quick succession for the SAME underlying change (an
  // initial local read, then a fresher value moments later - a live relay
  // echo, or a syncFetch backfill). Without a generation guard, two
  // overlapping renderMessages() calls race: each independently clears
  // `messagesRoot` and appends its OWN <ul> at the end of its own await
  // chain - whichever call's listMessages() resolves LAST wins the DOM, not
  // whichever was triggered last. If the OLDER call resolves after the
  // newer one, it clears the already-correct newer render and appends
  // stale/duplicate content on top - confirmed, reproducible cause of the
  // "content sometimes duplicates" bug. Same fix shape
  // `apps/notifications/client.js`/`apps/profile/client.js` already
  // established: only the call still holding the LATEST token may touch
  // the DOM.
  let renderToken = 0;

  async function renderMessages() {
    const token = ++renderToken;
    if (stopped) return;
    const myPub = await services.actors.whoAmI();
    if (stopped || token !== renderToken) return;
    const { messages } = await services.messages.listMessages(SPACE_ID, topicId);
    if (stopped || token !== renderToken) return;

    clearMessageWatchers();
    messagesRoot.textContent = '';
    if (messages.length === 0) {
      const p = document.createElement('p');
      p.className = 'qu-forum-empty';
      p.textContent = t('empty');
      messagesRoot.appendChild(p);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'qu-forum-messages';
    for (const message of messages) {
      const li = await renderMessage(message, myPub);
      // A newer renderMessages() call may have started (and already called
      // clearMessageWatchers()) while `renderMessage()`'s own awaits
      // (attachment/profile/extension-slot lookups) were in flight - bail
      // before appending anything from this now-stale build, and before
      // continuing to the next message, so this call never touches
      // `messagesRoot` at all past this point.
      if (stopped || token !== renderToken) return;
      ul.appendChild(li);
    }
    messagesRoot.appendChild(ul);
  }

  async function renderMessage(message, myPub) {
    const li = document.createElement('li');
    li.className = 'qu-forum-message';
    li.dataset.messageId = message.id;
    li.dataset.author = message.author;

    const profile = await resolveAuthor(message.author);
    const label = formatActorLabel(message.author, profile);
    li.appendChild(renderAvatarOrAsset(message.author, label, profile?.avatar, { size: '2.2rem' }));

    const body = document.createElement('div');
    body.className = 'qu-forum-message-body';

    const head = document.createElement('div');
    head.className = 'qu-forum-message-head';
    const authorEl = document.createElement('span');
    authorEl.className = 'qu-forum-message-author';
    authorEl.textContent = label;
    head.appendChild(authorEl);

    const textWrap = document.createElement('div');
    if (editingDrafts.has(message.id)) renderMessageEdit(textWrap, message);
    else renderMessageText(textWrap, message);

    const footer = await buildMessageFooter(message, myPub, textWrap);

    body.append(head, textWrap, footer);
    li.appendChild(body);
    return li;
  }

  /**
   * The per-message footer ROW (`content.messageFooter`) - see this file's
   * own top doc comment. Three segments: `core.menu` (the "⋮" trigger,
   * opening `content.messageMenu` - this message's own Edit, plus whatever
   * `apps/pins`/`apps/bookmarks` contribute), `core.timestamp`, and
   * `reactions` (`apps/reactions`' own live widget, via `renderSlot()`).
   * Order comes from `rankFor()` against `extensionPoints.order` (relay-
   * settings' admin-edited `extensionOrder`), falling back to
   * `FOOTER_ORDER_DEFAULT`/`MENU_ORDER_DEFAULT` when unconfigured.
   * @param {object} message @param {string} myPub @param {HTMLElement} textWrap - re-rendered in place by the native "Edit" menu item.
   * @returns {Promise<HTMLElement>}
   */
  async function buildMessageFooter(message, myPub, textWrap) {
    const mine = message.author === myPub;
    const menuPayload = {
      services, qu, syncFetch, spaceId: SPACE_ID, threadId: topicId, messageId: message.id, myPub, mine,
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
              const nativeItems = mine ? [{ id: 'edit', label: t('edit'), icon: '✏️', onClick: () => renderMessageEdit(textWrap, message) }] : [];
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
          el.className = 'qu-forum-message-ts';
          el.textContent = message.editedAt ? `${formatTs(message.ts)} (${t('edit').toLowerCase()})` : formatTs(message.ts);
        },
      },
      {
        id: 'reactions',
        render: (el) => (extensionPoints ? extensionPoints.renderSlot('content.messageFooter', el, menuPayload) : null),
      },
    ];

    const footer = document.createElement('div');
    footer.className = 'qu-forum-message-footer';
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
    const p = document.createElement('p');
    p.className = 'qu-forum-message-text';
    if (message.formattedHtml) {
      p.innerHTML = message.formattedHtml; // see this file's own doc comment - escaped/whitelisted server-side, safe to insert
    } else {
      // Defensive: `formattedHtml` is only ever set when the topic's own
      // thread config includes 'markdown' formatting (see `applyFormatting()`,
      // `@qu/services`) - every topic THIS app creates always does (see
      // `ChannelService.createTopic()`'s own doc comment on why a restricted
      // topic still gets 'markdown', not just 'mentions'), but this falls
      // back to plain (still-safe, `textContent`-set) text rather than
      // silently rendering an empty body if that ever stops being true.
      p.textContent = message.body;
    }
    root.appendChild(p);
    if (message.attachment) {
      const assetEl = document.createElement('qu-asset');
      assetEl.className = 'qu-forum-message-attachment';
      assetEl.setAttribute('space-id', SPACE_ID);
      assetEl.setAttribute('asset-id', message.attachment.assetId);
      root.appendChild(assetEl);
    }
  }

  function renderMessageEdit(root, message) {
    root.textContent = '';
    const row = document.createElement('div');
    row.className = 'qu-forum-edit-row';
    const textarea = document.createElement('textarea');
    // Restores a draft surviving an unrelated re-render (see `editingDrafts`'
    // own doc comment) - falls back to the message's current body the FIRST
    // time this message is opened for editing.
    textarea.value = editingDrafts.get(message.id) ?? message.body;
    editingDrafts.set(message.id, textarea.value);
    textarea.addEventListener('input', () => editingDrafts.set(message.id, textarea.value));
    // Same mention + emoji completion as the composer - a fresh instance per
    // renderMessageEdit() call, torn down the same way mountReactions()'s/
    // mountPinButton()'s own per-message watchers are: pushed onto the
    // shared `messageWatchers` array clearMessageWatchers() drains on every
    // renderMessages() rebuild (this row gets rebuilt right along with
    // everything else whenever the thread changes).
    messageWatchers.push(mountMentionAutocomplete(textarea, { services, subscribe }));
    messageWatchers.push(mountEmojiAutocomplete(textarea));
    const buttons = document.createElement('div');
    buttons.className = 'qu-forum-edit-row-buttons';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = t('save');
    saveBtn.addEventListener('click', async () => {
      const body = textarea.value.trim();
      if (!body) return;
      await services.messages.editMessage(SPACE_ID, topicId, message.id, { body });
      editingDrafts.delete(message.id);
      // The edit's own write triggers this whole list's watchChildren() ->
      // renderMessages() re-render, which rebuilds this exact node - no
      // need to manually restore the read-only view here (editingDrafts no
      // longer has an entry for it, so the rebuild renders read-only).
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

  // Reactions/Pin/Bookmark used to be hardcoded here - now admin-toggleable
  // plugins (`apps/reactions`, `apps/pins`, `apps/bookmarks`), reached
  // through `content.messageFooter`/`content.messageMenu` (see
  // `buildMessageFooter()` above) and the once-per-topic `forum.topicToolbar`
  // slot (`mountTopicView()`'s own setup below).

  sendBtn.addEventListener('click', async () => {
    const body = composerInput.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    try {
      const extra = pendingAttachment ? { attachment: pendingAttachment } : {};
      await services.messages.postMessage(SPACE_ID, topicId, { body, extra });
      composerInput.value = '';
      clearPendingAttachment();
    } finally {
      sendBtn.disabled = false;
    }
  });

  const offMessages = watchChildren(qu, paths.threadMessagesParentPath(SPACE_ID, topicId), () => renderMessages(), { syncFetch });

  return () => {
    stopped = true;
    clearMessageWatchers();
    offMessages();
    stopComposerMentions();
    stopComposerEmoji();
    stopSidebar();
  };
}

// ===================================================================
// SEARCH - `content.search`/`content.searchResultTemplate` contributor
// (apps/search's own extension points, see that app's manifest.quapp for
// the full payload contract). Forum never imports apps/search; apps/search
// never imports Forum - both only agree on these two point strings, same
// "host defines, contributor implements" shape as content.messageActions/
// content.messageReactions above.
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

/** A short excerpt centered on the first match, so a long message's result row doesn't dump its entire body. */
function buildSnippet(body, query, radius = 60) {
  if (!body) return '';
  const idx = body.toLowerCase().indexOf(query);
  if (idx === -1) return body.length > 140 ? `${body.slice(0, 140)}…` : body;
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + query.length + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

/**
 * The `content.search` contributor.
 * @param {{services: object, qu: object, apps: object[], query: string, types: string[]|null, scope: 'global'|'app'|'subpage', segments?: string[]}} payload -
 *   `segments` is the ORIGINAL `#/forum/...` route's segments (see this
 *   file's own router doc comment on `mount()`) - only consulted for
 *   `scope: 'subpage'`; `'app'`/`'global'` both mean "search the whole
 *   forum" from THIS contributor's point of view (the search app itself is
 *   what decides whether to call every app's contributor or just this one -
 *   see `ExtensionPointHost.collect()`'s own `{onlyAppId}` doc comment).
 * @returns {Promise<Array<object>>}
 */
export async function searchForum({ services, qu, apps, query, types, scope, segments = [] }) {
  const SPACE_ID = apps?.find((a) => a.name === 'forum')?.spaceId;
  const q = (query ?? '').trim().toLowerCase();
  if (!SPACE_ID || !q) return [];
  const [, kindSeg, idSeg] = segments;

  async function messagesOfTopic(topicId, channelId, topicTitle) {
    const { messages } = await services.messages.listMessages(SPACE_ID, topicId);
    const out = [];
    for (const message of messages) {
      if (!message.body?.toLowerCase().includes(q)) continue;
      const contentType = classifyMessageContentType(message);
      if (types?.length && !types.includes(contentType)) continue;
      out.push({
        contentType, ts: message.ts, author: message.author,
        snippet: buildSnippet(message.body, q),
        href: `#/forum/t/${topicId}`,
        topicId, channelId, topicTitle: topicTitle ?? topicId,
      });
    }
    return out;
  }

  if (scope === 'subpage' && kindSeg === 't' && idSeg) {
    const topicBit = await qu.get(paths.documentPath(SPACE_ID, idSeg));
    return messagesOfTopic(idSeg, topicBit?.val?.channelId ?? null, topicBit?.val?.title);
  }
  if (scope === 'subpage' && kindSeg === 'c' && idSeg) {
    const topics = await services.channels.listTopics(SPACE_ID, idSeg);
    const perTopic = await Promise.all(topics.map((topic) => messagesOfTopic(topic._id, idSeg, topic.title)));
    return perTopic.flat();
  }
  // 'app'/'global', or 'subpage' with no specific channel/topic (the board home) - the whole forum.
  const channels = await services.channels.listChannels(SPACE_ID);
  const perChannel = await Promise.all(channels.map(async (channel) => {
    const topics = await services.channels.listTopics(SPACE_ID, channel._id);
    const perTopic = await Promise.all(topics.map((topic) => messagesOfTopic(topic._id, channel._id, topic.title)));
    return perTopic.flat();
  }));
  return perChannel.flat();
}

/**
 * The `content.searchResultTemplate` contributor - renders one row for an
 * entry THIS SAME app returned from `searchForum()` above.
 * @param {HTMLElement} container
 * @param {{entry: object, services: object}} payload
 */
export async function renderSearchResult(container, { entry, services }) {
  const wrap = document.createElement('a');
  wrap.className = 'qu-forum-search-result';
  wrap.href = entry.href;

  let authorLabel = entry.author ?? '';
  try {
    const profile = entry.author ? await services.profile.getPublicProfile(entry.author) : null;
    if (profile) authorLabel = formatActorLabel(entry.author, profile);
  } catch { /* offline/unresolvable - falls back to the raw pubkey */ }

  const meta = document.createElement('div');
  meta.className = 'qu-forum-search-result-meta';
  meta.textContent = `${authorLabel} · ${t('searchResultIn', { topic: entry.topicTitle ?? entry.topicId ?? '' })} · ${formatTs(entry.ts)}`;

  const snippet = document.createElement('p');
  snippet.className = 'qu-forum-search-result-snippet';
  snippet.textContent = entry.snippet ?? '';

  wrap.append(meta, snippet);
  container.appendChild(wrap);
}
