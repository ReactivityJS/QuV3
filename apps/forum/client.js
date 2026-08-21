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
 *   - `#/forum/c/<channelId>` - one channel's topic list, and (if
 *     restricted) an "invite member" field.
 *   - `#/forum/c/<channelId>/new-topic` - the "create a topic in THIS
 *     channel" form, its own subpage (see `mountNewTopicView()`'s own doc
 *     comment) - replaces what used to be an inline title field at the
 *     bottom of the topic list. The channel is already known here (no
 *     picker).
 *   - `#/forum/new-topic` - the SAME form, reached from the board view's own
 *     `primaryAction` (no channel open yet) - adds a channel `<select>` at
 *     the top, since a topic always needs a parent channel.
 *   - `#/forum/t/<topicId>` - one topic's thread: message list, composer,
 *     attachments, plus whatever admin-enabled plugins render into this
 *     app's own extension points (reactions/pins/bookmarks - see EXTENSION
 *     POINTS below) - everything this app already had before Channels/
 *     Topics existed, now parametrized by `topicId` instead of a single
 *     hardcoded thread id.
 *   - `#/forum/new` - the "create a channel" form, its own subpage, gated by
 *     the same policy check as the board/channel views' own `settings`
 *     entry that links to it (see `applyNewChannelSettings()`).
 *
 * NAVIGATION (`docs/app-navigation-standard.md` Rule 5): every view mounts
 * through `@qu/ui`'s `mountAppTemplate()`. "+ New topic" is `primaryAction`
 * on the board/channel views (context-aware href: the board view links to
 * the channel-picker form above, an open channel links straight to its own
 * `new-topic` route); "+ New channel" is `settings` (a gear icon) on both -
 * the old `shell.headerNavPoints` 1-or-2-item dropdown this app used to ship
 * is gone, superseded by these. EVERY view also gets `navigation`: the full
 * channel list, current one active where known - esoTalk's own "the channel
 * list never disappears, no matter how deep you've drilled in" idiom, still
 * true. The board/channel views' own `navigation` is NOT `desktopOnly`
 * (their own content is an activity feed/topic list, not the channel list
 * itself, so mobile genuinely needs the footer pill to switch channels at
 * all) - a topic's own `navigation` IS `desktopOnly` (mirrors
 * `apps/chat/client.js`'s room view: with no `primaryAction`/`settings`
 * either, mobile gets no app footer at all inside a topic, just the
 * composer). `channelsToNavItems()` is the one shared mapper every view's
 * own `stopTemplate.update()` call uses - each view already
 * fetches/watches `services.channels.listChannels()` for its own reasons,
 * so only the "channels -> nav items" shape is shared, not the fetch itself.
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
 * Matches this file's own pre-existing `actionBtn.disabled = true` convention
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
 * `content.messageMenu`, `content.topicToolbar`). Disabling any of them via
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
 *   - `content.topicToolbar` (`kind: 'ui'`) - rendered ONCE per topic view,
 *     above the message list. Payload: `{services, qu, syncFetch, spaceId,
 *     threadId, messagePermalink}` (Pins' own "Pinned" bar).
 *     `apps/chat/client.js` renders this SAME point into its own room view
 *     (with its own `messagePermalink` route shape) - see that file's own
 *     doc comment.
 *   - `content.composerActions` (`kind: 'menu'`, `ExtensionPointHost.
 *     collect()`) - the composer's own "+" action menu (Attach, plus
 *     whatever a plugin app contributes - e.g. a Calendar/Gallery app's own
 *     entry), gathered fresh every time it opens, same shape/mechanism as
 *     `content.messageMenu` above. Same payload shape as `content.
 *     topicToolbar`. `apps/chat/client.js` shares this SAME point (plus its
 *     own native "Share location" item, which forum's composer has no
 *     equivalent of) - see that file's own doc comment.
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
import { injectStyle, ensureTheme, renderAvatarOrAsset, renderSubpage, mountAppTemplate, createIconButton } from '@qu/ui';
import {
  renderEmojiPicker, renderContextMenu, mountMentionAutocomplete, mountEmojiAutocomplete, insertAtCursor, copyToClipboard,
  mountComposerAutogrow, COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS,
} from '@qu/thread-ui';

// Default fallback order for `content.messageFooter`/`content.messageMenu`
// items when an admin hasn't configured `relay-settings`' `extensionOrder`
// for that point yet (see `@qu/foundation`'s `rankFor()`) - reactions
// leftmost, the "⋮" menu and timestamp after, matching `apps/chat/client.js`'s
// OWN copy of these same two maps exactly, so the two apps render identical
// default ordering without either importing the other (an admin can still
// reorder either point via Relay Admin - see that app's own doc comment).
const FOOTER_ORDER_DEFAULT = { reactions: 0, 'core.menu': 10, 'core.timestamp': 20 };
const MENU_ORDER_DEFAULT = { edit: 0, reply: 5, pin: 10, bookmark: 20, copyText: 30, copyLink: 40 };
// The composer's own "+" action menu (content.composerActions - see this
// file's own top doc comment) - same convention, kept identical to
// apps/chat/client.js's own copy (minus 'location', which forum's composer
// has no equivalent of).
const COMPOSER_ACTIONS_ORDER_DEFAULT = { attach: 0 };

const DICT = {
  en: {
    title: 'Forum',
    empty: 'No messages yet - be the first to post.',
    composerPlaceholder: 'Write a message…',
    send: 'Send',
    edit: 'Edit', save: 'Save', cancel: 'Cancel',
    reply: 'Reply', replyingTo: 'Replying to {name}',
    originalMessageUnavailable: 'Original message',
    moreActions: 'More actions',
    copyText: 'Copy text',
    copyLink: 'Copy link',
    attachRemove: 'Remove attachment',
    addAttachment: 'Add',
    attachFile: 'Attach file',
    insertEmoji: 'Insert emoji',
    channels: 'Channels',
    allChannels: 'All channels',
    newChannelPlaceholder: 'New channel name…',
    createChannel: 'Create channel',
    newChannelLink: 'New channel',
    newTopicLink: 'New topic',
    newActions: 'Create new…',
    notAllowedToCreateChannel: 'This relay does not allow you to create a channel right now - ask an admin.',
    restrictedChannel: 'Restricted (only invited members)',
    membersPlaceholder: 'Member pubkeys, comma-separated',
    recentActivity: 'Recent activity',
    noTopicsAnywhereYet: 'No topics yet.',
    noTopicsYet: 'No topics in this channel yet.',
    newTopicPlaceholder: 'New topic title…',
    newTopicChannelLabel: 'Channel',
    newTopicNoChannels: 'No channels yet - create one first.',
    createTopic: 'Create topic',
    invite: 'Invite',
    invitePlaceholder: 'Actor pubkey to invite',
    restrictedBadge: '🔒 Restricted',
    replies: '{count} replies', // no singular/plural distinction - @qu/i18n has no plural-rules engine by design (see its own doc comment), matches QuV2's own identical "{count} replies" convention
    lastPostBy: 'by {name}',
    searchResultIn: 'in "{topic}"',
    permalink: 'Link to this post',
    unread: 'New',
    unreadTopicCount: '{count} new',
    newMessagesBelow: '↓ New posts',
    scrollToBottomButton: '↓',
  },
  de: {
    title: 'Forum',
    empty: 'Noch keine Nachrichten - sei die/der Erste.',
    composerPlaceholder: 'Nachricht schreiben…',
    send: 'Senden',
    edit: 'Bearbeiten', save: 'Speichern', cancel: 'Abbrechen',
    reply: 'Antworten', replyingTo: 'Antwort an {name}',
    originalMessageUnavailable: 'Ursprünglicher Beitrag',
    moreActions: 'Weitere Aktionen',
    copyText: 'Text kopieren',
    copyLink: 'Link kopieren',
    attachRemove: 'Anhang entfernen',
    addAttachment: 'Hinzufügen',
    attachFile: 'Datei anhängen',
    insertEmoji: 'Emoji einfügen',
    channels: 'Kanäle',
    allChannels: 'Alle Kanäle',
    newChannelPlaceholder: 'Name des neuen Kanals…',
    createChannel: 'Kanal erstellen',
    newChannelLink: 'Neuer Kanal',
    newTopicLink: 'Neues Thema',
    newActions: 'Neu erstellen…',
    notAllowedToCreateChannel: 'Auf diesem Relay darfst du aktuell keinen Kanal anlegen - wende dich an einen Admin.',
    restrictedChannel: 'Geschützt (nur eingeladene Mitglieder)',
    membersPlaceholder: 'Mitglieder-Pubkeys, kommagetrennt',
    recentActivity: 'Neueste Aktivität',
    noTopicsAnywhereYet: 'Noch keine Themen.',
    noTopicsYet: 'Noch keine Themen in diesem Kanal.',
    newTopicPlaceholder: 'Titel des neuen Themas…',
    newTopicChannelLabel: 'Kanal',
    newTopicNoChannels: 'Noch keine Kanäle - lege zuerst einen an.',
    createTopic: 'Thema erstellen',
    invite: 'Einladen',
    invitePlaceholder: 'Pubkey zum Einladen',
    restrictedBadge: '🔒 Geschützt',
    replies: '{count} Antworten',
    lastPostBy: 'von {name}',
    searchResultIn: 'in „{topic}“',
    permalink: 'Link zu diesem Beitrag',
    unread: 'Neu',
    unreadTopicCount: '{count} neu',
    newMessagesBelow: '↓ Neue Beiträge',
    scrollToBottomButton: '↓',
  },
};
const { t } = createI18n(DICT);

function formatReplies(count) {
  return t('replies', { count });
}

function formatUnreadTopicCount(count) {
  return t('unreadTopicCount', { count });
}

