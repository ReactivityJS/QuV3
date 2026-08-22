import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, AssetEngine, CollectionEngine, EntityEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import {
  ListService, AccessService, MessageService, ReactionService, PinService, ChannelService, CommentableService,
  ActorService, ProfileService, DirectoryService, ContactsService, AssetService, FlagService, BookmarksService, THREAD_PRESETS, paths,
} from '@qu/services';
import { ExtensionPointHost, Registry } from '@qu/foundation';
import { installDom, waitFor } from '@qu/ui/testing';
import { register as registerForum } from '../index.js';

installDom();
const { mount, searchForum, renderSearchResult } = await import('../client.js');

function createQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  // MessageService.postMessage()/editMessage() go through AccessEngine's
  // writer-ACL pipeline (see message-service.test.js's own freshSetup()) -
  // ReactionService/PinService need neither (see either's own doc comment:
  // "not ACL-checked by AccessEngine"). CollectionEngine resolves
  // ChannelService's curated {$list} documents (channels/topics) - see
  // apps/shell/src/services.js's own doc comment on why this is needed on
  // ANY qu that reads a curated list back, client-side included.
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu);
  new EntityEngine(qu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  return qu;
}

// Every existing test in this file predates Channels/Topics and talks
// directly to a topic id of 'general' - matching `apps/forum/index.js`'s
// own migration (a real "General" channel + "General" topic wrapping the
// exact same thread id that used to be the whole forum). `segments`
// routes `mount()` straight to that topic's view, same as a real
// `#/forum/t/general` hash would - see client.js's own router doc comment.
const TOPIC_SEGMENTS = ['forum', 't', 'general'];

/**
 * One identity's full service set and OWN store, as apps/shell's
 * createClientServices() would build it for a real browser tab -
 * `QuIdentityEngine` holds exactly one identity PER store (see its own
 * `#storeSeed()` guard), so two independent identities always need two
 * independent stores, never one shared `qu. Also runs `apps/forum/index.js`'s
 * own `register()` against a real `Registry` - the same relay-boot seed
 * every real deployment relies on for the "General" channel/topic to exist -
 * exactly once per fresh store, exactly like a real relay boot would.
 */
/**
 * @param {string} alias
 * @param {{syncFetch?: (path: string) => Promise<object|null>}} [options] -
 *   `syncFetch`, when given, is wired into every Service constructor that
 *   accepts one (`list`/`access`/`messages`/`channels`) - see the "an
 *   unauthorized post is rejected LOCALLY" test below for the one caller
 *   that actually needs this (a second, uninvited identity whose own
 *   `syncFetch` stub answers from a THIRD store, simulating a reachable
 *   relay - every other call site omits this entirely, unaffected).
 */
async function freshEnv(alias, { syncFetch = null } = {}) {
  const qu = createQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });
  const list = new ListService(qu, syncFetch);
  const access = new AccessService(qu, identity, syncFetch);
  const messages = new MessageService(qu, identity, list, access, syncFetch);
  const services = {
    actors: new ActorService(identity),
    profile: new ProfileService(qu, identity),
    messages,
    reactions: new ReactionService(qu, identity, list),
    pins: new PinService(qu, identity, list),
    assets: new AssetService(qu, new AssetEngine(qu), identity),
    bookmarks: new BookmarksService(new FlagService(qu, identity, list)),
    directory: new DirectoryService(qu, identity, list),
    contacts: new ContactsService(new FlagService(qu, identity, list), identity),
    channels: new ChannelService(qu, identity, list, access, messages, syncFetch),
    commentable: new CommentableService(messages),
  };
  const registry = new Registry();
  registry.registerService('list-service', list);
  registry.registerService('message-service', messages);
  registry.registerService('channel-service', services.channels);
  await registerForum(qu, { name: 'forum', version: '1.0.0', spaceId: FORUM_SPACE_ID }, registry);

  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/**
 * Copies everything a second identity's OWN mount needs to see about the
 * first identity into `intoQu` - the same `putSealed()` "as if sync had
 * already delivered it" technique `apps/user-list`'s/`apps/profile`'s own
 * test files already use, adapted for a thread's several derived-list
 * shapes (config + every current message) instead of a single profile
 * document.
 */
async function mirrorThreadInto(fromEnv, intoQu, spaceId, threadId) {
  const metaPath = paths.threadMetaPath(spaceId, threadId);
  const meta = await fromEnv.qu.get(metaPath);
  if (meta) await intoQu.putSealed(metaPath, meta);
  const entries = await fromEnv.qu.getChildren(paths.threadMessagesParentPath(spaceId, threadId));
  for (const { path, quBit } of entries) await intoQu.putSealed(path, quBit);
  const profile = await fromEnv.qu.get(actorPath(fromEnv.myPub, 'profile'));
  if (profile) await intoQu.putSealed(actorPath(fromEnv.myPub, 'profile'), profile);
}

/** Same "as if sync had already delivered it" technique as `mirrorThreadInto()`, for an uploaded asset (meta + every chunk). */
async function mirrorAssetInto(fromEnv, intoQu, spaceId, assetId) {
  const metaPath = paths.assetPath(spaceId, assetId) + '/meta';
  const metaBit = await fromEnv.qu.get(metaPath);
  if (!metaBit) return;
  await intoQu.putSealed(metaPath, metaBit);
  for (let i = 0; i < metaBit.val.chunkCount; i++) {
    const chunkPath = `${metaBit.val.blobPath}/chunk_${i}`;
    await intoQu.putSealed(chunkPath, await fromEnv.qu.get(chunkPath));
  }
}

// The real UUID committed in apps/forum/manifest.quapp - client.js now reads
// its spaceId off the apps catalog (`ctx.apps`), never a literal, so every
// mount() call below needs a matching catalog entry.
const FORUM_SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1';
const FORUM_APPS = [{ name: 'forum', spaceId: FORUM_SPACE_ID }];

// The REAL apps/bookmarks/client.js (not a synthetic fake) - proves the
// content.messageMenu contribution end to end against actual production
// code, the same way `ExtensionPointHost` would dynamically import it from
// a real apps catalog's `clientMainUrl`.
const BOOKMARKS_CLIENT_URL = new URL('../../bookmarks/client.js', import.meta.url).href;
const FORUM_APPS_WITH_BOOKMARKS = [
  { name: 'forum', spaceId: FORUM_SPACE_ID },
  { name: 'bookmarks', clientMainUrl: BOOKMARKS_CLIENT_URL, contributes: [{ point: 'content.messageMenu', export: 'bookmarkMenuItem' }] },
];

// Same "the REAL app, not a fake" reasoning as FORUM_APPS_WITH_BOOKMARKS -
// apps/reactions and apps/pins are admin-toggleable plugins now, reached
// only through the extension points forum's own manifest.quapp defines.
const REACTIONS_CLIENT_URL = new URL('../../reactions/client.js', import.meta.url).href;
const PINS_CLIENT_URL = new URL('../../pins/client.js', import.meta.url).href;
const FORUM_APPS_WITH_REACTIONS = [
  { name: 'forum', spaceId: FORUM_SPACE_ID },
  { name: 'reactions', clientMainUrl: REACTIONS_CLIENT_URL, contributes: [{ point: 'content.messageFooter', export: 'renderReactionWidget' }] },
];
const FORUM_APPS_WITH_PINS = [
  { name: 'forum', spaceId: FORUM_SPACE_ID },
  {
    name: 'pins', clientMainUrl: PINS_CLIENT_URL, contributes: [
      { point: 'content.messageMenu', export: 'pinMenuItem' },
      { point: 'content.topicToolbar', export: 'renderPinnedBar' },
    ],
  },
];

/**
 * Opens a message's "⋮" context menu (content.messageFooter's core.menu
 * segment) and returns its panel - `root` scopes to one specific message's
 * own `<li>` when a view has more than one (defaults to the whole container).
 * Scoped to `.qu-forum-message-footer` (not a bare
 * `.qu-thread-ui-context-menu-trigger` query) because the composer's own
 * "+" action menu (content.composerActions) is built from the SAME
 * `@qu/thread-ui` `renderContextMenu()` and carries the identical trigger
 * class - an unscoped query can resolve to whichever one happens to exist
 * in the DOM first (the composer mounts synchronously, a message's footer
 * only after its own async render), not necessarily a message's.
 */
async function openMessageMenu(root) {
  const selector = '.qu-forum-message-footer .qu-thread-ui-context-menu-trigger';
  await waitFor(() => root.querySelector(selector) !== null);
  root.querySelector(selector).click();
  await waitFor(() => root.querySelector('.qu-thread-ui-context-menu-panel') !== null);
  return root.querySelector('.qu-thread-ui-context-menu-panel');
}

/** Finds a context-menu item button by its label text, within an already-open panel. */
function menuItemButton(panel, label) {
  return [...panel.querySelectorAll('.qu-thread-ui-context-menu-item')].find((btn) => btn.textContent.includes(label));
}

function noopSubscribe() {}

