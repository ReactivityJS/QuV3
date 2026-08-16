/**
 * NOTIFICATIONS — a live feed over this identity's own notifications Thread
 * (`paths.notificationsSpaceId(myPub)`, thread id `paths.NOTIFICATIONS_THREAD_ID`),
 * written by `@qu/relay`'s `PushDeliveryService` (see that file's own doc
 * comment for the full delivery pipeline: prefs check -> in-app write ->
 * optional Web Push) every time this identity is mentioned, or otherwise
 * targeted by an app that declared a matching `pushActions` entry in its
 * manifest. Deliberately just a READER here - `apps/notifications` never
 * writes into its own feed (the relay does that, as a signed relay-authored
 * write - see `THREAD_PRESETS.notifications()`'s `writers: '*'`), and never
 * creates the thread either (idempotent creation happens automatically on
 * the FIRST notification ever delivered - a brand new identity with zero
 * notifications yet simply has no thread, and `watchChildren()` below
 * handles "nothing here yet" the same as any other empty derived list).
 *
 * Each item's `body` is the SAME generic, never-the-actual-content wording
 * `PushDeliveryService` also sends as the Web Push payload (see its own doc
 * comment on why); `title`/`url`/`appId` (top-level fields on the stored
 * message - `postMessage()`'s own `extra` PARAMETER gets spread flat onto
 * it, never nested under an `.extra` key on the result) are what make an
 * item distinguishable and clickable - `title` either the manifest-driven
 * `pushActions` wording (`createManifestNotificationResolver()`,
 * `packages/relay/src/push-delivery.js`) or the generic fallback, `url` a
 * real in-app hash route to jump straight to the relevant app.
 *
 * RICH RENDERING (`content.resolveReference`/`content.searchResultTemplate`,
 * the SAME two-point contract `apps/search` already established): a
 * notification MAY also carry a live `ref: {spaceId, threadId, messageId}`
 * (additive - see `PushDeliveryService#writeInAppNotification()`'s own doc
 * comment; an older notification, or one from an app with no contributor
 * for either point, simply lacks it or fails to resolve). When it does,
 * `renderItem()` resolves it via `extensionPoints.collect('content.
 * resolveReference', ..., {onlyAppId: message.appId})` into the SAME entry
 * shape `content.search` produces, then hands it to that SAME app's own
 * `content.searchResultTemplate` contributor via `extensionPoints.
 * renderFrom(...)` - the exact template Search already uses to render a
 * Forum/Chat result row, reused here unchanged. This app never learns
 * Forum's/Chat's data shape either way; it only ever asks "does this
 * notification's own app know how to show itself?" and falls back to the
 * generic title/body/url rendering above when the answer is no - disabled
 * app, deleted message, or simply no `ref` at all.
 *
 * READ TRACKING: `MessageService.markRead()`/`.getLastReadAt()` (a generic,
 * per-identity, PRIVATE, thread-level read marker - see either's own doc
 * comment) is exactly the right granularity here - ONE marker for the
 * WHOLE notifications thread, not per-item. `render()` reads the marker
 * BEFORE marking anything read (so it can still tell which items were
 * unread AS OF this render, for the `qu-notifications-unread` highlight),
 * then marks the thread read AFTER rendering - "opened the feed" is this
 * app's whole definition of "seen it", simple on purpose; a per-item
 * dismiss/mark-unread affordance is real, straightforward follow-up work,
 * not something this round's ask needs.
 *
 * DELIBERATELY NOT BUILT THIS ROUND: an unread-count badge on the shell's
 * own nav entry (the underlying data - `getLastReadAt()` vs. each item's
 * `ts` - already supports it; wiring a live badge into `apps/shell/src/nav.js`
 * is a separate, nav-level concern this app doesn't own) and per-item
 * dismiss/delete (no primitive for it exists - `QuStore` itself has no
 * delete(), matching every other Thread in this codebase).
 *
 * UNREAD-ONLY DEFAULT VIEW (the "Zwischenlösung" plan's own Baustein 4):
 * this app now defaults to showing only `message.ts > lastReadAt` items -
 * the SAME comparison `renderItem()` already used for its own "unread"
 * highlight, just also used as a FILTER now - with a "Show all (incl.
 * read)" toggle above the list. Purely a client-side render-time filter,
 * same as that highlight always was - no new storage shape, no per-item
 * read/unread state (still just the one thread-level `lastReadAt` marker -
 * see the "READ TRACKING" section above, unchanged). `render()`'s own
 * `lastReadAt` snapshot (read BEFORE this render's own `markRead()` call)
 * is what BOTH the filter and the highlight use, so a freshly-arrived
 * notification is never invisible for one render because `markRead()`
 * already ran - the two can never disagree about what counts as "unread"
 * for a given render.
 */
