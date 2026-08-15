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
 *      catalog entry already does.
 *
 * APP ACTION SLOT (`shell.headerAction`, see `docs/app-navigation-standard.md`
 * for the full standard this is Rule 2 of): the header itself defines this
 * one extension point (`@qu/foundation`'s `ExtensionPointHost.renderSlot()`,
 * same mechanism `apps/forum`'s `content.messageActions`/etc. already use,
 * just with the HOST being this file instead of an app) and renders it
 * ONCE, unlike the per-route `extensionPoints` `apps/shell/client.js`
 * rebuilds on every navigation - this header is mounted exactly once for
 * the whole session, so its OWN `ExtensionPointHost` lives for that long
 * too. `apps/search` is the one ALWAYS-VISIBLE contributor (its
 * `renderHeaderSearch` mounts a single 🔍 icon); `apps/calendar`/`apps/chat`
 * are CONDITIONAL contributors (a "+ New event"/"+ New group" icon, shown
 * only while that app is the active one) via `@qu/ui`'s
 * `mountAppHeaderAction()` helper - nothing here is app-specific, any app
 * can contribute a header icon either way. Since the contributed widget is
 * mounted once but the ROUTE changes on every navigation, the payload
 * carries a live `getContext()`/`onContextChange()` pair (a plain mutable
 * `{appId, segments}` object plus a listener list this file updates on
 * every `hashchange`) instead of a fresh payload per render - cheap (a
 * plain object mutation and a DOM attribute write, no re-import, no DOM
 * churn) and avoids a second, ad hoc "watch the route" mechanism. The
 * payload also carries `services`/`qu`/`subscribe`/`syncFetch` (the same
 * ones this header itself was built with) so a CONDITIONAL contributor can
 * resolve its own data once active, without a second trust surface - see
 * the `renderSlot()` call site below.
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
  },
  de: {
    home: 'Start', back: 'Zurück', forward: 'Vor', notifications: 'Benachrichtigungen',
    menu: 'Hauptmenü', noFavorites: 'Noch keine favorisierten Apps.',
    profile: 'Profil', settings: 'Einstellungen', appList: 'App-Liste', relayAdmin: 'Relay-Admin',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-shell-header-style';
const STYLE = `
  body { padding-top: 3.25rem; }
  .qu-shell-header { position: fixed; top: 0; left: 0; right: 0; z-index: 500; display: flex; align-items: center; gap: 0.4rem; height: 3.25rem; padding: 0 0.75rem; background: canvas; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-shell-home { display: flex; align-items: center; padding: 0.2rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-shell-home:hover { background: var(--qu-color-surface, #8882); }
  .qu-shell-home img { width: 1.9rem; height: 1.9rem; display: block; }
  .qu-shell-histbtn { background: none; border: none; cursor: pointer; font-size: 1.15em; line-height: 1; padding: 0.4rem 0.5rem; border-radius: var(--qu-radius-sm, 0.3rem); color: inherit; opacity: 0.75; }
  .qu-shell-histbtn:hover { background: var(--qu-color-surface, #8882); opacity: 1; }
  .qu-shell-header-spacer { flex: 1; }
  .qu-shell-header-slot { display: flex; align-items: center; }
  .qu-shell-bell { position: relative; display: inline-flex; background: none; border: none; cursor: pointer; text-decoration: none; color: inherit; font-size: 1.2em; padding: 0.35rem 0.55rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-shell-bell:hover { background: var(--qu-color-surface, #8882); }
  .qu-shell-badge { position: absolute; top: 0.05rem; right: 0.05rem; min-width: 1rem; height: 1rem; padding: 0 0.2rem; border-radius: 999px; background: var(--qu-color-danger, #c00); color: #fff; font-size: 0.62rem; font-weight: 700; line-height: 1rem; text-align: center; }
  .qu-shell-user { position: relative; min-width: 0; }
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
 * @param {{qu: import('@qu/core').QuStore, services: object, adminPubs?: string[], subscribe?: (prefix: string) => void, syncFetch?: (prefix: string) => Promise<*>, apps?: object[]}} deps -
 *   `apps` is the SAME manifest catalog every routed app already receives as
 *   `ctx.apps` (see this file's own "APP ACTION SLOT" doc comment) - defaults
 *   to `[]` so an existing caller that doesn't pass it yet just renders no
 *   `shell.headerAction` contributors, never throws.
 * @returns {() => void} A stop function.
 */
export function mountHeader(container, { qu, services, adminPubs = [], subscribe, syncFetch, apps = [] }) {
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

  const spacer = document.createElement('div');
  spacer.className = 'qu-shell-header-spacer';

  const headerSlot = document.createElement('div');
  headerSlot.className = 'qu-shell-header-slot';

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
  header.append(home, backBtn, forwardBtn, spacer, headerSlot, bell, userWrap);
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
  extensionPoints.renderSlot('shell.headerAction', headerSlot, { getContext, onContextChange, services, qu, subscribe, syncFetch });

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
  // Any link click inside the menu should close it - simplest is a single
  // delegated listener rather than one per rendered link (the menu's own
  // content is rebuilt from scratch on every open, see renderMenu() below).
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeMenu();
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

  /** Rebuilt from scratch on every open - favorites can have changed since the last time this was shown. */
  async function renderMenu() {
    if (stopped) return;
    if (!myPub) myPub = await myPubPromise;
    if (stopped) return;
    menu.textContent = '';

    let apps = [];
    try {
      const res = await fetch('/apps.json');
      apps = res.ok ? await res.json() : [];
    } catch { /* offline/unreachable - favorites just stay unresolved this open, the static links below are unaffected */ }
    if (stopped) return;
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
