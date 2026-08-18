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
 * @property {(content: HTMLElement) => void} render - Required. Builds the
 *   app's own UI into `content`, an element the Core has already constrained
 *   to exactly the remaining space (see this file's own top doc comment).
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

    @media (min-width: calc(${breakpoint} + 1px)) {
      .qu-apptpl-sidebar { display: flex; }
    }
    @media (max-width: ${breakpoint}) {
      .qu-apptpl-footer { display: flex; }
      .qu-apptpl-content--with-bar { padding-bottom: calc(4.4rem + env(safe-area-inset-bottom, 0px)); }
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
 * @returns {() => void} destroy
 */
export function mountAppTemplate(container, config) {
  const cfg = normalizeAppConfig(config);
  ensureStyle(cfg.breakpoint);
  container.textContent = '';

  const hasChrome = !!(cfg.primaryAction || cfg.navigation || cfg.views || cfg.settings);
  const fabOnly = hasChrome && !cfg.navigation && !cfg.views && !cfg.settings && !!cfg.primaryAction;

  const root = document.createElement('div');
  root.className = 'qu-apptpl-root';

  const layout = document.createElement('div');
  layout.className = 'qu-apptpl-layout';

  const content = document.createElement('div');
  content.className = 'qu-apptpl-content';
  if (hasChrome && !fabOnly) content.classList.add('qu-apptpl-content--with-bar');

  let cleanupFooter = () => {};
  if (hasChrome) {
    layout.appendChild(buildDesktopSidebar(cfg));
  }
  layout.appendChild(content);
  root.appendChild(layout);

  if (hasChrome) {
    const { el, cleanup } = buildMobileFooter(cfg, { fabOnly });
    root.appendChild(el);
    cleanupFooter = cleanup;
  }

  container.appendChild(root);
  cfg.render(content);

  return () => {
    cleanupFooter();
  };
}