import { watchChildren } from '@qu/reactive';
import { paths } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const DICT = {
  en: {
    title: 'Notifications',
    empty: 'No notifications yet.',
    emptyUnread: 'No unread notifications.',
    showAll: 'Show all (incl. read)',
    showUnreadOnly: 'Show unread only',
  },
  de: {
    title: 'Benachrichtigungen',
    empty: 'Noch keine Benachrichtigungen.',
    emptyUnread: 'Keine ungelesenen Benachrichtigungen.',
    showAll: 'Alle anzeigen (inkl. gelesene)',
    showUnreadOnly: 'Nur ungelesene anzeigen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-notifications-style';
const STYLE = `
  .qu-notifications-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-notifications-item a { display: block; padding: 0.6rem 0.8rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-notifications-item a:hover { background: var(--qu-color-surface, #8882); }
  .qu-notifications-item.qu-notifications-unread a { border-left: 3px solid var(--qu-color-accent, #5b5bd6); }
  .qu-notifications-item-title { font-weight: 600; }
  .qu-notifications-item-body { opacity: 0.85; font-size: 0.9em; margin-top: 0.15rem; }
  .qu-notifications-item-ts { opacity: 0.6; font-size: 0.75em; margin-top: 0.3rem; }
  .qu-notifications-empty { padding: 1.5rem; text-align: center; opacity: 0.7; }
  .qu-notifications-toggle { background: none; border: none; cursor: pointer; color: var(--qu-color-accent, #5b5bd6); font: inherit; font-size: 0.85em; padding: 0; margin: 0 0 0.6rem; text-decoration: underline; }
  .qu-notifications-toggle[hidden] { display: none; }
`;

/**
 * Synchronous outer function returning the stop function immediately,
 * deferring the async `whoAmI()`/subscribe/first-render setup to an inner
 * IIFE - the same "mount() itself is never async" convention every other
 * app in this codebase follows (`apps/shell/client.js`'s own composition
 * root is the one deliberate exception, not a second precedent).
 * @param {HTMLElement} container
 * @param {{qu: import('@qu/core').QuStore, services: object, subscribe?: (prefix: string) => void, syncFetch?: (prefix: string) => Promise<*>, extensionPoints?: import('@qu/foundation').ExtensionPointHost}} deps
 * @returns {() => void}
 */
export function mount(container, { qu, services, subscribe, syncFetch, extensionPoints }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let off = null;
  let myPub = null;
  let currentSpaceId = null;
  let showAll = false; // default: unread-only, see this file's own "UNREAD-ONLY DEFAULT VIEW" doc comment

  // See apps/search/client.js's own identical line - a resolved item's own
  // `content.searchResultTemplate` rendering (this file's own "RICH
  // RENDERING" doc comment above) may include a real `<qu-asset>` preview
  // (e.g. Forum's/Chat's `renderSearchResult()`), which resolves this via
  // an ancestor walk.
  container.assetService = services.assets;

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'qu-notifications-toggle';
  toggleBtn.hidden = true; // shown once render() knows there's at least one notification at all
  toggleBtn.addEventListener('click', () => {
    showAll = !showAll;
    if (currentSpaceId) render(currentSpaceId);
  });
  const listRoot = document.createElement('div');
  container.append(heading, toggleBtn, listRoot);

  // `watchChildren()`'s callback can legitimately fire twice in quick
  // succession (the initial local read, then a fresher value arriving
  // moments later - e.g. a live relay, or its own syncFetch backfill) -
  // without a guard, two overlapping render() calls both do real async
  // work (listMessages()/getLastReadAt()/markRead()) BETWEEN being
  // triggered and touching the DOM, and an OLDER call finishing AFTER a
  // NEWER one can leave a stale read-state rendered (confirmed: an item
  // correctly marked read by the newer call's markRead() could still show
  // the "unread" highlight, because the older call's own now-stale
  // `lastReadAt` snapshot was the one that ended up in the DOM). Same
  // monotonic-counter pattern `apps/profile/client.js`'s own `renderToken`/
  // `apps/user-list`'s own `unlistedToken` already establish for the exact
  // same class of race - only the call still holding the LATEST token when
  // its async work finishes may touch the DOM or call markRead().
  let renderToken = 0;
  async function render(spaceId) {
    const token = ++renderToken;
    if (stopped) return;
    const [{ messages: allMessages }, lastReadAt] = await Promise.all([
      services.messages.listMessages(spaceId, paths.NOTIFICATIONS_THREAD_ID, { order: 'desc' }),
      services.messages.getLastReadAt(spaceId, paths.NOTIFICATIONS_THREAD_ID),
    ]);
    if (stopped || token !== renderToken) return;

    // Same `ts > lastReadAt` comparison `renderItem()` already uses for its
    // own "unread" highlight - see this file's own "UNREAD-ONLY DEFAULT
    // VIEW" doc comment for why the filter and the highlight share one
    // snapshot of `lastReadAt` instead of risking two different notions of
    // "unread" within a single render.
    const messages = showAll ? allMessages : allMessages.filter((m) => m.ts > lastReadAt);

    let items = null;
    if (messages.length > 0) {
      // All the (potentially async, rich-rendering) per-item work happens
      // BEFORE anything touches the DOM, same "build first, mount once
      // behind one token check" discipline the rest of this function
      // already follows for its own listMessages()/getLastReadAt() pair -
      // a resolveReference()/renderFrom() round trip per item must not let
      // a newer render() interleave partial DOM updates with an older one.
      items = await Promise.all(messages.map((message) => renderItem(message, lastReadAt, { extensionPoints, services, qu, syncFetch, myPub })));
    }
    if (stopped || token !== renderToken) return;

    toggleBtn.hidden = allMessages.length === 0;
    toggleBtn.textContent = showAll ? t('showUnreadOnly') : t('showAll');

    listRoot.textContent = '';
    if (!items) {
      const p = document.createElement('p');
      p.className = 'qu-notifications-empty';
      p.textContent = !showAll && allMessages.length > 0 ? t('emptyUnread') : t('empty');
      listRoot.appendChild(p);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'qu-notifications-list';
      for (const li of items) ul.appendChild(li);
      listRoot.appendChild(ul);
    }

    // "Opened the feed" = seen everything currently in it - see this
    // file's own top doc comment on why a thread-level marker (not
    // per-item) is the right granularity here.
    await services.messages.markRead(spaceId, paths.NOTIFICATIONS_THREAD_ID);
  }

  (async () => {
    myPub = await services.actors.whoAmI();
    if (stopped) return;
    const spaceId = paths.notificationsSpaceId(myPub);
    currentSpaceId = spaceId;

    // Defense in depth, same reasoning apps/user-list's own subscribe?.()
    // call already documents - a future shell might already subscribe to
    // every space by default, but this app shouldn't silently depend on
    // that staying true.
    subscribe?.(paths.spacePath(spaceId));

    off = watchChildren(qu, paths.threadMessagesParentPath(spaceId, paths.NOTIFICATIONS_THREAD_ID), () => render(spaceId), { syncFetch });
  })();

  return () => {
    stopped = true;
    off?.();
  };
}

/**
 * @param {object} message
 * @param {number} lastReadAt
 * @param {{extensionPoints?: import('@qu/foundation').ExtensionPointHost, services: object, qu: object, syncFetch?: Function, myPub: string|null}} ctx
 * @returns {Promise<HTMLElement>}
 */
async function renderItem(message, lastReadAt, { extensionPoints, services, qu, syncFetch, myPub }) {
  const li = document.createElement('li');
  li.className = 'qu-notifications-item';
  if (message.ts > lastReadAt) li.classList.add('qu-notifications-unread');

  // See this file's own top doc comment's "RICH RENDERING" section - only
  // attempted when there's an ExtensionPointHost to ask AND a live
  // reference to resolve; any failure along the way (no contributor for
  // this appId, the message/thread no longer resolvable, etc.) falls
  // through to the plain rendering below exactly as if `ref` were absent.
  if (message.ref && extensionPoints) {
    try {
      const [entry] = await extensionPoints.collect(
        'content.resolveReference',
        { services, qu, syncFetch, myPub, ...message.ref },
        { onlyAppId: message.appId }
      );
      if (entry) {
        const row = document.createElement('div');
        await extensionPoints.renderFrom('content.searchResultTemplate', message.appId, row, { entry, services });
        if (row.childNodes.length > 0) {
          li.appendChild(row);
          return li;
        }
      }
    } catch { /* resolution/rendering failed - fall through to the generic rendering below */ }
  }

  // `MessageService.postMessage()` SPREADS its `extra` param directly onto
  // the stored message (`{ ..., ...extra }`, see its own doc comment) - by
  // the time listMessages() hands it back, `title`/`url`/`appId` are
  // top-level fields, never nested under a `.extra` key.
  const link = document.createElement('a');
  link.href = message.url ?? '#/notifications';

  const titleEl = document.createElement('div');
  titleEl.className = 'qu-notifications-item-title';
  titleEl.textContent = message.title ?? '';

  const bodyEl = document.createElement('div');
  bodyEl.className = 'qu-notifications-item-body';
  bodyEl.textContent = message.body;

  const tsEl = document.createElement('div');
  tsEl.className = 'qu-notifications-item-ts';
  tsEl.textContent = new Date(message.ts).toLocaleString();

  link.append(titleEl, bodyEl, tsEl);
  li.appendChild(link);
  return li;
}
