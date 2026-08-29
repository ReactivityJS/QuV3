/**
 * SHELL HEADER — the fixed top bar: Home (the Quniverse logo, `/logo.svg`,
 * linking to `#`), browser Back/Forward, a live unread-count Notification
 * bell, and the signed-in identity's own avatar+name as the shell's one
 * main menu. Replaces the old plain app-icon strip (`./nav.js`, removed) -
 * browsing every app now lives at `#/app-list` (reachable from the menu),
 * and the fast path back to an app is favoriting it there.
 *
 * HISTORY BACK/FORWARD: every route change in this app is a plain
 * `location.hash = ...` assignment (see `client.js`/`router.js`), which the
 * browser already turns into a real `History` entry on its own - so "Back"/
 * "Forward" are exactly `history.back()`/`history.forward()`, no separate
 * history stack to maintain here.
 *
 * BELL BADGE: the exact gap `apps/notifications/client.js`'s own top doc
 * comment already flagged ("the underlying data already supports [a shell
 * nav badge] ... a separate, nav-level concern this app doesn't own") -
 * `MessageService.listMessages()` + `getLastReadAt()` over this identity's
 * own notifications thread (`paths.notificationsSpaceId()`/
 * `NOTIFICATIONS_THREAD_ID`), reactive via `watchChildren()`, the same
 * shape that app's own `render()` already uses. Unlike that app, the bell
 * never calls `markRead()` - only actually opening `#/notifications` counts
 * as "seen it".
 *
 * MAIN MENU: opens on avatar/name click, closes on an outside click, Escape,
 * or picking a link. Two groups, separated by one small divider:
 *   1. This identity's own favorited apps (`services.favorites.list()`,
 *      resolved against the same `/apps.json` catalog every other
 *      app-picking UI in this codebase reads for icon/label) - re-rendered
 *      live off the `qu:flag-changed` event `renderFlagToggle()` already
 *      broadcasts on every toggle (see `@qu/ui/flag-toggle.js` and
 *      `apps/app-list/client.js`, which is exactly where a favorite gets
 *      toggled today).
 *   2. Profile (`#/~<myPub>`), User Settings (`#/~<myPub>/settings` -
 *      `apps/profile`'s existing Settings subpage, also the mount point for
 *      that app's new `userSettings.contributions` extension point - see
 *      its own doc comment for how another app, or a future relay-level
 *      settings section, hooks a contribution in without this file knowing
 *      anything about it), App List (`#/app-list` - browse/favorite/flag
 *      every app), and Relay Admin (`#/relay-admin`, shown only when this
 *      identity's pub is in `/config.json`'s `adminPubs` - the same check
 *      `@qu/relay`'s `AdminHttp#verifyAdmin()` enforces server-side; this is
 *      just "worth showing the link", never the real gate). `apps/relay-admin`
 *      itself isn't built yet (see `apps/shell/client.js`'s own top doc
 *      comment's "DELIBERATELY NOT BUILT" list) - the link degrades to the
 *      same graceful "app not found" placeholder every other not-yet-loaded
 *      catalog entry already does. A final group, separated by its OWN
 *      divider and only rendered at all once at least one of its two
 *      entries applies - "Apply update" (text, only while an update is
 *      actually pending) and "Install app" (only once the browser has
 *      actually offered an install prompt) - see "PWA INSTALL/UPDATE" below.
 *
 * PWA INSTALL/UPDATE: `deps.pwa` (see `mountHeader()`'s own JSDoc) carries
 * the live state/callbacks `apps/shell/client.js` already set up by calling
 * `./pwa.js`'s `registerServiceWorker()`/`captureInstallPrompt()` as early
 * as possible in ITS OWN boot sequence (see that file's own doc comment on
 * why timing matters here) - this file only RENDERS that state, it never
 * calls `./pwa.js` itself. Two affordances, doubled for discoverability
 * (the user specifically asked for the update one to exist in both places,
 * not just the icon):
 *   - A small, otherwise-`hidden` icon button (🔄, right of the App Action
 *     Slot) that appears once an update is available - clicking it applies
 *     it directly from the header.
 *   - The SAME "apply update" action, in text form, as a menu entry (see
 *     "MAIN MENU" above) - easier to notice/explain than an icon alone,
 *     redundant on purpose.
 *   - "Install app" - menu-only (no header icon - installing is a one-time
 *     action, not something that needs a permanent header slot the way a
 *     recurring "check for updates" glance does).
 * All three replace what used to be a single, separate, always-in-the-DOM
 * bar under the header (`mountPwaUi()`, removed) - folded into chrome that
 * already exists instead of a permanent extra row.
 *
 * TWO HEADER EXTENSION POINTS (see `docs/app-navigation-standard.md` for the
 * full standard these are Rules 2): the header defines two separate
 * `@qu/foundation` `ExtensionPointHost.renderSlot()` points (same mechanism
 * `apps/forum`'s `content.messageActions`/etc. already use, just with the
 * HOST being this file instead of an app), each rendered ONCE - unlike the
 * per-route `extensionPoints` `apps/shell/client.js` rebuilds on every
 * navigation, this header is mounted exactly once for the whole session, so
 * its OWN `ExtensionPointHost` lives for that long too:
 *
 *   - `shell.headerAction` (`headerSlot`, right side, next to the bell) -
 *     for ALWAYS-VISIBLE, cross-app icons. `apps/search`'s
 *     `renderHeaderSearch` (a single 🔍 icon) is the one contributor.
 *   - `shell.headerNavPoints` (`navPointsSlot`, LEFT side, right after
 *     Back/Forward) - for CONDITIONAL, per-app "things you can create/do
 *     from here" (Calendar's "+ New event", Chat's "+ New group", ToDo's
 *     "+ New task", Forum's "New channel"/"New topic"), shown only while
 *     that app is the active one, via `@qu/ui`'s `mountAppHeaderAction()`
 *     (the "only while active" boilerplate) plus `renderNavPointsMenu()`
 *     (renders 1 item as a plain link, 2+ as a dropdown - see that file's
 *     own doc comment). Nothing here is app-specific - any app can
 *     contribute to either point.
 *
 * Since a contributor is mounted once but the ROUTE changes on every
 * navigation, both points' payload carries a live `getContext()`/
 * `onContextChange()` pair (a plain mutable `{appId, segments}` object plus
 * a listener list this file updates on every `hashchange`) instead of a
 * fresh payload per render - cheap (a plain object mutation and a DOM
 * attribute write, no re-import, no DOM churn) and avoids a second, ad hoc
 * "watch the route" mechanism. The payload also carries
 * `services`/`qu`/`subscribe`/`syncFetch` (the same ones this header itself
 * was built with) so a CONDITIONAL contributor can resolve its own data once
 * active, without a second trust surface - see the `renderSlot()` call
 * sites below.
 */