const STYLE_ID = 'qu-forum-style';
const STYLE = `
  .qu-forum-messages { list-style: none; margin: 0 0 0.8rem; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-forum-message { display: flex; gap: 0.6rem; padding: 0.55rem 0.75rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-lg, 0.7rem); background: var(--qu-color-surface, transparent); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  @keyframes qu-forum-message-highlight-fade { from { outline-color: var(--qu-color-accent, #5b5bd6); } to { outline-color: transparent; } }
  .qu-forum-message-highlight { outline: 2px solid var(--qu-color-accent, #5b5bd6); outline-offset: 2px; animation: qu-forum-message-highlight-fade 2s ease forwards; }
  /* UNREAD-BY-ME - see renderMessage()'s own doc comment. A left accent bar
     (not a full background tint, which would fight the reactions/attachment
     content sitting inside the same card) plus a small text badge next to
     the author name - the "here's what's new since your last visit" idiom
     familiar from forum software, deliberately distinct from chat's own
     per-message read TICK (a different signal entirely - see that badge's
     own doc comment). */
  .qu-forum-message-unread { border-left: 3px solid var(--qu-color-accent, #5b5bd6); }
  .qu-forum-message-unread-badge { font-size: 0.68em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--qu-color-accent, #5b5bd6); border: 1px solid var(--qu-color-accent, #5b5bd6); border-radius: 999px; padding: 0.05rem 0.4rem; }
  .qu-forum-message-body { flex: 1; min-width: 0; }
  .qu-forum-message-head { display: flex; align-items: baseline; gap: 0.5rem; }
  .qu-forum-message-author { font-weight: 600; }
  /* The "replying to" quote - a real link to the parent post's own
     permalink (see mountTopicView()'s own "PERMALINKS" doc comment), not
     just a text snippet - clicking it scrolls to and highlights the
     original post, the exact same mechanism the timestamp link already
     uses. */
  .qu-forum-message-reply { display: block; border-left: 2px solid var(--qu-color-accent, #5b5bd6); padding-left: 0.5rem; margin-bottom: 0.3rem; font-size: 0.85em; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-decoration: none; cursor: pointer; }
  .qu-forum-message-reply:hover { opacity: 1; text-decoration: underline; }
  .qu-forum-message-text { overflow-wrap: anywhere; }
  .qu-forum-message-text code { font-family: var(--qu-font-mono, ui-monospace, monospace); background: var(--qu-color-surface, #8882); padding: 0.05rem 0.3rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  /* The per-message footer ROW (content.messageFooter) - menu trigger,
     timestamp, reactions, in whatever order rankFor() resolves (admin-
     configurable via relay-settings' extensionOrder, see this file's own
     top doc comment and FOOTER_ORDER_DEFAULT above). Each segment renders
     into its own <span> child, laid out left-to-right by this one flex
     rule - no per-segment CSS needed beyond it. */
  .qu-forum-message-footer { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.35rem; flex-wrap: wrap; }
  .qu-forum-message-ts { font-size: 0.75em; opacity: 0.6; color: inherit; text-decoration: none; }
  .qu-forum-message-ts:hover { text-decoration: underline; }
  .qu-forum-edit-row { display: flex; flex-direction: column; gap: 0.4rem; position: relative; }
  .qu-forum-edit-row textarea { font: inherit; padding: 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; }
  .qu-forum-edit-row-buttons { display: flex; gap: 0.4rem; }
  /* The composer: a "+" action-menu trigger (content.composerActions - see
     this file's own top doc comment's "EXTENSION POINTS" section), a
     rounded PILL holding the textarea + emoji trigger, and one circular
     send button - the SAME visual language apps/chat/client.js's own
     composer uses (see that file's own STYLE comment), minus the mic morph
     (Forum has no voice messages - see mountTopicView()'s own top doc
     comment). position: relative on .qu-forum-composer itself (NOT
     .qu-forum-composer-input-wrap, the textarea's own direct parent) -
     @qu/thread-ui's mountMentionAutocomplete() appends its dropdown into the
     textarea's parentNode as position: absolute, which anchors to the
     nearest POSITIONED ancestor, not necessarily the direct parent - exactly
     apps/chat/client.js's own identical setup, already proven to work. */
  .qu-forum-composer { display: flex; align-items: flex-end; gap: 0.4rem; position: relative; }
  .qu-forum-composer-tools { display: flex; align-items: center; gap: 0.2rem; padding-bottom: 0.35rem; }
  /* Same sizing as apps/chat/client.js's own .qu-chat-composer-plus override -
     @qu/thread-ui's own .qu-thread-ui-context-menu-trigger default is tuned
     for the smaller per-message "⋮" menu, not a composer-height tool cluster. */
  .qu-forum-composer-plus .qu-thread-ui-context-menu-trigger { font-size: 1.1em; padding: 0.3rem; border-radius: 999px; opacity: 0.75; }
  .qu-forum-composer-plus .qu-thread-ui-context-menu-trigger:hover { opacity: 1; background: var(--qu-color-border, #8884); }
  /* min-height/max-height are a defensive fallback only - the actual
     1-to-COMPOSER_MAX_ROWS growth is driven by @qu/thread-ui's
     mountComposerAutogrow(), not this CSS. */
  .qu-forum-composer-input-wrap { flex: 1; min-width: 0; display: flex; align-items: flex-end; gap: 0.3rem; background: var(--qu-color-surface, #8882); border: 1px solid var(--qu-color-border, #8884); border-radius: 1.3rem; padding: 0.4rem 0.6rem; }
  .qu-forum-composer-input-wrap textarea { flex: 1; min-width: 0; font: inherit; border: none; background: transparent; resize: none; min-height: 1.4rem; max-height: 8rem; padding: 0.15rem 0; }
  .qu-forum-composer-input-wrap textarea:focus { outline: none; }
  .qu-forum-composer-action { flex-shrink: 0; width: 2.6rem; height: 2.6rem; border-radius: 50%; border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font-size: 1.1em; line-height: 1; }
  .qu-forum-composer-action:disabled { opacity: 0.6; cursor: default; }
  .qu-forum-empty { padding: 1.5rem; text-align: center; opacity: 0.7; }
  .qu-forum-composer-wrap { flex-shrink: 0; display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem 1rem 1rem; border-top: 1px solid var(--qu-color-border, #8884); }
  .qu-forum-reply-banner { display: flex; justify-content: space-between; align-items: center; padding: 0.3rem 0.6rem; border-left: 3px solid var(--qu-color-accent, #5b5bd6); background: var(--qu-color-surface, #8882); border-radius: var(--qu-radius-sm, 0.3rem); font-size: 0.85em; }
  .qu-forum-reply-banner button { background: none; border: none; cursor: pointer; opacity: 0.7; font: inherit; }
  .qu-forum-reply-banner[hidden] { display: none; }
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
  /* TOPIC VIEW ROOM LAYOUT - mounted with mountAppTemplate({fullHeight: true,
     ...}) now (see mountTopicView()'s own top doc comment and @qu/ui's
     app-template.js own "FULL HEIGHT MODE" doc comment for the full "why
     fixed, not calc(100vh)" reasoning, which now lives there instead of
     here). This element is just a plain flex COLUMN filling whatever height
     .qu-apptpl-content hands it - flex: 1; min-height: 0 is what makes it
     actually stretch, same as apps/chat/client.js's own .qu-chat-room-view. */
  .qu-forum-room-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .qu-forum-topic-header { flex-shrink: 0; padding: 0.6rem 1rem 0.4rem; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-forum-topic-header h1 { margin: 0 0 0.3rem; font-size: 1.2em; }
  .qu-forum-messages-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 1rem; }
  /* Persistent scroll-to-bottom button - see apps/chat/client.js's own
     identical .qu-chat-scroll-bottom-btn for the full reasoning (position:
     sticky pins it near the bottom of the VISIBLE scroll area with zero JS
     position math). */
  .qu-forum-scroll-bottom-btn { position: sticky; bottom: 1rem; left: 50%; transform: translateX(-50%); display: block; width: fit-content; padding: 0.4rem 0.9rem; border: none; border-radius: 999px; background: var(--qu-color-accent, #5b5bd6); color: white; font: inherit; font-size: 0.85em; cursor: pointer; box-shadow: 0 0.2rem 0.6rem rgba(0,0,0,0.25); }
  .qu-forum-scroll-bottom-btn:hover { filter: brightness(1.08); }
  .qu-forum-scroll-bottom-btn[hidden] { display: none; }
  .qu-forum-scroll-bottom-btn-unseen { background: var(--qu-color-danger, #d64545); }
  .qu-forum-new-channel-form, .qu-forum-new-topic-form, .qu-forum-invite-form { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.6rem; max-width: 26rem; }
  .qu-forum-invite-error, .qu-forum-new-channel-error, .qu-forum-new-topic-error, .qu-forum-composer-error { color: var(--qu-color-danger, #c00); font-size: 0.85em; margin: 0; }
  .qu-forum-invite-error[hidden], .qu-forum-new-channel-error[hidden], .qu-forum-new-topic-error[hidden], .qu-forum-composer-error[hidden] { display: none; }
  .qu-forum-new-channel-form input[type="text"], .qu-forum-new-topic-form input[type="text"], .qu-forum-invite-form input[type="text"] { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-forum-new-channel-form label, .qu-forum-new-topic-form label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9em; }
  .qu-forum-new-topic-form select { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); flex: 1; min-width: 0; }
  .qu-forum-new-topic-body { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; min-height: 6rem; }
  .qu-forum-new-channel-form button, .qu-forum-new-topic-form button, .qu-forum-invite-form button { align-self: flex-start; padding: 0.4rem 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font: inherit; }
  .qu-forum-new-channel-form button:disabled, .qu-forum-new-topic-form button:disabled, .qu-forum-invite-form button:disabled { opacity: 0.6; cursor: default; }
  .qu-forum-topics { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-topic-row a { display: block; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-forum-topic-row a:hover { background: var(--qu-color-border, #8884); }
  .qu-forum-topic-title-row { display: flex; align-items: center; gap: 0.4rem; }
  .qu-forum-topic-title { font-weight: 600; }
  /* Topic-level "unread by me" badge (buildTopicRow()'s own doc comment) -
     same accent pill language as the per-message unread badge inside a
     topic view (.qu-forum-message-unread-badge), just filled instead of
     outlined, so it reads as a COUNT rather than a per-item flag. */
  .qu-forum-topic-unread-badge { font-size: 0.68em; font-weight: 700; letter-spacing: 0.02em; color: white; background: var(--qu-color-accent, #5b5bd6); border-radius: 999px; padding: 0.1rem 0.5rem; white-space: nowrap; }
  .qu-forum-topic-meta { font-size: 0.8em; opacity: 0.7; margin-top: 0.15rem; }
  .qu-forum-channel-heading { display: flex; align-items: center; gap: 0.5rem; }
  .qu-forum-search-result { display: block; padding: 0.6rem 0.8rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-forum-search-result:hover { background: var(--qu-color-surface, #8882); }
  .qu-forum-search-result-link { display: block; text-decoration: none; color: inherit; }
  .qu-forum-search-result-meta { font-size: 0.8em; opacity: 0.7; }
  .qu-forum-search-result-snippet { margin: 0.25rem 0 0; overflow-wrap: anywhere; }
  /* The real preview/player for an image/video/audio/file result (see
     renderSearchResult()'s own doc comment) - a SIBLING of the link, not
     nested inside it, so a video/audio's own native controls (or an
     image's click-to-lightbox) never fight the row's own "click anywhere
     to open the message" navigation. */
  .qu-forum-search-result-attachment { display: block; margin-top: 0.4rem; max-width: 16rem; max-height: 12rem; }
  .qu-forum-search-result-attachment img, .qu-forum-search-result-attachment video { max-width: 100%; max-height: 12rem; border-radius: var(--qu-radius-sm, 0.3rem); }
`;

