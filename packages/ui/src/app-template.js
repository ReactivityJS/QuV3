/**
 * APP TEMPLATE — the data-driven "app chrome" building block: an app hands
 * over a plain `AppConfig` object (navigation items, view/mode switches, a
 * primary action, settings entries, and a `render(content)` callback for its
 * own UI) and `mountAppTemplate()` decides everything about WHERE that stuff
 * goes and how big the content area is. An app using this never writes its
 * own footer/sidebar layout code, never fights the platform for pixels, and
 * can't accidentally break another app's chrome - the Core owns placement
 * and dimensions (the content element handed to `render()` is already
 * constrained to exactly the remaining space), the app only owns content.
 *
 * This is an ADDITIVE sibling to the rest of `docs/app-navigation-standard.md`,
 * not a replacement: the global shell header (`apps/shell/src/header.js`,
 * Back/Forward, `shell.headerNavPoints`) is unchanged, `renderSubpage()`
 * (Rule 1) and `mountContextSwitcher()` (Rule 3) are unchanged and still the
 * right tool for a real hash-routed subpage or an existing "channel/calendar"
 * switcher. What THIS module adds is a second, per-app-owned chrome region -
 * a left sidebar on wide screens, a fixed bottom bar on narrow ones - for the
 * four things almost every app eventually needs some version of: "where do I
 * go" (`navigation`), "how do I look at this" (`views`), "create new X"
 * (`primaryAction`), and "app settings" (`settings`). See that doc's own
 * "App Template / Footer-Sidebar Chrome" section for the full rationale,
 * including why a FAB is fine here (an opt-in, data-driven, single Core-owned
 * slot) when a earlier, per-app, hand-rolled FAB was explicitly rejected.
 *
 * EVERY SECTION IS OPTIONAL, AND EMPTY SECTIONS RENDER NOTHING. An app that
 * passes only `render` gets no chrome at all - the content area is exactly
 * 100% of the container, same as calling `render()` directly. An app that
 * passes only `primaryAction` (no navigation/views/settings) gets a single
 * floating action button in the bottom-right corner instead of a full-width
 * bar - there is no empty bar to render around it.
 *
 * Uses the SAME `720px` breakpoint and CSS-media-query-toggles-visibility
 * approach as `./context-switcher.js` (both the sidebar and the footer are
 * always both built; CSS decides which one is actually visible) rather than
 * a resize listener - cheaper, and avoids a whole class of "JS layout
 * decided based on a stale width" bugs.
 *
 * The dropdown popups used for a multi-item navigation/views pill and for
 * the settings gear deliberately reuse the exact same shape as
 * `./nav-points-menu.js`'s 2+-item dropdown and the shell header's own user
 * menu (`apps/shell/src/header.js`'s `.qu-shell-menu`) - a small, anchored
 * popup of real `<a href>` links, open/close/outside-click/Escape. This is
 * NOT the "JS-toggled overlay/drawer/scrim" `docs/app-navigation-standard.md`
 * Rule 3 rejects for the Context Switcher (that rejection is about a list
 * with no route/back support of its own); every link in these popups is a
 * real, already-routable href, exactly like the nav-points-menu precedent.
 * The open/close logic is intentionally re-implemented here (not imported
 * from `./nav-points-menu.js`) rather than reworking that already-tested
 * file's internals for a second caller.
 */
import { injectStyle } from './style.js';

/**
 * @typedef {Object} AppTemplateLinkItem
 * @property {string} id
 * @property {string} label
 * @property {string} href
 * @property {string} [icon]
 * @property {string|number} [badge]
 */

/**
 * @typedef {Object} AppTemplateSettingsItem
 * @property {string} label
 * @property {string} href
 * @property {string} [icon]
 */