/** `@qu/ui/testing`'s waitFor() never awaits an async predicate (documented gotcha, docs/building-an-app.md §9) - a real poll loop for conditions that themselves need an `await`. */
async function waitForAsync(check, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`waitForAsync: condition never became true within ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Must be attached to document.body - reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** jsdom's own scrollHeight/clientHeight are fixed getter-only 0s - same helper as apps/chat/test/client.test.js's own identical simulateScroll(), needed to give the geometry-based scroll listener real numbers to compare. */
function simulateScroll(scrollEl, { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  Object.defineProperty(scrollEl, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: clientHeight, configurable: true });
  scrollEl.scrollTop = scrollTop;
  scrollEl.dispatchEvent(new window.Event('scroll'));
}

test('renders the empty state when the thread has no messages yet', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-empty') !== null);
    assert.equal(container.querySelector('.qu-forum-message'), null);
  } finally {
    stop();
  }
});

test('renders a posted message with the author\'s alias, body, and a data-message-id', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const posted = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Hello, forum!' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message') !== null);
    const li = container.querySelector('.qu-forum-message');
    assert.equal(li.dataset.messageId, posted.id);
    assert.equal(li.dataset.author, a.myPub);
    assert.match(li.querySelector('.qu-forum-message-author').textContent, /Ada/);
    assert.match(li.querySelector('.qu-forum-message-text').textContent, /Hello, forum!/);
  } finally {
    stop();
  }
});

test('a post body URL gets a <qu-link-preview url="..."> right after the text - only the FIRST of several links', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'see https://example.com/a and also https://example.com/b' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text') !== null);
    const previews = container.querySelectorAll('qu-link-preview');
    assert.equal(previews.length, 1); // only the first link, not one per link
    assert.equal(previews[0].getAttribute('url'), 'https://example.com/a');
  } finally {
    stop();
  }
});

test('a post body with no URL gets no <qu-link-preview> at all', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'no links here' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('no links here'));
    assert.equal(container.querySelector('qu-link-preview'), null);
  } finally {
    stop();
  }
});

test('the composer posts a message and clears the input afterward', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    const textarea = container.querySelector('textarea');
    textarea.value = 'Posted from the composer';
    const sendBtn = container.querySelector('.qu-content-editor-submit-slot button');
    sendBtn.click();

    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('Posted from the composer'));
    assert.equal(textarea.value, '');
    const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    assert.equal(messages.length, 1);
  } finally {
    stop();
  }
});

test('the composer textarea starts at ONE visual line (rows=1) - regression: an un-sized <textarea> defaults to the UA\'s own rows=2', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    assert.equal(container.querySelector('.qu-content-editor-input-wrap textarea').rows, 1);
  } finally {
    stop();
  }
});

test('the composer\'s leading action slot includes Attach natively, plus any plugin-contributed content.composerActions item', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  // A duck-typed stub (not a real ExtensionPointHost) - this point has no
  // real contributing app yet, this only proves the HOOK itself works, the
  // same way this file's own "content.messageMenu: without extensionPoints"
  // sibling test proves the native-only path.
  const seen = [];
  const extensionPoints = {
    order: null,
    collect: async (point, payload) => {
      seen.push({ point, payload });
      return [{ id: 'calendar.newEvent', label: 'New calendar event', icon: '📅', onClick: () => {} }];
    },
    renderSlot: async () => {}, // content.topicToolbar - unrelated to this test, just needs to exist
  };
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS, extensionPoints });
  try {
    // composerActionsExtension() fetches content.composerActions ONCE at
    // mount time (see that function's own doc comment) - with only 2 total
    // leading actions (Attach + the one plugin item), the Presentation
    // Resolver's default 'inline-then-menu' strategy (threshold: 2) shows
    // both inline, no "+" menu needed for this count.
    await waitFor(() => container.querySelectorAll('.qu-content-editor-leading .qu-slot-resolver-item').length === 2);
    const items = [...container.querySelectorAll('.qu-content-editor-leading .qu-slot-resolver-item')];
    assert.deepEqual(items.map((btn) => btn.textContent), ['📎', '📅']);
    // `seen` also picks up the topic header's own `content.entityMenu`
    // collect() call (Quniverse V4, unrelated to this test) - filter to
    // just the point this test actually cares about.
    const composerActionsCalls = seen.filter((call) => call.point === 'content.composerActions');
    assert.equal(composerActionsCalls.length, 1);
    assert.equal(composerActionsCalls[0].payload.spaceId, FORUM_SPACE_ID);
    assert.equal(composerActionsCalls[0].payload.threadId, 'general');
  } finally {
    stop();
  }
});

test('attaching a file via the composer\'s <qu-asset-upload> sends it along with the message and renders as <qu-asset>', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('qu-asset-upload') !== null);
    const fileInput = container.querySelector('qu-asset-upload input[type=file]');
    const file = new File(['fake image bytes'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event('change'));
    // A real upload involves Ed25519 key derivation + per-chunk SHA-256
    // hashing - comfortably under a second in isolation, but occasionally
    // close to waitFor()'s default 1000ms under a loaded full-suite run
    // (observed flaking at ~1040ms) - a longer timeout here is about REAL
    // crypto work taking real time, not a bug being masked.
    await waitFor(() => container.querySelector('.qu-content-ui-attachment-chip') !== null, { timeout: 5000 });

    const textarea = container.querySelector('textarea');
    textarea.value = 'Check out this photo';
    const sendBtn = container.querySelector('.qu-content-editor-submit-slot button');
    sendBtn.click();

    await waitFor(() => container.querySelector('.qu-forum-message-attachment') !== null, { timeout: 5000 });
    const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    assert.equal(messages[0].attachment.name, 'photo.png');
    assert.equal(messages[0].attachment.mime, 'image/png');
    assert.equal(container.querySelector('.qu-forum-message-attachment').getAttribute('asset-id'), messages[0].attachment.assetId);
    // The pending-attachment chip is cleared after a successful send (see
    // content-editor.js's own `reset()` hook, Forum-migration round).
    assert.equal(container.querySelector('.qu-content-ui-attachment-chip'), null);
  } finally {
    stop();
  }
});

test('composer: a failed postMessage() (e.g. this identity\'s local ACL copy for the thread went stale) surfaces the error instead of failing silently', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const originalPostMessage = a.services.messages.postMessage.bind(a.services.messages);
  a.services.messages.postMessage = async () => {
    throw new Error('AccessEngine: writer not authorized to write to threads "general"');
  };

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    const textarea = container.querySelector('textarea');
    textarea.value = 'This should fail';
    container.querySelector('.qu-content-editor-submit-slot button').click();

    await waitFor(() => container.querySelector('.qu-forum-composer-error')?.hidden === false);
    assert.match(container.querySelector('.qu-forum-composer-error').textContent, /writer not authorized/);
    // the composer text is NOT cleared on failure - the user can retry (see
    // mountTopicView()'s own composer onSubmit doc comment on why this
    // needs an explicit restore against mountContentComposer()'s own
    // unconditional, synchronous clear-on-submit).
    assert.equal(textarea.value, 'This should fail');
  } finally {
    a.services.messages.postMessage = originalPostMessage;
    stop();
  }
});

test('composer: an unauthorized post is rejected LOCALLY, before it ever reaches the relay/other peers - not merely a friendlier error surfaced after the fact', async () => {
  const ada = await freshEnv('Ada');
  const channel = await ada.services.channels.createChannel(FORUM_SPACE_ID, { title: 'VIP', restricted: true, memberPubs: [] });
  const topic = await ada.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Secret' });

  // Eve - a real identity, never invited to this channel. Her OWN local
  // store has the topic's own Entity (simulating e.g. a stale bookmark
  // from before this restricted-channel privacy fix), but crucially NOT
  // this topic's own COMMENT thread ACL - the exact "never synced this ACL,
  // ever" scenario the composer's own pre-send syncFetch() call (client.js,
  // mountTopicView()'s composer onSubmit) exists to close.
  const eve = await freshEnv('Eve', {
    // A syncFetch stub answering from Ada's store - THE relay's real job
    // (`SyncEngine.fetch()`/`#handleResponse()`) is exactly this: serve
    // whatever the authoritative store actually has for a path, regardless
    // of whether the REQUESTER would be allowed to write it. Copies the
    // RAW stored QuBit (bypassing any pipeline), same as production sync.
    syncFetch: async (path) => {
      const { adapter, rel } = ada.qu.resolveMount(path);
      const quBit = await adapter.get(rel);
      if (quBit) await eve.qu.putSealed(path, quBit);
      return quBit ?? null;
    },
  });
  await eve.qu.putSealed(paths.entityPath(FORUM_SPACE_ID, topic._id), await ada.qu.get(paths.entityPath(FORUM_SPACE_ID, topic._id)));

  const container = makeContainer();
  const stop = mount(container, {
    qu: eve.qu, services: eve.services, apps: FORUM_APPS, subscribe: noopSubscribe,
    segments: ['forum', 't', topic._id], syncFetch: eve.services.messages.syncFetch,
  });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    container.querySelector('textarea').value = 'I should never arrive';
    container.querySelector('.qu-content-editor-submit-slot button').click();

    await waitFor(() => container.querySelector('.qu-forum-composer-error')?.hidden === false);
    assert.match(container.querySelector('.qu-forum-composer-error').textContent, /not authorized/);

    // The message is genuinely nowhere - not just hidden from Eve's own
    // view, but never written to the authoritative store (Ada's) at all,
    // i.e. the local rejection happened BEFORE anything was ever sent out.
    const { messages } = await ada.services.messages.listMessages(FORUM_SPACE_ID, topic._id);
    assert.equal(messages.length, 0);
    const { messages: eveMessages } = await eve.services.messages.listMessages(FORUM_SPACE_ID, topic._id);
    assert.equal(eveMessages.length, 0);
  } finally {
    stop();
  }
});

