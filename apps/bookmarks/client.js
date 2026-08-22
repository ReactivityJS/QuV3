/**
 * BOOKMARKS — the second real consumer of `@qu/foundation`'s
 * `contributes`/`ExtensionPointHost` mechanism (the first was the
 * synthetic fake-app pair in `apps/shell`'s own test file) - this app is
 * BOTH a normally-mounted page (`mount()`, "My Bookmarks") AND a
 * cross-app UI plugin (`bookmarkMenuItem()`, dynamically imported and
 * called by whatever host app defines the `content.messageMenu` point -
 * `apps/forum` and `apps/chat` today, see either's own doc comment) from
 * the SAME bundle - neither host imports this file, and this file never
 * imports either host; both sides only agree on the `content.messageMenu`
 * point string and the payload shape below.
 *
 * STORAGE: `@qu/services`' `BookmarksService` (a thin `FlagService`
 * wrapper, private/self-encrypted mode - a bookmark is nobody's business
 * but the identity that set it). Neither `mount()` nor `bookmarkMenuItem()`
 * construct their OWN `FlagService`/`BookmarksService` - both read
 * `services.bookmarks` off whatever context they're given (the normal
 * shell ctx for `mount()`, the host app's own payload for the
 * contribution), so there is exactly ONE way bookmarks get read/written,
 * never a second copy of the storage logic living in the UI layer.
 *
 * CONTRIBUTOR PAYLOAD CONTRACT (`content.messageMenu`, `kind: 'menu'` - a
 * `collect()`-style `(payload) -> {id, label, icon, onClick}`, NOT a DOM
 * mount): `payload` is `{services, messageId, spaceId, threadId, body,
 * author, ...}` - `services` (specifically `services.bookmarks`) is what
 * lets this run with no `qu`/`identity` of its own; `messageId` is the
 * `entityRef` bookmarked; the rest (`spaceId`/`threadId`/`body`/`author`)
 * becomes the bookmark's stored SNAPSHOT (see `BookmarksService.add()`'s
 * own doc comment on why a snapshot, not a re-fetch) - a host app that
 * renders this point is expected to pass exactly this shape. The CURRENT
 * bookmarked state is resolved fresh on every `collect()` call - no live
 * subscription, same "a menu is transient" reasoning `apps/pins/client.js`'s
 * own `pinMenuItem()` doc comment has.
 *
 * QUNIVERSE V4 (Forum-migration round, docs/v4-concept.md §4): a second
 * export, `entityBookmarkMenuItem()`, contributes the same kind of menu item
 * to a new `content.entityMenu` point - bookmarking an Entity's own content
 * (e.g. a Forum Topic's opening post) rather than one of its comments.
 * Payload is `{services, entityId, snapshot}` - `entityId` stands in for
 * `messageId`, `snapshot` is passed through as-is (the caller already knows
 * its own Entity's shape, unlike the message-scoped item which assembles the
 * snapshot itself from individual fields). Storage-wise this is
 * `BookmarksService` called with `entityKind: 'entity'` instead of the
 * default `'forumMessage'` - each `entityKind` is its own independent list
 * (see that Service's own doc comment), so an entity's bookmark state never
 * collides with a comment's.
 *
 * "My Bookmarks" (`mount()`) is deliberately simple: one flat, reverse-
 * chronological list of every bookmark's stored snapshot, each linking back
 * to `#/~<author>` (the one navigable reference a bookmarked message
 * already has - forum messages have no permalink of their own yet, a
 * documented, separate scope cut, see apps/forum's own doc comment) with a
 * remove ("un-bookmark") button. Reactive via `watchChildren()` on the
 * private flag's own parent path, re-reading through `BookmarksService`
 * (not the raw watched value) every time - the same "watch for the
 * notification, re-fetch through the Service that knows how to
 * decrypt/shape it" convention every other app in this codebase already
 * uses.
 */
import { watchChildren } from '@qu/reactive';
import { paths } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, mountAppTemplate } from '@qu/ui';

