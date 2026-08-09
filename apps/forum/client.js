/**
 * FORUM — a real browser client for the single public thread `apps/forum/
 * index.js`'s `register()` already ensures exists on every relay
 * (`THREAD_ID='general'`, redeclared locally below - see that file's own doc
 * comment for why this bundle never imports it from there). `SPACE_ID` is
 * NOT a local literal - it's read at mount time off this app's own entry in
 * `ctx.apps` (the manifest catalog every mounted app already receives), i.e.
 * `manifest.quapp`'s fixed `spaceId` UUID, never a human-readable name (see
 * `@qu/foundation`'s manifest schema doc comment on why: a name/label like
 * "forum" is display metadata, not a collision-safe storage key).
 * `MessageService`/`ReactionService`/`PinService` (`@qu/services`)
 * have existed fully built and tested since early in this project, with
 * nothing wiring them to a real client until this file - the same
 * "backfill hook built, no real caller yet" gap earlier rounds already
 * found and closed for `ProfileService`'s `syncFetch` and
 * `DirectoryService.setVisible()`.
 *
 * SCOPE - what THIS round deliberately does NOT build, and why:
 *   - No channels/topics: QuV2's own Forum had a Channel -> Topic ->
 *     per-topic-Thread hierarchy on top of a `DocumentService`/
 *     `CollectionService` pair V3 never ported (superseded by
 *     `ListService`, see `DirectoryService`'s own doc comment on why that
 *     split doesn't exist here). Building a channels concept just for this
 *     app would be new service-layer design nobody has asked for - a
 *     client for the ONE thread that already exists is the honest next
 *     step, not a speculative bigger one.
 *   - No delete: `MessageService` has no delete primitive at all (only
 *     `editMessage()`, author-only) - nothing to expose.
 *   - No restricted-thread management UI: the one thread this app talks to
 *     is `THREAD_PRESETS.forum()` - `writers:'*', readers:'*'` - there is no
 *     reader list to manage.
 *
 * ATTACHMENTS (`@qu/ui`'s `<qu-asset-upload>`/`<qu-asset>`, over `@qu/services`'
 * `AssetService`) - this app's designated TEST integration for the file/
 * image/video/audio upload+sync+display mechanism (see `AssetEngine`'s own
 * doc comment for where the actual chunking/hashing/dedup/retry LOGIC
 * lives). `pendingAttachment` (mount()-closure state) holds the result of
 * the LAST completed upload until Send is actually clicked - picking a file
 * starts uploading it immediately (not deferred to Send, unlike QuV2's own
 * Chat composer, whose `pendingFile` variable held a raw, not-yet-uploaded
 * `File` until submit) so the composer can show real upload/sync PROGRESS
 * before the message is even sent, at the cost of one edge case: uploading
 * and never sending leaves an orphaned, unreferenced asset in this
 * identity's own local+relay storage - acceptable for a public forum
 * attachment (no delete primitive exists for messages either, see above),
 * revisit if that stops being true. `attachment: {assetId, name, mime,
 * size}` rides on `MessageService.postMessage()`'s existing `extra` param
 * (merged into the stored message as-is, exactly like a relay-authored
 * notification's `{title, url, appId, image}` already does) - no new
 * Service-layer field needed. The public thread here (`readers: '*'`) never
 * passes `readerPubs` to `upload()` - attachments stay unencrypted, matching
 * the message bodies sitting next to them.
 *
 * REACTIONS/PINS UI - adapted from QuV2's Chat client (QuV2's own Forum
 * never had either), deliberately simplified: a fixed, always-visible row
 * of emoji buttons per message (not a "⋮" popup menu or an expandable
 * 150-emoji grid - no other app in V3 uses a popup menu, and a small fixed
 * set covers the common case same as QuV2's own "quick pick" strip did
 * before its optional expansion). Clicking a button that isn't your current
 * reaction sets it; clicking your current one clears it -
 * `ReactionService.setReaction()`'s own "a second call simply replaces the
 * first, `null` clears" semantics make this trivial, no extra client state
 * needed. Pins get a single collapsible bar at the top (not QuV2's
 * popup-plus-badge combination) listing every currently pinned message with
 * an unpin button each.
 *
 * REACTIVITY: the message list re-fetches via `services.messages.
 * listMessages()` (not the raw watched QuBits) every time `watchChildren()`
 * fires on the thread's messages parent path - exactly `apps/profile`'s own
 * `watch()` pattern (ignore the raw callback value, re-read through the
 * Service that knows how to decrypt/format it correctly). Each currently
 * rendered message gets its OWN `watchChildren()` on its reactions parent
 * path (mirrors QuV2's Chat client: reactions live in a separate
 * per-message collection, so they don't share the messages-list watch) -
 * every one of those watchers is torn down and rebuilt on each message-list
 * re-render (no diffing - this app has no pagination yet, so "rebuild all
 * message-scoped watchers every time the list changes" is simple and cheap
 * enough, revisit if that stops being true). Pins get exactly one
 * `watchChildren()` on the thread's pins parent path.
 *
 * `formattedHtml` (already computed server/service-side by `MessageService.
 * postMessage()`/`editMessage()` via `thread-formatting.js`) is inserted
 * via `innerHTML` directly - verified safe: `formatMarkdown()` HTML-escapes
 * the raw body FIRST (`escapeHtml()`), then applies only a small whitelist
 * of its own substitutions - there is no way a message body can smuggle
 * real markup through it. Covered by an explicit regression test anyway
 * (see this app's own test file).
 *
 * EXTENSION POINT (`content.messageActions`, declared in this app's own
 * `manifest.quapp` under `definesExtensionPoints` - see `@qu/foundation`'s
 * manifest schema doc comment for the full `contributes`/`definesExtensionPoints`
 * vocabulary): per message, right after the built-in edit/pin actions, a
 * small `<span>` is appended and handed to `ctx.extensionPoints.
 * renderSlot('content.messageActions', slotEl, payload)` - ANY app whose
 * OWN manifest declares `contributes: [{point: "content.messageActions",
 * export: "..."}]` gets dynamically imported and rendered into it, with NO
 * import of that app anywhere in this file (see `apps/bookmarks/client.js`,
 * the first real one - this app has never heard of it, and vice versa).
 * `payload` is `{services, messageId, spaceId, threadId, body, author}` -
 * `services` (not `qu`/`identity` directly) is what a contributor needs to
 * reach its own Service without constructing one itself; the rest describes
 * THIS message, for whatever a contributor wants to do with it (e.g.
 * Bookmarks' snapshot). This is genuinely a "reactions-with-extra-steps"
 * DECLARATIVE point, not a live subscription of its own - a contributor's
 * OWN rendered widget (e.g. Bookmarks' `renderFlagToggle()`-based button)
 * is exactly as reactive as it makes itself; this app only ever calls
 * `renderSlot()` once per message, at the same points messages themselves
 * already re-render (see the REACTIVITY section above).
 */