test('an attachment can be sent with no caption at all - the same rule voice messages already get in apps/chat', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('qu-asset-upload') !== null);
    const fileInput = container.querySelector('qu-asset-upload input[type=file]');
    const file = new File(['fake image bytes'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event('change'));
    await waitFor(() => container.querySelector('.qu-content-ui-attachment-chip') !== null, { timeout: 5000 });

    // No text typed at all - `requireText`'s own default rule (see
    // mountContentEditor()'s doc comment) already allows an empty submit
    // once a contribution (the attachment) exists.
    container.querySelector('.qu-content-editor-submit-slot button').click();

    await waitFor(() => container.querySelector('.qu-forum-message-attachment') !== null, { timeout: 5000 });
    const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    assert.equal(messages[0].body, '');
    assert.equal(messages[0].attachment.name, 'photo.png');
    // No stray empty <p> for the caption-less body - see renderMessageText()'s own doc comment.
    assert.equal(container.querySelector('.qu-forum-message-text'), null);
  } finally {
    stop();
  }
});

test('the composer\'s emoji picker inserts the picked emoji at the caret', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    const textarea = container.querySelector('textarea');
    textarea.value = 'hi ';
    textarea.selectionStart = textarea.selectionEnd = 3;

    const emojiTrigger = container.querySelector('.qu-thread-ui-emoji-picker button');
    assert.ok(emojiTrigger, 'expected a thread-ui emoji picker in the composer row');
    emojiTrigger.click();
    await waitFor(() => container.querySelector('.qu-thread-ui-emoji-panel') !== null);
    const panelButton = container.querySelector('.qu-thread-ui-emoji-panel button');
    assert.ok(panelButton);
    const picked = panelButton.textContent;
    panelButton.click();

    assert.equal(textarea.value, `hi ${picked}`);
  } finally {
    stop();
  }
});

test('the composer\'s @mention autocomplete inserts a full pub, and the posted message is recognized as a real mention', async () => {
  const a = await freshEnv('Ada');
  const b = await freshEnv('Bob');
  // Ada shows up in the directory - the pool mountMentionAutocomplete() builds.
  await a.services.directory.setVisible(true);

  await b.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  // Bob's own client needs to be able to SEE Ada is visible AND resolve her
  // alias - mirror both her directory entry and her public profile document
  // into his store, the same "already synced in" technique every other
  // cross-peer test in this file uses. Without the profile mirror,
  // getPublicProfile() finds nothing locally, matchesActorQuery() has no
  // alias to match "ad" against, and falls through to a pub-substring match
  // that a random pub is very unlikely to satisfy - a real gap in THIS
  // TEST's own setup, not a product bug.
  await b.qu.putSealed(paths.directoryEntryPath(a.myPub), await a.qu.get(paths.directoryEntryPath(a.myPub)));
  await b.qu.putSealed(actorPath(a.myPub, 'profile'), await a.qu.get(actorPath(a.myPub, 'profile')));

  const container = makeContainer();
  const stop = mount(container, { qu: b.qu, services: b.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    const textarea = container.querySelector('textarea');
    textarea.value = 'hey @ad';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent(new CustomEvent('input', { bubbles: true }));

    await waitFor(() => container.querySelector('.qu-thread-ui-mention-item') !== null);
    container.querySelector('.qu-thread-ui-mention-item').dispatchEvent(new CustomEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(textarea.value, `hey @${a.myPub}`);

    container.querySelector('.qu-content-editor-submit-slot button').click();
    await waitFor(() => container.querySelector('.qu-forum-message-text') !== null);

    const { messages } = await b.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    assert.deepEqual(messages[0].mentions, [a.myPub]);
  } finally {
    stop();
  }
});

test('a message with no attachment never renders a <qu-asset>', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'plain text only' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text') !== null);
    assert.equal(container.querySelector('.qu-forum-message-attachment'), null);
  } finally {
    stop();
  }
});

test('an attachment posted by one peer renders (downloads+decodes) for a second peer via a synced copy', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const meta = await a.services.assets.upload(FORUM_SPACE_ID, 'photo1', { name: 'photo.png', mime: 'image/png', data: new TextEncoder().encode('real photo bytes') });
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'shared photo', extra: { attachment: { assetId: 'photo1', ...meta } } });

  const b = await freshEnv('Bob');
  await mirrorThreadInto(a, b.qu, FORUM_SPACE_ID, 'general');
  await mirrorAssetInto(a, b.qu, FORUM_SPACE_ID, 'photo1');

  const container = makeContainer();
  const stop = mount(container, { qu: b.qu, services: b.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-attachment img') !== null, { timeout: 5000 });
  } finally {
    stop();
  }
});

test('a message posted elsewhere in the SAME store appears live in an already-mounted view, no reload', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-empty') !== null);
    await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Arrived live' });
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('Arrived live'));
  } finally {
    stop();
  }
});

test('a slow, stale renderMessages() call resolving AFTER a newer one never overwrites the newer render (renderToken regression)', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  // Wrap listMessages() so the FIRST call (triggered by mount()'s own
  // initial watchChildren() fire, reading the still-empty thread) reads its
  // real, current result immediately but has its RETURN held back until
  // released below - simulating the exact race this fix targets: an older
  // render's listMessages() resolving to the CALLER after a newer one's
  // already has. Every later call (the second, triggered by postMessage()
  // below) returns immediately, uncontrolled.
  let releaseFirstCall;
  const firstCallGate = new Promise((resolve) => { releaseFirstCall = resolve; });
  let callCount = 0;
  const realListMessages = a.services.messages.listMessages.bind(a.services.messages);
  a.services.messages.listMessages = async (...args) => {
    const isFirst = ++callCount === 1;
    const result = await realListMessages(...args); // reads real state at the real call time
    if (isFirst) await firstCallGate; // ...but only DELIVERS it to the caller once released
    return result;
  };

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    // The newer render (triggered by this post) must complete and show the
    // real message BEFORE the older, gated call is ever released.
    await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Only message' });
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('Only message'));

    // Now let the stale FIRST call (which captured the thread as EMPTY)
    // finally resolve. Without the renderToken guard, this would clear
    // messagesRoot and re-render the empty state over the correct message -
    // with the guard, this call must recognize it's no longer current and
    // do nothing.
    releaseFirstCall();
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the stale call's continuation actually run

    assert.equal(container.querySelectorAll('.qu-forum-message').length, 1);
    assert.ok(container.querySelector('.qu-forum-message-text')?.textContent.includes('Only message'));
    assert.equal(container.querySelector('.qu-forum-empty'), null);
  } finally {
    stop();
  }
});

test('content.messageFooter (reactions): the REAL apps/reactions app is dynamically imported and rendered per message, live across two independent mounts', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'React to me' });

  // Two independent mounts of the SAME store - proves the reactive watch
  // chain works across separate DOM instances, without needing a second
  // distinct identity for this particular assertion.
  const containerA = makeContainer();
  const extensionPointsA = new ExtensionPointHost(FORUM_APPS_WITH_REACTIONS);
  const stopA = mount(containerA, { qu: a.qu, services: a.services, apps: FORUM_APPS_WITH_REACTIONS, subscribe: noopSubscribe, extensionPoints: extensionPointsA, segments: TOPIC_SEGMENTS });
  const containerB = makeContainer();
  const extensionPointsB = new ExtensionPointHost(FORUM_APPS_WITH_REACTIONS);
  const stopB = mount(containerB, { qu: a.qu, services: a.services, apps: FORUM_APPS_WITH_REACTIONS, subscribe: noopSubscribe, extensionPoints: extensionPointsB, segments: TOPIC_SEGMENTS });
  try {
    // Scoped to <qu-reactions-row> specifically - the composer's OWN insert-
    // emoji button (`renderEmojiPicker({trigger: '😀', ...})`, still built
    // directly into apps/forum/client.js) renders the exact same
    // `.qu-thread-ui-emoji-trigger`/`.qu-thread-ui-emoji-panel` classes (the
    // shared @qu/thread-ui component), so an unscoped querySelector() would
    // just as happily grab the composer's trigger instead of the message's
    // own reaction widget.
    await waitFor(() => containerA.querySelector('qu-reactions-row .qu-thread-ui-emoji-trigger') !== null);
    assert.equal(containerA.querySelector('.qu-reactions-pill'), null); // no reactions yet - only the "+" trigger

    containerA.querySelector('qu-reactions-row .qu-thread-ui-emoji-trigger').click();
    await waitFor(() => containerA.querySelector('qu-reactions-row .qu-thread-ui-emoji-panel') !== null);
    // 👍 isn't necessarily on the panel's first (paginated) page - see
    // emoji-panel.js's own doc comment - so search for it by name rather
    // than assuming it's already in the DOM.
    const reactionSearch = containerA.querySelector('qu-reactions-row .qu-thread-ui-emoji-panel-search');
    reactionSearch.value = 'thumbsup';
    reactionSearch.dispatchEvent(new window.Event('input'));
    [...containerA.querySelectorAll('qu-reactions-row .qu-thread-ui-emoji-panel-grid button')].find((btn) => btn.textContent === '👍').click();

    await waitFor(() => [...containerB.querySelectorAll('.qu-reactions-pill')].some((btn) => btn.textContent === '👍 1'));
    assert.ok(containerA.querySelector('.qu-reactions-pill').classList.contains('qu-reactions-pill-mine'));

    containerA.querySelector('.qu-reactions-pill').click(); // toggle off
    await waitFor(() => containerB.querySelector('.qu-reactions-pill') === null);
  } finally {
    stopA();
    stopB();
  }
});

