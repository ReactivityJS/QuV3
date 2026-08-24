/**
 * CONTEXT SWITCHER — the shared "which sibling place am I in, and how do I
 * reach another one" building block (a channel, a calendar, eventually a
 * chat room) that every app with more than one such "place" should render
 * identically, instead of hand-rolling its own sidebar/drawer. Generalizes
 * two patterns that already existed independently in this codebase before
 * this module: `apps/forum/client.js`'s `mountMiniChannelSidebar()`
 * (persistent sidebar, collapsing to an always-visible horizontal tab strip
 * on narrow screens) and `apps/calendar/client.js`'s old `.qu-cal-sidebar`
 * (persistent sidebar, an off-canvas drawer+scrim on narrow screens).
 *
 * THE DRAWER/SCRIM IS DELIBERATELY GONE. A JS-toggled overlay has no direct
 * link and no Back/Forward support of its own - exactly the same reasoning
 * `./subpage.js`'s own doc comment already gives for why a subpage is a real
 * hash route, never a `<dialog>`. So `variant: 'page'` (this module's
 * replacement for Calendar's old drawer) renders its "everything" list on a
 * real, dedicated, hash-routed sub-page instead - see `renderContextListPage()`
 * below - reached via a plain `<a>` in the app's own title row, not a
 * JS open/close toggle. `variant: 'tabs'` (Forum's shape) never needed an
 * overlay to begin with - the list is simply always visible, just laid out
 * differently at different widths - so it's unchanged in spirit, just
 * generalized.
 *
 * Two shapes, chosen by the caller based on the list itself:
 *   - `variant: 'tabs'` (default) - short, stable lists (Forum's channels).
 *     Persistent sidebar >= `breakpoint`, an always-visible horizontal
 *     scrollable strip below it. Nothing is ever hidden.
 *   - `variant: 'page'` - longer lists, or lists with their own per-item
 *     management UI that doesn't fit a simple link (Calendar's calendars:
 *     multi-select show/hide + share/delete/rename). Persistent sidebar
 *     >= `breakpoint`; below it, the sidebar itself is hidden and a plain
 *     "{activeLabel} ›" link in the title row points at `switchHref`, a
 *     real route the HOST APP's own routing renders via
 *     `renderContextListPage()` (see that function's own doc comment).
 *
 * Most apps' sidebar content is a plain "pick one, navigate there" list -
 * that's `items`. An app whose sidebar isn't a simple link list (again,
 * Calendar) passes `renderSidebar` instead, which takes over the whole
 * list area verbatim - `items`/`activeId`/`newItem` are then ignored.
 */
import { injectStyle } from './style.js';
import { renderSubpage } from './subpage.js';

const STYLE_ID_PREFIX = 'qu-ctxswitch-style';

