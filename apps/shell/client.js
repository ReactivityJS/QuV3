/**
 * QUNIVERSE SHELL — the browser's actual entry point (served at `/` by
 * `@qu/relay`'s `serveShell` option, see `packages/relay/src/static-shell.js`).
 * Everything else built so far (`apps/app-list`/`user-list`/`contact-list`)
 * exports `mount(container, ctx)` to be embedded by SOMETHING ELSE; this
 * file IS that something else - the one composition root that constructs
 * `QuStore`/`QuIdentityEngine`/the client Services/the sync connection from
 * scratch, then hands the resulting `{qu, identity, services, apps, segments,
 * subscribe, syncFetch, extensionPoints, goBack}` context to whichever app
 * the current route selects. `goBack()` (see its own doc comment) lets a
 * mounted app return the user to wherever they actually came from - real
 * browser history when there is one, a given fallback route otherwise -
 * instead of every app hardcoding its own "always go to my own home route".
 * `extensionPoints` (`@qu/foundation`'s
 * `ExtensionPointHost`, see that file's own doc comment) is rebuilt fresh
 * every route dispatch from the SAME `apps` catalog fetch already happening
 * here - cheap (it does no work itself until a mounted app actually asks for
 * a `point`) and keeps it as current as the catalog itself, same freshness
 * the `apps` array handed to `mount()` already has.
 *
 * `createClientServices()` (`./src/services.js`) is this round's actual,
 * scoped-down `bootClientRuntime()` (docs/v3-technical-concept.md §7
 * Finding 5, `@qu/foundation`'s `runtime-container.js` deferred it to
 * "whichever of `@qu/relay`/`apps/shell` is built first") - kept LOCAL to
 * this app, not promoted into a shared package, until a second real caller
 * (e.g. a future `apps/demo`) needs the exact same wiring.
 *
 * Boot sequence: identity ready (onboarding if not, see `./src/onboarding.js`)
 * -> own profile published (mirrors `@qu/relay`'s own `#bootInner()`) ->
 * sync connected (best-effort - a browser without WebSocket, or a
 * temporarily unreachable relay, degrades to local-only rather than
 * crashing the whole shell) -> this identity's own device-agnostic
 * language/theme preference applied (best-effort, see the "IDENTITY-BOUND
 * PREFERENCES" note below) -> PWA install/update UI mounted (best-effort,
 * see `./src/pwa.js`) -> fixed header mounted (`./src/header.js` - Home
 * logo, Back/Forward, notification bell, user menu) -> route dispatched
 * (`./src/router.js` - `#/<appId>` dynamically `import()`s the app's
 * `clientMainUrl` from `/apps.json` and calls its `mount()`; `#/~<pub>` is a
 * reserved sigil, matching the real Qu's own profile-link convention -
 * dispatches to the `profile` catalog entry regardless of the normal
 * by-name lookup, `segments` passed through UNCHANGED so `apps/profile`
 * re-derives the pub itself from `segments[0]`, exactly the convention
 * QuV2's own shell used).
 *
 * IDENTITY-BOUND PREFERENCES (language, theme): `@qu/i18n`'s locale and
 * `@qu/ui`'s theme are both device-local by design (`setLocale()`/
 * `setStoredTheme()`, `localStorage`) - `createI18n()` is called
 * SYNCHRONOUSLY at every app's module top level, before `qu`/`identity`
 * even exist, so neither can become identity-aware without breaking that.
 * Instead, this identity's OWN private, self-encrypted preference (see
 * `ProfileService`'s own doc comment) is the source of truth, and gets
 * PROPAGATED into the existing device-local mechanism once, right here,
 * every time this identity boots on a (possibly new) device - the
 * device-local layer becomes this preference's propagation target, not a
 * competing setting. `apps/profile`'s Settings subpath writes both
 * (`saveProfile()` AND `setLocale()`/`setStoredTheme()` immediately, for
 * instant effect on the device that just changed it) - see that app's own
 * doc comment. Unset stays unset: if the profile never set a preference,
 * neither function is called here, and the existing browser-detection/
 * `DEFAULT_THEME` fallback applies exactly as before - no special-casing
 * needed for "fall back to default".
 *
 * PWA/UPDATER (`./src/pwa.js`, `./sw.js`, `./manifest.webmanifest`):
 * installable (a web app manifest + a service worker whose only job besides
 * that is making an "update available" moment observable at all - it does
 * NOT cache any app data, see `sw.js`'s own doc comment for why: Quniverse's
 * real data already lives in IndexedDB, synced over WebSocket, not a static
 * asset worth intercepting). `registerServiceWorker()`/`captureInstallPrompt()`
 * are called at the very TOP of `mount()` below, before any other boot
 * work - see that call site's own doc comment for why timing matters here.
 * The install/update UI itself (an "Install app" menu entry + a small
 * update icon, both folded into chrome that already exists, plus a text
 * "Apply update" entry alongside Install at the bottom of the menu) lives
 * inside `./src/header.js`, which receives the resulting state/callbacks as
 * this function's own `pwa` object rather than calling `./src/pwa.js`
 * itself. Web Push's actual subscribe flow (permission prompt +
 * `PushManager.subscribe()` + `services.pushSubscriptions`) lives in
 * `apps/profile/client.js`'s own Settings subpage instead (identity-bound
 * device preferences, the same place every other one lives) - `sw.js`'s own
 * `push`/`notificationclick` handlers are what actually SHOW a notification
 * once a subscription exists and a push arrives.
 *
 * DELIBERATELY NOT BUILT THIS ROUND (see the README's own status entry for
 * the full account): remote-app integrity verification for `import()`
 * (every app mounted here is loaded from THIS SAME relay, which already
 * decided to load it - see `apps-catalog-store.js`'s signer-verification
 * doc comment for why that's an already-trusted origin, same trust level as
 * any other same-origin script this page loads), a Space switcher (no app
 * built so far needs one), `apps/relay-admin`.
 */