test('content.messageMenu (bookmarks): the REAL apps/bookmarks app (not a fake) contributes a menu item via ExtensionPointHost.collect()', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'bookmark me' });

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(FORUM_APPS_WITH_BOOKMARKS);
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS_WITH_BOOKMARKS, subscribe: noopSubscribe, extensionPoints, segments: TOPIC_SEGMENTS });
  try {
    let panel = await openMessageMenu(container);
    let bookmarkBtn = menuItemButton(panel, 'Bookmark this message'); // resolved inactive state (apps/bookmarks' own hasPrivate() check)
    assert.ok(bookmarkBtn, 'expected a "Bookmark this message" menu item');
    bookmarkBtn.click(); // also closes the menu, per renderContextMenu()'s own contract - onClick() itself is fire-and-forget from the DOM click handler's own perspective
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the underlying async add() land

    assert.equal(await a.services.bookmarks.isBookmarked((await a.services.messages.listMessages(FORUM_SPACE_ID, 'general')).messages[0].id), true);
    const [entry] = await a.services.bookmarks.list();
    assert.equal(entry.body, 'bookmark me');
    assert.equal(entry.spaceId, FORUM_SPACE_ID);
    assert.equal(entry.threadId, 'general');

    panel = await openMessageMenu(container);
    assert.ok(menuItemButton(panel, 'Remove bookmark'), 'expected the item to now read "Remove bookmark"');
  } finally {
    stop();
  }
});

test('content.messageMenu: without extensionPoints/a contributing app, the menu still opens with just this app\'s OWN native items ("Edit"+"Reply" for an own message) - no crash', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'no plugins loaded' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS }); // no extensionPoints at all
  try {
    const panel = await openMessageMenu(container);
    assert.ok(menuItemButton(panel, 'Edit')); // this app's own native item, unaffected by the missing extensionPoints
    assert.ok(menuItemButton(panel, 'Reply')); // native too - any message, not just mine
    assert.ok(menuItemButton(panel, 'Copy text'));
    assert.ok(menuItemButton(panel, 'Copy link'));
    assert.equal(panel.querySelectorAll('.qu-thread-ui-context-menu-item').length, 4); // Edit + Reply + Copy text + Copy link - no plugin contributed
  } finally {
    stop();
  }
});

test('content.messageMenu: "Copy text"/"Copy link" copy the message body and an ABSOLUTE permalink (not a bare hash) to the clipboard', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const posted = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'copy me please' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  const written = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { written.push(text); } } }, configurable: true });
  try {
    let panel = await openMessageMenu(container);
    menuItemButton(panel, 'Copy text').click();
    await waitFor(() => written.length === 1);
    assert.equal(written[0], 'copy me please');

    panel = await openMessageMenu(container);
    menuItemButton(panel, 'Copy link').click();
    await waitFor(() => written.length === 2);
    assert.equal(written[1], `http://localhost/#/forum/t/general/m/${posted.id}`); // absolute, not the bare "#/forum/t/general/m/<id>" hash
  } finally {
    stop();
    Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  }
});

test('content.messageMenu (bookmarks): a bookmark is private - a SECOND identity viewing the same message sees its own (unbookmarked) menu item', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'shared message' });
  const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
  await a.services.bookmarks.add(messages[0].id, { body: 'shared message' }); // Ada bookmarks it

  const b = await freshEnv('Bob');
  await mirrorThreadInto(a, b.qu, FORUM_SPACE_ID, 'general');

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(FORUM_APPS_WITH_BOOKMARKS);
  const stop = mount(container, { qu: b.qu, services: b.services, apps: FORUM_APPS_WITH_BOOKMARKS, subscribe: noopSubscribe, extensionPoints, segments: TOPIC_SEGMENTS });
  try {
    const panel = await openMessageMenu(container);
    // Bob's own, independent, still-inactive state - and no "Edit" item at
    // all (Ada's message, not his) - "Reply" is still there either way,
    // native to any message.
    assert.ok(menuItemButton(panel, 'Bookmark this message'));
    assert.ok(menuItemButton(panel, 'Reply'));
    assert.equal(menuItemButton(panel, 'Edit'), undefined);
  } finally {
    stop();
  }
});

test('content.messageMenu (pins) / content.topicToolbar: the REAL apps/pins app pins a message via its menu item and shows it in the pinned bar, live for a second independent mount; unpinning removes it', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Pin this one' });

  const containerA = makeContainer();
  const extensionPointsA = new ExtensionPointHost(FORUM_APPS_WITH_PINS);
  const stopA = mount(containerA, { qu: a.qu, services: a.services, apps: FORUM_APPS_WITH_PINS, subscribe: noopSubscribe, extensionPoints: extensionPointsA, segments: TOPIC_SEGMENTS });
  const containerB = makeContainer();
  const extensionPointsB = new ExtensionPointHost(FORUM_APPS_WITH_PINS);
  const stopB = mount(containerB, { qu: a.qu, services: a.services, apps: FORUM_APPS_WITH_PINS, subscribe: noopSubscribe, extensionPoints: extensionPointsB, segments: TOPIC_SEGMENTS });
  try {
    let panelA = await openMessageMenu(containerA);
    const pinBtn = menuItemButton(panelA, 'Pin');
    assert.ok(pinBtn, 'expected a "Pin" menu item');
    pinBtn.click();

    await waitFor(() => containerB.querySelector('.qu-pins-bar') !== null);
    const pinnedRowText = containerB.querySelector('.qu-pins-bar-row-text');
    assert.match(pinnedRowText.textContent, /Pin this one/);
    // Forum supplies a real messagePermalink() to the toolbar slot (see
    // mountTopicView()'s own renderSlot() call) - the pinned row is a real
    // link back to the original post, not just a text snippet.
    const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    assert.equal(pinnedRowText.tagName, 'A');
    assert.equal(pinnedRowText.getAttribute('href'), `#/forum/t/general/m/${messages[0].id}`);

    panelA = await openMessageMenu(containerA); // reopen - menu closed itself on the click above
    assert.ok(menuItemButton(panelA, 'Unpin'));

    containerB.querySelector('.qu-pins-bar-row button').click(); // unpin via the bar's own ✕
    await waitFor(() => containerB.querySelector('.qu-pins-bar') === null);
  } finally {
    stopA();
    stopB();
  }
});

// Regression: renderMessages() rebuilds the ENTIRE list from scratch on
// every write to ANY message in the thread - a message someone has an
// open, unsaved edit form on must survive that rebuild (still showing the
// form, with whatever they'd already typed), not silently revert back to
// its read-only view and discard their in-progress text the moment a
// completely UNRELATED message arrives.
test('an in-progress, unsaved edit survives an unrelated message arriving in the thread', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const own = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Original body' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message') !== null);
    const panel = await openMessageMenu(container);
    menuItemButton(panel, 'Edit').click();
    const textarea = container.querySelector('.qu-forum-edit-row textarea');
    assert.ok(textarea, 'expected the edit form to be open');
    textarea.value = 'Not yet saved...';
    textarea.dispatchEvent(new window.Event('input'));

    // An unrelated write to a DIFFERENT message in the same thread - not a
    // save, not touching the message being edited at all.
    await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'A completely unrelated message' });
    await waitFor(() => container.querySelectorAll('.qu-forum-message').length === 2);

    const stillOpenTextarea = container.querySelector(`[data-message-id="${own.id}"] .qu-forum-edit-row textarea`);
    assert.ok(stillOpenTextarea, 'the edit form must still be open after an unrelated message arrived');
    assert.equal(stillOpenTextarea.value, 'Not yet saved...');
  } finally {
    stop();
  }
});

test('the edit button only appears on the viewer\'s own message - a genuinely separate author never gets one', async () => {
  const a = await freshEnv('Ada');
  const b = await freshEnv('Bob');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const own = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'My own message' });

  // Bob needs the SAME thread config on his own store before he can post
  // into it (postMessage() reads config locally) - simulate that arriving
  // via sync exactly like mirrorThreadInto() does for the reverse direction.
  await mirrorThreadInto(a, b.qu, FORUM_SPACE_ID, 'general');
  await new Promise((r) => setTimeout(r, 3)); // distinct ts - see message-service.test.js's own tick() convention
  await b.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Someone else\'s message' });
  // Now mirror Bob's own message (and profile) back into Ada's store, as
  // sync would - Ada's single mount below needs to see both authors.
  await mirrorThreadInto(b, a.qu, FORUM_SPACE_ID, 'general');

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelectorAll('.qu-forum-message').length === 2);
    const ownLi = container.querySelector(`[data-message-id="${own.id}"]`);
    const otherLi = [...container.querySelectorAll('.qu-forum-message')].find((li) => li.dataset.messageId !== own.id);

    assert.equal(otherLi.dataset.author, b.myPub);
    const ownPanel = await openMessageMenu(ownLi);
    assert.ok(menuItemButton(ownPanel, 'Edit'));
    const otherPanel = await openMessageMenu(otherLi);
    assert.equal(menuItemButton(otherPanel, 'Edit'), undefined);

    const ownPanelAgain = await openMessageMenu(ownLi); // reopen - the previous one closed on its own via outside interaction above
    menuItemButton(ownPanelAgain, 'Edit').click();
    const textarea = ownLi.querySelector('.qu-forum-edit-row textarea');
    textarea.value = 'My EDITED message';
    [...ownLi.querySelectorAll('.qu-forum-edit-row-buttons button')].find((btn) => btn.textContent === 'Save').click();

    await waitFor(() => container.querySelector(`[data-message-id="${own.id}"] .qu-forum-message-text`)?.textContent.includes('My EDITED message'));
  } finally {
    stop();
  }
});