function styleFor(breakpoint) {
  return `
    .qu-ctxswitch-root { display: flex; flex-direction: column; }
    .qu-ctxswitch-titlebar { display: none; align-items: center; padding: 0.3rem 0 0.6rem; }
    .qu-ctxswitch-title-link { display: flex; align-items: center; gap: 0.3rem; text-decoration: none; color: inherit; font-weight: 600; font-size: 1.05em; padding: 0.2rem 0; }
    .qu-ctxswitch-title-link:hover { opacity: 0.8; }
    .qu-ctxswitch-layout { display: flex; align-items: flex-start; gap: 1.3rem; }
    .qu-ctxswitch-sidebar { width: 16rem; flex-shrink: 0; display: flex; flex-direction: column; gap: 0.5rem; }
    .qu-ctxswitch-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0; }
    .qu-ctxswitch-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
    .qu-ctxswitch-list a { display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.6rem; border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
    .qu-ctxswitch-list a:hover { background: var(--qu-color-border, #8884); }
    .qu-ctxswitch-item-active { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 15%, transparent); font-weight: 600; }
    .qu-ctxswitch-badge { margin-left: auto; font-size: 0.75em; opacity: 0.65; }
    .qu-ctxswitch-new { display: inline-block; opacity: 0.8; padding: 0.3rem 0.6rem; text-decoration: none; color: inherit; }
    .qu-ctxswitch-new:hover { opacity: 1; }
    .qu-ctxswitch-content { flex: 1; min-width: 0; }
    .qu-ctxswitch-page-heading { margin: 0 0 0.6rem; font-size: 1.1em; }

    /* FULL HEIGHT MODE (opt-in fullHeight: true) - mirrors app-template.js's
       own .qu-apptpl-root--full-height shape one level down, so a caller
       nesting mountContextSwitcher() inside a chrome.set({fullHeight: true})
       view (e.g. apps/calendar's own day/week/month grid) actually gets the
       remaining height cascaded all the way to its own render(content)
       callback, instead of stopping at chrome's own content slot. */
    .qu-ctxswitch-root[data-full-height] { flex: 1; min-height: 0; }
    .qu-ctxswitch-root[data-full-height] .qu-ctxswitch-layout { flex: 1; min-height: 0; align-items: stretch; }
    .qu-ctxswitch-root[data-full-height] .qu-ctxswitch-sidebar { overflow-y: auto; }
    .qu-ctxswitch-root[data-full-height] .qu-ctxswitch-content { flex: 1; min-height: 0; display: flex; flex-direction: column; }

    @media (max-width: ${breakpoint}) {
      .qu-ctxswitch-layout { flex-direction: column; }

      /* variant: 'tabs' - never hidden, just reflows into a horizontal strip. */
      .qu-ctxswitch-sidebar[data-variant="tabs"] { width: 100%; }
      .qu-ctxswitch-sidebar[data-variant="tabs"] .qu-ctxswitch-heading { display: none; }
      .qu-ctxswitch-sidebar[data-variant="tabs"] .qu-ctxswitch-list { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; gap: 0.4rem; padding-bottom: 0.2rem; -webkit-overflow-scrolling: touch; }
      .qu-ctxswitch-sidebar[data-variant="tabs"] .qu-ctxswitch-list li { flex: 0 0 auto; }
      .qu-ctxswitch-sidebar[data-variant="tabs"] .qu-ctxswitch-list a { white-space: nowrap; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; padding: 0.3rem 0.7rem; }
      .qu-ctxswitch-sidebar[data-variant="tabs"] .qu-ctxswitch-new { flex: 0 0 auto; }

      /* variant: 'page' - hidden below the breakpoint; the titlebar link (a REAL route) replaces it. */
      .qu-ctxswitch-sidebar[data-variant="page"] { display: none; }
      .qu-ctxswitch-titlebar[data-variant="page"] { display: flex; }
    }
  `;
}

function ensureStyle(breakpoint) {
  const id = `${STYLE_ID_PREFIX}-${String(breakpoint).replace(/[^a-zA-Z0-9]/g, '')}`;
  injectStyle(id, styleFor(breakpoint));
}

/**
 * Builds the sidebar's list content - shared verbatim between
 * `mountContextSwitcher()`'s desktop sidebar and `renderContextListPage()`'s
 * full page, so the two never drift apart.
 * @param {HTMLElement} host - appended into directly.
 * @param {{items?: Array<{id: string, label: string, href: string, icon?: string, badge?: string}>, renderSidebar?: (host: HTMLElement) => void, activeId?: string|null, newItem?: {label: string, href: string}}} options
 */
function buildSidebarBody(host, { items, renderSidebar, activeId, newItem }) {
  if (renderSidebar) {
    renderSidebar(host);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'qu-ctxswitch-list';
  for (const item of items ?? []) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = item.href;
    if (item.id === activeId) a.classList.add('qu-ctxswitch-item-active');
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
      badge.className = 'qu-ctxswitch-badge';
      badge.textContent = item.badge;
      a.appendChild(badge);
    }
    li.appendChild(a);
    ul.appendChild(li);
  }
  host.appendChild(ul);
  if (newItem) {
    const link = document.createElement('a');
    link.className = 'qu-ctxswitch-new';
    link.href = newItem.href;
    link.textContent = newItem.label;
    host.appendChild(link);
  }
}

