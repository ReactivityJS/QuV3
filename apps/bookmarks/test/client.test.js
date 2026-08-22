import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, FlagService, BookmarksService, ActorService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, bookmarkMenuItem, entityBookmarkMenuItem } = await import('../client.js');

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

// ===== bookmarkMenuItem() - the content.messageMenu contributor ===========

test('bookmarkMenuItem(): resolves an inactive item whose onClick adds the bookmark, persisting the snapshot', async () => {
  const { services } = await freshEnv();
  const item = await bookmarkMenuItem({
    services, messageId: 'msg1', spaceId: 'forum-space', threadId: 'general', body: 'hello', author: 'author-pub',
  });
  assert.equal(item.id, 'bookmark');
  assert.equal(item.icon, '🔖'); // inactive state

  await item.onClick();

  const [entry] = await services.bookmarks.list();
  assert.equal(entry.body, 'hello');
  assert.equal(entry.author, 'author-pub');
});

test('bookmarkMenuItem(): an ALREADY-bookmarked message resolves an active item whose onClick removes it', async () => {
  const { services } = await freshEnv();
  await services.bookmarks.add('msg1', { body: 'already saved', author: 'a' });

  const item = await bookmarkMenuItem({ services, messageId: 'msg1' });
  assert.equal(item.icon, '📑'); // active state

  await item.onClick();
  assert.equal(await services.bookmarks.isBookmarked('msg1'), false);
});

// ===== entityBookmarkMenuItem() - the content.entityMenu contributor ======

test('entityBookmarkMenuItem(): resolves an inactive item whose onClick adds the bookmark under entityKind "entity"', async () => {
  const { services } = await freshEnv();
  const item = await entityBookmarkMenuItem({ services, entityId: 'topic1', snapshot: { title: 'my topic' } });
  assert.equal(item.id, 'bookmark');
  assert.equal(item.icon, '🔖');

  await item.onClick();

  const [entry] = await services.bookmarks.list('entity');
  assert.equal(entry.title, 'my topic');
  assert.equal(await services.bookmarks.isBookmarked('topic1'), false); // never leaks into the default forumMessage list
});

test('entityBookmarkMenuItem(): an already-bookmarked entity resolves an active item whose onClick removes it, independent from the message-scoped list', async () => {
  const { services } = await freshEnv();
  await services.bookmarks.add('topic1', { title: 'saved' }, 'entity');
  await services.bookmarks.add('topic1', { body: 'a same-id message, unrelated' }); // same id, default entityKind

  const item = await entityBookmarkMenuItem({ services, entityId: 'topic1' });
  assert.equal(item.icon, '📑');

  await item.onClick();
  assert.equal(await services.bookmarks.isBookmarked('topic1', 'entity'), false);
  assert.equal(await services.bookmarks.isBookmarked('topic1'), true); // the default-kind bookmark is untouched
});