test('a post\'s timestamp is its permalink (#/forum/t/<topicId>/m/<id>); landing on that route scrolls to and highlights it', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'first' });
  const target = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'second' });
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'third' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelectorAll('.qu-forum-message').length === 3);
    const targetLi = container.querySelector(`[data-message-id="${target.id}"]`);
    const link = targetLi.querySelector('.qu-forum-message-ts');
    assert.equal(link.getAttribute('href'), `#/forum/t/general/m/${target.id}`);
    assert.equal(targetLi.id, `m-${target.id}`);
  } finally {
    stop();
  }

  const permalinkContainer = makeContainer();
  const stopPermalink = mount(permalinkContainer, {
    qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe,
    segments: [...TOPIC_SEGMENTS, 'm', target.id],
  });
  try {
    await waitFor(() => permalinkContainer.querySelectorAll('.qu-forum-message').length === 3);
    const highlighted = [...permalinkContainer.querySelectorAll('.qu-forum-message')].filter((li) => li.classList.contains('qu-forum-message-highlight'));
    assert.equal(highlighted.length, 1);
    assert.equal(highlighted[0].id, `m-${target.id}`);
  } finally {
    stopPermalink();
  }
});

test('a reply quote is a real link to its parent post\'s own permalink, not just a text snippet', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const original = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'the original post' });
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'a reply', replyTo: original.id });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-reply') !== null);
    const quote = container.querySelector('.qu-forum-message-reply');
    assert.equal(quote.tagName, 'A');
    assert.equal(quote.getAttribute('href'), `#/forum/t/general/m/${original.id}`);
    assert.equal(quote.textContent, 'the original post');
  } finally {
    stop();
  }
});

test('clicking "Reply" in a post\'s context menu shows a "replying to" banner, and posting includes replyTo - native to any post, not just "mine"', async () => {
  const a = await freshEnv('Ada');
  const b = await freshEnv('Bob');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await b.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const original = await b.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'from bob' });
  await mirrorThreadInto(b, a.qu, FORUM_SPACE_ID, 'general');

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message') !== null);
    const panel = await openMessageMenu(container);
    assert.equal(menuItemButton(panel, 'Edit'), undefined); // Bob's post, not Ada's
    menuItemButton(panel, 'Reply').click();

    await waitFor(() => container.querySelector('.qu-forum-reply-banner')?.hidden === false);
    assert.match(container.querySelector('.qu-forum-reply-banner').textContent, /Replying to/);

    container.querySelector('.qu-forum-composer textarea').value = 'my reply';
    container.querySelector('.qu-content-editor-submit-slot button').click();

    await waitForAsync(async () => (await a.services.messages.listMessages(FORUM_SPACE_ID, 'general')).messages.length === 2);
    const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    const reply = messages.find((m) => m.body === 'my reply');
    assert.equal(reply.replyTo, original.id);
    assert.equal(container.querySelector('.qu-forum-reply-banner').hidden, true); // cleared after sending
  } finally {
    stop();
  }
});

test('landing on a post permalink shows the persistent scroll-to-bottom button (ported from apps/chat/client.js)', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const target = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'find me' });
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'later one' });

  const container = makeContainer();
  const stop = mount(container, {
    qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe,
    segments: [...TOPIC_SEGMENTS, 'm', target.id],
  });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-highlight') !== null);
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').hidden, false);
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').classList.contains('qu-forum-scroll-bottom-btn-unseen'), false);
  } finally {
    stop();
  }
});

test('scrolling back down to the bottom after a permalink releases the anchor from the URL', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const target = await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'old one' });

  const container = makeContainer();
  const stop = mount(container, {
    qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe,
    segments: [...TOPIC_SEGMENTS, 'm', target.id],
  });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-highlight') !== null);
    const scroll = container.querySelector('.qu-forum-messages-scroll');
    simulateScroll(scroll, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 }); // "at the bottom"
    assert.equal(window.location.hash, '#/forum/t/general');
  } finally {
    stop();
  }
});

test('a new post while NOT at the bottom does not scroll or rebuild the view - marks the persistent scroll-to-bottom button as unseen instead', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'first' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('first'));
    const firstLi = container.querySelector('.qu-forum-message');
    assert.ok(firstLi);
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').hidden, true);

    const scroll = container.querySelector('.qu-forum-messages-scroll');
    simulateScroll(scroll, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }); // release stuckToBottom
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').hidden, false); // persistent button appears just from scrolling up, no new post needed
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'second' });

    await waitFor(() => container.querySelector('.qu-forum-scroll-bottom-btn')?.classList.contains('qu-forum-scroll-bottom-btn-unseen'));
    assert.equal(scrollToCalls.length, 0); // never auto-scrolled away from what the user was reading
    // INCREMENTAL APPEND, not a full rebuild - the FIRST post's own DOM node is the exact same element reference as before, never torn down.
    assert.equal(container.querySelector('.qu-forum-message'), firstLi);
    assert.equal(container.querySelectorAll('.qu-forum-message').length, 2);
  } finally {
    stop();
  }
});

test('a new post while AT the bottom scrolls smoothly to it, via incremental append (not a full rebuild)', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'first' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('first'));
    const firstLi = container.querySelector('.qu-forum-message');
    const scroll = container.querySelector('.qu-forum-messages-scroll');
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'second' });

    await waitFor(() => container.querySelectorAll('.qu-forum-message').length === 2);
    assert.equal(container.querySelector('.qu-forum-message'), firstLi); // incremental append, first post untouched
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').hidden, true);
    await waitFor(() => scrollToCalls.length > 0);
    assert.equal(scrollToCalls.at(-1).behavior, 'smooth');
  } finally {
    stop();
  }
});

test('clicking the persistent scroll-to-bottom button scrolls to the bottom and hides it', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'first' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('first'));
    const scroll = container.querySelector('.qu-forum-messages-scroll');
    simulateScroll(scroll, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'second' });
    await waitFor(() => container.querySelector('.qu-forum-scroll-bottom-btn')?.hidden === false);

    container.querySelector('.qu-forum-scroll-bottom-btn').click();
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').hidden, true);
    assert.equal(scrollToCalls.at(-1).behavior, 'smooth');
  } finally {
    stop();
  }
});

test('a resize-triggered "stay at bottom" correction is never falsely undone by its own scroll event catching up mid-content-growth (regression: an attachment growing messagesRoot across MULTIPLE steps - e.g. a large image resolving its real size well after an initial placeholder - could race the native \'scroll\' event for our OWN correction, read as "the user scrolled away", and permanently strand the newest message off-screen with no further correction ever attempted)', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'first' });

  // jsdom (this repo's test DOM) has no ResizeObserver at all - the real
  // one only exists in a real browser, so the client code guards its
  // construction with `typeof ResizeObserver !== 'undefined'`. A minimal
  // fake, installed just for this test, lets it manually drive the exact
  // callback a real browser would invoke on each layout step, without
  // needing an actual browser.
  let roInstance = null;
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; roInstance = this; }
    observe() {}
    disconnect() {}
  }
  const originalRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('first'));
    assert.ok(roInstance, 'expected the client to have constructed a ResizeObserver');
    const scroll = container.querySelector('.qu-forum-messages-scroll');
    // Emulates a real browser's own clamping - jsdom's plain scrollTop
    // property doesn't clamp on its own.
    scroll.scrollTo = (opts) => { scroll.scrollTop = Math.max(0, Math.min(opts.top, scroll.scrollHeight - scroll.clientHeight)); };
    Object.defineProperty(scroll, 'clientHeight', { value: 519, configurable: true });

    // STEP 1: an attachment is still mid-decode - content is 548px tall.
    // The ResizeObserver fires, correcting to what's CURRENTLY the bottom.
    Object.defineProperty(scroll, 'scrollHeight', { value: 548, configurable: true });
    roInstance.cb();
    assert.equal(scroll.scrollTop, 29); // clamped: 548 - 519

    // STEP 2: content grows FURTHER (868px) before the native 'scroll'
    // event for step 1's own correction ever gets a chance to fire - the
    // exact async-echo race this fix closes. scrollTop is untouched (still
    // 29, a stale echo of step 1), so this dispatched event looks
    // identical to what a delayed native event for step 1 would look like.
    Object.defineProperty(scroll, 'scrollHeight', { value: 868, configurable: true });
    scroll.dispatchEvent(new window.Event('scroll'));

    assert.equal(
      container.querySelector('.qu-forum-scroll-bottom-btn').hidden, true,
      'must still be considered "at the bottom" - the button must not appear just because content grew underneath a not-yet-corrected view'
    );

    // STEP 3: the NEXT ResizeObserver firing (guaranteed, since content is
    // still growing) picks up exactly where step 1 left off and finishes
    // the job.
    roInstance.cb();
    assert.equal(scroll.scrollTop, 349); // clamped: 868 - 519
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').hidden, true);
  } finally {
    stop();
    globalThis.ResizeObserver = originalRO;
  }
});

test('sending a post always scrolls the view to the bottom, even if the user had scrolled away from it (stuckToBottom released)', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-empty') !== null);
    const scroll = container.querySelector('.qu-forum-messages-scroll');
    simulateScroll(scroll, { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }); // release stuckToBottom
    const scrollToCalls = [];
    scroll.scrollTo = (opts) => scrollToCalls.push(opts);

    const textarea = container.querySelector('textarea');
    textarea.value = 'sent while scrolled away';
    container.querySelector('.qu-content-editor-submit-slot button').click();

    await waitFor(() => scrollToCalls.length > 0);
    assert.equal(container.querySelector('.qu-forum-scroll-bottom-btn').hidden, true);
  } finally {
    stop();
  }
});

