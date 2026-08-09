/**
 * PWA — installability (`beforeinstallprompt` capture) and the
 * update-available flow driven from the browser page side, paired with
 * `apps/shell/sw.js` (the service worker itself - see that file's own doc
 * comment for why it does NOT cache any app data) and `apps/shell/
 * manifest.webmanifest` (the web app manifest `index.html` links to).
 *
 * UPDATE FLOW: `sw.js` deliberately does NOT call `skipWaiting()`
 * automatically on install - a new worker sits in `.waiting` until this
 * module explicitly tells it to take over, which is what makes an
 * observable "update available" moment possible at all (an automatic
 * takeover would just swap code under a running page with no notice).
 * `registerServiceWorker()` distinguishes a GENUINE update (a second
 * worker installs while an earlier one is already controlling the page)
 * from the very first installation (nothing controls the page yet) -
 * only the former ever fires `onUpdateAvailable()`. `applyUpdate()` posts
 * the message that lets the waiting worker call `skipWaiting()` itself
 * (see `sw.js`); the resulting `controllerchange` event reloads the page
 * exactly once so the new worker (and, via `static-apps.js`/
 * `static-shell.js`'s `cache-control: no-cache`, a genuinely fresh
 * `shell-bundle.js`) actually takes effect.
 *
 * Every exported function is best-effort and silently does nothing if the
 * browser lacks the underlying API (`navigator.serviceWorker`,
 * `beforeinstallprompt` support) - same "an optional browser feature
 * degrades gracefully, never crashes the shell" pattern `client.js`'s own
 * `connectToRelay()`/`/config.json` handling already uses. This also means
 * every one of these calls is a silent no-op under jsdom (used by every
 * test in this repo), with no test-only branching needed in the functions
 * themselves.
 *
 * Deliberately NOT ported from the prototype this is rebuilt from: the
 * "install the current hash route as its own shortcut" deep-link variant
 * (a Blob-built manifest copy with `start_url` swapped to the current
 * route) - a standalone feature nobody has asked for yet, not a piece this
 * round's actual ask ("PWA, updater") needs.
 */
import { createLogger } from '@qu/log';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const log = createLogger('shell:pwa');

const DICT = {
  en: { updateAvailable: 'Update available — reload', installApp: 'Install app' },
  de: { updateAvailable: 'Update verfügbar — neu laden', installApp: 'App installieren' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-shell-pwa-style';
const STYLE = `
  .qu-pwa-bar { display: flex; gap: 0.5rem; padding: 0.4rem 0.8rem; border-bottom: 1px solid var(--qu-color-border, #8884); background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 10%, transparent); }
  /* Without this, bar.hidden = true (the default, until something is
     actually actionable - see mountPwaUi()) would have no visual effect: a
     plain author-stylesheet class selector beats the UA's own [hidden]
     rule at equal specificity, so an empty, permanently-visible bar with
     its own border/background would show on every single page load. */
  .qu-pwa-bar[hidden] { display: none; }
  .qu-pwa-bar button { padding: 0.3rem 0.7rem; border-radius: var(--qu-radius-sm, 0.3rem); border: 1px solid var(--qu-color-border, #8884); background: var(--qu-color-accent, #5b5bd6); color: white; cursor: pointer; font: inherit; }
  .qu-pwa-bar button:disabled { opacity: 0.6; cursor: default; }
`;

/**
 * Registers `/sw.js` and reports genuine updates (not first installs).
 * @param {{onUpdateAvailable?: (registration: ServiceWorkerRegistration) => void}} [options]
 */
export function registerServiceWorker({ onUpdateAvailable } = {}) {
  if (!navigator.serviceWorker) return; // unsupported browser - no PWA update flow, nothing else degrades

  // `Clients.claim()` (see sw.js's own `activate` handler) fires
  // `controllerchange` even the very FIRST time this page transitions from
  // "no controller at all" to "controlled" - that is NOT a genuine code
  // update (nothing this page was already running just got replaced), so
  // it must never trigger a reload. Confirmed live: without this guard, a
  // freshly onboarded browser reloads itself once, completely unprompted,
  // the moment its very first service worker finishes activating - if that
  // race lands while the page is ALREADY mid-reload for an unrelated
  // reason (e.g. `apps/profile`'s own theme/language "Reload now"), the
  // boot sequence can restart before it ever finishes, which is exactly
  // what surfaces as a page that appears to hang on load. Snapshotting
  // `.controller` here, before `.register()` even runs, mirrors the same
  // "was this page already controlled" check `watchInstalling()` below
  // already uses to tell a genuine update apart from a first install.
  const hadControllerAtBoot = Boolean(navigator.serviceWorker.controller);

  // Scoped to THIS call, not module-level: a real page calls this exactly
  // once per load (so this is effectively "once ever" there too), and it
  // keeps every test in this file independent - a fresh call always starts
  // with a fresh "haven't reloaded yet" state.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadControllerAtBoot) return;
    reloaded = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('/sw.js').then((registration) => {
    function watchInstalling(installing) {
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // `navigator.serviceWorker.controller` already being set is what
        // distinguishes THIS install from the very first one ever (nothing
        // controls a page before its first service worker activates) - only
        // the former is a genuine "the running page is now outdated" event.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          onUpdateAvailable?.(registration);
        }
      });
    }
    registration.addEventListener('updatefound', () => watchInstalling(registration.installing));
    // A worker may already be sitting in `.waiting` from an update that
    // fired on an EARLIER page load the user never actually applied -
    // surface it again now rather than leaving it silently stuck forever.
    if (registration.waiting && navigator.serviceWorker.controller) onUpdateAvailable?.(registration);
  }).catch((err) => log.warn('service worker registration failed:', err.message));
}

