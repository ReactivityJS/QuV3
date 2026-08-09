import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, FlagService, BookmarksService, ActorService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, renderBookmarkToggle } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const flags = new FlagService(qu, identity, new ListService(qu));
  const services = {
    actors: new ActorService(identity),
    bookmarks: new BookmarksService(flags),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

function noopSubscribe() {}

/** Must be attached to document.body - reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ===== mount() - "My Bookmarks" ============================================

test('renders the empty state when there are no bookmarks yet', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-bookmarks-empty') !== null);
  } finally {
    stop();
  }
});

test('renders a bookmarked message\'s stored snapshot (author, body) with a link back to the author\'s profile', async () => {
  const { qu, services, myPub } = await freshEnv();
  await services.bookmarks.add('msg1', { body: 'a message worth saving', author: 'author-pub-1', spaceId: 'forum-space', threadId: 'general' });

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-bookmarks-item') !== null);
    assert.match(container.querySelector('.qu-bookmarks-item-text').textContent, /a message worth saving/);
    assert.equal(container.querySelector('.qu-bookmarks-item-author').getAttribute('href'), '#/~author-pub-1');
  } finally {
    stop();
  }
  void myPub;
});

test('clicking the remove button un-bookmarks the message, live', async () => {
  const { qu, services } = await freshEnv();
  await services.bookmarks.add('msg1', { body: 'remove me', author: 'a' });

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-bookmarks-item') !== null);
    container.querySelector('.qu-bookmarks-item button').click();
    await waitFor(() => container.querySelector('.qu-bookmarks-empty') !== null);
    assert.equal(await services.bookmarks.isBookmarked('msg1'), false);
  } finally {
    stop();
  }
});

test('a bookmark added elsewhere in the SAME store appears live in an already-mounted view', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-bookmarks-empty') !== null);
    await services.bookmarks.add('msg1', { body: 'arrived live', author: 'a' });
    await waitFor(() => container.querySelector('.qu-bookmarks-item-text')?.textContent.includes('arrived live'));
  } finally {
    stop();
  }
});

test('newest bookmark first', async () => {
  const { qu, services } = await freshEnv();
  await services.bookmarks.add('msg1', { body: 'first', author: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  await services.bookmarks.add('msg2', { body: 'second', author: 'a' });

  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelectorAll('.qu-bookmarks-item').length === 2);
    const texts = [...container.querySelectorAll('.qu-bookmarks-item-text')].map((el) => el.textContent);
    assert.deepEqual(texts, ['second', 'first']);
  } finally {
    stop();
  }
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-bookmarks-empty') !== null);
  assert.doesNotThrow(() => stop());
});

// ===== renderBookmarkToggle() - the content.messageActions contributor ====

test('renderBookmarkToggle(): renders inactive, then toggles active on click, persisting via services.bookmarks', async () => {
  const { services } = await freshEnv();
  const container = document.createElement('div');
  document.body.appendChild(container);

  await renderBookmarkToggle(container, {
    services, messageId: 'msg1', spaceId: 'forum-space', threadId: 'general', body: 'hello', author: 'author-pub',
  });
  await waitFor(() => container.querySelector('button') !== null);
  const btn = container.querySelector('button');
  await waitFor(() => btn.textContent === '🔖'); // resolved inactive state

  btn.click();
  await waitFor(() => btn.textContent === '📑');
  assert.equal(await services.bookmarks.isBookmarked('msg1'), true);

  const [entry] = await services.bookmarks.list();
  assert.equal(entry.body, 'hello');
  assert.equal(entry.author, 'author-pub');

  btn.click();
  await waitFor(() => btn.textContent === '🔖');
  assert.equal(await services.bookmarks.isBookmarked('msg1'), false);
});

test('renderBookmarkToggle(): reflects an ALREADY-bookmarked message as active on mount', async () => {
  const { services } = await freshEnv();
  await services.bookmarks.add('msg1', { body: 'already saved', author: 'a' });

  const container = document.createElement('div');
  document.body.appendChild(container);
  await renderBookmarkToggle(container, { services, messageId: 'msg1' });

  await waitFor(() => container.querySelector('button')?.textContent === '📑');
});