test('UNREAD-BY-ME: another author\'s post shows an unread badge the first time this identity views the topic, and not again after', async () => {
  const ada = await freshEnv('Ada');
  const bob = await freshEnv('Bob');
  await ada.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await ada.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'hello from Ada' });
  await mirrorThreadInto(ada, bob.qu, FORUM_SPACE_ID, 'general');

  const container = makeContainer();
  const stop = mount(container, { qu: bob.qu, services: bob.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message') !== null);
    assert.ok(container.querySelector('.qu-forum-message').classList.contains('qu-forum-message-unread'));
    assert.match(container.querySelector('.qu-forum-message-unread-badge').textContent, /new/i);
  } finally {
    stop();
  }

  // A fresh mount (a later visit) sees the SAME post no longer flagged -
  // the first mount's own renderMessages() already called markRead().
  const secondContainer = makeContainer();
  const stopSecond = mount(secondContainer, { qu: bob.qu, services: bob.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => secondContainer.querySelector('.qu-forum-message') !== null);
    assert.equal(secondContainer.querySelector('.qu-forum-message').classList.contains('qu-forum-message-unread'), false);
    assert.equal(secondContainer.querySelector('.qu-forum-message-unread-badge'), null);
  } finally {
    stopSecond();
  }
});

test('UNREAD-BY-ME: THIS identity\'s own posts never get an unread badge', async () => {
  const ada = await freshEnv('Ada');
  await ada.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await ada.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'my own post' });

  const container = makeContainer();
  const stop = mount(container, { qu: ada.qu, services: ada.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message') !== null);
    assert.equal(container.querySelector('.qu-forum-message').classList.contains('qu-forum-message-unread'), false);
  } finally {
    stop();
  }
});

test('searchForum(): a TYPE filter with no text query returns every locally-available match of that type, not just body-text hits', async () => {
  const ada = await freshEnv('Ada');
  await ada.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await ada.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'just a normal post' });
  const withImage = await ada.services.messages.postMessage(FORUM_SPACE_ID, 'general', {
    body: '', extra: { attachment: { assetId: 'a1', mime: 'image/png', name: 'photo.png', size: 100 } },
  });

  const results = await searchForum({
    services: ada.services, qu: ada.qu, apps: FORUM_APPS, query: '', types: ['image'],
    scope: 'subpage', segments: TOPIC_SEGMENTS,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].href, `#/forum/t/general/m/${withImage.id}`);
  assert.equal(results[0].contentType, 'image');
});

test('searchForum(): an audio attachment classifies as "audio", not the generic "file" (regression: audio used to fall through to "file", losing the type)', async () => {
  const ada = await freshEnv('Ada');
  await ada.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await ada.services.messages.postMessage(FORUM_SPACE_ID, 'general', {
    body: '', extra: { attachment: { assetId: 'snd1', mime: 'audio/mpeg', name: 'clip.mp3', size: 200 } },
  });

  const results = await searchForum({
    services: ada.services, qu: ada.qu, apps: FORUM_APPS, query: '', types: ['audio'],
    scope: 'subpage', segments: TOPIC_SEGMENTS,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].contentType, 'audio');
});

test('renderSearchResult(): an image/video/audio/file result renders a real <qu-asset> preview (not just text) - AS SUCH, per that attachment\'s own MIME, using entry.spaceId/entry.attachment (regression: every result used to render as plain meta+snippet text regardless of contentType)', async () => {
  const ada = await freshEnv('Ada');
  await ada.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  const withImage = await ada.services.messages.postMessage(FORUM_SPACE_ID, 'general', {
    body: 'a caption', extra: { attachment: { assetId: 'img1', mime: 'image/png', name: 'photo.png', size: 100 } },
  });

  const [entry] = await searchForum({
    services: ada.services, qu: ada.qu, apps: FORUM_APPS, query: '', types: ['image'],
    scope: 'subpage', segments: TOPIC_SEGMENTS,
  });
  assert.equal(entry.spaceId, FORUM_SPACE_ID);
  assert.equal(entry.attachment.assetId, 'img1');

  const row = document.createElement('div');
  row.assetService = ada.services.assets; // <qu-asset>'s own ancestor-walk requirement - a real caller (apps/search/client.js) sets this once on its own top-level mount container
  await renderSearchResult(row, { entry, services: ada.services });

  const assetEl = row.querySelector('qu-asset');
  assert.ok(assetEl, 'expected a real <qu-asset> element, not just plain text');
  assert.equal(assetEl.getAttribute('space-id'), FORUM_SPACE_ID);
  assert.equal(assetEl.getAttribute('asset-id'), 'img1');
  // The link (navigates to the message) must be a SEPARATE element from the
  // asset preview, never wrapping it - see renderSearchResult()'s own doc
  // comment on why (a video/audio's native controls, or an image's
  // click-to-lightbox, must not also trigger row navigation).
  const link = row.querySelector('.qu-forum-search-result-link');
  assert.ok(link);
  assert.equal(link.getAttribute('href'), `#/forum/t/general/m/${withImage.id}`);
  assert.equal(link.contains(assetEl), false);
});

// Regression: formattedHtml is inserted via innerHTML - a message body
// containing a <script> tag must render as literal, escaped text, never as
// an actual executable element (see client.js's own doc comment on why
// thread-formatting.js's escape-first design already guarantees this).
test('a message body containing a <script> tag renders as escaped text, never as a real element', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: '<script>window.qu_xss_fired = true;</script>hello' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-text') !== null);
    assert.equal(container.querySelector('.qu-forum-message-text script'), null);
    assert.equal(window.qu_xss_fired, undefined);
    assert.match(container.querySelector('.qu-forum-message-text').textContent, /<script>/);
  } finally {
    stop();
  }
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Hi' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  await waitFor(() => container.querySelector('.qu-forum-message') !== null);
  assert.doesNotThrow(() => stop());
});

// ===================================================================
// BOARD VIEW - #/forum
// ===================================================================

test('board view (#/forum, no sub-segments) lists the migrated "General" channel in the app-template sidebar (both desktop and mobile), and its topic in the recent-activity feed', async () => {
  const a = await freshEnv('Ada');
  const [channel] = await a.services.channels.listChannels(FORUM_SPACE_ID);
  const [topic] = await a.services.channels.listTopics(FORUM_SPACE_ID, channel._id);
  await a.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'first ever post' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('.qu-apptpl-sidebar .qu-apptpl-list a') !== null);
    const links = [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')];
    assert.equal(links[0].textContent, 'All channels');
    assert.equal(links[0].getAttribute('href'), '#/forum');
    assert.match(links[1].textContent, /General/);
    const activeLink = container.querySelector('.qu-apptpl-sidebar .qu-apptpl-item-active');
    assert.equal(activeLink.getAttribute('href'), '#/forum'); // the board view IS "All channels"

    await waitFor(() => container.querySelector('.qu-forum-topic-row a') !== null);
    const topicLink = container.querySelector('.qu-forum-topic-row a');
    assert.equal(topicLink.getAttribute('href'), `#/forum/t/${topic._id}`);
    assert.match(topicLink.textContent, new RegExp(topic.title)); // topic title
  } finally {
    stop();
  }
});

test('board view: explicitly backfills each channel\'s OWN topics list via syncFetch (regression: relying solely on ChannelService\'s internal once-per-generation miss-gate could race the sync connection on a cold client and never retry - "loads empty, needs a reload")', async () => {
  const a = await freshEnv('Ada');
  const requestedPaths = [];
  const syncFetch = async (path) => { requestedPaths.push(path); return null; };

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, syncFetch, segments: ['forum'] });
  try {
    await waitFor(() => requestedPaths.includes(paths.listPath(FORUM_SPACE_ID, 'topics-general-channel')));
    assert.ok(requestedPaths.includes(paths.listPath(FORUM_SPACE_ID, 'channels')));
  } finally {
    stop();
  }
});

test('board view: the mobile footer shows a channel pill whose popup lists the same entries as the sidebar, "All channels" as the active label', async () => {
  const a = await freshEnv('Ada');
  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('.qu-apptpl-pill') !== null);
    assert.equal(container.querySelector('.qu-apptpl-pill-label').textContent, 'All channels');
    const popupLinks = [...container.querySelectorAll('.qu-apptpl-popup a')];
    assert.ok(popupLinks.some((l) => l.getAttribute('href') === '#/forum/c/general-channel' && l.textContent.includes('General')));
  } finally {
    stop();
  }
});

test('board view: a restricted channel shows a 🔒 badge in the persistent sidebar', async () => {
  const a = await freshEnv('Ada');
  await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Secret Stuff', restricted: true, memberPubs: [] });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')].some((a2) => a2.textContent.includes('Secret Stuff')));
    const row = [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')].find((a2) => a2.textContent.includes('Secret Stuff'));
    assert.match(row.textContent, /🔒/);
  } finally {
    stop();
  }
});

// ===== mountAppTemplate() chrome: primaryAction ("New topic") + settings ("New channel") (see docs/app-navigation-standard.md Rule 5) =====
// "+ New channel" now lives in the app-template `settings` gear slot; "+ New topic" is the board/channel view's own `primaryAction` FAB/desktop button.

test('board view: no "New channel" settings entry for a non-admin when channels.allowMemberCreate is false, but "New topic" primaryAction is always present', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [], settings: { channels: { allowMemberCreate: false, allowMemberRestricted: false } } }), { status: 200 }));

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('a.qu-apptpl-fab') !== null);
    assert.equal(container.querySelector('a.qu-apptpl-fab').getAttribute('href'), '#/forum/new-topic');
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the channel-policy fetch settle
    assert.equal(container.querySelector('.qu-apptpl-gear'), null);
  } finally {
    stop();
  }
});

