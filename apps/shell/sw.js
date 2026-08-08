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
 * No `push`/`notificationclick` handlers this round - nothing in
 * `apps/shell` ever calls `PushManager.subscribe()` yet (`packages/push`/
 * `@qu/services`' `PushSubscriptionService` exist server-side, waiting for
 * a real client caller, same "hook built, no caller wired it up yet"
 * pattern as `ProfileService`'s own `syncFetch` parameter before
 * `apps/shell` existed) - a handler here would never receive anything.
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
