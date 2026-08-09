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
 *   - `#/forum` - every channel (sidebar) + a merged recent-activity topic
 *     feed across all of them, newest first.
 *   - `#/forum/c/<channelId>` - one channel's topic list, a "new topic"
 *     form, and (if restricted) an "invite member" field.
 *   - `#/forum/t/<topicId>` - one topic's thread: message list, composer,
 *     reactions, pins, attachments, the `content.messageActions` extension
 *     point - everything this app already had before Channels/Topics
 *     existed, now parametrized by `topicId` instead of a single hardcoded
 *     thread id.
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
 * REACTIONS/PINS/EMOJI/MENTIONS - see `@qu/thread-ui`'s own doc comment for
 * the shared `renderEmojiPicker()`/`mountMentionAutocomplete()`/
 * `insertAtCursor()` primitives this app's composer and reaction rows are
 * built from - the SAME package a future `apps/chat` port is meant to reuse
 * without rework.
 *
 * REACTIVITY (topic view): the message list re-fetches via `services.
 * messages.listMessages()` (not the raw watched QuBits) every time
 * `watchChildren()` fires on the topic's messages parent path - exactly
 * `apps/profile`'s own `watch()` pattern (ignore the raw callback value,
 * re-read through the Service that knows how to decrypt/format it
 * correctly). Every async render function in this file (`renderMessages()`,
 * `renderPinned()`, each message's own reaction/pin row) is guarded by a
 * monotonic per-call token, the fix for a confirmed duplicate-content race:
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
 * EXTENSION POINT (`content.messageActions`, declared in this app's own
 * `manifest.quapp` under `definesExtensionPoints`): per message, right
 * after the built-in edit/pin actions, a small `<span>` is appended and
 * handed to `ctx.extensionPoints.renderSlot('content.messageActions',
 * slotEl, payload)` - ANY app whose OWN manifest declares `contributes:
 * [{point: "content.messageActions", export: "..."}]` gets dynamically
 * imported and rendered into it, with NO import of that app anywhere in
 * this file (see `apps/bookmarks/client.js`, the first real one). `payload`
 * is `{services, messageId, spaceId, threadId, body, author}`.
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
import { paths, formatActorLabel } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderAvatarOrAsset, renderSubpage } from '@qu/ui';
import { renderEmojiPicker, mountMentionAutocomplete, insertAtCursor } from '@qu/thread-ui';

const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '🔥'];

const DICT = {
  en: {
    title: 'Forum',
    empty: 'No messages yet - be the first to post.',
    composerPlaceholder: 'Write a message…',
    send: 'Send',
    edit: 'Edit', save: 'Save', cancel: 'Cancel',
    pin: 'Pin', unpin: 'Unpin',
    pinnedBar: 'Pinned',
    attachRemove: 'Remove attachment',
    insertEmoji: 'Insert emoji', moreEmoji: 'More emoji',
    backToForum: '← Forum', backToChannel: '← {channel}',
    channels: 'Channels',
    noChannelsYet: 'No channels yet - create one below.',
    newChannelPlaceholder: 'New channel name…',
    createChannel: 'Create channel',
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
  },
  de: {
    title: 'Forum',
    empty: 'Noch keine Nachrichten - sei die/der Erste.',
    composerPlaceholder: 'Nachricht schreiben…',
    send: 'Senden',
    edit: 'Bearbeiten', save: 'Speichern', cancel: 'Abbrechen',
    pin: 'Anheften', unpin: 'Lösen',
    pinnedBar: 'Angeheftet',
    attachRemove: 'Anhang entfernen',
    insertEmoji: 'Emoji einfügen', moreEmoji: 'Weitere Emojis',
    backToForum: '← Forum', backToChannel: '← {channel}',
    channels: 'Kanäle',
    noChannelsYet: 'Noch keine Kanäle - leg unten einen an.',
    newChannelPlaceholder: 'Name des neuen Kanals…',
    createChannel: 'Kanal erstellen',
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
  },
};
const { t } = createI18n(DICT);

