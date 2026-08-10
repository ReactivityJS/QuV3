import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, AssetEngine, CollectionEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import {
  ListService, AccessService, MessageService, ReactionService, PinService, ChannelService,
  ActorService, ProfileService, DirectoryService, ContactsService, AssetService, FlagService, BookmarksService, THREAD_PRESETS, paths,
} from '@qu/services';
import { ExtensionPointHost, Registry } from '@qu/foundation';
import { installDom, waitFor } from '@qu/ui/testing';
import { register as registerForum } from '../index.js';

installDom();
const { mount } = await import('../client.js');

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
async function freshEnv(alias) {
  const qu = createQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
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
    channels: new ChannelService(qu, identity, list, access, messages),
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
// content.messageActions contribution end to end against actual production
// code, the same way `ExtensionPointHost` would dynamically import it from
// a real apps catalog's `clientMainUrl`.
const BOOKMARKS_CLIENT_URL = new URL('../../bookmarks/client.js', import.meta.url).href;
const FORUM_APPS_WITH_BOOKMARKS = [
  { name: 'forum', spaceId: FORUM_SPACE_ID },
  { name: 'bookmarks', clientMainUrl: BOOKMARKS_CLIENT_URL, contributes: [{ point: 'content.messageActions', export: 'renderBookmarkToggle' }] },
];

// Same "the REAL app, not a fake" reasoning as FORUM_APPS_WITH_BOOKMARKS -
// apps/reactions and apps/pins are admin-toggleable plugins now, reached
// only through the extension points forum's own manifest.quapp defines.
const REACTIONS_CLIENT_URL = new URL('../../reactions/client.js', import.meta.url).href;
const PINS_CLIENT_URL = new URL('../../pins/client.js', import.meta.url).href;
const FORUM_APPS_WITH_REACTIONS = [
  { name: 'forum', spaceId: FORUM_SPACE_ID },
  { name: 'reactions', clientMainUrl: REACTIONS_CLIENT_URL, contributes: [{ point: 'content.messageReactions', export: 'renderReactionWidget' }] },
];
const FORUM_APPS_WITH_PINS = [
  { name: 'forum', spaceId: FORUM_SPACE_ID },
  {
    name: 'pins', clientMainUrl: PINS_CLIENT_URL, contributes: [
      { point: 'content.messagePinToggle', export: 'renderPinToggle' },
      { point: 'forum.topicToolbar', export: 'renderPinnedBar' },
    ],
  },
];

function noopSubscribe() {}

/** Must be attached to document.body - reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
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

test('the composer posts a message and clears the input afterward', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('textarea') !== null);
    const textarea = container.querySelector('textarea');
    textarea.value = 'Posted from the composer';
    const sendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    sendBtn.click();

    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('Posted from the composer'));
    assert.equal(textarea.value, '');
    const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    assert.equal(messages.length, 1);
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
    await waitFor(() => container.querySelector('.qu-forum-pending-attachment')?.hidden === false, { timeout: 5000 });

    const textarea = container.querySelector('textarea');
    textarea.value = 'Check out this photo';
    const sendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    sendBtn.click();

    await waitFor(() => container.querySelector('.qu-forum-message-attachment') !== null, { timeout: 5000 });
    const { messages } = await a.services.messages.listMessages(FORUM_SPACE_ID, 'general');
    assert.equal(messages[0].attachment.name, 'photo.png');
    assert.equal(messages[0].attachment.mime, 'image/png');
    assert.equal(container.querySelector('.qu-forum-message-attachment').getAttribute('asset-id'), messages[0].attachment.assetId);
    // The pending-attachment chip is cleared after a successful send.
    assert.equal(container.querySelector('.qu-forum-pending-attachment').hidden, true);
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

    const sendBtn = [...container.querySelectorAll('button')].find((btn) => btn.textContent === 'Send');
    sendBtn.click();
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

test('content.messageReactions: the REAL apps/reactions app is dynamically imported and rendered per message, live across two independent mounts', async () => {
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
    [...containerA.querySelectorAll('qu-reactions-row .qu-thread-ui-emoji-panel button')].find((btn) => btn.textContent === '👍').click();

    await waitFor(() => [...containerB.querySelectorAll('.qu-reactions-pill')].some((btn) => btn.textContent === '👍 1'));
    assert.ok(containerA.querySelector('.qu-reactions-pill').classList.contains('qu-reactions-pill-mine'));

    containerA.querySelector('.qu-reactions-pill').click(); // toggle off
    await waitFor(() => containerB.querySelector('.qu-reactions-pill') === null);
  } finally {
    stopA();
    stopB();
  }
});

test('content.messageActions: the REAL apps/bookmarks app (not a fake) is dynamically imported and rendered per message via ExtensionPointHost.renderSlot()', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'bookmark me' });

  const container = makeContainer();
  const extensionPoints = new ExtensionPointHost(FORUM_APPS_WITH_BOOKMARKS);
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS_WITH_BOOKMARKS, subscribe: noopSubscribe, extensionPoints, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelector('.qu-forum-message-extensions button') !== null);
    const btn = container.querySelector('.qu-forum-message-extensions button');
    await waitFor(() => btn.textContent === '🔖'); // resolved inactive state (apps/bookmarks' own hasPrivate() check)

    btn.click();
    await waitFor(() => btn.textContent === '📑');
    assert.equal(await a.services.bookmarks.isBookmarked((await a.services.messages.listMessages(FORUM_SPACE_ID, 'general')).messages[0].id), true);

    const [entry] = await a.services.bookmarks.list();
    assert.equal(entry.body, 'bookmark me');
    assert.equal(entry.spaceId, FORUM_SPACE_ID);
    assert.equal(entry.threadId, 'general');
  } finally {
    stop();
  }
});

test('content.messageActions: without extensionPoints/a contributing app, the slot stays empty - no crash', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'no bookmarks app loaded' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS }); // no extensionPoints at all
  try {
    await waitFor(() => container.querySelector('.qu-forum-message') !== null);
    assert.equal(container.querySelector('.qu-forum-message-extensions').children.length, 0);
  } finally {
    stop();
  }
});

test('content.messageActions: a bookmark is private - a SECOND identity viewing the same message sees its own (unbookmarked) toggle state', async () => {
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
    await waitFor(() => container.querySelector('.qu-forum-message-extensions button') !== null);
    const btn = container.querySelector('.qu-forum-message-extensions button');
    // Give the async hasPrivate() resolution a moment, then confirm it settles UNBOOKMARKED for Bob.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(btn.textContent, '🔖'); // Bob's own, independent, still-inactive state
  } finally {
    stop();
  }
});

test('content.messagePinToggle/forum.topicToolbar: the REAL apps/pins app pins a message and shows it in the pinned bar, live for a second independent mount; unpinning removes it', async () => {
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
    await waitFor(() => containerA.querySelector('.qu-forum-message-actions button') !== null);
    const pinBtn = [...containerA.querySelectorAll('.qu-forum-message-actions button')].find((btn) => btn.textContent === 'Pin');
    assert.ok(pinBtn, 'expected a "Pin" button');
    pinBtn.click();

    await waitFor(() => containerB.querySelector('.qu-pins-bar') !== null);
    assert.match(containerB.querySelector('.qu-pins-bar-row span').textContent, /Pin this one/);
    await waitFor(() => [...containerA.querySelectorAll('.qu-forum-message-actions button')].some((btn) => btn.textContent === 'Unpin'));

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
    container.querySelector('.qu-forum-message-actions button').click(); // "Edit" - the only button own message has besides Pin
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
    assert.ok([...ownLi.querySelectorAll('button')].some((btn) => btn.textContent === 'Edit'));
    assert.equal([...otherLi.querySelectorAll('button')].some((btn) => btn.textContent === 'Edit'), false);

    [...ownLi.querySelectorAll('button')].find((btn) => btn.textContent === 'Edit').click();
    const textarea = ownLi.querySelector('.qu-forum-edit-row textarea');
    textarea.value = 'My EDITED message';
    [...ownLi.querySelectorAll('.qu-forum-edit-row-buttons button')].find((btn) => btn.textContent === 'Save').click();

    await waitFor(() => container.querySelector(`[data-message-id="${own.id}"] .qu-forum-message-text`)?.textContent.includes('My EDITED message'));
  } finally {
    stop();
  }
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

test('board view (#/forum, no sub-segments) lists the migrated "General" channel in the persistent sidebar and its topic in the recent-activity feed', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'first ever post' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-mini-channels a') !== null);
    assert.match(container.querySelector('.qu-forum-mini-channels a').textContent, /General/);

    await waitFor(() => container.querySelector('.qu-forum-topic-row a') !== null);
    const topicLink = container.querySelector('.qu-forum-topic-row a');
    assert.equal(topicLink.getAttribute('href'), '#/forum/t/general');
    assert.match(topicLink.textContent, /General/); // topic title
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
    await waitFor(() => [...container.querySelectorAll('.qu-forum-mini-channels a')].some((a2) => a2.textContent.includes('Secret Stuff')));
    const row = [...container.querySelectorAll('.qu-forum-mini-channels a')].find((a2) => a2.textContent.includes('Secret Stuff'));
    assert.match(row.textContent, /🔒/);
  } finally {
    stop();
  }
});

test('the persistent sidebar\'s "+ New channel" link is hidden when channels.allowMemberCreate is false for a non-admin', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [], settings: { channels: { allowMemberCreate: false, allowMemberRestricted: false } } }), { status: 200 }));

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-mini-channels') !== null);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the /config.json fetch + re-render settle
    assert.equal(container.querySelector('.qu-forum-mini-new-channel'), null);
  } finally {
    stop();
  }
});

test('the persistent sidebar\'s "+ New channel" link still shows for this relay\'s own admin even when channels.allowMemberCreate is false', async (t) => {
  const a = await freshEnv('Ada');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ adminPubs: [a.myPub], settings: { channels: { allowMemberCreate: false, allowMemberRestricted: false } } }), { status: 200 }));

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum'] });
  try {
    await waitFor(() => container.querySelector('.qu-forum-mini-new-channel') !== null);
    assert.equal(container.querySelector('.qu-forum-mini-new-channel').getAttribute('href'), '#/forum/new');
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
// CHANNEL VIEW - #/forum/c/<channelId>
// ===================================================================

test('channel view lists its topics with a live reply count, and a "new topic" form creates one', async () => {
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

    const titleInput = container.querySelector('.qu-forum-new-topic-form input[type="text"]');
    titleInput.value = 'Second topic';
    container.querySelector('.qu-forum-new-topic-form button').click();
    await waitFor(() => [...container.querySelectorAll('.qu-forum-topic-title')].some((el) => el.textContent === 'Second topic'));
  } finally {
    stop();
  }
});

test('channel view: a persistent mini sidebar lists every channel and highlights the active one', async () => {
  const a = await freshEnv('Ada');
  const announcements = await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Announcements' });
  await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Off-topic' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: ['forum', 'c', announcements._id] });
  try {
    await waitFor(() => container.querySelectorAll('.qu-forum-mini-channels a').length >= 3); // General + Announcements + Off-topic
    const links = [...container.querySelectorAll('.qu-forum-mini-channels a')];
    assert.ok(links.some((a2) => a2.textContent.includes('Off-topic')));
    const active = container.querySelector('.qu-forum-mini-channel-active');
    assert.match(active.textContent, /Announcements/);
  } finally {
    stop();
  }
});

test('topic view: a persistent mini sidebar lists every channel alongside the thread', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.channels.createChannel(FORUM_SPACE_ID, { title: 'Off-topic' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe, segments: TOPIC_SEGMENTS });
  try {
    await waitFor(() => container.querySelectorAll('.qu-forum-mini-channels a').length >= 2); // General + Off-topic
    await waitFor(() => container.querySelector('.qu-forum-message, .qu-forum-empty') !== null); // the thread itself still renders alongside it
  } finally {
    stop();
  }
});

test('channel view: an OPEN channel shows no invite form; a RESTRICTED one does, and inviting actually grows membership', async () => {
  const a = await freshEnv('Ada');
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
    pubInput.value = 'some-actor-pub-1234567890';
    containerRestricted.querySelector('.qu-forum-invite-form button').click();

    // waitFor()'s predicate is never awaited (see @qu/ui/testing's own
    // doc comment - `while (!check())` runs it synchronously) - a real
    // poll loop is needed for an async check like this one.
    let invited = false;
    for (let i = 0; i < 200 && !invited; i++) {
      const channel = await a.services.channels.getChannel(FORUM_SPACE_ID, restrictedChannel._id);
      invited = channel.memberPubs.includes('some-actor-pub-1234567890');
      if (!invited) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(invited, 'expected addChannelMember() to have run by now');
  } finally {
    stopOpen();
    stopRestricted();
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