/**
 * @typedef {Object} AppConfig
 * @property {{label: string, href: string, icon?: string}} [primaryAction] -
 *   The one, always-in-the-same-place "create new X" action (Rule 2's
 *   dedicated-route reasoning applies here too - always a real `href`, never
 *   an `onClick`). Rendered as a prominent button: top of the sidebar on
 *   wide screens, a circular button at the end of the footer (or floating
 *   alone, if nothing else is present) on narrow ones.
 * @property {{items: AppTemplateLinkItem[], activeId?: string|null, heading?: string}} [navigation] -
 *   "Where am I / where can I go" - a channel, a calendar, a folder. Omit
 *   (or pass an empty `items`) if your app has nothing to switch between.
 * @property {{items: AppTemplateLinkItem[], activeId?: string|null, heading?: string}} [views] -
 *   "How do I want to see this" - day/week/month, list/grid, latest/top.
 * @property {{items: AppTemplateSettingsItem[], heading?: string}} [settings] -
 *   App-level settings/management links, reached via a gear icon.
 * @property {string} [breakpoint='720px'] - Same meaning as
 *   `mountContextSwitcher()`'s own `breakpoint` option.
 * @property {boolean} [fullHeight=false] - Opt-in: `content` (and the
 *   sidebar, if any) is bound to exactly the remaining VIEWPORT height below
 *   the shell header (and above the mobile footer bar, if one renders),
 *   instead of the default "grows with its own content, page scrolls"
 *   behavior. For a messenger-style view with its OWN internal
 *   header/scroll-region/composer structure (a room list next to an open
 *   chat room, e.g. `apps/chat`) - see this file's own "FULL HEIGHT MODE"
 *   doc comment below for why this has to be real `position: fixed`, not a
 *   `calc(100vh - ...)` height. Leave `false` (the default) for an ordinary
 *   page that should simply scroll with the rest of the document - true for
 *   almost every app.
 * @property {(content: HTMLElement) => void} render - Required. Builds the
 *   app's own UI into `content`, an element the Core has already constrained
 *   to exactly the remaining space (see this file's own top doc comment).
 */

/**
 * FULL HEIGHT MODE (`fullHeight: true`) - genuine `position: fixed`
 * (viewport-relative), NOT a `calc(100vh - ...)` height computed against
 * `.qu-shell-screen`'s own padding/box model. `apps/chat/client.js`'s
 * now-superseded `.qu-chat-room-view` rule (this mode's direct ancestor -
 * copy its own doc comment's full reasoning if you need the "why" in more
 * detail) already worked this out the hard way: a computed-height approach
 * is fragile by construction (any drift in an ancestor's padding, an extra
 * wrapping element, or accumulated sub-pixel rounding makes the computed box
 * even slightly TALLER than the real remaining viewport) and produced a
 * DOUBLE scrollbar in production - the inner content AND the outer page both
 * scrolling, with the last bit of content pushed below the visible area.
 * Fixed positioning sidesteps all of that: its containing block is the
 * VIEWPORT itself, independent of any ancestor's box model, and removes the
 * element from the page's normal flow entirely, so it can't contribute to
 * (or be pushed around by) the page's own scroll height. Top AND bottom
 * BOTH set (never top plus an explicit height) is deliberate too - the
 * browser derives the box's real height from the two insets live, on every
 * reflow, including a mobile browser's collapsing/expanding address bar
 * changing the actual visible height, with no `vh`/`dvh` calc() needed.
 */

const STYLE_ID_PREFIX = 'qu-apptpl-style';