function formatReplies(count) {
  return t('replies', { count });
}

const STYLE_ID = 'qu-forum-style';
const STYLE = `
  .qu-forum-pinned { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.8rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 8%, transparent); }
  .qu-forum-pinned-title { font-weight: 600; font-size: 0.8em; opacity: 0.75; }
  .qu-forum-pinned-row { display: flex; align-items: center; gap: 0.5rem; }
  .qu-forum-pinned-row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9em; }
  .qu-forum-messages { list-style: none; margin: 0 0 0.8rem; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-forum-message { display: flex; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-forum-message-body { flex: 1; min-width: 0; }
  .qu-forum-message-head { display: flex; align-items: baseline; gap: 0.5rem; }
  .qu-forum-message-author { font-weight: 600; }
  .qu-forum-message-ts { font-size: 0.75em; opacity: 0.6; }
  .qu-forum-message-edited { font-size: 0.75em; opacity: 0.6; font-style: italic; }
  .qu-forum-message-text { overflow-wrap: anywhere; }
  .qu-forum-message-text code { font-family: var(--qu-font-mono, ui-monospace, monospace); background: var(--qu-color-surface, #8882); padding: 0.05rem 0.3rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-forum-message-actions { display: flex; gap: 0.4rem; margin-top: 0.3rem; }
  .qu-forum-message-actions button { background: none; border: none; cursor: pointer; opacity: 0.6; font: inherit; font-size: 0.85em; padding: 0; }
  .qu-forum-message-actions button:hover { opacity: 1; }
  .qu-forum-message-extensions { display: inline-flex; gap: 0.3rem; margin-top: 0.4rem; }
  .qu-forum-reactions { display: flex; gap: 0.3rem; margin-top: 0.4rem; flex-wrap: wrap; align-items: center; }
  .qu-forum-reaction { border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; background: transparent; cursor: pointer; padding: 0.1rem 0.5rem; font-size: 0.9em; }
  .qu-forum-reaction.qu-forum-reaction-mine { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 20%, transparent); border-color: var(--qu-color-accent, #5b5bd6); }
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
  .qu-forum-board { display: flex; flex-direction: column; gap: 1.2rem; }
  .qu-forum-channels { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-channel-row a { display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.6rem; border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-forum-channel-row a:hover { background: var(--qu-color-border, #8884); }
  .qu-forum-restricted-badge { font-size: 0.75em; opacity: 0.75; }
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
  .qu-subpage-back { display: inline-block; margin-bottom: 0.6rem; opacity: 0.75; text-decoration: none; color: inherit; }
  .qu-subpage-back:hover { opacity: 1; }
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
  } else {
    stopView = mountBoardView(container, viewCtx);
  }
  return () => stopView?.();
}

// ===================================================================
// BOARD VIEW - #/forum: every channel + a merged recent-activity feed
// ===================================================================

function mountBoardView(container, { qu, services, syncFetch, SPACE_ID }) {
  let stopped = false;
  container.textContent = '';

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const channelsRoot = document.createElement('div');
  const activityRoot = document.createElement('div');
  container.append(heading, channelsRoot, activityRoot);

  let renderToken = 0;
  async function render() {
    const token = ++renderToken;
    if (stopped) return;
    const channels = await services.channels.listChannels(SPACE_ID);
    if (stopped || token !== renderToken) return;
    const topicsPerChannel = await Promise.all(channels.map((c) => services.channels.listTopics(SPACE_ID, c._id)));
    if (stopped || token !== renderToken) return;

    renderChannelsSidebar(channelsRoot, channels);

    const merged = [];
    channels.forEach((channel, i) => {
      for (const topic of topicsPerChannel[i]) merged.push({ ...topic, channelTitle: channel.title });
    });
    merged.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    renderActivityFeed(activityRoot, merged);
  }

  function renderChannelsSidebar(root, channels) {
    root.textContent = '';
    const title = document.createElement('h2');
    title.textContent = t('channels');
    root.appendChild(title);

    if (channels.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-forum-empty';
      empty.textContent = t('noChannelsYet');
      root.appendChild(empty);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'qu-forum-channels';
      for (const channel of channels) {
        const li = document.createElement('li');
        li.className = 'qu-forum-channel-row';
        const a = document.createElement('a');
        a.href = `#/forum/c/${channel._id}`;
        a.textContent = channel.title;
        if (channel.restricted) {
          const badge = document.createElement('span');
          badge.className = 'qu-forum-restricted-badge';
          badge.textContent = '🔒';
          a.appendChild(badge);
        }
        li.appendChild(a);
        ul.appendChild(li);
      }
      root.appendChild(ul);
    }
    root.appendChild(newChannelForm());
  }

  function newChannelForm() {
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

    const membersInput = document.createElement('input');
    membersInput.type = 'text';
    membersInput.placeholder = t('membersPlaceholder');
    membersInput.hidden = true;
    restrictedInput.addEventListener('change', () => { membersInput.hidden = !restrictedInput.checked; });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = t('createChannel');
    form.append(titleInput, restrictedLabel, membersInput, submit);

    // The actual fix for "double-clicking Create sometimes makes two
    // boards" (see this file's own top doc comment) - disable for the
    // duration of the create call, same convention `sendBtn` already uses
    // for posting a message.
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) return;
      submit.disabled = true;
      try {
        const memberPubs = membersInput.value.split(',').map((s) => s.trim()).filter(Boolean);
        await services.channels.createChannel(SPACE_ID, { title, restricted: restrictedInput.checked, memberPubs });
        titleInput.value = '';
        restrictedInput.checked = false;
        membersInput.value = '';
        membersInput.hidden = true;
        // No manual render() call - the channels-list watch() below
        // already covers this, exactly like the topic view never manually
        // reloads after postMessage().
      } finally {
        submit.disabled = false;
      }
    });
    return form;
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
  };
}