function formatTs(ts) {
  return new Date(ts).toLocaleString();
}

/**
 * One topic row - shared by the board view's merged activity feed
 * (`mountBoardView()`) and a channel view's own topic list
 * (`mountChannelView()`), so the reply-count/unread-badge markup only
 * exists once. `topic` is a `ChannelService.listTopics()` result (or the
 * board view's own `{...topic, channelTitle}` merge of one).
 * @param {object} topic @param {string} [channelTitle] - board view only; a channel view already shows one channel's own heading.
 * @returns {HTMLLIElement}
 */
function buildTopicRow(topic, channelTitle) {
  const li = document.createElement('li');
  li.className = 'qu-forum-topic-row';
  const a = document.createElement('a');
  a.href = `#/forum/t/${topic._id}`;
  const titleRow = document.createElement('div');
  titleRow.className = 'qu-forum-topic-title-row';
  const titleEl = document.createElement('span');
  titleEl.className = 'qu-forum-topic-title';
  titleEl.textContent = topic.title;
  titleRow.appendChild(titleEl);
  // UNREAD-BY-ME, aggregated per topic (see ChannelService.listTopics()'s
  // own doc comment on `unreadCount`) - the overview-level counterpart of
  // the per-message badge inside a topic view (renderMessage()'s own
  // "UNREAD-BY-ME" doc comment), so a board/channel list actually shows
  // there's something new WITHOUT opening every topic to find out.
  if (topic.unreadCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'qu-forum-topic-unread-badge';
    badge.textContent = formatUnreadTopicCount(topic.unreadCount);
    titleRow.appendChild(badge);
  }
  const metaEl = document.createElement('div');
  metaEl.className = 'qu-forum-topic-meta';
  const parts = [formatReplies(topic.replyCount), formatTs(topic.lastActivityAt)];
  if (channelTitle) parts.unshift(channelTitle);
  metaEl.textContent = parts.join(' · ');
  a.append(titleRow, metaEl);
  li.appendChild(a);
  return li;
}

/**
 * Keeps a render callback current as new messages land in ANY of the given
 * topics, or their unread-by-me state changes (`services.messages.
 * markRead()` writes the SAME per-thread read-marker `getLastReadAt()`
 * reads - see ChannelService.listTopics()'s own `unreadCount` doc comment).
 * FIXES a confirmed bug: `ChannelService.listTopics()`'s own reply/unread
 * counts are computed fresh on every CALL, but nothing previously
 * re-invoked it when a message posted to an topic already on screen - only
 * a topic/channel being ADDED re-triggered a render (via the
 * topics/channels list watch every caller already has), so an open board/
 * channel overview's own reply counts (and, until this round, its unread
 * counts - not shown here at all before) silently went stale the moment
 * you left a topic and it kept getting new posts. One
 * `watchChildren()` per topic id - the SAME per-topic thread-messages path
 * a topic view itself already watches (`mountTopicView()`'s own
 * `offMessages`) - diffed against the topic id set on every call so
 * watchers are added/removed as the topic LIST itself changes, never
 * leaked across re-renders. `initial: false` - the caller just rendered
 * with fresh data moments ago, a redundant immediate re-fire would only
 * waste a render pass.
 * Also watches each topic's own PRIVATE read-marker (`MessageService.
 * markRead()`'s own `threadReadMarkerPath()`) - the other half of
 * `unreadCount` going stale in place: reading a topic on ANOTHER device (or
 * in another tab) moves that marker without ever touching the topic's own
 * messages, so the message-only watch above would miss it. `services` is
 * only needed for the one `whoAmI()` call this requires (the read marker
 * path is per-actor) - resolved once, lazily, on the first `sync()` call.
 * @param {object} qu @param {Function|undefined} syncFetch @param {string|number} SPACE_ID
 * @param {object} services
 * @param {() => void} onChange
 * @returns {{sync: (topicIds: string[]) => void, stop: () => void}}
 */
function watchTopicsActivity(qu, syncFetch, SPACE_ID, services, onChange) {
  const messageWatchers = new Map(); // topicId -> stop function
  const readMarkerWatchers = new Map(); // topicId -> stop function
  let myPubPromise = null;
  let stopped = false;

  function sync(topicIds) {
    const wanted = new Set(topicIds);
    for (const [id, off] of messageWatchers) {
      if (!wanted.has(id)) { off(); messageWatchers.delete(id); }
    }
    for (const [id, off] of readMarkerWatchers) {
      if (!wanted.has(id)) { off(); readMarkerWatchers.delete(id); }
    }
    for (const id of wanted) {
      if (!messageWatchers.has(id)) {
        messageWatchers.set(id, watchChildren(qu, paths.threadMessagesParentPath(SPACE_ID, id), () => onChange(), { syncFetch, initial: false }));
      }
    }
    // Read-marker watchers need `myPub` first (one async whoAmI() call,
    // cached/shared across every topic) - added once it resolves, same
    // `wanted` set re-checked in case sync() has since been called again
    // (a topic removed before this resolves must never get a watcher).
    myPubPromise ??= services.actors.whoAmI();
    myPubPromise.then((myPub) => {
      if (stopped) return;
      for (const id of wanted) {
        if (!readMarkerWatchers.has(id)) {
          readMarkerWatchers.set(id, watch(qu, paths.threadReadMarkerPath(SPACE_ID, id, myPub), () => onChange(), { syncFetch, initial: false }));
        }
      }
    });
  }
  function stop() {
    stopped = true;
    for (const off of messageWatchers.values()) off();
    for (const off of readMarkerWatchers.values()) off();
    messageWatchers.clear();
    readMarkerWatchers.clear();
  }
  return { sync, stop };
}

/**
 * Router - dispatches `#/forum`, `#/forum/c/<channelId>`, `#/forum/t/<topicId>`,
 * `#/forum/new-topic` (channel picker, reached from the board view's own
 * `primaryAction`) and `#/forum/c/<channelId>/new-topic` (channel already
 * known) to their own view mounter. `segments[0]` is always this app's own id
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

  // A trailing /m/<messageId> (`#/forum/t/<topicId>/m/<id>`) is a message
  // PERMALINK - see mountTopicView()'s own "PERMALINKS" doc comment for
  // what it does once there. Same scheme apps/chat/client.js's own route
  // parsing already establishes for chat's own room routes.
  const [, kindSeg, idSeg, seg3, seg4] = segments;
  const viewCtx = { ...ctx, SPACE_ID };
  let stopView;
  if (kindSeg === 't' && idSeg) {
    stopView = mountTopicView(container, { ...viewCtx, topicId: idSeg, messageId: seg3 === 'm' ? seg4 : null });
  } else if (kindSeg === 'c' && idSeg && seg3 === 'new-topic') {
    stopView = mountNewTopicView(container, { ...viewCtx, channelId: idSeg });
  } else if (kindSeg === 'c' && idSeg) {
    stopView = mountChannelView(container, { ...viewCtx, channelId: idSeg });
  } else if (kindSeg === 'new-topic') {
    stopView = mountNewTopicView(container, { ...viewCtx, channelId: null });
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
 * An already-fetched channel list, reduced to `mountAppTemplate()`'s plain
 * `{id, label, href, icon}` link-item shape (see `@qu/ui`'s
 * `app-template.js` own `AppTemplateLinkItem` typedef) - shared by the
 * board view, channel view, and topic view's own `navigation` sections
 * (each already fetches/watches `services.channels.listChannels()` for its
 * own reasons, so this only does the mapping, not the fetch itself - the
 * same "one place computes the shape, every view's chrome reuses it" idea
 * `apps/chat/client.js`'s own `roomsToNavItems()` established, just without
 * a matching `listRooms()`-style fetcher here since there's nothing extra
 * to compute per channel). A leading `{id: 'all', ...}` entry (never a real
 * channel id - `crypto.randomUUID()` never produces it) is the board view's
 * own destination, `#/forum` - mirrors the retired
 * `mountMiniChannelSidebar()`'s identical sentinel.
 * @param {Array<{_id: string, title: string, restricted?: boolean}>} channels
 * @returns {Array<{id: string, label: string, href: string, icon?: string}>}
 */
function channelsToNavItems(channels) {
  return [
    { id: 'all', label: t('allChannels'), href: '#/forum' },
    ...channels.map((c) => ({ id: c._id, label: c.title, href: `#/forum/c/${c._id}`, icon: c.restricted ? '🔒' : undefined })),
  ];
}

/**
 * "+ New channel" - `settings` (gear icon), not `primaryAction` (that's
 * "+ New topic" now - see `docs/app-navigation-standard.md` Rule 5's forum
 * example) - policy-gated the same way the retired sidebar's own inline
 * link and `renderHeaderNavPoints()`'s "New channel" dropdown item both
 * were. Depends on an async fetch not ready at the one synchronous
 * `mountAppTemplate()` call every view makes - see that function's own
 * "LATE-ARRIVING CHROME DATA" doc comment - so this is always called via
 * `stopTemplate.update()` from an app's own async IIFE, never awaited
 * before the initial `mountAppTemplate()` call itself.
 * @param {ReturnType<typeof mountAppTemplate>} stopTemplate
 * @param {object} services
 * @param {() => boolean} isStopped
 */
