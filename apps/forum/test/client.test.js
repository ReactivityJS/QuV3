import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { AccessEngine, ThreadEngine, AssetEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import {
  ListService, AccessService, MessageService, ReactionService, PinService,
  ActorService, ProfileService, AssetService, FlagService, BookmarksService, THREAD_PRESETS, paths,
} from '@qu/services';
import { ExtensionPointHost } from '@qu/foundation';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

function createQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  // MessageService.postMessage()/editMessage() go through AccessEngine's
  // writer-ACL pipeline (see message-service.test.js's own freshSetup()) -
  // ReactionService/PinService need neither (see either's own doc comment:
  // "not ACL-checked by AccessEngine").
  new AccessEngine(qu);
  new ThreadEngine(qu);
  return qu;
}

/**
 * One identity's full service set and OWN store, as apps/shell's
 * createClientServices() would build it for a real browser tab -
 * `QuIdentityEngine` holds exactly one identity PER store (see its own
 * `#storeSeed()` guard), so two independent identities always need two
 * independent stores, never one shared `qu.
 */
async function freshEnv(alias) {
  const qu = createQu();
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const services = {
    actors: new ActorService(identity),
    profile: new ProfileService(qu, identity),
    messages: new MessageService(qu, identity, list, access),
    reactions: new ReactionService(qu, identity, list),
    pins: new PinService(qu, identity, list),
    assets: new AssetService(qu, new AssetEngine(qu), identity),
    bookmarks: new BookmarksService(new FlagService(qu, identity, list)),
  };
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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

test('a message with no attachment never renders a <qu-asset>', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'plain text only' });

  const container = makeContainer();
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: b.qu, services: b.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-forum-empty') !== null);
    await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Arrived live' });
    await waitFor(() => container.querySelector('.qu-forum-message-text')?.textContent.includes('Arrived live'));
  } finally {
    stop();
  }
});

test('reaction toggle: clicking an emoji sets it, clicking the same one again clears it, live for a second independent mount', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'React to me' });

  // Two independent mounts of the SAME store - proves the reactive watch
  // chain works across separate DOM instances, without needing a second
  // distinct identity for this particular assertion.
  const containerA = makeContainer();
  const stopA = mount(containerA, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
  const containerB = makeContainer();
  const stopB = mount(containerB, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
  try {
    await waitFor(() => containerA.querySelector('.qu-forum-reaction') !== null);
    const findThumbsUpA = () => [...containerA.querySelectorAll('.qu-forum-reaction')].find((btn) => btn.textContent.startsWith('👍'));
    findThumbsUpA().click();

    await waitFor(() => [...containerB.querySelectorAll('.qu-forum-reaction')].some((btn) => btn.textContent === '👍 1'));
    assert.ok([...containerA.querySelectorAll('.qu-forum-reaction')].find((btn) => btn.textContent === '👍 1').classList.contains('qu-forum-reaction-mine'));

    // Each live re-render rebuilds the reaction row with a fresh closure -
    // re-query the CURRENT button rather than reusing the first click's now-
    // stale, detached reference (whose own click handler is still bound to
    // the pre-reaction "mine: false" state it was created with).
    findThumbsUpA().click(); // toggle off
    const findThumbsUpB = () => [...containerB.querySelectorAll('.qu-forum-reaction')].find((btn) => btn.textContent.startsWith('👍'));
    await waitFor(() => findThumbsUpB()?.textContent === '👍');
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS_WITH_BOOKMARKS, subscribe: noopSubscribe, extensionPoints });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe }); // no extensionPoints at all
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
  const stop = mount(container, { qu: b.qu, services: b.services, apps: FORUM_APPS_WITH_BOOKMARKS, subscribe: noopSubscribe, extensionPoints });
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

test('pinning shows the message in the pinned bar, live for a second independent mount; unpinning removes it', async () => {
  const a = await freshEnv('Ada');
  await a.services.messages.createThread(FORUM_SPACE_ID, 'general', THREAD_PRESETS.forum());
  await a.services.messages.postMessage(FORUM_SPACE_ID, 'general', { body: 'Pin this one' });

  const containerA = makeContainer();
  const stopA = mount(containerA, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
  const containerB = makeContainer();
  const stopB = mount(containerB, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
  try {
    await waitFor(() => containerA.querySelector('.qu-forum-message-actions button') !== null);
    const pinBtn = [...containerA.querySelectorAll('.qu-forum-message-actions button')].find((btn) => btn.textContent === 'Pin');
    assert.ok(pinBtn, 'expected a "Pin" button');
    pinBtn.click();

    await waitFor(() => containerB.querySelector('.qu-forum-pinned') !== null);
    assert.match(containerB.querySelector('.qu-forum-pinned-row span').textContent, /Pin this one/);
    await waitFor(() => [...containerA.querySelectorAll('.qu-forum-message-actions button')].some((btn) => btn.textContent === 'Unpin'));

    containerB.querySelector('.qu-forum-pinned-row button').click(); // unpin via the bar's own ✕
    await waitFor(() => containerB.querySelector('.qu-forum-pinned') === null);
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
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
  const stop = mount(container, { qu: a.qu, services: a.services, apps: FORUM_APPS, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-forum-message') !== null);
  assert.doesNotThrow(() => stop());
});