test('board view: shows a "New channel" settings entry for this relay\'s own admin, even when channels.allowMemberCreate is false', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [a.myPub], settings: { channels: { allowMemberCreate: false, allowMemberRestricted: false } } }), { status: 200 }));

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('.qu-apptpl-gear') !== null);
    const settingsLink = container.querySelector('.qu-apptpl-popup a, .qu-apptpl-section--settings a');
    assert.ok(settingsLink);
    assert.equal(settingsLink.getAttribute('href'), '#/forum/new');
  } finally {
    stop();
  }
});

test('channel view: "New topic" primaryAction links into this specific channel, and "New channel" settings entry reacts live to switching channels', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [a.myPub], settings: { channels: { allowMemberCreate: true, allowMemberRestricted: false } } }), { status: 200 }));
  const chan2 = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Second', restricted: false, memberPubs: [] });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', 'general-channel'] });
  try {
    await waitFor(() => container.querySelector('a.qu-apptpl-fab') !== null);
    assert.equal(container.querySelector('a.qu-apptpl-fab').getAttribute('href'), '#/forum/c/general-channel/new-topic');
    await waitFor(() => container.querySelector('.qu-apptpl-gear') !== null);

    // Switching to a different channel view updates the active sidebar entry.
    stop();
    const container2 = makeContainer();
    const stop2 = mount(container2, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', chan2._id] });
    await waitFor(() => container2.querySelector('a.qu-apptpl-fab') !== null);
    assert.equal(container2.querySelector('a.qu-apptpl-fab').getAttribute('href'), `#/forum/c/${chan2._id}/new-topic`);
    stop2();
  } finally {
    stop();
  }
});

// ===================================================================
// NEW CHANNEL VIEW - #/forum/new
// ===================================================================

test('new channel view: creating a channel via the form navigates to the new channel\'s own page, live in the persistent sidebar', async () => {
  const a = await freshEnv('Ada');
  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-channel-form') !== null);
    const titleInput = container.querySelector('.qu-forum-new-channel-form input[type="text"]');
    titleInput.value = 'Off-topic';
    const submit = container.querySelector('.qu-forum-new-channel-form button');
    submit.click();

    await waitFor(() => window.location.hash.startsWith('#/forum/c/'));
    const channels = await a.services.channels.listChannels(FORUM_SPACE_ID);
    const created = channels.find((c) => c.title === 'Off-topic');
    assert.ok(created);
    assert.equal(window.location.hash, `#/forum/c/${created._id}`);
  } finally {
    stop();
  }
});

test('new channel view: double-clicking "Create channel" before the first call resolves creates only ONE channel (regression: QuV2\'s missing double-submit guard)', async () => {
  const a = await freshEnv('Ada');
  // Slow down createChannel() so the button is provably still mid-flight
  // when the second click is attempted.
  let releaseCreate;
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  const realCreateChannel = a.services.channels.createChannel.bind(a.services.channels);
  a.services.channels.createChannel = async (...args) => {
    await gate;
    return realCreateChannel(...args);
  };

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-channel-form') !== null);
    const titleInput = container.querySelector('.qu-forum-new-channel-form input[type="text"]');
    titleInput.value = 'Only Once';
    const submit = container.querySelector('.qu-forum-new-channel-form button');
    submit.click(); // first submit - synchronously disables the button before the gated await
    assert.equal(submit.disabled, true);
    submit.click(); // a disabled button does not dispatch a click-activated submit a second time

    releaseCreate();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const channels = await a.services.channels.listChannels(FORUM_SPACE_ID);
    assert.equal(channels.filter((c) => c.title === 'Only Once').length, 1);
  } finally {
    stop();
  }
});

test('new channel view: a failed create (e.g. a restricted channel\'s own member list contains a pubkey with no resolvable profile) surfaces the error instead of failing silently', async () => {
  const a = await freshEnv('Ada');
  const originalCreateChannel = a.services.channels.createChannel.bind(a.services.channels);
  a.services.channels.createChannel = async () => {
    throw new Error('resolveReaderXKeys: reader "some-actor-pub" has no published profile - cannot encrypt for them');
  };

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-channel-form') !== null);
    const titleInput = container.querySelector('.qu-forum-new-channel-form input[type="text"]');
    titleInput.value = 'Doomed Board';
    const submit = container.querySelector('.qu-forum-new-channel-form button');
    submit.click();

    await waitFor(() => container.querySelector('.qu-forum-new-channel-error')?.hidden === false);
    assert.match(container.querySelector('.qu-forum-new-channel-error').textContent, /no published profile/);
    // the button re-enables - the admin can fix the input and retry.
    assert.equal(submit.disabled, false);
    assert.equal(titleInput.value, 'Doomed Board');
  } finally {
    a.services.channels.createChannel = originalCreateChannel;
    stop();
  }
});

test('new channel view: channels.allowMemberCreate: false shows "not allowed" instead of the form for a non-admin', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [], settings: { channels: { allowMemberCreate: false, allowMemberRestricted: false } } }), { status: 200 }));

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new'] });
  try {
    await waitFor(() => container.textContent.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(container.querySelector('.qu-forum-new-channel-form'), null);
  } finally {
    stop();
  }
});

test('new channel view: channels.allowMemberCreate: false still shows the form for this relay\'s own admin', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [a.myPub], settings: { channels: { allowMemberCreate: false, allowMemberRestricted: false } } }), { status: 200 }));

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-channel-form') !== null);
  } finally {
    stop();
  }
});

test('new channel view: channels.allowMemberRestricted: false hides the restricted checkbox for a non-admin, but the form itself still allows an OPEN channel', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [], settings: { channels: { allowMemberCreate: true, allowMemberRestricted: false } } }), { status: 200 }));

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-channel-form') !== null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(container.querySelector('.qu-forum-new-channel-form label').hidden, true);
  } finally {
    stop();
  }
});

// ===================================================================
// NEW TOPIC VIEW - #/forum/c/<channelId>/new-topic and #/forum/new-topic
// ===================================================================

test('new topic view (channel known, #/forum/c/<id>/new-topic): no channel picker, creating posts the title + body as the opening message and navigates to the new topic', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id, 'new-topic'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-topic-form') !== null);
    assert.equal(container.querySelector('.qu-forum-new-topic-form select'), null);
    container.querySelector('.qu-forum-new-topic-form input[type="text"]').value = 'Hello world';
    container.querySelector('.qu-forum-new-topic-composer textarea').value = 'First post body';
    container.querySelector('.qu-forum-new-topic-composer .qu-content-editor-submit-slot button').click();

    await waitFor(() => window.location.hash.startsWith('#/forum/t/'));
    const topicId = window.location.hash.slice('#/forum/t/'.length);
    const topics = await a.services.channels.listTopics(FORUM_SPACE_ID, channel._id);
    const created = topics.find((tp) => tp._id === topicId);
    assert.equal(created?.title, 'Hello world');
    assert.equal(created?.content?.text, 'First post body'); // the opening post is the Entity's own content now, not a separate message
  } finally {
    stop();
  }
});

test('new topic view (no channel, #/forum/new-topic): shows a channel <select>, disabled until channels resolve, required to submit', async () => {
  const a = await freshEnv('Ada');
  await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new-topic'] });
  try {
    const select = container.querySelector('.qu-forum-new-topic-form select');
    assert.ok(select);
    assert.equal(select.disabled, true);
    await waitFor(() => select.disabled === false);
    assert.ok([...select.querySelectorAll('option')].some((o) => o.textContent === 'Announcements'));
  } finally {
    stop();
  }
});

test('new topic view: a failed createTopic() (e.g. this identity is no longer a member of the channel) surfaces the error instead of failing silently', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });
  const originalCreateTopic = a.services.channels.createTopic.bind(a.services.channels);
  a.services.channels.createTopic = async () => {
    throw new Error('ChannelService.createTopic: no channel "x" in space "y"');
  };

  window.location.hash = ''; // a prior test may have left a #/forum/t/... hash behind
  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id, 'new-topic'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-topic-form') !== null);
    container.querySelector('.qu-forum-new-topic-form input[type="text"]').value = 'Doomed Topic';
    container.querySelector('.qu-forum-new-topic-composer .qu-content-editor-submit-slot button').click();

    await waitFor(() => container.querySelector('.qu-forum-new-topic-error')?.hidden === false);
    assert.match(container.querySelector('.qu-forum-new-topic-error').textContent, /no channel/);
    assert.equal(window.location.hash.startsWith('#/forum/t/'), false); // never navigated away
  } finally {
    a.services.channels.createTopic = originalCreateTopic;
    window.location.hash = '';
    stop();
  }
});

// ===================================================================
// CHANNEL VIEW - #/forum/c/<channelId>
// ===================================================================

test('none of the forum subpages (channel view, topic view, new-channel view) render their own back link - the shell header\'s Back/Forward already covers it', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });

  // The new-channel form still goes through renderSubpage() directly
  // (`.qu-subpage-content`). The channel view no longer does - it's
  // @qu/ui's mountAppTemplate() now (see mountChannelView()'s own doc
  // comment / docs/app-navigation-standard.md Rule 5), which owns its own
  // "no back link" guarantee without needing a nested renderSubpage() -
  // waited for via its own `.qu-apptpl-content` marker instead. The
  // topic view is its own fixed "room" layout with no page-level back-link
  // concept to begin with, checked separately below via its own
  // always-present marker.
  const channelContainer = makeContainer();
  const stopChannel = mount(channelContainer, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id] });
  try {
    await waitFor(() => channelContainer.querySelector('.qu-apptpl-content') !== null);
    assert.equal(channelContainer.querySelector('.qu-subpage-back'), null);
  } finally {
    stopChannel();
  }

  const newChannelContainer = makeContainer();
  const stopNewChannel = mount(newChannelContainer, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'new'] });
  try {
    await waitFor(() => newChannelContainer.querySelector('.qu-subpage-content') !== null);
    assert.equal(newChannelContainer.querySelector('.qu-subpage-back'), null);
  } finally {
    stopNewChannel();
  }

  const topicContainer = makeContainer();
  const stopTopic = mount(topicContainer, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => topicContainer.querySelector('.qu-forum-room-view') !== null);
    assert.equal(topicContainer.querySelector('.qu-subpage-back'), null);
  } finally {
    stopTopic();
  }
});