async function applyNewChannelSettings(stopTemplate, services, isStopped) {
  const { channelPolicy, isAdmin } = await fetchChannelPolicy(services);
  if (isStopped()) return;
  if (!isAdmin && !channelPolicy.allowMemberCreate) return;
  stopTemplate.update({ settings: { items: [{ label: t('newChannelLink'), href: '#/forum/new' }] } });
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
  const errorEl = document.createElement('p');
  errorEl.className = 'qu-forum-new-channel-error';
  errorEl.hidden = true;
  form.append(titleInput, restrictedLabel, membersInput, submit, errorEl);

  // The actual fix for "double-clicking Create sometimes makes two boards"
  // (see this file's own top doc comment) - disable for the duration of the
  // create call, same convention `actionBtn` already uses for posting a message.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) return;
    submit.disabled = true;
    errorEl.hidden = true;
    try {
      const memberPubs = membersInput.value.split(',').map((s) => s.trim()).filter(Boolean);
      const channel = await services.channels.createChannel(SPACE_ID, { title, restricted: restrictedInput.checked, memberPubs });
      onCreated?.(channel);
    } catch (err) {
      // Same "a caller with no catch here previously saw NOTHING" fix as
      // mountInviteForm()'s own `.qu-forum-invite-error` (see its doc
      // comment) - most commonly a restricted channel's own member list
      // containing a pubkey with no resolvable profile (`resolveReaderXKeys()`'s
      // fail-closed contract, see channel-service.js's "RESTRICTED CHANNELS"
      // doc comment), previously an unhandled rejection with the button just
      // quietly re-enabling.
      errorEl.textContent = err.message;
      errorEl.hidden = false;
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
  let topicsActivity;
  let off;
  const topicsListWatchers = new Map(); // channelId -> stop function

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
    for (const topic of topics) ul.appendChild(buildTopicRow(topic, topic.channelTitle));
    root.appendChild(ul);
  }

  // See docs/app-navigation-standard.md Rule 5 - `navigation` is NOT
  // `desktopOnly` here (unlike an open topic's own room-style view, or
  // apps/chat/client.js's room list): this view's own CONTENT is a merged
  // activity FEED, not the channel list itself, so mobile genuinely needs
  // the footer pill to reach a specific channel at all.
  const stopTemplate = mountAppTemplate(container, {
    primaryAction: { label: t('newTopicLink'), href: '#/forum/new-topic', icon: '✏️' },
    render: (content) => {
      const heading = document.createElement('h1');
      heading.textContent = t('title');
      const activityRoot = document.createElement('div');
      content.append(heading, activityRoot);

      // Keeps reply/unread counts current as messages land in any topic
      // already on screen, not just when a channel/topic is added - see
      // watchTopicsActivity()'s own doc comment for the confirmed bug this fixes.
      topicsActivity = watchTopicsActivity(qu, syncFetch, SPACE_ID, services, () => render());

      let renderToken = 0;
      async function render() {
        const token = ++renderToken;
        if (stopped) return;
        const channels = await services.channels.listChannels(SPACE_ID);
        if (stopped || token !== renderToken) return;

        stopTemplate.update({
          navigation: {
            items: channelsToNavItems(channels),
            activeId: 'all', // the board view IS the "All channels" entry
            heading: t('channels'),
            filter: true,
          },
        });

        // A per-channel topics-list watch, added once per channel (never
        // re-added on a later render() re-run) - `ChannelService`'s own
        // internal backfill-on-miss (packages/services/src/list-service.js's
        // listCuratedRawPaths()) only retries a local miss ONCE PER SYNC
        // "GENERATION" (see packages/services/src/sync-freshness.js's own
        // doc comment on createMissGate()), which can race the sync
        // connection still coming up on a cold client and then not retry
        // until the next reconnect - a page reload is what actually forces
        // that retry today, which is the exact "board view loads empty,
        // needs a reload" symptom this closes. `watch()`'s own `syncFetch`
        // option (below) is called UNCONDITIONALLY every time, no gating -
        // same shape mountChannelView()'s own dedicated topics-list watch
        // already uses for its one channel - and its callback re-runs THIS
        // render() the moment fresh data actually lands, or a new topic is
        // added later (watchTopicsActivity() above only covers ALREADY-
        // LISTED topics' own messages, not a channel gaining a new topic).
        for (const channel of channels) {
          if (topicsListWatchers.has(channel._id)) continue;
          topicsListWatchers.set(channel._id, watch(qu, paths.listPath(SPACE_ID, `topics-${channel._id}`), () => render(), { syncFetch, initial: false }));
        }

        const topicsPerChannel = await Promise.all(channels.map((c) => services.channels.listTopics(SPACE_ID, c._id)));
        if (stopped || token !== renderToken) return;

        const merged = [];
        channels.forEach((channel, i) => {
          for (const topic of topicsPerChannel[i]) merged.push({ ...topic, channelTitle: channel.title });
        });
        merged.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        topicsActivity.sync(merged.map((topic) => topic._id));
        renderActivityFeed(activityRoot, merged);
      }

      off = watch(qu, paths.listPath(SPACE_ID, 'channels'), () => render(), { syncFetch }); // initial: true (default) - fires render() immediately, not just on later changes
    },
  });
  applyNewChannelSettings(stopTemplate, services, () => stopped);

  return () => {
    stopped = true;
    off?.();
    topicsActivity?.stop();
    for (const stopWatch of topicsListWatchers.values()) stopWatch();
    stopTemplate();
  };
}

// ===================================================================
// CHANNEL VIEW - #/forum/c/<channelId>: one channel's topics
// ===================================================================
// The former `shell.headerNavPoints` contributor ("+ New channel"/"+ New
// topic", a 1-or-2-item dropdown) is retired - see
// docs/app-navigation-standard.md Rule 5. Both actions now live as
// `mountAppTemplate()` chrome instead: "+ New topic" is the board/channel
// view's own `primaryAction`, "+ New channel" is `settings`
// (`applyNewChannelSettings()` above).

function mountChannelView(container, { qu, services, syncFetch, SPACE_ID, channelId }) {
  let stopped = false;

  const heading = document.createElement('div');
  heading.className = 'qu-forum-channel-heading';
  const headingTitle = document.createElement('h1');
  const restrictedBadge = document.createElement('span');
  restrictedBadge.className = 'qu-forum-restricted-badge';
  heading.append(headingTitle, restrictedBadge);
  const topicsRoot = document.createElement('div');
  const inviteRoot = document.createElement('div');

  // See docs/app-navigation-standard.md Rule 1 (no bespoke back link - the
  // shell header's own Back/Forward already covers this, and the sidebar's
  // own "All channels" entry covers the rest) and Rule 5 - same shape as
  // mountBoardView()'s own mountAppTemplate() call above; `navigation` is
  // NOT `desktopOnly` here either, for the same reason.
  const stopTemplate = mountAppTemplate(container, {
    primaryAction: { label: t('newTopicLink'), href: `#/forum/c/${channelId}/new-topic`, icon: '✏️' },
    render: (content) => content.append(heading, topicsRoot, inviteRoot),
  });
  applyNewChannelSettings(stopTemplate, services, () => stopped);
  const offChannelList = watch(qu, paths.listPath(SPACE_ID, 'channels'), async () => {
    if (stopped) return;
    const channels = await services.channels.listChannels(SPACE_ID);
    if (stopped) return;
    stopTemplate.update({
      navigation: {
        items: channelsToNavItems(channels),
        activeId: channelId,
        heading: t('channels'),
        filter: true,
      },
    });
  }, { syncFetch });

  let currentChannel = null;
  let topicsRenderToken = 0;
  // Keeps reply/unread counts current as messages land in any topic
  // already on screen - see watchTopicsActivity()'s own doc comment.
  const topicsActivity = watchTopicsActivity(qu, syncFetch, SPACE_ID, services, () => renderTopics());
  async function renderTopics() {
    const token = ++topicsRenderToken;
    if (stopped) return;
    const topics = await services.channels.listTopics(SPACE_ID, channelId);
    if (stopped || token !== topicsRenderToken) return;
    topicsActivity.sync(topics.map((topic) => topic._id));

    topicsRoot.textContent = '';
    if (topics.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-forum-empty';
      empty.textContent = t('noTopicsYet');
      topicsRoot.appendChild(empty);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'qu-forum-topics';
      for (const topic of topics) ul.appendChild(buildTopicRow(topic));
      topicsRoot.appendChild(ul);
    }
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
    const errorEl = document.createElement('p');
    errorEl.className = 'qu-forum-invite-error';
    errorEl.hidden = true;
    form.append(label, pubInput, submit, errorEl);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const actorPub = pubInput.value.trim();
      if (!actorPub) return;
      submit.disabled = true;
      errorEl.hidden = true;
      try {
        await services.channels.addChannelMember(SPACE_ID, channelId, actorPub);
        pubInput.value = '';
      } catch (err) {
        // See ChannelService.addChannelMember()'s own doc comment: this can
        // throw even after the channel-level membership add already
        // succeeded, if growing one or more EXISTING topics' own ACL failed
        // - surfaced here rather than left as a silent unhandled rejection
        // (confirmed real: a caller with no try/catch here previously saw
        // NOTHING, while the invited member could remain unable to post in
        // some topics with no visible sign anything had gone wrong).
        errorEl.textContent = err.message;
        errorEl.hidden = false;
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
    offChannelList();
    topicsActivity.stop();
    stopTemplate();
  };
}

// ===================================================================
// NEW TOPIC - #/forum/c/<channelId>/new-topic
// ===================================================================
// A real subpage (Rule 2 - see renderHeaderNavPoints() below), replacing
// the old inline title-field form that used to sit at the bottom of every
// channel's topic list. No policy gate of its own - same as the inline form
// it replaces, `services.channels.createTopic()` relies entirely on the
// channel's own writer ACL (restricted or not) to enforce who can actually
// post; this view has nothing extra to check client-side.

/**
 * NEW TOPIC - `#/forum/c/<channelId>/new-topic` (channel already known - no
 * picker, `channelId` is a real id) or `#/forum/new-topic` (reached from the
 * board view's own `primaryAction` - `channelId` is `null`, so a channel
 * `<select>` is added at the top of the form; the channel list resolves
 * asynchronously, same "build immediately, fill in via your own async IIFE"
 * shape every other async render in this file already follows - the form is
 * simply not submittable yet while it's empty, `<select required>` already
 * enforces that natively).
 *
 * Beyond the title, the form also takes the topic's opening post right here
 * (content textarea + one optional attachment) - same "build immediately,
 * fill in via your own async IIFE" shape every other async render in this
 * file already follows for the channel `<select>`, and the exact same
 * upload-starts-on-pick / `qu-asset-uploaded` / `confirmSent()` attachment
 * lifecycle `mountTopicView()`'s own composer uses (see this file's own top
 * doc comment's "ATTACHMENTS" section) - createTopic() then postMessage()
 * are two calls, but read as one atomic "create topic with its first post"
 * action from the form's point of view (a topic with no opening post makes
 * no sense here, unlike a later reply in an existing thread).
 */
function mountNewTopicView(container, { services, SPACE_ID, channelId }) {
  let stopped = false;
  const formRoot = document.createElement('div');
  const heading = document.createElement('h1');
  heading.textContent = t('newTopicLink');

  renderSubpage(container, {
    showBackLink: false, // the shell header's own Back/Forward already covers this - see this app's own top doc comment
    render: (content) => content.append(heading, formRoot),
  });

  const form = document.createElement('form');
  form.className = 'qu-forum-new-topic-form';

  let channelSelect = null;
  if (!channelId) {
    channelSelect = document.createElement('select');
    channelSelect.required = true;
    channelSelect.disabled = true; // enabled once the channel list resolves, below
    const label = document.createElement('label');
    label.textContent = t('newTopicChannelLabel');
    label.appendChild(channelSelect);
    form.appendChild(label);

    (async () => {
      const channels = await services.channels.listChannels(SPACE_ID);
      if (stopped) return;
      if (channels.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'qu-forum-empty';
        empty.textContent = t('newTopicNoChannels');
        label.replaceWith(empty);
        form.hidden = true;
        return;
      }
      for (const c of channels) {
        const opt = document.createElement('option');
        opt.value = c._id;
        opt.textContent = c.title;
        channelSelect.appendChild(opt);
      }
      channelSelect.disabled = false;
    })();
  }

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = t('newTopicPlaceholder');
  titleInput.required = true;
  form.appendChild(titleInput);

  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'qu-forum-new-topic-body';
  bodyInput.placeholder = t('composerPlaceholder');
  form.appendChild(bodyInput);

  // Same "upload starts on file-pick, held as `pendingAttachment` until
  // submit" lifecycle as the topic view's own composer - see this file's
  // own top doc comment's "ATTACHMENTS" section.
  const attachUpload = document.createElement('qu-asset-upload');
  const pendingAttachmentEl = document.createElement('div');
  pendingAttachmentEl.className = 'qu-forum-pending-attachment';
  pendingAttachmentEl.hidden = true;
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
    const removeBtn = createIconButton({ icon: '✕', label: t('attachRemove'), onClick: clearPendingAttachment });
    pendingAttachmentEl.append(label, removeBtn);
  });
  form.append(attachUpload, pendingAttachmentEl);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = t('createTopic');
  const errorEl = document.createElement('p');
  errorEl.className = 'qu-forum-new-topic-error';
  errorEl.hidden = true;
  form.append(submit, errorEl);

  // Same double-submit guard as the board view's "create channel" form.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    const body = bodyInput.value.trim();
    const targetChannelId = channelId ?? channelSelect?.value;
    if (!title || !targetChannelId) return;
    submit.disabled = true;
    errorEl.hidden = true;
    try {
      const topic = await services.channels.createTopic(SPACE_ID, targetChannelId, { title });
      const attachment = pendingAttachment;
      if (body || attachment) {
        const extra = attachment ? { attachment } : {};
        await services.messages.postMessage(SPACE_ID, topic._id, { body, extra });
        if (attachment) attachUpload.confirmSent(attachment.assetId);
      }
      if (!stopped) window.location.hash = `#/forum/t/${topic._id}`;
    } catch (err) {
      // Same "no catch here previously meant NOTHING visible" fix as
      // mountInviteForm()'s own `.qu-forum-invite-error` - a locally
      // rejected createTopic()/postMessage() (e.g. this identity was
      // removed from a restricted channel between opening this form and
      // submitting it) used to leave the button just quietly re-enabling.
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  formRoot.appendChild(form);

  return () => { stopped = true; };
}