import { QuStore } from '@qu/core';
import { IndexedDBAdapter } from '@qu/runtime/indexeddb';
import { QuIdentityEngine } from '@qu/identity';
import { createI18n, setLocale } from '@qu/i18n';
import { injectStyle, ensureTheme, setStoredTheme } from '@qu/ui';
import { createLogger, setLogLevel, getLogLevel } from '@qu/log';
import { ExtensionPointHost } from '@qu/foundation';
import { renderOnboarding } from './src/onboarding.js';
import { createClientServices } from './src/services.js';
import { connectToRelay } from './src/sync.js';
import { mountHeader } from './src/header.js';
import { mountChrome } from './src/chrome.js';
import { mountNotificationPopups } from './src/notification-popups.js';
import { registerServiceWorker, applyUpdate, captureInstallPrompt } from './src/pwa.js';
import { parseHash } from './src/router.js';

const log = createLogger('shell');

// Devtools convenience - `quLog.setLevel('debug')` in the console, no
// rebuild needed (persists via @qu/log's own localStorage read - see its
// own doc comment).
if (typeof window !== 'undefined') window.quLog = { setLevel: setLogLevel, getLevel: getLogLevel };

const DICT = {
  en: { home: 'Pick an app from the menu to get started.', appNotFound: 'App not found (or not enabled on this relay).' },
  de: { home: 'Wähle über das Menü eine App aus, um loszulegen.', appNotFound: 'App nicht gefunden (oder auf diesem Relay nicht aktiviert).' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-shell-style';
const STYLE = `
  body { margin: 0; font-family: system-ui, sans-serif; }
  .qu-shell-placeholder { padding: 2rem; text-align: center; opacity: 0.7; }
`;

function createDefaultQu() {
  const qu = new QuStore();
  qu.mount('store', new IndexedDBAdapter('qu-store'));
  qu.mount('blob', new IndexedDBAdapter('qu-blob'));
  return qu;
}

/**
 * @param {HTMLElement} container
 * @param {{qu?: import('@qu/core').QuStore, identity?: import('@qu/identity').QuIdentityEngine}} [deps] -
 *   Both injectable for tests (a `MemoryStoreAdapter`-backed `qu`, no real
 *   IndexedDB needed); production (no args) constructs real
 *   `IndexedDBAdapter`-backed ones.
 * @returns {Promise<() => void>} A stop function.
 */
export async function mount(container, { qu = createDefaultQu(), identity = new QuIdentityEngine(qu) } = {}) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let stopMountedApp = null;
  // See renderRoute()'s own doc comment - a monotonic epoch, bumped at the
  // start of every call, so a STALE call (superseded by a newer navigation
  // while it was still awaiting fetch()/import()/mount()) can tell it's
  // stale and bail out instead of racing the newer one for control of
  // `screen`/`stopMountedApp`.
  let navToken = 0;
  // How many routes THIS session has ever rendered (boot counts as one) -
  // what goBack() (below) uses to tell "there's a real in-app page behind
  // us" from "this tab/window started right here" (e.g. an OS push
  // notification's Accept action opens a BRAND NEW window with only that
  // one URL in its history - see goBack()'s own doc comment).
  let routeCount = 0;

  // PWA install/update - registered HERE, before any other boot work (not
  // inside mountHeader() below, which only runs after onboarding/profile/
  // sync/prefs/admin+apps fetches complete): `beforeinstallprompt` and a
  // service worker `updatefound` can both fire within moments of page load,
  // and a browser event listener attached late simply never sees an event
  // that already happened (see `./src/pwa.js`'s own doc comment) -
  // confirmed live, a prior version of this that called
  // `captureInstallPrompt()`/`registerServiceWorker()` from inside
  // `mountHeader()` sometimes missed both entirely. The resulting state and
  // callbacks are threaded into `mountHeader()` as `pwa` below, which
  // renders them whenever it itself eventually mounts - "when do we start
  // listening" and "when do we render" are deliberately decoupled.
  let updateRegistration = null;
  let updateAvailable = false;
  const updateListeners = new Set();
  registerServiceWorker({
    onUpdateAvailable: (registration) => {
      updateRegistration = registration;
      updateAvailable = true;
      for (const cb of updateListeners) cb();
    },
  });
  let installable = false;
  const installListeners = new Set();
  const { installApp } = captureInstallPrompt({
    onInstallable: () => {
      installable = true;
      for (const cb of installListeners) cb();
    },
  });
  const pwa = {
    getUpdateAvailable: () => updateAvailable,
    onUpdateAvailable: (cb) => updateListeners.add(cb),
    applyUpdate: () => applyUpdate(updateRegistration),
    getInstallable: () => installable,
    onInstallable: (cb) => installListeners.add(cb),
    installApp,
  };

  if (!(await identity.hasIdentity())) {
    const onboardRoot = document.createElement('div');
    container.appendChild(onboardRoot);
    await renderOnboarding(onboardRoot, identity);
    onboardRoot.remove();
  }
  if (stopped) return () => { stopped = true; };

  let sync = null;
  let transport = null;
  try {
    ({ sync, transport } = connectToRelay(qu));
  } catch (err) {
    log.warn('realtime sync unavailable in this environment:', err.message);
  }

  // Two DIFFERENT backfill shapes, both from the same `sync` - never
  // confuse them:
  //   - `fetchOne(path)` (-> SyncEngine.fetch()) - ONE document, what
  //     ListService/ProfileService's own `syncFetch` constructor params
  //     already expect (see services.js's own doc comment for why THIS
  //     round wires them for the first time).
  //   - `syncFetch(prefix)` (-> SyncEngine.fetchPrefix()) - MANY sibling
  //     documents under a prefix, what a DERIVED `<qu-list parent="...">`
  //     needs (see that element's own `.syncFetch` doc comment) - passed
  //     to every mounted app below.
  const fetchOne = (path) => sync?.fetch(path) ?? Promise.resolve(null);
  const syncFetch = (prefix) => sync?.fetchPrefix(prefix) ?? Promise.resolve();
  // Passed to every mounted app as `subscribe` (see e.g. apps/user-list's
  // own "defense in depth" use of it) - a no-op when sync never connected,
  // never a throw.
  const subscribe = (prefix) => sync?.subscribe(prefix);
  // TELEMETRY - a getter, not the raw `sync`/`transport` themselves (neither
  // is otherwise ever threaded into a mounted app's `ctx` - apps only ever
  // get the narrow `subscribe`/`syncFetch` closures above), so `apps/debug`'s
  // header badge and settings contribution can read live byte/rate counters
  // without this file handing out its own SyncEngine reference wholesale.
  // All-zero when sync never connected, same "no-op, never a throw" shape
  // every other sync-derived closure here already has.
  const syncStats = { getStats: () => sync?.getTransportStats() ?? { bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0 } };

  const services = createClientServices(qu, identity, { syncFetch: fetchOne, getGeneration: () => sync?.getGeneration() ?? 0 });

  // PRESENCE - ONE heartbeat for the whole session, started here (not by
  // apps/chat's own room-view mount anymore - see PresenceService's own top
  // doc comment on why presence is now user-centric, not room-centric),
  // independent of which app (if any) happens to be mounted or how many
  // chat rooms are open.
  //
  // PUSH ONLY WHILE ACTUALLY VISIBLE - gated by `document.visibilityState`,
  // not unconditional: `PushDeliveryService` (packages/relay/src/
  // push-delivery.js) skips sending a Web Push whenever `PresenceTracker.
  // isRecentlyOnline()` sees this identity's traffic as fresh (that tracker
  // is fed by `onPeerIdentified`, which fires on EVERY signed write this
  // identity sends - see `packages/sync/src/sync-engine.js`'s own doc
  // comment on that hook - so a heartbeat write is exactly the kind of
  // traffic that keeps it "fresh"). An UNGATED heartbeat would therefore
  // keep publishing 'online' - and so keep suppressing push - for as long
  // as this tab stays open at all, backgrounded or not. Stopping the
  // heartbeat the instant the tab backgrounds (`stopHeartbeat()` publishes
  // 'offline' immediately, same as it always has) closes that gap with no
  // new signal/protocol/relay change - the exact mechanism
  // `apps/chat/client.js` used to run PER ROOM VIEW before presence became
  // session-global; folded into the SAME `visibilitychange` listener the
  // mobile-foreground sync catch-up below already needs, so there is only
  // ever one such listener for the whole session.
  let stopHeartbeat = null;
  // MOBILE FOREGROUND CATCH-UP - see SyncEngine.refreshSubscriptions()'s own
  // doc comment for the exact gap this closes: backgrounding a mobile
  // browser/PWA does NOT reliably close the underlying WebSocket (the OS may
  // keep it alive, or a flaky network may let it go silently stale without
  // either side noticing), so a real transport 'reconnect' event - the thing
  // that would normally trigger a catch-up - may simply never fire even
  // though real time passed while suspended. Confirmed live: a chat room
  // left mounted through a phone screen lock never picked up messages sent
  // while it was locked, even after unlocking - only leaving and
  // re-entering the room (a fresh mount, with its own one-time subscribe +
  // catch-up) did. `visibilitychange` -> visible is the one reliable signal
  // "this page is back in front of a user" a browser gives regardless of
  // what the underlying connection actually did - treating it the same as a
  // reconnect (which is literally what refreshSubscriptions() does) closes
  // the gap for every mounted app's active subscriptions at once, no
  // per-app code needed.
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      stopHeartbeat?.().catch(() => {});
      stopHeartbeat = null;
    } else {
      sync?.refreshSubscriptions();
      if (!stopHeartbeat) stopHeartbeat = services.presence.startHeartbeat();
    }
  }
  onVisibilityChange(); // establish the initial heartbeat state - starts it now unless this tab is already backgrounded at boot
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Mirrors @qu/relay's own #bootInner() - a published profile is what
  // makes this identity's X25519 key resolvable by anyone else.
  const ownPub = await services.actors.whoAmI();
  if (!(await identity.getProfile(ownPub))) {
    await identity.publishMainProfile({});
  }

  // Propagate this identity's own device-agnostic language/theme
  // preference into the existing device-local mechanisms - see this file's
  // own "IDENTITY-BOUND PREFERENCES" doc comment above for the full
  // reasoning. Best-effort: a profile read failure degrades to "nothing
  // applied this boot", not a crash - the existing browser-detection/
  // DEFAULT_THEME fallback already covers that case correctly.
  try {
    const { preferredLocale, preferredTheme } = await services.profile.getOwnProfile();
    if (preferredLocale) setLocale(preferredLocale);
    if (preferredTheme) setStoredTheme(preferredTheme);
  } catch (err) {
    log.warn('could not read this identity\'s own language/theme preference:', err.message);
  }

  const headerRoot = document.createElement('div');
  container.appendChild(headerRoot);

  // `adminPubs` is this relay's own operator allowlist (see
  // `@qu/relay`'s `AdminHttp#verifyAdmin()`) - fetched here only so the
  // header's user menu knows whether to SHOW a Relay Admin link at all;
  // the real, enforced gate stays entirely server-side. `extensionOrder`
  // (relay-settings' admin-edited `{[point]: [id, ...]}` map, see
  // `@qu/foundation`'s `extension-order.js`) is fetched the SAME once-per-
  // page-load way - same accepted "won't reflect a live admin edit without
  // a reload" trade-off `adminPubs` itself already has - and threaded into
  // every `ExtensionPointHost` built below, so a point's configured order
  // renders identically regardless of which app happens to be mounted.
  // `iceServers` (this operator's own `RTCIceServer[]` list, see
  // `@qu/relay`'s `http-router.js` and `@qu/webrtc`'s `ice-config.js`) is
  // threaded into every mounted app's own `ctx` below, for apps built on
  // `@qu/webrtc`'s `WebRTCTransport` (e.g. `apps/geochase`) - unset/empty
  // just means those apps fall back to the built-in free STUN default.
  let adminPubs = [];
  let extensionOrder = {};
  let iceServers = [];
  let menuThreshold = 8; // DEFAULT_RELAY_SETTINGS.chrome.menuThreshold, see relay-settings.js
  try {
    const res = await fetch('/config.json');
    if (res.ok) {
      const data = await res.json();
      adminPubs = data.adminPubs ?? [];
      extensionOrder = data.settings?.extensionOrder ?? {};
      iceServers = data.iceServers ?? [];
      menuThreshold = data.settings?.chrome?.menuThreshold ?? menuThreshold;
    }
  } catch { /* offline/unreachable - header just shows no admin link, extension points fall back to their own default order/ICE servers/menuThreshold */ }

  // The platform-owned chrome (sidebar/footer nav, primaryAction, views,
  // settings) - mounted ONCE for the whole session, alongside the header.
  // Apps mount into `chrome.contentSlot` (same structural role `screen`
  // used to play) and drive their own chrome via `ctx.chrome.set()`
  // instead of calling `mountAppTemplate()` themselves - see
  // `./src/chrome.js`'s own doc comment for the full "Chrome Inversion"
  // reasoning (docs/v4-concept.md / the architecture-review plan). Mounted
  // AFTER the `/config.json` fetch above so `menuThreshold` reflects this
  // relay's own admin setting from the very first render, not a hardcoded
  // default that then never changes for the rest of the session (same
  // once-per-page-load staleness trade-off `extensionOrder`/`adminPubs`
  // already accept).
  const chrome = mountChrome(container, { qu, syncFetch, menuThreshold });

  // A boot-time snapshot of the SAME catalog `renderRoute()` re-fetches on
  // every navigation below - the header is mounted exactly once for the
  // whole session (see its own "SEARCH SLOT" doc comment), so a snapshot
  // this fresh is fine; an admin disabling/adding an app mid-session just
  // isn't reflected in the header's own `shell.headerAction` contributors
  // until next reload, same acceptable staleness `adminPubs` above already has.
  let bootApps = [];
  try {
    const res = await fetch('/apps.json');
    bootApps = res.ok ? await res.json() : [];
  } catch { /* offline/unreachable - header renders no shell.headerAction contributors, everything else still works */ }
  let stopHeader = null;
  try {
    stopHeader = mountHeader(headerRoot, { qu, services, adminPubs, subscribe, syncFetch, apps: bootApps, pwa, syncStats });
  } catch (err) {
    log.warn('shell header unavailable in this environment:', err.message);
  }

  // Popup/toast notifications - the "Zwischenlösung" in-app half of the
  // Phone app's incoming-call UX (see `apps/shell/src/notification-popups.js`'s
  // own doc comment). Best-effort, same reasoning as the header/PWA UI above:
  // a failure here just means no toasts pop this session, never a crash.
  // Its own boot-time `ExtensionPointHost` (same construction as
  // `renderRoute()`'s own per-route instance below, just built once here
  // since this watcher itself only ever mounts once per session, same as
  // the header) is what lets a "decline" toast action signal directly via
  // `content.notificationAction` instead of navigating - see
  // `notification-popups.js`'s own doc comment.
  let stopNotificationPopups = null;
  try {
    const notificationExtensionPoints = new ExtensionPointHost(bootApps, { extensionOrder });
    stopNotificationPopups = mountNotificationPopups(container, {
      qu, identity, services, apps: bootApps, extensionPoints: notificationExtensionPoints, subscribe, syncFetch,
    });
  } catch (err) {
    log.warn('notification popups unavailable in this environment:', err.message);
  }

  function renderPlaceholder(message) {
    chrome.contentSlot.textContent = '';
    const p = document.createElement('p');
    p.className = 'qu-shell-placeholder';
    p.textContent = message;
    chrome.contentSlot.appendChild(p);
  }

  /**
   * "Go back to wherever the user actually came from" - real browser
   * history when there IS a real prior in-app page (`routeCount > 1`,
   * see its own doc comment), a given fallback route otherwise. Handed to
   * every mounted app as `ctx.goBack` - built here, in the ONE place that
   * already tracks navigation, rather than each app inventing its own
   * "always go to my own home route" `goBack()` (apps/phone's old
   * behavior: hanging up always landed on `#/phone`, even if the call was
   * accepted from a toast while the user was reading a Forum thread or a
   * Chat room - see this plan's own "Zurück zur ursprünglichen Seite"
   * feedback). Hash routing pushes a real history entry on every change
   * (browser-native, nothing this app does explicitly), and this app's own
   * `hashchange` listener already re-renders whatever route `history.back()`
   * lands on - no new plumbing needed beyond counting how many routes this
   * session has rendered.
   * @param {string} [fallbackHash] - Used when there's no real in-app
   *   history to go back to (e.g. an OS push notification's "Accept" action
   *   opened a BRAND NEW window/tab whose history starts right at the call).
   */
  function goBack(fallbackHash = '#/') {
    if (routeCount > 1) window.history.back();
    else window.location.hash = fallbackHash;
  }

  /**
   * The `hashchange` handler - has TWO `await` points (the `/apps.json`
   * fetch, then the dynamic `import()`) before it ever touches `screen` or
   * calls `mod.mount()`. Nothing stops a SECOND `hashchange` firing while a
   * first call is still in either await (a fast double-navigation - e.g.
   * clicking a link twice, or one nav triggering another) - without a guard,
   * two concurrent calls race to build into the SAME `screen` node with no
   * ordering guarantee between them, and whichever's async chain resolves
   * LAST silently "wins" regardless of which one is actually current,
   * potentially leaving the other's in-flight `mod.mount()` call's own
   * returned stop function never captured/called. `navToken` (declared
   * alongside `stopped`/`stopMountedApp` above) closes that: each call
   * captures its own token at the very start, and bails out - without
   * touching `screen`, calling `renderPlaceholder()`, or assigning
   * `stopMountedApp` - the moment a NEWER call has since started. Same
   * `token`/`stopped` guard idiom already used throughout this codebase
   * (e.g. every app's own `renderToken` pattern, see
   * `docs/building-an-app.md` §9) - applied here to the one place it was
   * missing.
   */
  async function renderRoute() {
    const token = ++navToken;
    routeCount++;
    stopMountedApp?.();
    stopMountedApp = null;
    // A fresh chrome epoch for this navigation - clears whatever the
    // previous app registered (nav/views/settings/primaryAction) and hands
    // back a handle only THIS navigation may write through (see chrome.js's
    // own `begin()`/epoch doc comment - a late `.set()` call from a
    // torn-down view's forgotten watcher becomes a silent no-op, mirroring
    // the `navToken` guard already used throughout this function).
    const chromeHandle = chrome.begin();
    chrome.contentSlot.textContent = '';

    const { appId, segments } = parseHash(window.location.hash);
    if (!appId) { renderPlaceholder(t('home')); return; }
    // #/~<pub> is a reserved sigil (matching the real Qu's own profile-link
    // convention) meaning "show this identity's public profile" - always
    // dispatches to the `profile` catalog entry regardless of the normal
    // by-name lookup below; `segments` is passed through UNCHANGED (still
    // `['~<pub>']`) so apps/profile parses the pub back out of segments[0]
    // itself - the shell doesn't need to know what a pub even looks like
    // beyond this one prefix check.
    const catalogName = appId.startsWith('~') ? 'profile' : appId;

    let apps = [];
    try {
      const res = await fetch('/apps.json');
      apps = res.ok ? await res.json() : [];
    } catch { /* transient fetch failure - treated the same as "app not found" below */ }
    if (stopped || token !== navToken) return; // a newer navigation started while this fetch was in flight
    const app = apps.find((a) => a.name === catalogName);
    // `enabled === false` (an admin's `disabledApps`, see relay-settings.js)
    // is treated exactly like "not found" - the real enforced gate is still
    // server-side (a disabled app's OWN routes are just as reachable if a
    // client bypasses this check), but there's no reason for the shell's own
    // UI to knowingly mount something an admin just turned off.
    if (!app?.clientMainUrl || app.enabled === false) { renderPlaceholder(t('appNotFound')); return; }

    log.debug(`mounting app "${catalogName}"`);
    const mod = await import(/* @vite-ignore */ app.clientMainUrl);
    if (stopped || token !== navToken) return;
    // A contribute-only app (e.g. `apps/reactions`/`apps/pins` - live plugin
    // code for another app's extension point, no page of its own) ships a
    // clientMain with no `mount` export - still reachable in the App List
    // catalog (it has no way to opt out of being listed there today), so a
    // direct/mistaken navigation to it degrades to the same "not found"
    // placeholder rather than throwing on `mod.mount is not a function`.
    if (typeof mod.mount !== 'function') { renderPlaceholder(t('appNotFound')); return; }
    const extensionPoints = new ExtensionPointHost(apps, { extensionOrder });
    const stopFn = (await mod.mount(chrome.contentSlot, { qu, identity, services, apps, segments, subscribe, syncFetch, extensionPoints, iceServers, goBack, chrome: chromeHandle, syncStats })) ?? null;
    if (stopped || token !== navToken) {
      // A newer navigation already won control of `chrome.contentSlot`
      // while this mount() call was itself in flight - never leave this one
      // mounted (and its watches/subscriptions live) in the background.
      stopFn?.();
      return;
    }
    stopMountedApp = stopFn;
  }

  window.addEventListener('hashchange', renderRoute);
  await renderRoute();

  return () => {
    stopped = true;
    window.removeEventListener('hashchange', renderRoute);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    stopMountedApp?.();
    stopHeader?.();
    stopNotificationPopups?.();
    stopHeartbeat?.().catch(() => {});
    chrome.stop();
    transport?.close();
  };
}

// Self-boot in a real browser - `apps/shell/index.html` provides exactly
// this one element. Never fires in a test (jsdom tests build their own
// container without this specific id - see the established
// `makeContainer()` convention every other app's tests already use).
if (typeof document !== 'undefined') {
  const root = document.getElementById('quniverse-shell-root');
  if (root) mount(root);
}
