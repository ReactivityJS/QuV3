/**
 * APP HEADER ACTION — the boilerplate every `shell.headerNavPoints`
 * contributor needs when its icon should only show up while ITS OWN app is
 * the active one (e.g. Calendar's "+ New event", Forum's "New channel"/"New
 * topic" dropdown) instead of being unconditionally visible everywhere, the
 * way `apps/search`'s own `shell.headerAction` contributor
 * (`renderHeaderSearch()`) is. `ExtensionPointHost.renderSlot()` mounts
 * every contributor ONCE for the whole session (the shell header itself is
 * mounted once, see `apps/shell/src/header.js`'s own doc comment) - so
 * "only visible for my app" has to be a live, route-driven show/hide inside
 * the contributor itself, not something the host can do for it. This is
 * that show/hide, written once here instead of once per app - usable by a
 * `shell.headerAction` contributor too, if a future one ever needs to be
 * conditional rather than always-visible.
 *
 * `render(wrap)` is called (and its returned cleanup, if any, kept) only
 * while `getContext().appId === appId`; on leaving that app, the cleanup (if
 * returned) runs and `wrap` is cleared, so a contributor's own async setup
 * (a `fetch`, a Services call) can safely bail out via its own `stopped`
 * flag inside that returned cleanup the same way every real `mount()` in
 * this codebase already does (see `docs/building-an-app.md`). Pair this with
 * `renderNavPointsMenu()` (`nav-points-menu.js`) inside `render()` to
 * actually build the icon/dropdown - see `docs/app-navigation-standard.md`
 * Rule 2.
 *
 * Also injects the shared `.qu-app-action-btn` style every contributor's own
 * icon should use - the same visual language as the shell header's own
 * Back/Forward buttons and `apps/search`'s icon (`apps/shell/src/header.js`'s
 * `.qu-shell-histbtn`, `apps/search/client.js`'s `.qu-search-header-btn`),
 * centralized here so every app's header action looks identical without
 * redefining the rule itself.
 */
import { injectStyle } from './style.js';

const STYLE_ID = 'qu-app-header-action-style';
const STYLE = `
  .qu-app-header-action { display: inline-flex; }
  .qu-app-action-btn { display: inline-flex; align-items: center; justify-content: center; background: none; border: none; cursor: pointer; text-decoration: none; color: inherit; font-size: 1.2em; line-height: 1; padding: 0.35rem 0.55rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-app-action-btn:hover { background: var(--qu-color-surface, #8882); }
`;

/**
 * @param {HTMLElement} container - the itemEl `ExtensionPointHost.renderSlot()` already created for this contributor.
 * @param {{
 *   appId: string,
 *   getContext: () => {appId: string|null, segments: string[]},
 *   onContextChange: (cb: () => void) => void,
 *   render: (wrap: HTMLElement) => (void|(() => void)),
 * }} options
 */
export function mountAppHeaderAction(container, { appId, getContext, onContextChange, render }) {
  injectStyle(STYLE_ID, STYLE);
  const wrap = document.createElement('span');
  wrap.className = 'qu-app-header-action';
  container.appendChild(wrap);

  // `mounted` tracks "is my own render() currently the thing sitting in
  // `wrap`" SEPARATELY from whether `render()` happened to return a cleanup
  // function - a contributor with nothing to tear down (a static link, e.g.
  // Chat's "+ New group") legitimately returns nothing, and piggybacking
  // this on "cleanup is truthy" would then re-run render() (stacking
  // duplicate DOM) on every single onContextChange call, not just the one
  // where this app actually became active.
  let mounted = false;
  let cleanup = null;
  function update() {
    const active = getContext().appId === appId;
    wrap.hidden = !active;
    if (active && !mounted) {
      mounted = true;
      cleanup = render(wrap) || null;
    } else if (!active && mounted) {
      mounted = false;
      cleanup?.();
      cleanup = null;
      wrap.textContent = '';
    }
  }

  update();
  onContextChange(update);
}