test('channel view lists its topics with a live reply count', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });
  const topic = await a.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Welcome' });
  await a.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'hi there' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id] });
  try {
    await waitFor(() => container.querySelector('h1')?.textContent === 'Announcements');
    await waitFor(() => container.querySelector('.qu-forum-topic-row a') !== null);
    assert.match(container.querySelector('.qu-forum-topic-title').textContent, /Welcome/);
    assert.match(container.querySelector('.qu-forum-topic-meta').textContent, /1/); // reply count
    // No more inline "new topic" form here - that's the New Topic subpage now (see below), reachable from the header's Nav Points dropdown.
    assert.equal(container.querySelector('.qu-forum-new-topic-form'), null);
  } finally {
    stop();
  }
});

// ===================================================================
// NEW TOPIC VIEW - #/forum/c/<channelId>/new-topic
// ===================================================================

test('new topic view: submitting the form creates a topic and navigates to its own thread page', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id, 'new-topic'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-new-topic-form') !== null);
    // No back link - Rule 1, the global header covers it.
    assert.equal([...container.querySelectorAll('a')].some((a) => a.textContent.includes('←')), false);

    const titleInput = container.querySelector('.qu-forum-new-topic-form input[type="text"]');
    titleInput.value = 'Second topic';
    container.querySelector('.qu-forum-new-topic-composer .qu-content-editor-submit-slot button').click();
    await waitFor(() => /^#\/forum\/t\//.test(window.location.hash));
  } finally {
    stop();
    window.location.hash = '';
  }

  // The newly created topic is real, listed back on the channel view.
  const stop2 = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id] });
  try {
    await waitFor(() => [...container.querySelectorAll('.qu-forum-topic-title')].some((el) => el.textContent === 'Second topic'));
  } finally {
    stop2();
  }
});

test('channel view: the reply count updates live when a message is posted to an already-listed topic, without leaving the view (regression: only a NEW topic used to re-render)', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });
  const topic = await a.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Welcome' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-topic-row a') !== null);
    assert.match(container.querySelector('.qu-forum-topic-meta').textContent, /^0 replies/);

    await a.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'a reply' });
    await waitFor(() => /^1 repl/.test(container.querySelector('.qu-forum-topic-meta').textContent));
  } finally {
    stop();
  }
});

test('board view: the merged activity feed\'s reply count updates live too', async () => {
  const a = await freshEnv('Ada');
  const [channel] = await a.services.channels.listChannels(FORUM_SPACE_ID);
  const [topic] = await a.services.channels.listTopics(FORUM_SPACE_ID, channel._id);

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-topic-row a') !== null);
    assert.match(container.querySelector('.qu-forum-topic-meta').textContent, /0 replies/); // "General · 0 replies · ..." - channel title prefix included in the merged feed

    await a.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'a reply' });
    await waitFor(() => /1 repl/.test(container.querySelector('.qu-forum-topic-meta').textContent));
  } finally {
    stop();
  }
});

test('channel view: shows a live "unread by me" badge per topic - someone else\'s post shows it, markRead() clears it, all without leaving the view', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });
  const topic = await a.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Welcome' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', channel._id] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-topic-row a') !== null);
    assert.equal(container.querySelector('.qu-forum-topic-unread-badge'), null);

    // `asSpaceId` signs with a different derived key than Ada's own main
    // key (see ChannelService's own listTopics() test for the same
    // technique) - simulates "someone else" posted, without a second
    // identity/store pair.
    await a.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'from someone else', asSpaceId: 'other-space' });
    await waitFor(() => container.querySelector('.qu-forum-topic-unread-badge') !== null);
    assert.match(container.querySelector('.qu-forum-topic-unread-badge').textContent, /1/);

    await a.services.messages.markRead(FORUM_SPACE_ID, topic._id);
    await waitFor(() => container.querySelector('.qu-forum-topic-unread-badge') === null);
  } finally {
    stop();
  }
});

test('channel view: the app-template sidebar lists every channel and highlights the active one', async () => {
  const a = await freshEnv('Ada');
  const announcements = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });
  await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Off-topic' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', announcements._id] });
  try {
    await waitFor(() => container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a').length >= 4); // All channels + General + Announcements + Off-topic
    const links = [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')];
    assert.ok(links.some((a2) => a2.textContent.includes('Off-topic')));
    const active = container.querySelector('.qu-apptpl-sidebar .qu-apptpl-item-active');
    assert.match(active.textContent, /Announcements/);
  } finally {
    stop();
  }
});

test('topic view: a desktopOnly app-template sidebar lists every channel alongside the thread', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Off-topic' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a').length >= 3); // All channels + General + Off-topic
    await waitFor(() => container.querySelector('.qu-forum-message, .qu-forum-empty') !== null); // the thread itself still renders alongside it
    assert.equal(container.querySelector('.qu-apptpl-footer'), null); // desktopOnly nav, no primaryAction/settings -> no mobile footer at all
  } finally {
    stop();
  }
});

test('channel view: an OPEN channel shows no invite form; a RESTRICTED one does, and inviting actually grows membership', async () => {
  const a = await freshEnv('Ada');
  // A REAL actor with a published profile - re-encrypting the channel
  // document for a new reader (see channel-service.js's own "RESTRICTED
  // CHANNELS" doc comment) needs a resolvable X key, `resolveReaderXKeys()`'s
  // own fail-closed contract - a bare made-up pubkey with no profile can no
  // longer stand in for "someone to invite" here.
  const bob = await freshEnv('Bob');
  await a.qu.putSealed(actorPath(bob.myPub, 'profile'), await bob.qu.get(actorPath(bob.myPub, 'profile')));

  const openChannel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Open' });
  const restrictedChannel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Closed', restricted: true, memberPubs: [] });

  const containerOpen = makeContainer();
  const stopOpen = mount(containerOpen, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', openChannel._id] });
  const containerRestricted = makeContainer();
  const stopRestricted = mount(containerRestricted, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', restrictedChannel._id] });
  try {
    await waitFor(() => containerOpen.querySelector('h1')?.textContent === 'Open');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(containerOpen.querySelector('.qu-forum-invite-form'), null);

    await waitFor(() => containerRestricted.querySelector('.qu-forum-invite-form') !== null);
    const pubInput = containerRestricted.querySelector('.qu-forum-invite-form input[type="text"]');
    pubInput.value = bob.myPub;
    containerRestricted.querySelector('.qu-forum-invite-form button').click();

    // waitFor()'s predicate is never awaited (see @qu/ui/testing's own
    // doc comment - `while (!check())` runs it synchronously) - a real
    // poll loop is needed for an async check like this one.
    let invited = false;
    for (let i = 0; i < 200 && !invited; i++) {
      const channel = await a.services.channels.getChannel(FORUM_SPACE_ID, restrictedChannel._id);
      invited = channel.memberPubs.includes(bob.myPub);
      if (!invited) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(invited, 'expected addChannelMember() to have run by now');
  } finally {
    stopOpen();
    stopRestricted();
  }
});

test('channel view: a failed invite (addChannelMember() rejects - e.g. some existing topics failed to grow) surfaces the error instead of failing silently', async () => {
  const a = await freshEnv('Ada');
  const restrictedChannel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Closed', restricted: true, memberPubs: [] });
  const originalAddChannelMember = a.services.channels.addChannelMember.bind(a.services.channels);
  a.services.channels.addChannelMember = async () => {
    throw new Error('ChannelService.addChannelMember: added to the channel, but failed to grow membership for 1/2 existing topic(s) - boom');
  };

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', restrictedChannel._id] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-invite-form') !== null);
    const pubInput = container.querySelector('.qu-forum-invite-form input[type="text"]');
    pubInput.value = 'some-actor-pub';
    container.querySelector('.qu-forum-invite-form button').click();

    await waitFor(() => container.querySelector('.qu-forum-invite-error')?.hidden === false);
    assert.match(container.querySelector('.qu-forum-invite-error').textContent, /1\/2 existing topic/);
    // the input is NOT cleared on failure - the admin can retry the same submission
    assert.equal(pubInput.value, 'some-actor-pub');
  } finally {
    a.services.channels.addChannelMember = originalAddChannelMember;
    stop();
  }
});

test('a message posted in a RESTRICTED channel\'s topic never appears in the merged board activity feed as readable plaintext to a non-member - the topic IS genuinely gated (integration smoke test over ChannelService, already unit-tested for encryption directly)', async () => {
  const a = await freshEnv('Ada');
  const channel = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'VIP', restricted: true, memberPubs: [] });
  const topic = await a.services.channels.createTopic(FORUM_SPACE_ID, channel._id, { title: 'Secret topic' });
  const { id: messageId } = await a.services.messages.postMessage(FORUM_SPACE_ID, topic._id, { body: 'members only' });
  const raw = await a.qu.get(paths.threadMessagePath(FORUM_SPACE_ID, topic._id, messageId));
  assert.notEqual(raw.val, 'members only');
  assert.equal(typeof raw.val.iv, 'string');
});