/** @param {ServiceWorkerRegistration|null|undefined} registration */
export function applyUpdate(registration) {
  registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
}

/**
 * Captures the browser's install prompt (fired at most once per page load,
 * per the spec) so a caller can offer its own "Install app" button instead
 * of relying on browser-chrome-specific UI.
 * @param {{onInstallable?: () => void}} [options]
 * @returns {{installApp: () => Promise<boolean>}} `installApp()` shows the
 *   captured prompt and resolves to whether the user accepted; resolves to
 *   `false` immediately if no prompt was ever captured (unsupported
 *   browser, or called twice - the native prompt is one-shot).
 */
export function captureInstallPrompt({ onInstallable } = {}) {
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    onInstallable?.();
  });
  return {
    async installApp() {
      if (!deferred) return false;
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      return outcome === 'accepted';
    },
  };
}

/**
 * A single, unobtrusive bar shown only once something is actually
 * actionable - hidden entirely otherwise (not two permanently-visible,
 * mostly-disabled buttons).
 * @param {HTMLElement} container
 */
export function mountPwaUi(container) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);

  const bar = document.createElement('div');
  bar.className = 'qu-pwa-bar';
  bar.hidden = true;

  const updateBtn = document.createElement('button');
  updateBtn.type = 'button';
  updateBtn.textContent = t('updateAvailable');
  updateBtn.hidden = true;

  const installBtn = document.createElement('button');
  installBtn.type = 'button';
  installBtn.textContent = t('installApp');
  installBtn.hidden = true;

  bar.append(updateBtn, installBtn);
  container.appendChild(bar);

  function syncBarVisibility() {
    bar.hidden = updateBtn.hidden && installBtn.hidden;
  }

  let registration = null;
  registerServiceWorker({
    onUpdateAvailable: (reg) => {
      registration = reg;
      updateBtn.hidden = false;
      syncBarVisibility();
    },
  });
  updateBtn.addEventListener('click', () => {
    updateBtn.disabled = true;
    applyUpdate(registration);
  });

  const { installApp } = captureInstallPrompt({
    onInstallable: () => {
      installBtn.hidden = false;
      syncBarVisibility();
    },
  });
  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    await installApp(); // one-shot regardless of outcome - the native prompt won't fire again either way
    installBtn.hidden = true;
    installBtn.disabled = false;
    syncBarVisibility();
  });
}