// ===================================================================
// TOPIC VIEW - #/forum/t/<topicId>: one topic's thread
// ===================================================================

/**
 * TOPIC VIEW - mounts with `mountAppTemplate({fullHeight: true, ...})`, the
 * exact same technique `apps/chat/client.js`'s own `mountRoomView()` uses
 * (see `@qu/ui`'s `app-template.js` own "FULL HEIGHT MODE" doc comment for
 * the full "why fixed positioning, not vh/dvh calc()" reasoning) - ported
 * over per explicit request ("the base for Forum and Chat really is
 * identical - Forum just doesn't need voice messages"). A topic's message
 * list and composer never scroll away, no double-scrollbar, and it gets the
 * exact same scroll-follow/persistent-scroll-to-bottom/true-bottom-
 * correction machinery Chat has (see the "SCROLL-FOLLOW" block below). The
 * channel sidebar is now the Core's own `navigation` (`desktopOnly: true` -
 * see this function's own `stopTemplate.update()` call below) - this app's
 * own "the channel list never disappears, no matter how deep you've drilled
 * in" idiom (top doc comment) still holds on wide screens; on mobile there's
 * no footer here at all (no `primaryAction`/`settings`, unlike the board/
 * channel views), so the topic's own composer is the only bottom bar,
 * same fix `apps/chat/client.js`'s room view migration made.
 *
 * PERMALINKS - a post's timestamp (see `buildMessageFooter()`) IS its
 * permalink, `#/forum/t/<topicId>/m/<messageId>` - clicking it, or landing
 * on one from Search/a notification (see this file's own
 * `content.resolveReference` contributor below), scrolls that post into
 * view (inside the internal scroll container now, not the page) and
 * briefly highlights it (`.qu-forum-message-highlight`).
 */
