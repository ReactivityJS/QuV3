/**
 * NOTIFICATION POPUPS — the live-watcher half of the notification-popup
 * "Zwischenlösung" (see the Phone-app plan's own "Baustein 4" section):
 * shows a toast (via `@qu/ui`'s `mountToastHost()`) for each notification
 * that arrives DURING this session, on the same notifications Thread the
 * header's own unread bell badge already watches (`header.js`'s
 * `updateBadge()`/`watchChildren()` - this mirrors that exact pattern, just
 * reacting to NEW entries instead of counting unread ones).
 *
 * SESSION-START WATERMARK, NOT `lastReadAt`: a fresh mount only pops toasts
 * for messages with `ts` after the watcher's OWN mount time, not every
 * unread backlog entry replayed from a previous session - opening the app
 * after being away for a day should show the unread BADGE (header.js's
 * job), not a wall of toasts.
 *
 * ACTIONS: a stored notification's own `actions` field (optional, written
 * by `PushDeliveryService`/`resolveNotification` alongside the normal
 * `title`/`body`/`url` - see that file's own `extra` doc comment, and
 * `MessageService.postMessage()`'s own doc comment for why `extra` fields
 * land FLAT on the stored message, not nested) is used verbatim when
 * present - e.g. an incoming call's own Accept/Decline pair. Otherwise a
 * single generic "open" action links to `url`. Nothing here is call-
 * specific - a future notification type gets multi-action popups for free
 * just by writing its own `actions` array.
 */
import { watchChildren } from '@qu/reactive';
import { paths } from '@qu/services';
import { mountToastHost } from '@qu/ui';
import { createI18n } from '@qu/i18n';

const DICT = {
  en: { open: 'Open' },
  de: { open: 'Öffnen' },
};
const { t } = createI18n(DICT);

/**
 * @param {HTMLElement} container - Where the toast stack mounts (e.g. `document.body`).
 * @param {{qu: import('@qu/core').QuStore, services: object, subscribe?: (prefix: string) => void, syncFetch?: (prefix: string) => Promise<*>}} deps
 * @returns {() => void} stop
 */
export function mountNotificationPopups(container, { qu, services, subscribe, syncFetch }) {
  const { show, destroy } = mountToastHost(container);
  let stopped = false;
  let off = null;
  const sessionStartTs = Date.now();
  const seenIds = new Set();

  (async () => {
    const myPub = await services.actors.whoAmI();
    if (stopped) return;
    const spaceId = paths.notificationsSpaceId(myPub);
    // Defense in depth, same reasoning header.js's own subscribe?.() call documents.
    subscribe?.(paths.spacePath(spaceId));

    async function check() {
      if (stopped) return;
      const { messages } = await services.messages.listMessages(spaceId, paths.NOTIFICATIONS_THREAD_ID, { order: 'desc' });
      if (stopped) return;
      for (const m of messages) {
        if (m.ts <= sessionStartTs) continue;
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        const actions = Array.isArray(m.actions) && m.actions.length > 0
          ? m.actions
          : m.url ? [{ label: t('open'), href: m.url }] : [];
        show({ title: m.title, body: m.body, actions });
      }
    }

    off = watchChildren(qu, paths.threadMessagesParentPath(spaceId, paths.NOTIFICATIONS_THREAD_ID), check, { syncFetch });
  })();

  return () => {
    stopped = true;
    off?.();
    destroy();
  };
}
