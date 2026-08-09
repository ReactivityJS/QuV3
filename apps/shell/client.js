/**
 * QUNIVERSE SHELL — the browser's actual entry point (served at `/` by
 * `@qu/relay`'s `serveShell` option, see `packages/relay/src/static-shell.js`).
 * Everything else built so far (`apps/app-list`/`user-list`/`contact-list`)
 * exports `mount(container, ctx)` to be embedded by SOMETHING ELSE; this
 * file IS that something else - the one composition root that constructs
 * `QuStore`/`QuIdentityEngine`/the client Services/the sync connection from
 * scratch, then hands the resulting `{qu, identity, services, apps, segments,
 * subscribe, syncFetch, extensionPoints}` context to whichever app the
 * current route selects. `extensionPoints` (`@qu/foundation`'s
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
 * see `./src/pwa.js`) -> nav mounted (`./src/nav.js`) -> route dispatched
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
 * asset worth intercepting). Still deliberately NOT built: Web Push's
 * actual subscribe flow (`packages/push`/`PushSubscriptionService` exist
 * server-side already, but nothing here ever calls
 * `PushManager.subscribe()` yet - a separate, larger feature needing its
 * own permission UI, not something "PWA + updater" itself requires).
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
import { mountNav } from './src/nav.js';
import { mountPwaUi } from './src/pwa.js';
import { parseHash } from './src/router.js';

const log = createLogger('shell');

// Devtools convenience - `quLog.setLevel('debug')` in the console, no
// rebuild needed (persists via @qu/log's own localStorage read - see its
// own doc comment).
if (typeof window !== 'undefined') window.quLog = { setLevel: setLogLevel, getLevel: getLogLevel };

const DICT = {
  en: { home: 'Pick an app above to get started.', appNotFound: 'App not found (or not enabled on this relay).' },
  de: { home: 'Wähle oben eine App aus, um loszulegen.', appNotFound: 'App nicht gefunden (oder auf diesem Relay nicht aktiviert).' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-shell-style';
const STYLE = `
  body { margin: 0; font-family: system-ui, sans-serif; }
  .qu-shell-screen { padding: 1rem; }
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

  const services = createClientServices(qu, identity, { syncFetch: fetchOne, getGeneration: () => sync?.getGeneration() ?? 0 });

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

  const pwaRoot = document.createElement('div');
  const navRoot = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'qu-shell-screen';
  container.append(pwaRoot, navRoot, screen);

  // Best-effort, same as everything else optional in this boot sequence -
  // see this file's own "PWA/UPDATER" doc comment above.
  try {
    mountPwaUi(pwaRoot);
  } catch (err) {
    log.warn('PWA install/update UI unavailable in this environment:', err.message);
  }

  let relayPub = null;
  try {
    const res = await fetch('/config.json');
    relayPub = res.ok ? (await res.json()).relayPub : null;
  } catch { /* offline/unreachable - nav just stays empty, everything else still works */ }
  if (relayPub) mountNav(navRoot, { qu, relayPub, syncFetch });

  function renderPlaceholder(message) {
    screen.textContent = '';
    const p = document.createElement('p');
    p.className = 'qu-shell-placeholder';
    p.textContent = message;
    screen.appendChild(p);
  }

  async function renderRoute() {
    stopMountedApp?.();
    stopMountedApp = null;
    screen.textContent = '';

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
    const app = apps.find((a) => a.name === catalogName);
    if (!app?.clientMainUrl) { renderPlaceholder(t('appNotFound')); return; }

    log.debug(`mounting app "${catalogName}"`);
    const mod = await import(/* @vite-ignore */ app.clientMainUrl);
    if (stopped) return;
    const extensionPoints = new ExtensionPointHost(apps);
    stopMountedApp = (await mod.mount(screen, { qu, identity, services, apps, segments, subscribe, syncFetch, extensionPoints })) ?? null;
  }

  window.addEventListener('hashchange', renderRoute);
  await renderRoute();

  return () => {
    stopped = true;
    window.removeEventListener('hashchange', renderRoute);
    stopMountedApp?.();
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
