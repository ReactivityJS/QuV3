/**
 * NAV POINTS MENU — the rendering half of the App Navigation Points Slot
 * (`shell.headerNavPoints`, see `apps/shell/src/header.js`'s own doc comment
 * and `docs/app-navigation-standard.md`). `mountAppHeaderAction()` already
 * handles "only mount while my app is active"; this decides how to render
 * however many items that app contributes:
 *   - 0 items → nothing (e.g. no create permission right now).
 *   - 1 item → a single `<a class="qu-app-action-btn">`, the exact shape
 *     every app's header action already had before this existed (Calendar's
 *     "+ New event", Chat's "+ New group", ToDo's "+ New task").
 *   - 2+ items → a `<button class="qu-app-action-btn">` that toggles a small
 *     dropdown menu, one link per item - Forum's "New channel"/"New topic"
 *     is the first real case of this. Same open/close/outside-click/Escape
 *     shape as the shell header's own user menu
 *     (`apps/shell/src/header.js`'s `userBtn`/`menu`), just a separate
 *     component/CSS class here rather than reusing that file's private
 *     styles.
 */
import { injectStyle } from './style.js';

const STYLE_ID = 'qu-navpoints-menu-style';
const STYLE = `
  .qu-navpoints-wrap { position: relative; display: inline-flex; }
  .qu-navpoints-menu { position: absolute; top: calc(100% + 0.4rem); left: 0; min-width: 11rem; background: canvas; color: canvastext; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); box-shadow: 0 0.5rem 1.4rem rgba(0,0,0,0.2); padding: 0.35rem; display: flex; flex-direction: column; gap: 0.05rem; z-index: 500; }
  .qu-navpoints-menu[hidden] { display: none; }
  .qu-navpoints-menu a { display: flex; align-items: center; padding: 0.45rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); text-decoration: none; color: inherit; font: inherit; }
  .qu-navpoints-menu a:hover { background: var(--qu-color-surface, #8882); }
`;

/**
 * @param {HTMLElement} wrap - the element `mountAppHeaderAction()`'s `render(wrap)` handed you.
 * @param {{ items: Array<{label: string, href: string}>, icon?: string, menuLabel?: string }} options
 * @returns {() => void} cleanup - removes any listeners this attached.
 */
export function renderNavPointsMenu(wrap, { items, icon = '+', menuLabel }) {
  injectStyle(STYLE_ID, STYLE);
  if (items.length === 0) return () => {};

  if (items.length === 1) {
    const link = document.createElement('a');
    link.className = 'qu-app-action-btn';
    link.textContent = icon;
    link.title = items[0].label;
    link.setAttribute('aria-label', items[0].label);
    link.href = items[0].href;
    wrap.appendChild(link);
    return () => {};
  }

  const root = document.createElement('div');
  root.className = 'qu-navpoints-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qu-app-action-btn';
  btn.textContent = icon;
  btn.title = menuLabel ?? icon;
  btn.setAttribute('aria-label', menuLabel ?? icon);
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'qu-navpoints-menu';
  menu.hidden = true;
  for (const item of items) {
    const a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    menu.appendChild(a);
  }
  root.append(btn, menu);
  wrap.appendChild(root);

  function close() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  function toggle() {
    const next = menu.hidden;
    menu.hidden = !next;
    btn.setAttribute('aria-expanded', String(next));
  }
  function onDocClick(e) {
    if (!root.contains(e.target)) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  btn.addEventListener('click', toggle);
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) close();
  });
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);

  return () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
  };
}