const DICT = {
  en: {
    title: 'My Bookmarks',
    empty: 'No bookmarks yet - bookmark a forum message to see it here.',
    remove: 'Remove bookmark',
    bookmarkAdd: 'Bookmark this message',
    bookmarkRemove: 'Remove bookmark',
  },
  de: {
    title: 'Meine Lesezeichen',
    empty: 'Noch keine Lesezeichen - markiere eine Forumsnachricht, um sie hier zu sehen.',
    remove: 'Lesezeichen entfernen',
    bookmarkAdd: 'Nachricht mit Lesezeichen versehen',
    bookmarkRemove: 'Lesezeichen entfernen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-bookmarks-style';
const STYLE = `
  .qu-bookmarks-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-bookmarks-item { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.6rem 0.8rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-bookmarks-item-body { flex: 1; min-width: 0; }
  .qu-bookmarks-item-author { font-weight: 600; font-size: 0.85em; }
  .qu-bookmarks-item-text { overflow-wrap: anywhere; margin: 0.2rem 0 0; }
  .qu-bookmarks-item button { background: none; border: none; cursor: pointer; opacity: 0.6; font: inherit; padding: 0; }
  .qu-bookmarks-item button:hover { opacity: 1; }
  .qu-bookmarks-empty { padding: 1.5rem; text-align: center; opacity: 0.7; }
`;

export function mount(container, { qu, services, syncFetch }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const listRoot = document.createElement('div');
  mountAppTemplate(container, { render: (content) => content.append(heading, listRoot) });

  async function render() {
    if (stopped) return;
    const bookmarks = await services.bookmarks.list();
    if (stopped) return;
    bookmarks.sort((a, b) => (b.starredAt ?? 0) - (a.starredAt ?? 0));

    listRoot.textContent = '';
    if (bookmarks.length === 0) {
      const p = document.createElement('p');
      p.className = 'qu-bookmarks-empty';
      p.textContent = t('empty');
      listRoot.appendChild(p);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'qu-bookmarks-list';
    for (const bookmark of bookmarks) {
      const li = document.createElement('li');
      li.className = 'qu-bookmarks-item';

      const body = document.createElement('div');
      body.className = 'qu-bookmarks-item-body';
      const authorEl = document.createElement('a');
      authorEl.className = 'qu-bookmarks-item-author';
      authorEl.href = bookmark.author ? `#/~${bookmark.author}` : '#';
      authorEl.textContent = bookmark.author ?? '';
      const textEl = document.createElement('p');
      textEl.className = 'qu-bookmarks-item-text';
      textEl.textContent = bookmark.body ?? '';
      body.append(authorEl, textEl);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '✕';
      removeBtn.title = t('remove');
      removeBtn.setAttribute('aria-label', t('remove'));
      removeBtn.addEventListener('click', () => services.bookmarks.remove(bookmark.id));

      li.append(body, removeBtn);
      ul.appendChild(li);
    }
    listRoot.appendChild(ul);
  }

  let off = null;
  (async () => {
    const myPub = await services.actors.whoAmI();
    if (stopped) return;
    off = watchChildren(qu, paths.privateFlagParentPath(myPub, 'bookmark', 'forumMessage'), () => render(), { syncFetch });
    await render();
  })();

  return () => {
    stopped = true;
    off?.();
  };
}

/**
 * The `content.messageMenu` contributor - see this file's own top doc
 * comment for the full payload contract.
 * @param {{services: object, messageId: string, spaceId?: string, threadId?: string, body?: string, author?: string}} payload
 * @returns {Promise<{id: string, label: string, icon: string, onClick: () => void}>}
 */
export async function bookmarkMenuItem({ services, messageId, spaceId, threadId, body, author }) {
  const bookmarked = await services.bookmarks.isBookmarked(messageId);
  const snapshot = { spaceId, threadId, body, author };
  return {
    id: 'bookmark',
    label: bookmarked ? t('bookmarkRemove') : t('bookmarkAdd'),
    icon: bookmarked ? '📑' : '🔖',
    onClick: () => (bookmarked ? services.bookmarks.remove(messageId) : services.bookmarks.add(messageId, snapshot)),
  };
}

/**
 * The `content.entityMenu` contributor - bookmarking an Entity's own
 * content (Quniverse V4, Forum-migration round) rather than one of its
 * comments. See this file's own top doc comment for the payload contract.
 * @param {{services: object, entityId: string, snapshot?: object}} payload
 * @returns {Promise<{id: string, label: string, icon: string, onClick: () => void}>}
 */
export async function entityBookmarkMenuItem({ services, entityId, snapshot = {} }) {
  const bookmarked = await services.bookmarks.isBookmarked(entityId, 'entity');
  return {
    id: 'bookmark',
    label: bookmarked ? t('bookmarkRemove') : t('bookmarkAdd'),
    icon: bookmarked ? '📑' : '🔖',
    onClick: () => (bookmarked ? services.bookmarks.remove(entityId, 'entity') : services.bookmarks.add(entityId, snapshot, 'entity')),
  };
}