/**
 * @param {HTMLElement} container - cleared and (re)populated in place.
 * @param {{
 *   items?: Array<{id: string, label: string, href: string, icon?: string, badge?: string}>,
 *   renderSidebar?: (host: HTMLElement) => void,
 *   activeId?: string|null,
 *   heading?: string - omit when `renderSidebar` already builds its own heading (see that option's own doc comment).
 *   variant?: 'tabs'|'page',
 *   breakpoint?: string,
 *   switchHref?: string,
 *   activeLabel?: string,
 *   hideTitleLink?: boolean,
 *   newItem?: {label: string, href: string},
 *   fullHeight?: boolean - opt-in, see this file's own "FULL HEIGHT MODE" CSS
 *     comment. Only meaningful when the CALLER's own container is itself
 *     inside a `chrome.set({fullHeight: true})` view - it cascades the
 *     remaining height down through this component's own nested sidebar+
 *     content layout, it doesn't create height on its own.
 *   render: (content: HTMLElement) => void,
 * }} options
 * @returns {() => void} destroy
 */
export function mountContextSwitcher(container, {
  items, renderSidebar, activeId = null, heading, variant = 'tabs', breakpoint = '720px',
  switchHref, activeLabel, hideTitleLink = false, newItem, fullHeight = false, render,
}) {
  ensureStyle(breakpoint);
  container.textContent = '';

  const root = document.createElement('div');
  root.className = 'qu-ctxswitch-root';
  if (fullHeight) root.dataset.fullHeight = 'true';

  // `hideTitleLink` - an opt-out for a caller that reaches `switchHref`
  // through some OTHER real, routable affordance instead (e.g. Calendar's
  // own `mountAppTemplate()` settings-gear entry, "Kalender verwalten") -
  // never leaves `switchHref` unreachable, just avoids showing it twice.
  if (variant === 'page' && !hideTitleLink) {
    const titlebar = document.createElement('div');
    titlebar.className = 'qu-ctxswitch-titlebar';
    titlebar.dataset.variant = 'page';
    const link = document.createElement('a');
    link.className = 'qu-ctxswitch-title-link';
    link.href = switchHref;
    link.textContent = `${activeLabel ?? heading} ›`;
    titlebar.appendChild(link);
    root.appendChild(titlebar);
  }

  const layout = document.createElement('div');
  layout.className = 'qu-ctxswitch-layout';

  const sidebar = document.createElement('aside');
  sidebar.className = 'qu-ctxswitch-sidebar';
  sidebar.dataset.variant = variant;
  // Omitted when a `renderSidebar` override already builds its own heading
  // (e.g. apps/forum's mountMiniChannelSidebar() - see that call site) -
  // avoids a redundant/empty duplicate label.
  if (heading) {
    const headingEl = document.createElement('h2');
    headingEl.className = 'qu-ctxswitch-heading';
    headingEl.textContent = heading;
    sidebar.appendChild(headingEl);
  }
  buildSidebarBody(sidebar, { items, renderSidebar, activeId, newItem });
  layout.appendChild(sidebar);

  const content = document.createElement('div');
  content.className = 'qu-ctxswitch-content';
  layout.appendChild(content);

  root.appendChild(layout);
  container.appendChild(root);

  render(content);

  return () => {};
}

/**
 * The full-page listing rendered at a `variant: 'page'` app's `switchHref`
 * route (the HOST APP's own `segments`-based routing decides when to call
 * this - e.g. Calendar's `mount()` on `segments[1] === 'manage'`). Same
 * sidebar content `mountContextSwitcher()`'s desktop sidebar renders, just
 * full-page, through `renderSubpage({showBackLink:false})` per this
 * standard's Rule 1 (the shell's own Back button already covers "return to
 * where I came from") - a real hash route, never a modal.
 * @param {HTMLElement} container
 * @param {{items?: Array<object>, renderSidebar?: (host: HTMLElement) => void, activeId?: string|null, heading: string, newItem?: {label: string, href: string}}} options
 */
export function renderContextListPage(container, { items, renderSidebar, activeId = null, heading, newItem }) {
  renderSubpage(container, {
    showBackLink: false,
    render: (content) => {
      const h1 = document.createElement('h1');
      h1.className = 'qu-ctxswitch-page-heading';
      h1.textContent = heading;
      content.appendChild(h1);
      const body = document.createElement('div');
      buildSidebarBody(body, { items, renderSidebar, activeId, newItem });
      content.appendChild(body);
    },
  });
}