import { watchChildren } from '@qu/reactive';
import { paths, formatActorLabel } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderAvatar } from '@qu/ui';

const THREAD_ID = 'general';
const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '🔥'];

const DICT = {
  en: {
    title: 'Forum',
    empty: 'No messages yet - be the first to post.',
    composerPlaceholder: 'Write a message…',
    send: 'Send',
    edit: 'Edit', save: 'Save', cancel: 'Cancel',
    pin: 'Pin', unpin: 'Unpin',
    pinnedBar: 'Pinned', pinnedNone: '',
    attachRemove: 'Remove attachment',
  },
  de: {
    title: 'Forum',
    empty: 'Noch keine Nachrichten - sei die/der Erste.',
    composerPlaceholder: 'Nachricht schreiben…',
    send: 'Senden',
    edit: 'Bearbeiten', save: 'Speichern', cancel: 'Abbrechen',
    pin: 'Anheften', unpin: 'Lösen',
    pinnedBar: 'Angeheftet', pinnedNone: '',
    attachRemove: 'Anhang entfernen',
  },
};
const { t } = createI18n(DICT);

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
  .qu-forum-reactions { display: flex; gap: 0.3rem; margin-top: 0.4rem; flex-wrap: wrap; }
  .qu-forum-reaction { border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; background: transparent; cursor: pointer; padding: 0.1rem 0.5rem; font-size: 0.9em; }
  .qu-forum-reaction.qu-forum-reaction-mine { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 20%, transparent); border-color: var(--qu-color-accent, #5b5bd6); }
  .qu-forum-edit-row { display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-edit-row textarea { font: inherit; padding: 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; }
  .qu-forum-edit-row-buttons { display: flex; gap: 0.4rem; }
  .qu-forum-composer { display: flex; gap: 0.5rem; }
  .qu-forum-composer textarea { flex: 1; font: inherit; padding: 0.5rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); resize: vertical; min-height: 2.4rem; }
  .qu-forum-composer button { padding: 0 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: none; background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font: inherit; }
  .qu-forum-composer button:disabled { opacity: 0.6; cursor: default; }
  .qu-forum-empty { padding: 1.5rem; text-align: center; opacity: 0.7; }
  .qu-forum-composer-wrap { display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-forum-pending-attachment { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85em; opacity: 0.85; }
  .qu-forum-pending-attachment button { background: none; border: none; cursor: pointer; opacity: 0.7; font: inherit; padding: 0; }
  .qu-forum-message-attachment { margin-top: 0.5rem; max-width: 18rem; }
`;

function formatTs(ts) {
  return new Date(ts).toLocaleString();
}

export function mount(container, { qu, services, apps, subscribe, syncFetch, extensionPoints }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  const SPACE_ID = apps?.find((a) => a.name === 'forum')?.spaceId;
  if (!SPACE_ID) throw new Error('[forum] no "spaceId" found in the apps catalog for "forum" - check manifest.quapp');

  // Same "set on an ancestor before descendant Custom Elements connect"
  // discipline `.qu` already requires elsewhere in `@qu/ui` - both the
  // composer's `<qu-asset-upload>` and every message's `<qu-asset>`
  // (attachment display) resolve this via `findAssetService()`'s ancestor
  // walk.
  container.assetService = services.assets;

  // Defense in depth - a future shell would already subscribe broadly
  // enough to cover this, but this app shouldn't silently depend on that
  // staying true (same reasoning as apps/user-list's own subscribe() call).
  subscribe?.(paths.spacePath(SPACE_ID));
  subscribe?.(`/blob/${SPACE_ID}`); // attachment chunks live under a SEPARATE top-level mount - see AssetEngine's own doc comment

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
  composerRow.append(composerInput, attachUpload, sendBtn);

  const pendingAttachmentEl = document.createElement('div');
  pendingAttachmentEl.className = 'qu-forum-pending-attachment';
  pendingAttachmentEl.hidden = true;
  composerWrap.append(composerRow, pendingAttachmentEl);

  container.append(heading, pinnedRoot, messagesRoot, composerWrap);

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

  async function renderMessages() {
    if (stopped) return;
    const myPub = await services.actors.whoAmI();
    if (stopped) return;
    const { messages } = await services.messages.listMessages(SPACE_ID, THREAD_ID);
    if (stopped) return;

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
      ul.appendChild(await renderMessage(message, myPub));
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
    li.appendChild(renderAvatar(message.author, label, profile?.avatar, { size: '2.2rem' }));

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
        services, messageId: message.id, spaceId: SPACE_ID, threadId: THREAD_ID, body: message.body, author: message.author,
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
    p.innerHTML = message.formattedHtml; // see this file's own doc comment - escaped/whitelisted server-side, safe to insert
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
    const buttons = document.createElement('div');
    buttons.className = 'qu-forum-edit-row-buttons';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = t('save');
    saveBtn.addEventListener('click', async () => {
      const body = textarea.value.trim();
      if (!body) return;
      await services.messages.editMessage(SPACE_ID, THREAD_ID, message.id, { body });
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
    async function render() {
      if (stopped) return;
      const reactions = await services.reactions.getReactions(SPACE_ID, THREAD_ID, messageId);
      if (stopped) return;
      root.textContent = '';
      const row = document.createElement('div');
      row.className = 'qu-forum-reactions';
      for (const emoji of REACTION_CHOICES) {
        const reactors = reactions[emoji] ?? [];
        const mine = reactors.includes(myPub);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qu-forum-reaction' + (mine ? ' qu-forum-reaction-mine' : '');
        btn.textContent = reactors.length > 0 ? `${emoji} ${reactors.length}` : emoji;
        btn.addEventListener('click', () => services.reactions.setReaction(SPACE_ID, THREAD_ID, messageId, mine ? null : emoji));
        row.appendChild(btn);
      }
      root.appendChild(row);
    }
    const off = watchChildren(qu, paths.threadReactionsParentPath(SPACE_ID, THREAD_ID, messageId), () => render(), { syncFetch });
    messageWatchers.push(off);
  }

  /**
   * Same live-per-message pattern as `mountReactions()` above, watching the
   * THREAD's pins parent path (shared by every message's own button, and
   * separately by `renderPinned()`'s own top-bar watcher below) - a little
   * redundant (every currently rendered message's button re-fetches
   * `listPinned()` on ANY pin change in the thread, not just its own), but
   * keeps every pin button honestly live without inventing a second data
   * shape, and this app has no pagination yet to make that cost noticeable.
   */
  function mountPinButton(btn, messageId) {
    async function render() {
      if (stopped) return;
      const pinnedIds = await services.pins.listPinned(SPACE_ID, THREAD_ID);
      if (stopped) return;
      const pinned = pinnedIds.includes(messageId);
      btn.textContent = pinned ? t('unpin') : t('pin');
      btn.onclick = () => services.pins.setPinned(SPACE_ID, THREAD_ID, messageId, !pinned);
    }
    const off = watchChildren(qu, paths.threadPinsParentPath(SPACE_ID, THREAD_ID), () => render(), { syncFetch });
    messageWatchers.push(off);
  }

  async function renderPinned() {
    if (stopped) return;
    const pinnedIds = await services.pins.listPinned(SPACE_ID, THREAD_ID);
    if (stopped) return;
    pinnedRoot.textContent = '';
    if (pinnedIds.length === 0) return;

    const box = document.createElement('div');
    box.className = 'qu-forum-pinned';
    const title = document.createElement('div');
    title.className = 'qu-forum-pinned-title';
    title.textContent = `📌 ${t('pinnedBar')} (${pinnedIds.length})`;
    box.appendChild(title);

    for (const messageId of pinnedIds) {
      const quBit = await qu.get(paths.threadMessagePath(SPACE_ID, THREAD_ID, messageId));
      if (stopped) return;
      const row = document.createElement('div');
      row.className = 'qu-forum-pinned-row';
      const span = document.createElement('span');
      span.textContent = quBit?.val?.body ?? messageId;
      const unpinBtn = document.createElement('button');
      unpinBtn.type = 'button';
      unpinBtn.textContent = '✕';
      unpinBtn.title = t('unpin');
      unpinBtn.addEventListener('click', () => services.pins.setPinned(SPACE_ID, THREAD_ID, messageId, false));
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
      await services.messages.postMessage(SPACE_ID, THREAD_ID, { body, extra });
      composerInput.value = '';
      clearPendingAttachment();
    } finally {
      sendBtn.disabled = false;
    }
  });

  const offMessages = watchChildren(qu, paths.threadMessagesParentPath(SPACE_ID, THREAD_ID), () => renderMessages(), { syncFetch });
  const offPins = watchChildren(qu, paths.threadPinsParentPath(SPACE_ID, THREAD_ID), () => renderPinned(), { syncFetch });

  return () => {
    stopped = true;
    clearMessageWatchers();
    offMessages();
    offPins();
  };
}