import { watch, watchChildren } from '@qu/reactive';
import { paths, formatActorLabel } from '@qu/services';
import { actorPath } from '@qu/identity';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderAvatarOrAsset } from '@qu/ui';
import { ExtensionPointHost } from '@qu/foundation';
import { parseHash } from './router.js';

const DICT = {
  en: {
    home: 'Home', back: 'Back', forward: 'Forward', notifications: 'Notifications',
    menu: 'Main menu', noFavorites: 'No favorite apps yet.',
    profile: 'Profile', settings: 'Settings', appList: 'App List', relayAdmin: 'Relay Admin',
    installApp: 'Install app', updateAvailable: 'Update available — click to reload', applyUpdate: 'Apply update',
  },
  de: {
    home: 'Start', back: 'Zurück', forward: 'Vor', notifications: 'Benachrichtigungen',
    menu: 'Hauptmenü', noFavorites: 'Noch keine favorisierten Apps.',
    profile: 'Profil', settings: 'Einstellungen', appList: 'App-Liste', relayAdmin: 'Relay-Admin',
    installApp: 'App installieren', updateAvailable: 'Update verfügbar — zum Neuladen klicken', applyUpdate: 'Update durchführen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-shell-header-style';
const STYLE = `
  body { padding-top: 3.25rem; }
  .qu-shell-header { position: fixed; top: 0; left: 0; right: 0; z-index: 500; display: flex; align-items: center; gap: 0.4rem; height: 3.25rem; padding: 0 0.75rem; background: canvas; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-shell-home { display: flex; align-items: center; padding: 0.2rem; border-radius: var(--qu-radius-sm, 0.3rem); flex-shrink: 0; }
  .qu-shell-home:hover { background: var(--qu-color-surface, #8882); }
  .qu-shell-home img { width: 1.9rem; height: 1.9rem; display: block; }
  .qu-shell-histbtn { background: none; border: none; cursor: pointer; font-size: 1.15em; line-height: 1; padding: 0.4rem 0.5rem; border-radius: var(--qu-radius-sm, 0.3rem); color: inherit; opacity: 0.75; flex-shrink: 0; }
  .qu-shell-histbtn:hover { background: var(--qu-color-surface, #8882); opacity: 1; }
  /* SLOTS - 'shell.headerNavPoints'/'shell.headerAction' (see this file's own
     "TWO HEADER EXTENSION POINTS" doc comment) render arbitrary, plugin-owned
     content into these two elements - min-width: 0 + overflow: hidden
     forces EVERY contributor (present or future) to yield to the row's
     actually available width instead of being able to blow it out, same
     structural guarantee regardless of how well-behaved any one contributor
     happens to be. Without this, a contributor rendering unbounded
     white-space: nowrap content (e.g. apps/debug's byte-rate badge) forces
     this slot to its own full content width, which - combined with every
     other item below ALSO having no flex-shrink: 0 before this fix - pushed
     the excess overflow onto .qu-shell-user (the main menu) instead, right
     off the edge of a narrow mobile viewport. Confirmed live: this is a
     "must never happen" regression, not a cosmetic one - the main menu is
     this app's only way to reach Settings/App List/Relay Admin. */
  .qu-shell-nav-slot { display: flex; align-items: center; min-width: 0; overflow: hidden; }
  .qu-shell-header-spacer { flex: 1; }
  .qu-shell-header-slot { display: flex; align-items: center; min-width: 0; overflow: hidden; }
  .qu-shell-update-btn { display: inline-flex; background: none; border: none; cursor: pointer; font-size: 1.1em; line-height: 1; padding: 0.35rem 0.5rem; border-radius: var(--qu-radius-sm, 0.3rem); color: inherit; flex-shrink: 0; }
  .qu-shell-update-btn:hover { background: var(--qu-color-surface, #8882); }
  .qu-shell-update-btn[hidden] { display: none; }
  .qu-shell-update-btn:disabled { opacity: 0.6; cursor: default; }
  .qu-shell-bell { position: relative; display: inline-flex; background: none; border: none; cursor: pointer; text-decoration: none; color: inherit; font-size: 1.2em; padding: 0.35rem 0.55rem; border-radius: var(--qu-radius-sm, 0.3rem); flex-shrink: 0; }
  .qu-shell-bell:hover { background: var(--qu-color-surface, #8882); }
  .qu-shell-badge { position: absolute; top: 0.05rem; right: 0.05rem; min-width: 1rem; height: 1rem; padding: 0 0.2rem; border-radius: 999px; background: var(--qu-color-danger, #c00); color: #fff; font-size: 0.62rem; font-weight: 700; line-height: 1rem; text-align: center; }
  /* THE MAIN MENU - flex-shrink: 0 is the actual fix (see the slots' own
     doc comment above): this must NEVER be the row's overflow valve, no
     matter what a header-action/nav-point contributor renders. min-width: 0
     alone (kept from before) only permits shrinking below content size - it
     does not by itself protect against being the element that DOES shrink;
     flex-shrink: 0 is what actually withholds this element from the
     browser's flex-shrink distribution entirely. */
  .qu-shell-user { position: relative; min-width: 0; flex-shrink: 0; }
  .qu-shell-user-btn { display: flex; align-items: center; gap: 0.4rem; max-width: 11rem; background: none; border: none; cursor: pointer; padding: 0.25rem 0.6rem 0.25rem 0.25rem; border-radius: 999px; color: inherit; font: inherit; }
  .qu-shell-user-btn:hover { background: var(--qu-color-surface, #8882); }
  .qu-shell-user-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.88em; }
  .qu-shell-menu { position: absolute; top: calc(100% + 0.4rem); right: 0; min-width: 14rem; background: canvas; color: canvastext; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); box-shadow: 0 0.5rem 1.4rem rgba(0,0,0,0.2); padding: 0.35rem; display: flex; flex-direction: column; gap: 0.05rem; }
  /* [hidden] and .qu-shell-menu have EQUAL selector specificity - without
     this, the browser's own [hidden] { display: none } UA rule loses the
     cascade tie to this stylesheet's later display: flex (confirmed live:
     a "closed" menu with .hidden === true stayed visually on top of the
     page, intercepting clicks on whatever was underneath it). */
  .qu-shell-menu[hidden] { display: none; }
  .qu-shell-menu a, .qu-shell-menu-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); text-decoration: none; color: inherit; font: inherit; background: none; border: none; cursor: pointer; text-align: left; width: 100%; box-sizing: border-box; }
  .qu-shell-menu a:hover, .qu-shell-menu-item:hover { background: var(--qu-color-surface, #8882); }
  .qu-shell-menu-divider { height: 1px; margin: 0.3rem 0.2rem; background: var(--qu-color-border, #8884); }
  .qu-shell-menu-empty { padding: 0.45rem 0.6rem; opacity: 0.6; font-size: 0.85em; }
`;

/**
 * @param {HTMLElement} container
 * @param {{qu: import('@qu/core').QuStore, services: object, adminPubs?: string[], subscribe?: (prefix: string) => void, syncFetch?: (prefix: string) => Promise<*>, apps?: object[], pwa?: {getUpdateAvailable?: () => boolean, onUpdateAvailable?: (cb: () => void) => void, applyUpdate?: () => void, getInstallable?: () => boolean, onInstallable?: (cb: () => void) => void, installApp?: () => Promise<boolean>}, syncStats?: {getStats: () => {bytesIn: number, bytesOut: number, rateIn: number, rateOut: number}}}} deps -
 *   `apps` is the SAME manifest catalog every routed app already receives as
 *   `ctx.apps` (see this file's own "TWO HEADER EXTENSION POINTS" doc
 *   comment) - defaults to `[]` so an existing caller that doesn't pass it
 *   yet just renders no `shell.headerAction`/`shell.headerNavPoints`
 *   contributors, never throws. `pwa` is `apps/shell/client.js`'s own
 *   already-listening `registerServiceWorker()`/`captureInstallPrompt()`
 *   state (see this file's own "PWA INSTALL/UPDATE" doc comment for why
 *   THAT file calls them, not this one) - every field defaults to an inert
 *   no-op/`false` so a caller that doesn't pass it (any existing test) just
 *   renders neither affordance, never throws. `syncStats` is threaded
 *   verbatim into the `shell.headerAction` payload below - see
 *   `apps/shell/client.js`'s own doc comment on it (`apps/debug`'s header
 *   badge contributor is the one consumer today).
 * @returns {() => void} A stop function.
 */
export function mountHeader(container, { qu, services, adminPubs = [], subscribe, syncFetch, apps = [], pwa = {}, syncStats }) {
  const {
    getUpdateAvailable = () => false,
    onUpdateAvailable = () => {},
    applyUpdate: doApplyUpdate = () => {},
    getInstallable = () => false,
    onInstallable = () => {},
    installApp = async () => false,
  } = pwa;
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  const header = document.createElement('div');
  header.className = 'qu-shell-header';

  const home = document.createElement('a');
  home.className = 'qu-shell-home';
  home.href = '#';
  home.title = t('home');
  home.setAttribute('aria-label', t('home'));
  const logoImg = document.createElement('img');
  logoImg.src = '/logo.svg';
  logoImg.alt = 'Quniverse';
  home.appendChild(logoImg);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'qu-shell-histbtn';
  backBtn.textContent = '←';
  backBtn.title = t('back');
  backBtn.setAttribute('aria-label', t('back'));
  backBtn.addEventListener('click', () => window.history.back());

  const forwardBtn = document.createElement('button');
  forwardBtn.type = 'button';
  forwardBtn.className = 'qu-shell-histbtn';
  forwardBtn.textContent = '→';
  forwardBtn.title = t('forward');
  forwardBtn.setAttribute('aria-label', t('forward'));
  forwardBtn.addEventListener('click', () => window.history.forward());

  const navPointsSlot = document.createElement('div');
  navPointsSlot.className = 'qu-shell-nav-slot';

  const spacer = document.createElement('div');
  spacer.className = 'qu-shell-header-spacer';

  const headerSlot = document.createElement('div');
  headerSlot.className = 'qu-shell-header-slot';

  // Hidden until a genuine update is actually available (see this file's
  // own "PWA INSTALL/UPDATE" doc comment below) - a small icon instead of a
  // permanent extra row, and never shown for the routine "first ever
  // install" case, only a real code update sitting behind a reload.
  const updateBtn = document.createElement('button');
  updateBtn.type = 'button';
  updateBtn.className = 'qu-shell-update-btn';
  updateBtn.textContent = '🔄';
  updateBtn.title = t('updateAvailable');
  updateBtn.setAttribute('aria-label', t('updateAvailable'));
  updateBtn.hidden = true;

  const bell = document.createElement('a');
  bell.className = 'qu-shell-bell';
  bell.href = '#/notifications';
  bell.title = t('notifications');
  bell.setAttribute('aria-label', t('notifications'));
  bell.textContent = '🔔';
  const badge = document.createElement('span');
  badge.className = 'qu-shell-badge';
  badge.hidden = true;
  bell.appendChild(badge);

  const userWrap = document.createElement('div');
  userWrap.className = 'qu-shell-user';
  // Ancestor `renderAvatarOrAsset()`'s `<qu-asset>` resolves via
  // `findAssetService()` - same "set on an ancestor before descendant
  // Custom Elements connect" discipline `apps/profile/client.js`'s own
  // `root.assetService` already establishes.
  userWrap.assetService = services.assets;

  const userBtn = document.createElement('button');
  userBtn.type = 'button';
  userBtn.className = 'qu-shell-user-btn';
  userBtn.setAttribute('aria-haspopup', 'true');
  userBtn.setAttribute('aria-expanded', 'false');
  const avatarSlot = document.createElement('span');
  const nameSlot = document.createElement('span');
  nameSlot.className = 'qu-shell-user-name';
  userBtn.append(avatarSlot, nameSlot);

  const menu = document.createElement('div');
  menu.className = 'qu-shell-menu';
  menu.hidden = true;

  userWrap.append(userBtn, menu);
  header.append(home, backBtn, forwardBtn, navPointsSlot, spacer, headerSlot, updateBtn, bell, userWrap);
  container.appendChild(header);

  // See this file's own "SEARCH SLOT" doc comment above - one
  // ExtensionPointHost for this header's whole lifetime, one renderSlot()
  // call (contributors mount their own DOM once), route changes propagated
  // via routeContext + contextListeners instead of a re-render per navigation.
  const extensionPoints = new ExtensionPointHost(apps);
  const routeContext = { appId: null, segments: [] };
  const contextListeners = new Set();
  function getContext() {
    return routeContext;
  }
  function onContextChange(cb) {
    contextListeners.add(cb);
  }
  function updateRouteContext() {
    const { appId, segments } = parseHash(window.location.hash);
    routeContext.appId = appId;
    routeContext.segments = segments;
    for (const cb of contextListeners) cb();
  }
  updateRouteContext();
  window.addEventListener('hashchange', updateRouteContext);
  // `services`/`qu`/`subscribe`/`syncFetch` ride along so a CONDITIONAL
  // contributor (see @qu/ui's `mountAppHeaderAction()`) can resolve its own
  // data once it becomes the active app - e.g. Calendar's "+ New event"
  // needs `services.flags` to find an editable calendar, Chat's "+ New
  // group" needs `services` for its own policy check. `apps/search`'s
  // existing contributor ignores the extra fields, so this is non-breaking.
  extensionPoints.renderSlot('shell.headerAction', headerSlot, { getContext, onContextChange, services, qu, subscribe, syncFetch, syncStats });
  // `shell.headerNavPoints` - a second, LEFT-aligned slot next to Back/Forward
  // (see this file's own "APP NAVIGATION POINTS SLOT" doc comment above).
  // Same mechanism, same payload shape as `shell.headerAction` above - a
  // contributor uses the same `@qu/ui` `mountAppHeaderAction()` helper (only
  // visible while active) plus `renderNavPointsMenu()` to render however
  // many items it contributes (1 = plain link, 2+ = a dropdown).
  extensionPoints.renderSlot('shell.headerNavPoints', navPointsSlot, { getContext, onContextChange, services, qu, subscribe, syncFetch });

  // PWA UPDATE/INSTALL - see this file's own "PWA INSTALL/UPDATE" doc
  // comment: `deps.pwa` is `apps/shell/client.js`'s already-listening state,
  // this only renders it. `getUpdateAvailable()`/`getInstallable()` are
  // checked immediately (in case either already fired before this header
  // even mounted, e.g. a fast beforeinstallprompt on a repeat visit) AND
  // subscribed to for whatever fires later - both cases matter, since which
  // one applies depends purely on timing this file has no control over.
  function showUpdateAvailable() {
    updateBtn.hidden = false;
    if (!menu.hidden) renderMenu();
  }
  if (getUpdateAvailable()) updateBtn.hidden = false; // no menu to re-render yet at this point in mountHeader() - the icon alone is enough here
  onUpdateAvailable(showUpdateAvailable);
  updateBtn.addEventListener('click', () => {
    updateBtn.disabled = true;
    doApplyUpdate();
  });

  // `installable` is read by renderMenu() below (rebuilt from scratch on
  // every open, see its own doc comment) - if installability changes while
  // the menu already happens to be open, re-render it in place so the entry
  // doesn't wait for a close/reopen to show up.
  let installable = getInstallable();
  onInstallable(() => {
    installable = true;
    if (!menu.hidden) renderMenu();
  });

  function closeMenu() {
    menu.hidden = true;
    userBtn.setAttribute('aria-expanded', 'false');
  }
  function onDocClick(e) {
    if (!userWrap.contains(e.target)) closeMenu();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') closeMenu();
  }
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);
  // Any link OR action button (e.g. "Install app") click inside the menu
  // should close it - simplest is a single delegated listener rather than
  // one per rendered item (the menu's own content is rebuilt from scratch
  // on every open, see renderMenu() below).
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a, .qu-shell-menu-item')) closeMenu();
  });

  // A promise, not a plain resolved-later variable: `renderMenu()` can run
  // from a click that happens BEFORE identity resolution below finishes
  // (confirmed in testing - a click synchronous with mount() otherwise saw
  // `myPub` still `null` and rendered nothing, with nothing left to ever
  // retrigger it) - awaiting the SAME promise here means an early click
  // still gets a fully populated menu, just a touch later, instead of a
  // permanently empty one.
  const myPubPromise = services.actors.whoAmI();
  let myPub = null;
  myPubPromise.then((pub) => { myPub = pub; });

  /**
   * Rebuilt from scratch on every open - favorites can have changed since
   * the last time this was shown. Uses `mountHeader()`'s own `apps` param
   * (the SAME boot-time catalog snapshot `shell.headerAction`/
   * `shell.headerNavPoints` already build their `ExtensionPointHost` from
   * above) for icon/label lookup - NOT a fresh `fetch('/apps.json')` per
   * open. An earlier version of this function shadowed that outer `apps`
   * with its own same-named local variable and re-fetched it over the
   * network on every single menu open - a real, confirmed bug: the catalog
   * was already sitting right here the whole time, so every open paid a
   * synchronous network round-trip (menu visibly opening EMPTY until it
   * resolved) for data that never needed fetching at all. Same accepted
   * "off by a reload, not live" staleness this file's own "TWO HEADER
   * EXTENSION POINTS" doc comment already documents for the exact same
   * `apps` snapshot.
   */
  async function renderMenu() {
    if (stopped) return;
    if (!myPub) myPub = await myPubPromise;
    if (stopped) return;
    menu.textContent = '';

    const byName = new Map(apps.map((a) => [a.name, a]));

    const favIds = await services.favorites.list();
    if (stopped) return;
    if (favIds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qu-shell-menu-empty';
      empty.textContent = t('noFavorites');
      menu.appendChild(empty);
    } else {
      for (const appId of favIds) {
        const entry = byName.get(appId);
        const link = document.createElement('a');
        link.href = `#/${appId}`;
        link.textContent = `${entry?.icon ?? '🧩'} ${entry?.label ?? appId}`;
        menu.appendChild(link);
      }
    }

    const divider = document.createElement('div');
    divider.className = 'qu-shell-menu-divider';
    menu.appendChild(divider);

    const profileLink = document.createElement('a');
    profileLink.href = `#/~${myPub}`;
    profileLink.textContent = `👤 ${t('profile')}`;

    const settingsLink = document.createElement('a');
    settingsLink.href = `#/~${myPub}/settings`;
    settingsLink.textContent = `⚙️ ${t('settings')}`;

    const appListLink = document.createElement('a');
    appListLink.href = '#/app-list';
    appListLink.textContent = `🧰 ${t('appList')}`;

    menu.append(profileLink, settingsLink, appListLink);

    if (adminPubs.includes(myPub)) {
      const adminLink = document.createElement('a');
      adminLink.href = '#/relay-admin';
      adminLink.textContent = `🛡️ ${t('relayAdmin')}`;
      menu.appendChild(adminLink);
    }

    // A final group, own divider, rendered only once at least one of its
    // two entries actually applies - never a permanently-visible disabled
    // one. "Apply update" is the SAME action the header's own update icon
    // performs, offered again here in text form since an icon alone is easy
    // to miss - deliberately redundant, not a replacement for it.
    const updateAvailableNow = getUpdateAvailable();
    if (updateAvailableNow || installable) {
      const pwaDivider = document.createElement('div');
      pwaDivider.className = 'qu-shell-menu-divider';
      menu.appendChild(pwaDivider);
    }
    if (updateAvailableNow) {
      const applyUpdateBtn = document.createElement('button');
      applyUpdateBtn.type = 'button';
      applyUpdateBtn.className = 'qu-shell-menu-item';
      applyUpdateBtn.textContent = `🔄 ${t('applyUpdate')}`;
      applyUpdateBtn.addEventListener('click', () => {
        applyUpdateBtn.disabled = true;
        doApplyUpdate();
      });
      menu.appendChild(applyUpdateBtn);
    }
    if (installable) {
      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.className = 'qu-shell-menu-item';
      installBtn.textContent = `⬇️ ${t('installApp')}`;
      installBtn.addEventListener('click', async () => {
        installBtn.disabled = true;
        await installApp(); // one-shot regardless of outcome - the native prompt won't fire again either way
        installable = false;
      });
      menu.appendChild(installBtn);
    }
  }

  userBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    userBtn.setAttribute('aria-expanded', String(opening));
    if (opening) renderMenu();
  });

  function onFlagChanged(e) {
    if (!menu.hidden && e.detail?.flagType === 'favorite' && e.detail?.entityKind === 'app') renderMenu();
  }
  window.addEventListener('qu:flag-changed', onFlagChanged);

  let off = null;
  let offBadge = null;
  let badgeToken = 0;
  async function updateBadge(spaceId) {
    const token = ++badgeToken;
    const [{ messages }, lastReadAt] = await Promise.all([
      services.messages.listMessages(spaceId, paths.NOTIFICATIONS_THREAD_ID, { order: 'desc' }),
      services.messages.getLastReadAt(spaceId, paths.NOTIFICATIONS_THREAD_ID),
    ]);
    if (stopped || token !== badgeToken) return;
    const unread = messages.filter((m) => m.ts > lastReadAt).length;
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
  }

  // Kept as a mutable reference, not the original `avatarSlot` constant:
  // every re-render below REPLACES the mounted avatar element wholesale
  // (renderAvatarOrAsset() returns a fresh node each time), so the node to
  // replace next has to track whatever is actually in the DOM right now.
  let mountedAvatarEl = avatarSlot;
  function applyOwnProfile(profile) {
    if (stopped) return;
    const label = formatActorLabel(myPub, profile ?? {});
    nameSlot.textContent = label;
    userBtn.title = `${label} — ${t('menu')}`;
    const nextAvatarEl = renderAvatarOrAsset(myPub, label, profile?.avatar, { size: '1.7rem' });
    mountedAvatarEl.replaceWith(nextAvatarEl);
    mountedAvatarEl = nextAvatarEl;
  }

  (async () => {
    myPub = await myPubPromise;
    if (stopped) return;

    applyOwnProfile(await services.profile.getOwnProfile());
    if (stopped) return;

    // Live-updates the name/avatar shown here the moment this identity's
    // own alias/avatar changes (e.g. edited in apps/profile's Settings, on
    // THIS device or synced in from another one) - watch() re-delivers on
    // every write to the public profile document, no reload needed. Goes
    // back through getOwnProfile() rather than reading the watched value
    // directly: the stored document is a signed `{profile, signature}`
    // envelope (see @qu/identity's `publishMainProfile()`/`getProfile()`),
    // and getOwnProfile() is where that verification + private-field merge
    // already lives - watch() here is only the "something changed, go
    // re-resolve" trigger, same division of labor as `updateBadge()` below.
    off = watch(qu, actorPath(myPub, 'profile'), () => {
      if (stopped) return;
      services.profile.getOwnProfile().then(applyOwnProfile);
    }, { initial: false, syncFetch });

    const spaceId = paths.notificationsSpaceId(myPub);
    // Defense in depth, same reasoning apps/notifications/client.js's own
    // subscribe?.() call already documents.
    subscribe?.(paths.spacePath(spaceId));
    offBadge = watchChildren(qu, paths.threadMessagesParentPath(spaceId, paths.NOTIFICATIONS_THREAD_ID), () => updateBadge(spaceId), { syncFetch });
  })();

  return () => {
    stopped = true;
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('qu:flag-changed', onFlagChanged);
    window.removeEventListener('hashchange', updateRouteContext);
    off?.();
    offBadge?.();
  };
}