function styleFor(breakpoint) {
  return `
    .qu-apptpl-root { display: flex; flex-direction: column; }
    .qu-apptpl-layout { display: flex; align-items: flex-start; gap: 1.3rem; }

    .qu-apptpl-sidebar { display: none; width: 14rem; flex-shrink: 0; flex-direction: column; gap: 0.9rem; position: sticky; top: calc(3.25rem + 1rem); }
    .qu-apptpl-primary-desktop { display: flex; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.6rem 0.9rem; border-radius: var(--qu-radius-md, 0.4rem); background: var(--qu-color-accent, #5b5bd6); color: #fff; text-decoration: none; font-weight: 600; }
    .qu-apptpl-section { display: flex; flex-direction: column; gap: 0.15rem; }
    .qu-apptpl-section--settings { margin-top: auto; }
    .qu-apptpl-section-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0 0 0.2rem; }
    .qu-apptpl-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
    .qu-apptpl-list a { display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.6rem; border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
    .qu-apptpl-list a:hover { background: var(--qu-color-border, #8884); }
    .qu-apptpl-item-active { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 15%, transparent); font-weight: 600; }
    .qu-apptpl-badge { margin-left: auto; font-size: 0.75em; opacity: 0.65; }

    .qu-apptpl-content { flex: 1; min-width: 0; min-height: 0; }

    .qu-apptpl-footer { display: none; position: fixed; left: 0; right: 0; bottom: 0; z-index: 450; align-items: center; gap: 0.5rem; padding: 0.5rem 0.7rem calc(0.5rem + env(safe-area-inset-bottom, 0px)); background: canvas; border-top: 1px solid var(--qu-color-border, #8884); }
    .qu-apptpl-footer--fab-only { background: none; border: none; padding: 0 1rem calc(1rem + env(safe-area-inset-bottom, 0px)); justify-content: flex-end; pointer-events: none; }
    .qu-apptpl-footer-start { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
    .qu-apptpl-footer-spacer { flex: 1; }
    .qu-apptpl-footer-end { display: flex; align-items: center; gap: 0.4rem; }

    .qu-apptpl-popup-wrap { position: relative; display: inline-flex; pointer-events: auto; }
    .qu-apptpl-pill { display: inline-flex; align-items: center; gap: 0.3rem; max-width: 10rem; background: var(--qu-color-surface, #8882); border: none; border-radius: 999px; padding: 0.4rem 0.7rem; font: inherit; color: inherit; cursor: pointer; }
    .qu-apptpl-pill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qu-apptpl-pill-caret { font-size: 0.65em; opacity: 0.7; }
    .qu-apptpl-gear { display: inline-flex; align-items: center; justify-content: center; background: none; border: none; border-radius: var(--qu-radius-sm, 0.3rem); padding: 0.45rem; font-size: 1.15em; line-height: 1; color: inherit; cursor: pointer; }
    .qu-apptpl-gear:hover { background: var(--qu-color-surface, #8882); }
    .qu-apptpl-popup { position: absolute; bottom: calc(100% + 0.5rem); left: 0; min-width: 11rem; max-height: 60vh; overflow-y: auto; background: canvas; color: canvastext; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); box-shadow: 0 0.5rem 1.4rem rgba(0,0,0,0.2); padding: 0.35rem; display: flex; flex-direction: column; gap: 0.05rem; z-index: 500; }
    .qu-apptpl-popup[hidden] { display: none; }
    .qu-apptpl-popup a { display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); text-decoration: none; color: inherit; font: inherit; }
    .qu-apptpl-popup a:hover { background: var(--qu-color-surface, #8882); }

    .qu-apptpl-fab { display: inline-flex; align-items: center; justify-content: center; width: 3.2rem; height: 3.2rem; flex-shrink: 0; border-radius: 999px; background: var(--qu-color-accent, #5b5bd6); color: #fff; text-decoration: none; font-size: 1.4em; box-shadow: 0 0.3rem 0.9rem rgba(0,0,0,0.25); pointer-events: auto; }

    /* FULL HEIGHT MODE - see this file's own top "FULL HEIGHT MODE" doc
       comment for the full "why fixed, not calc(100vh)" reasoning. */
    .qu-apptpl-root--full-height { position: fixed; top: 3.25rem; right: 0; bottom: 0; left: 0; z-index: 10; }
    .qu-apptpl-root--full-height .qu-apptpl-layout { flex: 1; min-height: 0; align-items: stretch; }
    .qu-apptpl-root--full-height .qu-apptpl-sidebar { position: static; overflow-y: auto; }
    .qu-apptpl-root--full-height .qu-apptpl-content { display: flex; flex-direction: column; min-height: 0; }

    @media (min-width: calc(${breakpoint} + 1px)) {
      .qu-apptpl-sidebar { display: flex; }
    }
    @media (max-width: ${breakpoint}) {
      .qu-apptpl-footer { display: flex; }
      .qu-apptpl-content--with-bar { padding-bottom: calc(4.4rem + env(safe-area-inset-bottom, 0px)); }
      /* full-height mode has no scrolling page to pad - the fixed root's
         own bottom inset is what has to make room for the footer bar
         instead (fab-only footers float OVER content on purpose - see
         .qu-apptpl-footer--fab-only's own pointer-events: none rule - so
         this is scoped to the real-bar case only, same condition
         .qu-apptpl-content--with-bar above already uses). */
      .qu-apptpl-root--full-height.qu-apptpl-root--has-footer-bar { bottom: calc(4.4rem + env(safe-area-inset-bottom, 0px)); }
    }
  `;
}

