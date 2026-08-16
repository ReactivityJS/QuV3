/**
 * SERVICE WORKER — exists for exactly two reasons: PWA installability
 * (some browsers require a `fetch` handler before they'll offer "Add to
 * Home Screen" at all) and the update-available flow `apps/shell/src/
 * pwa.js` drives from the browser page side.
 *
 * Deliberately NOT an offline data cache: Quniverse's actual data lives in
 * IndexedDB, synced over WebSocket (see `apps/shell/src/sync.js`) - none of
 * that is a static asset worth intercepting here, and caching it would just
 * be a second, harder-to-invalidate copy of state `@qu/sync` already owns.
 * `fetch` below is a pure pass-through for exactly that reason.
 *
 * `SW_VERSION` is replaced with a real content hash by `scripts/
 * build-apps.mjs` (derived from `dist/shell-bundle.js`'s own bytes) when
 * this file is copied to `apps/shell/dist/sw.js` - see that script's own
 * comment. Without SOME byte actually changing between deploys, a browser
 * would never notice a new service worker exists at all, and the whole
 * update flow below would never fire - a hand-maintained version string
 * (what this file would otherwise need) is exactly the kind of thing that's
 * easy to forget to bump.
 *
 * `push`/`notificationclick` (below): the browser decrypts a Web Push
 * message before this handler ever sees it (aes128gcm, RFC 8291) - `event.
 * data.json()` is already the plain object `@qu/relay`'s `PushDeliveryService`
 * sent (`{title, body, appId, url, actions?}`, see `packages/push/src/send.js`'s
 * own doc comment for why that's always a generic, never-the-actual-content
 * template). `notificationclick` focuses an ALREADY-OPEN tab on this origin
 * rather than always opening a new one - a user with the app already open
 * in another tab almost certainly wants that tab brought forward, not a
 * second copy of the whole app.
 *
 * MULTI-BUTTON NOTIFICATIONS (`actions`, e.g. Phone's own incoming-call
 * Accept/Decline - see `packages/relay/src/push-delivery.js`'s own doc
 * comment): the Notification API's own `actions` option only accepts
 * `{action, title, icon?}` - it has no notion of a per-button destination
 * URL, so THAT part (`payload.actions[].url`) is stashed in `data.actions`
 * (this worker's own bookkeeping, never shown to the platform) instead,
 * alongside the existing default `data.url`. `notificationclick`'s
 * `event.action` is the clicked button's `action` id, or `''` (empty
 * string) when the user clicked the notification body itself rather than a
 * button - only a non-empty `event.action` looks up a specific button's
 * url in `data.actions`; the empty-string/body-click case falls through to
 * `data.url` exactly as it always has.
 *
 * Bare `console.*`, not `@qu/log`: this file runs in the separate
 * ServiceWorkerGlobalScope and is served completely unbundled (no bare
 * `@qu/*` import would resolve here) - same reasoning as every other
 * unbundled file in this repo (e.g. every app's own `index.js`).
 */
const SW_VERSION = '__SW_VERSION__';

self.addEventListener('install', () => {
  console.log(`[sw ${SW_VERSION}] installed, waiting for SKIP_WAITING`);
});

self.addEventListener('activate', (event) => {
  console.log(`[sw ${SW_VERSION}] activated`);
  event.waitUntil(self.clients.claim());
});

// No automatic self.skipWaiting() on install - see this file's own doc
// comment on pwa.js's update-available flow: skipping automatically here
// would mean an update takes over silently, with no "new version
// available" moment for the page to ever observe or ask the user about.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch (err) {
    console.error(`[sw ${SW_VERSION}] push event with unparsable payload:`, err);
    return;
  }
  if (!payload) return;
  const { title = 'Quniverse', body = '', url = '/', actions = [] } = payload;
  // data.url/data.actions (read back in notificationclick below) -
  // showNotification() itself has no "what to do on click" concept, only
  // whatever this worker chooses to do with the event afterward. The
  // platform-facing `actions` option is `{action, title}` only (see this
  // file's own "MULTI-BUTTON NOTIFICATIONS" doc comment above) - each
  // button's real destination stays in `data.actions`, never handed to the
  // platform itself.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url, actions },
      actions: actions.map(({ action, title: buttonTitle }) => ({ action, title: buttonTitle })),
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const clickedAction = event.notification.data?.actions?.find((a) => a.action === event.action);
  const rawUrl = clickedAction?.url ?? event.notification.data?.url ?? '/';
  // `rawUrl` is always a bare hash (`#/forum/t/<id>/m/<id>`, see
  // push-delivery.js's own `resolveNotification`/`#genericNotification()` -
  // this app is a single hash-routed page, there's no separate server-side
  // route per app). Both `WindowClient.navigate()` and `Clients.
  // openWindow()` resolve a relative URL against THIS SCRIPT's own location
  // (`self.location`, e.g. `/dist/sw.js`), NEVER the page being navigated -
  // a bare hash therefore resolved to the SERVICE WORKER'S OWN SOURCE FILE
  // with the hash tacked on, and THAT'S what actually opened - confirmed,
  // reported live as "clicking a notification opens the service worker
  // source instead of the message." Resolving explicitly against
  // `self.location.origin` (the site's real root, where the SPA itself is
  // served) fixes both call sites at once.
  const url = new URL(rawUrl, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Prefer an ALREADY-OPEN tab on this origin - focus() it and navigate
      // to the notification's own target, rather than always spawning a
      // second tab; same-origin is guaranteed (a service worker only ever
      // sees clients it itself controls).
      for (const client of clientsList) {
        await client.focus();
        if ('navigate' in client) await client.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