function mountTopicView(container, { qu, services, subscribe, syncFetch, extensionPoints, SPACE_ID, topicId, messageId = null }) {
  let stopped = false;

  const roomView = document.createElement('div');
  roomView.className = 'qu-forum-room-view';
  // `fullHeight: true` + a `desktopOnly` `navigation` - the exact same
  // shape apps/chat/client.js's own `mountRoomView()` uses (see that
  // function's own doc comment and @qu/ui's app-template.js own "FULL
  // HEIGHT MODE" doc comment): the channel sidebar still "never disappears,
  // no matter how deep you've drilled in" on wide screens, but on mobile
  // there's no primaryAction/settings here at all (unlike the board/channel
  // views), so the mobile footer is empty and the Core renders none -
  // the topic's own composer is already a bottom bar, a second one right
  // above it would read as duplicated chrome (same reasoning chat's own
  // room view migration was fixed for).
  const stopTemplate = mountAppTemplate(container, { fullHeight: true, render: (content) => content.appendChild(roomView) });

  const header = document.createElement('div');
  header.className = 'qu-forum-topic-header';
  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const pinnedRoot = document.createElement('div');
  header.append(heading, pinnedRoot);
  // Rendered ONCE - unlike the per-message slots in renderMessage(), this
  // point's own contributor (Pins' `renderPinnedBar()`) self-manages its
  // own live updates (a Custom Element watching the topic's pins path
  // itself - see that file's own doc comment), so there's no per-topic
  // watchChildren() left in THIS file for pins at all.
  if (extensionPoints) {
    extensionPoints.renderSlot('content.topicToolbar', pinnedRoot, {
      services, qu, syncFetch, spaceId: SPACE_ID, threadId: topicId,
      // Lets a contributor (Pins' own "📌 Pinned" bar) link a message back
      // to its real permalink without hardcoding/duplicating forum's own
      // route shape (`#/forum/t/<topicId>/m/<id>`) inside its own,
      // host-agnostic code - see apps/pins/client.js's own doc comment.
      messagePermalink: (messageId) => `#/forum/t/${topicId}/m/${messageId}`,
    });
  }

  const messagesScroll = document.createElement('div');
  messagesScroll.className = 'qu-forum-messages-scroll';
  const messagesRoot = document.createElement('div');
  // A SIBLING of messagesRoot, never touched by renderMessages()'s own
  // clear-and-rebuild of messagesRoot - exactly `apps/chat/client.js`'s own
  // `scrollToBottomBtn` (see that file's own doc comment for the full
  // reasoning: persistent whenever not at the bottom, for ANY reason, never
  // a one-shot toast).
  const scrollToBottomBtn = document.createElement('button');
  scrollToBottomBtn.type = 'button';
  scrollToBottomBtn.className = 'qu-forum-scroll-bottom-btn';
  scrollToBottomBtn.hidden = true;
  messagesScroll.append(messagesRoot, scrollToBottomBtn);

  const composerWrap = document.createElement('div');
  composerWrap.className = 'qu-forum-composer-wrap';
  const replyBanner = document.createElement('div');
  replyBanner.className = 'qu-forum-reply-banner';
  replyBanner.hidden = true;

  // The composer is a rounded "pill" (textarea + emoji trigger) plus a "+"
  // action-menu trigger (`content.composerActions` - see this file's own top
  // doc comment's "EXTENSION POINTS" section) and one circular send button -
  // the SAME visual language `apps/chat/client.js`'s own composer uses (see
  // that file's own top doc comment's "COMPOSER" section), minus the
  // mic/morph-to-mic behavior entirely: Forum has no voice messages (see
  // this function's own top doc comment), so this action button is ALWAYS
  // "send".
  const composerRow = document.createElement('div');
  composerRow.className = 'qu-forum-composer';
  const composerTools = document.createElement('div');
  composerTools.className = 'qu-forum-composer-tools';
  const attachUpload = document.createElement('qu-asset-upload');
  attachUpload.setAttribute('space-id', SPACE_ID);
  attachUpload.setAttribute('hide-picker', ''); // its own picker button is replaced by the "+" action menu below
  const composerActionsBtn = renderContextMenu({
    trigger: '+',
    triggerTitle: t('addAttachment'),
    getItems: async () => {
      const nativeItems = [
        { id: 'attach', label: t('attachFile'), icon: '📎', onClick: () => attachUpload.openPicker() },
      ];
      const payload = { services, qu, syncFetch, spaceId: SPACE_ID, threadId: topicId };
      const pluginItems = extensionPoints ? await extensionPoints.collect('content.composerActions', payload) : [];
      return [...nativeItems, ...pluginItems].sort(
        (a, b) => rankFor(extensionPoints?.order, 'content.composerActions', a.id, COMPOSER_ACTIONS_ORDER_DEFAULT[a.id] ?? 50)
          - rankFor(extensionPoints?.order, 'content.composerActions', b.id, COMPOSER_ACTIONS_ORDER_DEFAULT[b.id] ?? 50)
      );
    },
  });
  composerActionsBtn.classList.add('qu-forum-composer-plus');
  composerTools.append(composerActionsBtn, attachUpload);

  const inputWrap = document.createElement('div');
  inputWrap.className = 'qu-forum-composer-input-wrap';
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
  actionBtn.className = 'qu-forum-composer-action';
  actionBtn.textContent = '➤';
  actionBtn.title = t('send');
  actionBtn.setAttribute('aria-label', t('send'));

  composerRow.append(composerTools, inputWrap, actionBtn);

  // @mention completion (by alias or pub, from the 2nd typed character) and
  // :shortcode: emoji completion, both from the 2nd typed character - wire-
  // format unchanged, purely compose-time insert helpers. See
  // `@qu/thread-ui`'s own doc comment.
  const stopComposerMentions = mountMentionAutocomplete(composerInput, { services, subscribe });
  const stopComposerEmoji = mountEmojiAutocomplete(composerInput);

  const pendingAttachmentEl = document.createElement('div');
  pendingAttachmentEl.className = 'qu-forum-pending-attachment';
  pendingAttachmentEl.hidden = true;
  const composerErrorEl = document.createElement('p');
  composerErrorEl.className = 'qu-forum-composer-error';
  composerErrorEl.hidden = true;
  // ABOVE the input row, not below it - see apps/chat/client.js's own
  // identical composer-ordering fix for why (a pending attachment is
  // context for what's about to be sent, not a footnote after the fact).
  composerWrap.append(replyBanner, pendingAttachmentEl, composerErrorEl, composerRow);

  roomView.append(header, messagesScroll, composerWrap);

  // Resolves the topic's own title AND its room-switcher `navigation` (see
  // mountAppTemplate()'s own "LATE-ARRIVING CHROME DATA" doc comment) -
  // doesn't block the message list itself from loading, both start
  // independently. No activeChannelId known until `topicBit` resolves - a
  // topic only knows its own parent channel from its own stored document -
  // so, unlike the channel view, the sidebar briefly shows with no active
  // highlight before this settles.
  (async () => {
    const [channels, topicBit] = await Promise.all([
      services.channels.listChannels(SPACE_ID),
      qu.get(paths.documentPath(SPACE_ID, topicId)),
    ]);
    if (stopped) return;
    const topic = topicBit?.val;
    if (topic) heading.textContent = topic.title;
    stopTemplate.update({
      navigation: {
        items: channelsToNavItems(channels),
        activeId: topic?.channelId ?? null,
        heading: t('channels'),
        desktopOnly: true,
        filter: true,
      },
    });
  })();

  // ---- PERMALINKS + scroll-follow - the exact same state machine
  // `apps/chat/client.js`'s own `mountRoomView()` uses (see that file's own
  // doc comments at each of these for the full "why" - reproduced only
  // briefly here to avoid duplicating hundreds of lines of reasoning
  // verbatim): `pendingScrollTarget` is a ONE-TIME scroll target consumed by
  // the very first renderMessages() call after mount; `stuckToBottom`
  // mirrors "is the user currently looking at the newest post" (true by
  // default, false when landing on an older permalinked one); a persistent
  // `scrollToBottomBtn` is shown whenever NOT at the bottom, for any reason
  // (scrolled up, or a permalink further up), not just reactively when a
  // new post arrives.
  let pendingScrollTarget = messageId;
  let stuckToBottom = !pendingScrollTarget;
  // The message id we're currently "stuck" to after landing on a permalink
  // (mirrors `stuckToBottom`, just anchored to a message instead of the
  // bottom) - see the ResizeObserver below's own doc comment for why this
  // exists: FIXES a confirmed bug where a pinned/permalinked message with
  // attachments still loading (an image/video `<qu-asset>` resolves well
  // after the initial scrollIntoView() already ran, per this file's own
  // "TRUE BOTTOM" doc comment) landed the viewport up to a couple of posts
  // short of the actual target, because nothing ever re-corrected the
  // scroll position once those attachments grew the layout ABOVE it. Set
  // right after the initial scrollIntoView() below, cleared on any
  // subsequent GENUINE (non-programmatic) scroll - the same "stuck until
  // the user scrolls away" contract `stuckToBottom` already has.
  let stuckToMessageId = null;
  // The scrollTop WE last put the viewport at while anchored to
  // `stuckToMessageId` (read back from the DOM immediately after our own
  // scrollIntoView() call, never predicted ahead of time - scrollIntoView's
  // exact resulting offset is browser/layout-computed). The messagesScroll
  // 'scroll' listener below compares against this on every event (both a
  // genuine user scroll AND our own corrective one fire the identical
  // event - there is no reliable "who caused this" signal on a plain
  // 'scroll' event) - a mismatch means something ELSE moved the scroll
  // position since our last correction, i.e. a real user scroll, which
  // releases the anchor. Deliberately NOT a "was this programmatic" boolean
  // guard (an earlier version of this fix used one, and broke: jsdom (this
  // repo's test DOM) has no real scrollIntoView() at all, so the guard's
  // matching "consume the flag" scroll event never arrived, silently
  // eating the NEXT real scroll event instead - the geometry-comparison
  // approach here needs no such event-timing assumption).
  let lastKnownAnchorScrollTop = null;
  // The scrollTop a RESIZE-TRIGGERED bottom correction (`scrollToBottom(_,
  // true)` below) last set - narrower in scope than `lastKnownAnchorScrollTop`
  // above ON PURPOSE: tracked ONLY for a `correcting: true` call, never the
  // plain first-render "jump to bottom" or an explicit smooth catch-up (see
  // `scrollToBottom()`'s own doc comment on why those two stay untracked).
  //
  // FIXES A CONFIRMED, REPRODUCIBLE RACE: an attachment's `<qu-asset>` can
  // grow `messagesRoot`'s height across MULTIPLE steps as it decodes/lays
  // out (e.g. a large image resolving its real dimensions well after an
  // initial, smaller placeholder size), each one firing the ResizeObserver
  // below. The native 'scroll' event for one of OUR OWN corrective
  // `scrollTo()` calls is dispatched ASYNCHRONOUSLY (browsers coalesce it
  // to "before the next paint") - if the content grows AGAIN before that
  // event actually fires, the event's "am I at the bottom" check runs
  // against the NOW-LARGER `scrollHeight` but the scrollTop from a moment
  // ago, reads as "the user scrolled away", and permanently sets
  // `stuckToBottom` to false - after which NO further correction ever runs
  // again (`scrollToBottom(_, true)`'s own guard bails on `!stuckToBottom`),
  // stranding the view mid-load with the newest/active post pushed out of
  // sight. Verified live with a real (non-trivial, network-throttled) image
  // attachment - `scrollTop` got stuck at an early, now-stale "bottom"
  // while `scrollHeight` kept growing underneath it. The messagesScroll
  // 'scroll' listener below SKIPS recomputing `stuckToBottom` entirely for
  // an event whose scrollTop still matches this value - unlike the anchor
  // case above (where a match only decides whether to keep the anchor;
  // `stuckToBottom` still recomputes normally either way, since a
  // permalinked target is virtually never actually at the bottom) - so the
  // next (guaranteed, since content is still resizing) ResizeObserver
  // firing keeps correcting until it actually settles.
  let lastKnownBottomScrollTop = null;
  // Whether a post arrived while NOT stuck to the bottom - purely cosmetic
  // (see syncScrollToBottomButton()'s own doc comment), never what decides
  // the button's visibility.
  let hasUnseenMessage = false;
  let lastRenderedSnapshot = [];
  let hasRenderedOnce = false;
  const BOTTOM_FOLLOW_THRESHOLD_PX = 80;
  /**
   * @param {boolean} smooth
   * @param {boolean} [correcting] - true for a RESIZE-triggered correction
   *   (see the ResizeObserver below), never a caller-visible "scroll to
   *   bottom" action in its own right - skipped once the user has since
   *   scrolled away again.
   */
  function scrollToBottom(smooth, correcting = false) {
    if (correcting && !stuckToBottom) return;
    if (messagesScroll.scrollTo) messagesScroll.scrollTo({ top: messagesScroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    else messagesScroll.scrollTop = messagesScroll.scrollHeight; // jsdom (this repo's test DOM) has no scrollTo() at all
    // Only a RESIZE-triggered correction is tracked - see
    // `lastKnownBottomScrollTop`'s own doc comment for exactly why the
    // narrower scope (a SMOOTH scroll doesn't reach its target
    // synchronously either, so it couldn't be tracked accurately anyway).
    if (correcting) lastKnownBottomScrollTop = messagesScroll.scrollTop;
  }
  /**
   * Re-aligns the viewport back on `stuckToMessageId`'s own element (if
   * still stuck to one) - the permalink counterpart of `scrollToBottom(...,
   * true)` above, invoked by the SAME ResizeObserver below whenever
   * `messagesRoot`'s size changes (a late-loading attachment being the
   * confirmed real-world trigger - see `stuckToMessageId`'s own doc
   * comment).
   */
  function correctStuckMessageScroll() {
    if (!stuckToMessageId) return;
    const anchorEl = messagesRoot.querySelector(`[data-message-id="${CSS.escape(stuckToMessageId)}"]`);
    if (!anchorEl?.scrollIntoView) return;
    anchorEl.scrollIntoView({ block: 'start' });
    lastKnownAnchorScrollTop = messagesScroll.scrollTop;
  }
  // TRUE BOTTOM, EVEN WITH LATE-LOADING CONTENT - see apps/chat/client.js's
  // own identical ResizeObserver for the full reasoning (an attachment's
  // <qu-asset> resolves and inserts its real <img>/<video> asynchronously,
  // well after renderMessage() already returned). Also re-corrects a
  // permalink/pinned-message anchor for the identical reason - see
  // `stuckToMessageId`'s own doc comment.
  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { correctStuckMessageScroll(); scrollToBottom(false, true); })
    : null;
  resizeObserver?.observe(messagesRoot);
  /** Shows/hides/labels the persistent scroll-to-bottom button - see apps/chat/client.js's own identical function for the full reasoning. */
  function syncScrollToBottomButton() {
    scrollToBottomBtn.hidden = stuckToBottom;
    scrollToBottomBtn.textContent = hasUnseenMessage ? t('newMessagesBelow') : t('scrollToBottomButton');
    scrollToBottomBtn.classList.toggle('qu-forum-scroll-bottom-btn-unseen', hasUnseenMessage);
  }
  function topicHash() {
    return `#/forum/t/${topicId}`;
  }
  function messagePermalink(message) {
    return `${topicHash()}/m/${message.id}`;
  }
  // The "Copy link" menu item needs a link that still works PASTED
  // elsewhere (a chat message, an email) - a bare hash like
  // messagePermalink()'s own return value only means anything relative to
  // this same tab's current page. Resolved against the page's own current
  // full URL (not just `location.origin`) so it survives being served from
  // a subpath too - same reasoning `apps/shell/sw.js`'s own
  // `notificationclick` handler now resolves a push notification's stored
  // hash against `self.location.origin` for (see that file's own doc
  // comment on the bug THAT was: a bare hash resolved against the wrong
  // base).
  function absoluteMessagePermalink(message) {
    return new URL(messagePermalink(message), window.location.href).href;
  }
  // Landing back at the very bottom RELEASES a permalink anchor still
  // sitting in the URL - see apps/chat/client.js's own identical
  // `releasePermalinkAnchor()` for the full reasoning.
  function releasePermalinkAnchor() {
    const plainHash = topicHash();
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
    // A resize-correction echo (see `lastKnownBottomScrollTop`'s own doc
    // comment) - skip recomputing ANYTHING here, unlike the anchor-echo
    // check below (which only decides whether to release the anchor;
    // `stuckToBottom` still recomputes normally either way).
    if (lastKnownBottomScrollTop !== null && Math.abs(messagesScroll.scrollTop - lastKnownBottomScrollTop) <= 1) return;
    lastKnownBottomScrollTop = null;
    // Releases `stuckToMessageId` only when THIS scroll moved the viewport
    // away from where our own last correction put it - see that variable's
    // own doc comment for why a geometry comparison, not an event-timing
    // guard flag. `lastKnownAnchorScrollTop === null` means we were never
    // anchored to a message in the first place (a plain "at the bottom"
    // mount) - nothing to release.
    if (lastKnownAnchorScrollTop !== null && Math.abs(messagesScroll.scrollTop - lastKnownAnchorScrollTop) > 1) {
      stuckToMessageId = null;
      lastKnownAnchorScrollTop = null;
    }
    const nowAtBottom = messagesScroll.scrollHeight - messagesScroll.scrollTop - messagesScroll.clientHeight < BOTTOM_FOLLOW_THRESHOLD_PX;
    if (nowAtBottom && !stuckToBottom) {
      releasePermalinkAnchor();
      hasUnseenMessage = false;
    }
    stuckToBottom = nowAtBottom;
    syncScrollToBottomButton();
  });

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
    const removeBtn = createIconButton({ icon: '✕', label: t('attachRemove'), onClick: clearPendingAttachment });
    pendingAttachmentEl.append(label, removeBtn);
  });

  const profileCache = new Map();
  async function resolveAuthor(pub) {
    if (!profileCache.has(pub)) {
      profileCache.set(pub, services.profile.getPublicProfile(pub).catch(() => null));
    }
    return profileCache.get(pub);
  }

  // Reply-to state, mirroring apps/chat/client.js's own setReplyingTo() -
  // bound via the native "Reply" content.messageMenu item below (any post,
  // not just `mine` - Edit is the "mine only" one).
  let replyingTo = null; // {id, body} or null
  function setReplyingTo(message, authorLabel) {
    replyingTo = message ? { id: message.id, body: message.body } : null;
    replyBanner.textContent = '';
    if (!message) { replyBanner.hidden = true; return; }
    replyBanner.hidden = false;
    const label = document.createElement('span');
    label.textContent = t('replyingTo', { name: authorLabel });
    const cancelBtn = createIconButton({ icon: '✕', label: t('cancel'), onClick: () => setReplyingTo(null) });
    replyBanner.append(label, cancelBtn);
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

  /** @param {object[]} messages @returns {{id: string, editedAt: number|null}[]} */
  function snapshotOf(messages) {
    return messages.map((m) => ({ id: m.id, editedAt: m.editedAt ?? null }));
  }
  /**
   * True when `current` is `previous` with ONLY new posts appended after
   * it - same ids, same `editedAt`, in the same order, for the whole
   * `previous` prefix. Exactly `apps/chat/client.js`'s own `isSimpleAppend()`
   * (see that file's own doc comment for the full "why": avoids the
   * DOM-clear-induced scroll-position corruption a full rebuild causes).
   */
  function isSimpleAppend(previous, current) {
    if (previous.length === 0 || current.length <= previous.length) return false;
    for (let i = 0; i < previous.length; i++) {
      if (previous[i].id !== current[i].id || previous[i].editedAt !== current[i].editedAt) return false;
    }
    return true;
  }

  async function renderMessages() {
    const token = ++renderToken;
    if (stopped) return;
    const myPub = await services.actors.whoAmI();
    if (stopped || token !== renderToken) return;
    // Snapshot BEFORE markRead() below moves the marker - see this file's
    // own "UNREAD-BY-ME" doc comment on buildMessageFooter() for why this
    // has to be the position from before THIS view, not after.
    const lastReadAt = await services.messages.getLastReadAt(SPACE_ID, topicId);
    if (stopped || token !== renderToken) return;
    const { messages } = await services.messages.listMessages(SPACE_ID, topicId);
    if (stopped || token !== renderToken) return;
    // Awaited (not fire-and-forget) - a caller/test that unmounts this view
    // right after seeing the unread badge render must be able to rely on
    // the read marker having actually landed by then (see this file's own
    // "UNREAD-BY-ME" tests, apps/forum/test/client.test.js), not on
    // whatever happened to still be in flight when this view tore down.
    if (messages.length) await services.messages.markRead(SPACE_ID, topicId).catch(() => {});
    if (stopped || token !== renderToken) return;

    // See this function's own "INCREMENTAL APPEND" reasoning - the same
    // apps/chat/client.js's own renderMessages() already established.
    const wasStuckToBottom = stuckToBottom;
    const currentSnapshot = snapshotOf(messages);

    // INCREMENTAL APPEND - the common case (a plain new post, nothing else
    // changed) only appends to the EXISTING <ul>, never touching or
    // rebuilding anything already on screen, so nothing above it can ever
    // collapse/get re-clamped by the browser the way a full DOM clear does.
    if (!pendingScrollTarget && isSimpleAppend(lastRenderedSnapshot, currentSnapshot)) {
      const appended = messages.slice(lastRenderedSnapshot.length);
      const ul = messagesRoot.querySelector('.qu-forum-messages');
      for (const message of appended) {
        const li = await renderMessage(message, myPub, lastReadAt);
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

    const previousScrollTop = messagesScroll.scrollTop; // restored below when this render must not move the view
    const isFirstRender = !hasRenderedOnce;
    clearMessageWatchers();
    messagesRoot.textContent = '';
    lastRenderedSnapshot = currentSnapshot;
    hasRenderedOnce = true;
    if (messages.length === 0) {
      const p = document.createElement('p');
      p.className = 'qu-forum-empty';
      p.textContent = t('empty');
      messagesRoot.appendChild(p);
      return;
    }

    const byId = new Map(messages.map((m) => [m.id, m])); // see renderMessageText()'s own reply-quote lookup
    const ul = document.createElement('ul');
    ul.className = 'qu-forum-messages';
    for (const message of messages) {
      const li = await renderMessage(message, myPub, lastReadAt, byId);
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

    // See this function's own "PERMALINKS + scroll-follow" doc comment on
    // mountTopicView().
    let effectiveStuck = wasStuckToBottom;
    if (pendingScrollTarget) {
      const targetLi = [...messagesRoot.querySelectorAll('.qu-forum-message')].find((el) => el.dataset.messageId === pendingScrollTarget);
      pendingScrollTarget = null;
      if (targetLi) {
        // A permalink target is, by definition, not the bottom - the
        // button must show here so there's a way back down.
        hasUnseenMessage = false;
        stuckToBottom = false;
        // Stays "stuck" to this message (re-corrected by the ResizeObserver
        // above) until the user scrolls on their own - see
        // `stuckToMessageId`'s own doc comment for the late-loading-
        // attachment bug this fixes.
        stuckToMessageId = targetLi.dataset.messageId;
        // jsdom (this repo's test DOM) has no layout engine and doesn't
        // implement scrollIntoView() at all - optional-chained so tests
        // exercise every line around it without stubbing it out.
        targetLi.scrollIntoView?.({ block: 'start' });
        lastKnownAnchorScrollTop = messagesScroll.scrollTop;
        targetLi.classList.add('qu-forum-message-highlight');
        setTimeout(() => targetLi.classList.remove('qu-forum-message-highlight'), 2000);
        syncScrollToBottomButton();
        return;
      }
      effectiveStuck = true; // the permalinked post is gone (deleted?) - fall through to "show latest" below
    }
    stuckToBottom = effectiveStuck;
    if (effectiveStuck) {
      hasUnseenMessage = false;
      // A smooth scroll (not an instant jump) except on the very first
      // render of this mount - see apps/chat/client.js's own identical
      // scrollToBottom(!isFirstRender) call for the full reasoning.
      scrollToBottom(!isFirstRender);
    } else {
      messagesScroll.scrollTop = previousScrollTop;
    }
    syncScrollToBottomButton();
  }

  async function renderMessage(message, myPub, lastReadAt, byId) {
    const li = document.createElement('li');
    const unread = message.author !== myPub && message.ts > lastReadAt;
    li.className = 'qu-forum-message' + (unread ? ' qu-forum-message-unread' : '');
    li.id = `m-${message.id}`;
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
    if (unread) {
      // UNREAD-BY-ME - see mountTopicView()'s own doc comment: this is a
      // PRIVATE per-identity "have I seen this" marker (MessageService.
      // markRead()/getLastReadAt()), the deliberate opposite of apps/chat's
      // own read-tick footer segment (a PUBLIC signal telling the SENDER
      // someone else has read THEIR message - meaningless here, a Topic can
      // have any number of readers, not one fixed peer to tick for). A
      // small badge next to the author name, not a footer segment - it
      // describes THIS reader's own relationship to the post, not something
      // the post's author contributed or would see on their own copy of it.
      const unreadBadge = document.createElement('span');
      unreadBadge.className = 'qu-forum-message-unread-badge';
      unreadBadge.textContent = t('unread');
      head.appendChild(unreadBadge);
    }

    const textWrap = document.createElement('div');
    if (editingDrafts.has(message.id)) renderMessageEdit(textWrap, message);
    else renderMessageText(textWrap, message, byId);

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
              const nativeItems = [];
              if (mine) nativeItems.push({ id: 'edit', label: t('edit'), icon: '✏️', onClick: () => renderMessageEdit(textWrap, message) });
              nativeItems.push({
                id: 'reply', label: t('reply'), icon: '↩️',
                onClick: async () => {
                  const authorLabel = formatActorLabel(message.author, await resolveAuthor(message.author));
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
          // The timestamp doubles as this post's permalink - see
          // mountTopicView()'s own "PERMALINKS" doc comment.
          const link = document.createElement('a');
          link.className = 'qu-forum-message-ts';
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

  function renderMessageText(root, message, byId) {
    root.textContent = '';
    if (message.replyTo) {
      // A real link to the parent post's own permalink (see
      // mountTopicView()'s own "PERMALINKS" doc comment), not just a text
      // snippet - clicking it scrolls to and highlights the original post,
      // the exact same mechanism the timestamp link already uses. `byId`
      // may not have the parent (paginated out) - still links to
      // `message.replyTo`'s own id either way; renderMessages() itself
      // already falls back to doing nothing further if the target isn't
      // locally rendered.
      const parent = byId?.get(message.replyTo);
      const replyEl = document.createElement('a');
      replyEl.className = 'qu-forum-message-reply';
      replyEl.href = `#/forum/t/${topicId}/m/${message.replyTo}`;
      replyEl.textContent = parent?.body ?? t('originalMessageUnavailable');
      root.appendChild(replyEl);
    }
    // Skipped entirely for a caption-less attachment post (an empty body is
    // only possible today via an attachment - see actionBtn's own click
    // handler) - same reasoning apps/chat/client.js's own renderMessageText()
    // already applies for voice/location messages: an empty paragraph adds
    // nothing, the attachment below is the actual content.
    if (message.body) {
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
    }
    // Only the FIRST link in a post gets a preview card - see
    // <qu-link-preview>'s own doc comment (@qu/ui's
    // link-preview-components.js) for why (relay-proxied, IP/CORS-safe) and
    // why just the first (never a wall of cards for a multi-link post).
    // `message.body` (the plain, pre-formatting text), not `formattedHtml` -
    // `detectLinks()` needs the raw URL text, and this is the exact same
    // source `classifyMessageContentType()` below already reads for its own
    // 'link' classification.
    const firstLink = detectLinks(message.body ?? '').find((seg) => seg.type === 'link');
    if (firstLink) {
      const preview = document.createElement('qu-link-preview');
      preview.setAttribute('url', firstLink.value);
      root.appendChild(preview);
    }
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
  // `buildMessageFooter()` above) and the once-per-topic `content.topicToolbar`
  // slot (`mountTopicView()`'s own setup below).

  actionBtn.addEventListener('click', async () => {
    const body = composerInput.value.trim();
    // A caption is optional whenever there's an attachment to post instead
    // - same "content doesn't have to be text" rule apps/chat/client.js's
    // own sendTextMessage() already applies for its voice messages; only a
    // genuinely empty post (no text AND no attachment) is refused.
    if (!body && !pendingAttachment) return;
    actionBtn.disabled = true;
    composerErrorEl.hidden = true;
    try {
      // Refreshes this topic's own ACL doc right before posting - closes
      // the exact silent-failure scenario this file's own top doc comment
      // describes (`[SyncEngine] rejecting synced QuBit ... writer not
      // authorized`), NOT merely shrinks it, whenever a relay is actually
      // reachable: `syncFetch()` (`SyncEngine.fetch()`) ingests the fetched
      // ACL via the same trusted "already-signed synced data" path
      // `#handleSync()` uses, bypassing any local write-authorization check
      // (it's not this identity authoring a change, just receiving one) -
      // so it persists REGARDLESS of whether this identity itself has
      // write access. The very next line's `postMessage()` then runs
      // through `QuStore.put()`'s own synchronous `AccessEngine` pipeline
      // hook (`assertWriteAuthorized()`), which now sees the FRESH,
      // authoritative ACL and throws immediately if unauthorized - the
      // write never reaches PERSIST/NOTIFY, never enters the outbox, and
      // is never sent out at all. Proven end-to-end (two real identities,
      // no mocked rejection) by this app's own test: "composer: an
      // unauthorized post is rejected LOCALLY, before it ever reaches the
      // relay/other peers". The one case this can't close: genuinely
      // OFFLINE (no relay reachable at all) - `syncFetch` then silently
      // no-ops (`.catch(() => {})` below) and this identity's existing,
      // possibly-stale local ACL cache is all there is to go on, same
      // optimistic-write-while-offline trade-off `outbox.js` already makes
      // for every other write in this codebase.
      await syncFetch?.(paths.aclPath(SPACE_ID, 'threads', topicId)).catch(() => {});
      const attachment = pendingAttachment;
      const extra = attachment ? { attachment } : {};
      await services.messages.postMessage(SPACE_ID, topicId, { body, replyTo: replyingTo?.id ?? null, extra });
      stuckToBottom = true; // sending a post always means "show me what I just sent" - see apps/chat/client.js's own identical rule
      composerInput.value = '';
      clearPendingAttachment();
      setReplyingTo(null);
      // Only now, once the attachment is genuinely part of a sent post,
      // does the (deferred) sync-out verification phase start - see
      // <qu-asset-upload>'s own doc comment on confirmSent() for why.
      if (attachment) attachUpload.confirmSent(attachment.assetId);
    } catch (err) {
      // Same "no catch here previously meant NOTHING visible" fix as
      // mountInviteForm()'s own `.qu-forum-invite-error` - e.g. this
      // identity's own local ACL copy for this topic's thread is stale
      // (see this file's own top doc comment's reasoning on
      // `[SyncEngine] rejecting synced QuBit ... writer not authorized`)
      // and the local write is rejected before ever reaching the network -
      // the composer used to just silently re-enable with nothing sent.
      composerErrorEl.textContent = err.message;
      composerErrorEl.hidden = false;
    } finally {
      actionBtn.disabled = false;
    }
  });

  const offMessages = watchChildren(qu, paths.threadMessagesParentPath(SPACE_ID, topicId), () => renderMessages(), { syncFetch });

  return () => {
    stopped = true;
    resizeObserver?.disconnect();
    clearMessageWatchers();
    offMessages();
    stopComposerMentions();
    stopComposerEmoji();
    stopComposerAutogrow();
    stopTemplate();
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
 * `resolveForumReference()` below) is treated the same as "no match found":
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
  // See apps/chat/client.js's own searchChat() doc comment on this same
  // guard - a TYPE filter alone ("every image in this topic") is a real
  // search, never satisfiable by a body-text match (an image post's body
  // is no more descriptive than any other's).
  if (!SPACE_ID || (!q && !types?.length)) return [];
  const [, kindSeg, idSeg] = segments;

  async function messagesOfTopic(topicId, channelId, topicTitle) {
    const { messages } = await services.messages.listMessages(SPACE_ID, topicId);
    const out = [];
    for (const message of messages) {
      const contentType = classifyMessageContentType(message);
      if (types?.length && !types.includes(contentType)) continue;
      if (q && !message.body?.toLowerCase().includes(q)) continue;
      out.push({
        contentType, ts: message.ts, author: message.author,
        snippet: buildSnippet(message.body, q),
        href: `#/forum/t/${topicId}/m/${message.id}`,
        topicId, channelId, topicTitle: topicTitle ?? topicId,
        // Carried through so renderSearchResult() below can actually render
        // an image/video/audio/file result AS SUCH (a real <qu-asset>
        // preview/player), not just its caption text - see that function's
        // own doc comment.
        spaceId: SPACE_ID, attachment: message.attachment ?? null,
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
 * The `content.resolveReference` contributor (see `apps/notifications/
 * manifest.quapp`'s own doc comment for the full payload contract) -
 * resolves a stored notification's bare `{spaceId, threadId, messageId}`
 * reference back into a `content.search`-shaped entry, so the SAME
 * `renderSearchResult()` below (Search's own template) can render it -
 * `apps/notifications` never needs to know Forum's message/topic shape any
 * more than `apps/search` does. A single `getMessage()` lookup, not a full
 * `listMessages()` scan - see that Service method's own doc comment.
 * @param {{services: object, qu: object, syncFetch?: Function, spaceId: string|number, threadId: string, messageId: string}} payload
 * @returns {Promise<object|null>} One entry, or `null` if unresolvable
 *   (deleted message, access revoked, etc.) - `ExtensionPointHost.collect()`
 *   treats a falsy return as "no result", not an error.
 */
export async function resolveForumReference({ services, qu, syncFetch, spaceId, threadId, messageId }) {
  await syncFetch?.(paths.threadMessagePath(spaceId, threadId, messageId)).catch(() => {});
  const message = await services.messages.getMessage(spaceId, threadId, messageId);
  if (!message) return null;

  const topicBit = await qu.get(paths.documentPath(spaceId, threadId));
  return {
    contentType: classifyMessageContentType(message), ts: message.ts, author: message.author,
    snippet: buildSnippet(message.body, ''),
    href: `#/forum/t/${threadId}/m/${messageId}`,
    topicId: threadId, channelId: topicBit?.val?.channelId ?? null, topicTitle: topicBit?.val?.title ?? threadId,
    spaceId, attachment: message.attachment ?? null,
  };
}

/**
 * The `content.searchResultTemplate` contributor - renders one row for an
 * entry THIS SAME app returned from `searchForum()`/`resolveForumReference()`
 * above (both callers, Search and Notifications, share this one template).
 *
 * RENDERS MEDIA AS SUCH - an image/video/audio/file result (`entry.
 * attachment` present, see either caller's own doc comment on that field)
 * gets a real `<qu-asset>` preview/player, the SAME widget a topic view's
 * own message list already uses for this exact attachment (`kind="auto"` -
 * resolves image/video/audio/file from the asset's own real MIME, not
 * `entry.contentType`, which only exists to drive the search TYPE FILTER).
 * Confirmed, previously-reported gap: every result rendered as plain
 * meta+snippet text regardless of `contentType`, so an image/video/audio
 * hit was indistinguishable from a plain text post until you actually
 * clicked through. Deliberately a SIBLING of the `<a>` (not nested inside
 * it) - a video/audio result's own native controls (play/seek/volume), or
 * an image's click-to-lightbox, must not also trigger the row's "navigate
 * to the message" link underneath them. Requires `container.assetService`
 * set somewhere up this row's own ancestor chain - both real callers
 * (`apps/search/client.js`, `apps/notifications/client.js`) set it once on
 * their own top-level mount `container`, the same "set on an ancestor
 * before children connect" discipline `<qu-asset>` needs everywhere else.
 * @param {HTMLElement} container
 * @param {{entry: object, services: object}} payload
 */
export async function renderSearchResult(container, { entry, services }) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-forum-search-result';

  const link = document.createElement('a');
  link.className = 'qu-forum-search-result-link';
  link.href = entry.href;

  let authorLabel = entry.author ?? '';
  try {
    const profile = entry.author ? await services.profile.getPublicProfile(entry.author) : null;
    if (profile) authorLabel = formatActorLabel(entry.author, profile);
  } catch { /* offline/unresolvable - falls back to the raw pubkey */ }

  const meta = document.createElement('div');
  meta.className = 'qu-forum-search-result-meta';
  meta.textContent = `${authorLabel} · ${t('searchResultIn', { topic: entry.topicTitle ?? entry.topicId ?? '' })} · ${formatTs(entry.ts)}`;
  link.appendChild(meta);

  if (entry.snippet) {
    const snippet = document.createElement('p');
    snippet.className = 'qu-forum-search-result-snippet';
    snippet.textContent = entry.snippet;
    link.appendChild(snippet);
  }
  wrap.appendChild(link);

  if (entry.attachment && entry.spaceId) {
    const assetEl = document.createElement('qu-asset');
    assetEl.className = 'qu-forum-search-result-attachment';
    assetEl.setAttribute('space-id', entry.spaceId);
    assetEl.setAttribute('asset-id', entry.attachment.assetId);
    wrap.appendChild(assetEl);
  }

  container.appendChild(wrap);
}