function ensureStyle(breakpoint) {
  const id = `${STYLE_ID_PREFIX}-${String(breakpoint).replace(/[^a-zA-Z0-9]/g, '')}`;
  injectStyle(id, styleFor(breakpoint));
}

function normalizeLinkSection(section) {
  if (!section || !Array.isArray(section.items) || section.items.length === 0) return null;
  return { items: section.items, activeId: section.activeId ?? null, heading: section.heading ?? null };
}

/**
 * Validates and fills defaults on a raw `AppConfig` object - the "loader" for
 * the data structure `mountAppTemplate()` accepts, same role
 * `packages/foundation/src/manifest.js`'s `validateManifest()` plays for
 * `manifest.quapp`: a clear, specific error instead of a silent skip or a
 * confusing DOM-shaped failure later.
 * @param {AppConfig} config
 * @returns {Required<Omit<AppConfig, 'primaryAction'>> & {primaryAction: AppConfig['primaryAction']|null}}
 */
export function normalizeAppConfig(config) {
  if (typeof config?.render !== 'function') {
    throw new Error(
      "mountAppTemplate(): config.render is required and must be a function - " +
      "it builds your app's own UI into the content element the template hands it.",
    );
  }
  return {
    breakpoint: config.breakpoint ?? '720px',
    fullHeight: config.fullHeight ?? false,
    primaryAction: config.primaryAction ?? null,
    navigation: normalizeLinkSection(config.navigation),
    views: normalizeLinkSection(config.views),
    settings: normalizeLinkSection(config.settings),
    render: config.render,
  };
}

function buildLinkList(items, { activeId, className = 'qu-apptpl-list', itemActiveClass = 'qu-apptpl-item-active' } = {}) {
  const ul = document.createElement('ul');
  ul.className = className;
  for (const item of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = item.href;
    if (item.id != null && item.id === activeId) a.classList.add(itemActiveClass);
    if (item.icon) {
      const icon = document.createElement('span');
      icon.textContent = item.icon;
      a.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = item.label;
    a.appendChild(label);
    if (item.badge) {
      const badge = document.createElement('span');
      badge.className = 'qu-apptpl-badge';
      badge.textContent = item.badge;
      a.appendChild(badge);
    }
    li.appendChild(a);
    ul.appendChild(li);
  }
  return ul;
}

function buildDesktopSidebar(cfg) {
  const sidebar = document.createElement('aside');
  sidebar.className = 'qu-apptpl-sidebar';

  if (cfg.primaryAction) {
    const link = document.createElement('a');
    link.className = 'qu-apptpl-primary-desktop';
    link.href = cfg.primaryAction.href;
    if (cfg.primaryAction.icon) {
      const icon = document.createElement('span');
      icon.textContent = cfg.primaryAction.icon;
      link.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = cfg.primaryAction.label;
    link.appendChild(label);
    sidebar.appendChild(link);
  }

  for (const [section, modifierClass] of [[cfg.navigation, null], [cfg.views, null], [cfg.settings, 'qu-apptpl-section--settings']]) {
    if (!section) continue;
    const wrap = document.createElement('div');
    wrap.className = modifierClass ? `qu-apptpl-section ${modifierClass}` : 'qu-apptpl-section';
    if (section.heading) {
      const heading = document.createElement('h2');
      heading.className = 'qu-apptpl-section-heading';
      heading.textContent = section.heading;
      wrap.appendChild(heading);
    }
    wrap.appendChild(buildLinkList(section.items, { activeId: section.activeId }));
    sidebar.appendChild(wrap);
  }

  return sidebar;
}

/**
 * A small, anchored popup trigger - the footer's shared shape for a
 * navigation/views pill and the settings gear alike. See this file's own top
 * doc comment for why this is a real-link popup, not a bottom sheet.
 * @returns {{el: HTMLElement, cleanup: () => void}}
 */
function buildPopupTrigger({ triggerEl, items, popupPosition = 'left' }) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-apptpl-popup-wrap';

  const menu = document.createElement('div');
  menu.className = 'qu-apptpl-popup';
  if (popupPosition === 'right') {
    menu.style.left = 'auto';
    menu.style.right = '0';
  }
  menu.hidden = true;
  for (const item of items) {
    const a = document.createElement('a');
    a.href = item.href;
    if (item.icon) {
      const icon = document.createElement('span');
      icon.textContent = item.icon;
      a.appendChild(icon);
    }
    const label = document.createElement('span');
    label.textContent = item.label;
    a.appendChild(label);
    menu.appendChild(a);
  }

  wrap.append(triggerEl, menu);

  function close() {
    menu.hidden = true;
    triggerEl.setAttribute('aria-expanded', 'false');
  }
  function toggle() {
    const opening = menu.hidden;
    menu.hidden = !opening;
    triggerEl.setAttribute('aria-expanded', String(opening));
  }
  function onDocClick(e) {
    if (!wrap.contains(e.target)) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  triggerEl.setAttribute('aria-haspopup', 'true');
  triggerEl.setAttribute('aria-expanded', 'false');
  triggerEl.addEventListener('click', toggle);
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) close();
  });
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);

  return {
    el: wrap,
    cleanup: () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeydown);
    },
  };
}

