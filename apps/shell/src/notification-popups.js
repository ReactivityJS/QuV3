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
 * ACTIONS: a stored notification's own `actions` field (optional, written by
 * `PushDeliveryService`/`resolveNotification` alongside the normal `title`/
 * `body`/`url` - see that file's own `extra` doc comment) is shaped
 * `{action, title, url}` - the SAME shape the native Web Push `Notification`
 * API needs (see `apps/shell/sw.js`'s own `notificationclick` handler,
 * which reads exactly this). `@qu/ui`'s `toast.js` needs a DIFFERENT shape
 * (`{label, href, onClick, tone, icon}`) - `#toToastAction()` below is the
 * one place that translates between them. Missing that translation was a
 * real, shipped bug: both buttons rendered blank and identical, and
 * clicking either just closed the toast without ever navigating or
 * signaling anything (see this plan's own "Bugfix-Runde" section for the
 * full incident - an Accept click silently doing nothing looked exactly
 * like the call being declined).
 *
 * `'accept'` stays a plain navigation (`href`) - switching into the call UI
 * IS what accepting should do. `'decline'` deliberately does NOT navigate -
 * it fires `content.notificationAction` (an `apps/phone`-contributed
 * handler, see that app's own `handleNotificationAction()` doc comment)
 * directly, so declining just signals and closes the popup, leaving the
 * user wherever they already were. Any OTHER action id (none exist today,
 * but a future notification type might add one) falls back to `href`
 * navigation, the same safe default `'accept'` uses - deliberately NOT
 * calling into `content.notificationAction` for unknown ids, since that
 * point is scoped to "signal without navigating", not a general click hook.
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
 * @param {{action: string, title: string, url: string}} action - the stored,
 *   push-delivery-shaped action.
 * @param {{qu: object, identity: object, apps: Array<object>, extensionPoints: object|null, iceServers?: Array<object>}} ctx
 * @returns {{label: string, href?: string, onClick?: () => void, tone?: string, icon?: string}}
 */
function toToastAction(action, { qu, identity, apps, extensionPoints, iceServers }) {
  if (action.action === 'accept') {
    return { label: action.title, href: action.url, tone: 'positive', icon: '📞' };
  }
  if (action.action === 'decline') {
    return {
      label: action.title,
      tone: 'danger',
      icon: '📵',
      onClick: () => {
        extensionPoints?.collect('content.notificationAction', {
          actionId: action.action, url: action.url, qu, identity, apps, iceServers,
        });
      },
    };
  }
  return { label: action.title, href: action.url };
}

/**
 * @param {HTMLElement} container - Where the toast stack mounts (e.g. `document.body`).
 * @param {{qu: import('@qu/core').QuStore, identity: import('@qu/identity').QuIdentityEngine, services: object, apps?: Array<object>, extensionPoints?: object, iceServers?: Array<object>, subscribe?: (prefix: string) => void, syncFetch?: (prefix: string) => Promise<*>}} deps
 * @returns {() => void} stop
 */
export function mountNotificationPopups(container, { qu, identity, services, apps, extensionPoints, iceServers, subscribe, syncFetch }) {
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
          ? m.actions.map((a) => toToastAction(a, { qu, identity, apps, extensionPoints, iceServers }))
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