// ===================================================================
// CHANNEL VIEW - #/forum/c/<channelId>: one channel's topics
// ===================================================================

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

  renderSubpage(container, {
    backHref: '#/forum',
    backLabel: t('backToForum'),
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
  };
}

// ===================================================================
// TOPIC VIEW - #/forum/t/<topicId>: one topic's thread
// ===================================================================

function mountTopicView(container, { qu, services, subscribe, syncFetch, extensionPoints, SPACE_ID, topicId }) {
  let stopped = false;

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const pinnedRoot = document.createElement('div');
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

  // @mention completion (by alias or pub, from the 2nd typed character) -
  // wire-format unchanged, purely a compose-time insert helper. See
  // `@qu/thread-ui`'s own doc comment.
  const stopComposerMentions = mountMentionAutocomplete(composerInput, { services, subscribe });

  const pendingAttachmentEl = document.createElement('div');
  pendingAttachmentEl.className = 'qu-forum-pending-attachment';
  pendingAttachmentEl.hidden = true;
  composerWrap.append(composerRow, pendingAttachmentEl);

  renderSubpage(container, {
    backHref: '#/forum',
    backLabel: t('backToForum'),
    render: (content) => content.append(heading, pinnedRoot, messagesRoot, composerWrap),
  });
  // renderSubpage() builds the back link internally and hands back nothing
  // - re-selected here (by the class it's own doc comment guarantees) so it
  // can be updated once the topic's real channel is known, below.
  const backLink = container.querySelector('.qu-subpage-back');

  // Resolves the topic's own title and its parent channel (for the back
  // link) - doesn't block the message list itself from loading, both start
  // independently.
  (async () => {
    const topicBit = await qu.get(paths.documentPath(SPACE_ID, topicId));
    if (stopped) return;
    const topic = topicBit?.val;
    if (topic) {
      heading.textContent = topic.title;
      backLink.href = `#/forum/c/${topic.channelId}`;
      const channelBit = await qu.get(paths.documentPath(SPACE_ID, topic.channelId));
      if (stopped) return;
      const channel = channelBit?.val;
      // Until the channel doc resolves, the link already correctly points
      // at #/forum/c/<channelId> above - only its LABEL still says
      // "← Forum" for a moment, never a broken destination.
      if (channel) backLink.textContent = t('backToChannel', { channel: channel.title });
    }
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
    const tsEl = document.createElement('span');
    tsEl.className = 'qu-forum-message-ts';
    tsEl.textContent = formatTs(message.ts);
    head.append(authorEl, tsEl);
    if (message.editedAt) {
      const editedEl = document.createElement('span');
      editedEl.className = 'qu-forum-message-edited';
      editedEl.textContent = `(${t('edit').toLowerCase()})`;
      head.appendChild(editedEl);
    }

    const textWrap = document.createElement('div');
    if (editingDrafts.has(message.id)) renderMessageEdit(textWrap, message);
    else renderMessageText(textWrap, message);

    const actions = document.createElement('div');
    actions.className = 'qu-forum-message-actions';
    if (message.author === myPub) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = t('edit');
      editBtn.addEventListener('click', () => renderMessageEdit(textWrap, message));
      actions.appendChild(editBtn);
    }
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    mountPinButton(pinBtn, message.id);
    actions.appendChild(pinBtn);

    const reactionsRoot = document.createElement('div');
    mountReactions(reactionsRoot, message.id, myPub);

    const extensionSlot = document.createElement('span');
    extensionSlot.className = 'qu-forum-message-extensions';
    if (extensionPoints) {
      await extensionPoints.renderSlot('content.messageActions', extensionSlot, {
        services, messageId: message.id, spaceId: SPACE_ID, threadId: topicId, body: message.body, author: message.author,
      });
    }

    body.append(head, textWrap, actions, reactionsRoot, extensionSlot);
    li.appendChild(body);
    return li;
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
    // Same mention completion as the composer - a fresh instance per
    // renderMessageEdit() call, torn down the same way mountReactions()'s/
    // mountPinButton()'s own per-message watchers are: pushed onto the
    // shared `messageWatchers` array clearMessageWatchers() drains on every
    // renderMessages() rebuild (this row gets rebuilt right along with
    // everything else whenever the thread changes).
    messageWatchers.push(mountMentionAutocomplete(textarea, { services, subscribe }));
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

  function mountReactions(root, messageId, myPub) {
    // Local to this call - `mountReactions()` is re-invoked fresh, with a
    // fresh closure, for every message on every renderMessages() rebuild
    // (`clearMessageWatchers()` tears down the OLD instance's watcher
    // first), so there's no shared state to guard across messages here -
    // just the same "two watchChildren() fires racing each other for THIS
    // one message" case every render() in this file needs guarding against.
    let reactionToken = 0;
    async function render() {
      const token = ++reactionToken;
      if (stopped) return;
      const reactions = await services.reactions.getReactions(SPACE_ID, topicId, messageId);
      if (stopped || token !== reactionToken) return;
      root.textContent = '';
      const row = document.createElement('div');
      row.className = 'qu-forum-reactions';

      // Which one (if any) is MY current reaction - `ReactionService.
      // setReaction()`'s own "one reaction per actor, a second call simply
      // replaces the first" semantics means there's at most one. Computed
      // once and shared by both the quick row's own toggle-off logic and
      // the "+" picker's extended grid below, so picking an already-mine
      // emoji from EITHER place clears it rather than just re-setting it.
      let myReaction = null;
      for (const [emoji, reactors] of Object.entries(reactions)) {
        if (reactors.includes(myPub)) { myReaction = emoji; break; }
      }

      for (const emoji of REACTION_CHOICES) {
        const reactors = reactions[emoji] ?? [];
        const mine = emoji === myReaction;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qu-forum-reaction' + (mine ? ' qu-forum-reaction-mine' : '');
        btn.textContent = reactors.length > 0 ? `${emoji} ${reactors.length}` : emoji;
        btn.addEventListener('click', () => services.reactions.setReaction(SPACE_ID, topicId, messageId, mine ? null : emoji));
        row.appendChild(btn);
      }
      row.appendChild(renderEmojiPicker({
        onPick: (emoji) => services.reactions.setReaction(SPACE_ID, topicId, messageId, emoji === myReaction ? null : emoji),
        trigger: '+',
        triggerTitle: t('moreEmoji'),
      }));
      root.appendChild(row);
    }
    const off = watchChildren(qu, paths.threadReactionsParentPath(SPACE_ID, topicId, messageId), () => render(), { syncFetch });
    messageWatchers.push(off);
  }

  /**
   * Same live-per-message pattern as `mountReactions()` above, watching the
   * TOPIC's pins parent path (shared by every message's own button, and
   * separately by `renderPinned()`'s own top-bar watcher below) - a little
   * redundant (every currently rendered message's button re-fetches
   * `listPinned()` on ANY pin change in the topic, not just its own), but
   * keeps every pin button honestly live without inventing a second data
   * shape, and this app has no pagination yet to make that cost noticeable.
   */
  function mountPinButton(btn, messageId) {
    let pinBtnToken = 0; // same per-instance guard as mountReactions() above
    async function render() {
      const token = ++pinBtnToken;
      if (stopped) return;
      const pinnedIds = await services.pins.listPinned(SPACE_ID, topicId);
      if (stopped || token !== pinBtnToken) return;
      const pinned = pinnedIds.includes(messageId);
      btn.textContent = pinned ? t('unpin') : t('pin');
      btn.onclick = () => services.pins.setPinned(SPACE_ID, topicId, messageId, !pinned);
    }
    const off = watchChildren(qu, paths.threadPinsParentPath(SPACE_ID, topicId), () => render(), { syncFetch });
    messageWatchers.push(off);
  }

  let pinnedRenderToken = 0; // same class of race as renderMessages() above, own independent render path
  async function renderPinned() {
    const token = ++pinnedRenderToken;
    if (stopped) return;
    const pinnedIds = await services.pins.listPinned(SPACE_ID, topicId);
    if (stopped || token !== pinnedRenderToken) return;
    pinnedRoot.textContent = '';
    if (pinnedIds.length === 0) return;

    const box = document.createElement('div');
    box.className = 'qu-forum-pinned';
    const title = document.createElement('div');
    title.className = 'qu-forum-pinned-title';
    title.textContent = `📌 ${t('pinnedBar')} (${pinnedIds.length})`;
    box.appendChild(title);

    for (const messageId of pinnedIds) {
      const quBit = await qu.get(paths.threadMessagePath(SPACE_ID, topicId, messageId));
      if (stopped || token !== pinnedRenderToken) return;
      const row = document.createElement('div');
      row.className = 'qu-forum-pinned-row';
      const span = document.createElement('span');
      span.textContent = quBit?.val?.body ?? messageId;
      const unpinBtn = document.createElement('button');
      unpinBtn.type = 'button';
      unpinBtn.textContent = '✕';
      unpinBtn.title = t('unpin');
      unpinBtn.addEventListener('click', () => services.pins.setPinned(SPACE_ID, topicId, messageId, false));
      row.append(span, unpinBtn);
      box.appendChild(row);
    }
    pinnedRoot.appendChild(box);
  }

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
  const offPins = watchChildren(qu, paths.threadPinsParentPath(SPACE_ID, topicId), () => renderPinned(), { syncFetch });

  return () => {
    stopped = true;
    clearMessageWatchers();
    offMessages();
    offPins();
    stopComposerMentions();
  };
}