function buildPill(section) {
  const active = section.items.find((item) => item.id === section.activeId) ?? section.items[0];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qu-apptpl-pill';
  btn.title = section.heading ?? active.label;
  btn.setAttribute('aria-label', section.heading ?? active.label);
  if (active.icon) {
    const icon = document.createElement('span');
    icon.textContent = active.icon;
    btn.appendChild(icon);
  }
  const label = document.createElement('span');
  label.className = 'qu-apptpl-pill-label';
  label.textContent = active.label;
  btn.appendChild(label);
  const caret = document.createElement('span');
  caret.className = 'qu-apptpl-pill-caret';
  caret.textContent = '▾';
  caret.setAttribute('aria-hidden', 'true');
  btn.appendChild(caret);
  return btn;
}

function buildMobileFooter(cfg, { fabOnly }) {
  const footer = document.createElement('div');
  footer.className = fabOnly ? 'qu-apptpl-footer qu-apptpl-footer--fab-only' : 'qu-apptpl-footer';
  const cleanupFns = [];

  if (fabOnly) {
    if (cfg.primaryAction) {
      footer.appendChild(buildFab(cfg.primaryAction));
    }
    return { el: footer, cleanup: () => {} };
  }

  const start = document.createElement('div');
  start.className = 'qu-apptpl-footer-start';
  if (cfg.navigation) {
    const { el, cleanup } = buildPopupTrigger({ triggerEl: buildPill(cfg.navigation), items: cfg.navigation.items });
    start.appendChild(el);
    cleanupFns.push(cleanup);
  }
  if (cfg.views) {
    const { el, cleanup } = buildPopupTrigger({ triggerEl: buildPill(cfg.views), items: cfg.views.items });
    start.appendChild(el);
    cleanupFns.push(cleanup);
  }

  const end = document.createElement('div');
  end.className = 'qu-apptpl-footer-end';
  if (cfg.settings) {
    const gearBtn = document.createElement('button');
    gearBtn.type = 'button';
    gearBtn.className = 'qu-apptpl-gear';
    gearBtn.textContent = '⚙️';
    gearBtn.title = cfg.settings.heading ?? 'Settings';
    gearBtn.setAttribute('aria-label', cfg.settings.heading ?? 'Settings');
    const { el, cleanup } = buildPopupTrigger({ triggerEl: gearBtn, items: cfg.settings.items, popupPosition: 'right' });
    end.appendChild(el);
    cleanupFns.push(cleanup);
  }
  if (cfg.primaryAction) {
    end.appendChild(buildFab(cfg.primaryAction));
  }

  footer.append(start, document.createElement('div'), end);
  footer.children[1].className = 'qu-apptpl-footer-spacer';

  return { el: footer, cleanup: () => { for (const fn of cleanupFns) fn(); } };
}

function buildFab(primaryAction) {
  const fab = document.createElement('a');
  fab.className = 'qu-apptpl-fab';
  fab.href = primaryAction.href;
  fab.textContent = primaryAction.icon ?? '+';
  fab.title = primaryAction.label;
  fab.setAttribute('aria-label', primaryAction.label);
  return fab;
}

/**
 * @param {HTMLElement} container - cleared and (re)populated in place.
 * @param {AppConfig} config
 * @returns {(() => void) & {update: (partial: Partial<AppConfig>) => void}} destroy -
 *   also carries an `update(partial)` property (see this file's own "LATE-
 *   ARRIVING CHROME DATA" doc comment) - a plain function object, so every
 *   existing caller's `const stop = mountAppTemplate(...); stop();` keeps
 *   working completely unchanged; `update` is just an extra property on
 *   that same function.
 */
export function mountAppTemplate(container, config) {
  let cfg = normalizeAppConfig(config);
  ensureStyle(cfg.breakpoint);
  container.textContent = '';

  const root = document.createElement('div');
  const layout = document.createElement('div');
  layout.className = 'qu-apptpl-layout';
  const content = document.createElement('div');
  content.className = 'qu-apptpl-content';

  let sidebarEl = null;
  let footerEl = null;
  let cleanupFooter = () => {};

  /**
   * (Re)builds everything EXCEPT `content`'s own children - `render()` is
   * only ever called once, by `mountAppTemplate()` itself below; an
   * `update()` call only ever touches the chrome around it. Safe to call
   * more than once - always tears its own previous chrome down first (the
   * initial build is just "the first call", not a separate code path).
   */
  function rebuildChrome() {
    cleanupFooter();
    sidebarEl?.remove();
    footerEl?.remove();

    const hasChrome = !!(cfg.primaryAction || cfg.navigation || cfg.views || cfg.settings);
    const fabOnly = hasChrome && !cfg.navigation && !cfg.views && !cfg.settings && !!cfg.primaryAction;

    root.className = cfg.fullHeight ? 'qu-apptpl-root qu-apptpl-root--full-height' : 'qu-apptpl-root';
    if (cfg.fullHeight && hasChrome && !fabOnly) root.classList.add('qu-apptpl-root--has-footer-bar');

    // In full-height mode, the fixed root's own bottom inset already makes
    // room for the footer bar (`.qu-apptpl-root--has-footer-bar`) - adding
    // this padding TOO would double-reserve that space, since content isn't
    // the thing scrolling the page anymore. See the `fullHeight` doc comment.
    content.classList.toggle('qu-apptpl-content--with-bar', hasChrome && !fabOnly && !cfg.fullHeight);

    sidebarEl = hasChrome ? buildDesktopSidebar(cfg) : null;
    if (sidebarEl) layout.insertBefore(sidebarEl, content);

    if (hasChrome) {
      const { el, cleanup } = buildMobileFooter(cfg, { fabOnly });
      footerEl = el;
      root.appendChild(footerEl);
      cleanupFooter = cleanup;
    } else {
      footerEl = null;
      cleanupFooter = () => {};
    }
  }

  // `content` must already be `layout`'s child BEFORE the first
  // `rebuildChrome()` call - `insertBefore(sidebarEl, content)` requires
  // `content` to already be a real sibling reference, not a detached node.
  layout.appendChild(content);
  root.appendChild(layout);
  rebuildChrome();
  container.appendChild(root);
  cfg.render(content);

  const stop = () => cleanupFooter();
  /**
   * LATE-ARRIVING CHROME DATA: an app whose `navigation`/`views`/`settings`
   * items depend on an async fetch (contacts + group memberships for a
   * room-switcher sidebar, e.g. `apps/chat/client.js`'s `mountRoomView()`)
   * can't have that data ready at the ONE synchronous `mountAppTemplate()`
   * call every other app makes - `render()` itself follows the same
   * "build immediately, fill in via your own async IIFE" convention every
   * app in this codebase already uses (see `docs/building-an-app.md`), and
   * chrome should be no different. `update(partial)` merges `partial` onto
   * the current config (same shape as the original `config`, any subset of
   * `primaryAction`/`navigation`/`views`/`settings`/`fullHeight`/
   * `breakpoint`) and rebuilds ONLY the chrome - `render()` is never called
   * again, so the app's own already-mounted content (and whatever
   * live-reactive setup it did inside `render()`) is completely undisturbed.
   * @param {Partial<AppConfig>} partial
   */
  stop.update = (partial) => {
    cfg = normalizeAppConfig({ ...cfg, ...partial });
    rebuildChrome();
  };
  return stop;
}
