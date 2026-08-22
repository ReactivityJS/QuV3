import { renderContextMenu } from '@qu/thread-ui';

/**
 * SLOT RESOLVER — Quniverse V4's Presentation Resolver (see
 * docs/v4-concept.md §6/§17): an app/extension declares WHAT it wants
 * (a list of candidate items), this decides HOW it's actually presented -
 * inline, collapsed into a menu, a hybrid of both, or a single
 * condition-picked item (switch/case) - exactly the "apps declare intent,
 * templates decide presentation" principle, now a real, reusable primitive
 * instead of only a documented aspiration.
 *
 * Lives in `packages/ui` (not `packages/content-ui`) on purpose - this is a
 * Core-level concept, not private to the ContentEditor: the same resolver
 * is meant to serve a future FAB/Nav presentation need too (see
 * docs/v4-concept.md §6's own "living in packages/ui beside app-template.js"
 * framing), not duplicated per consumer.
 *
 * `'menu'`/`'inline-then-menu'` reuse `@qu/thread-ui`'s existing, already-
 * proven `renderContextMenu()` (the exact mechanism `apps/chat/client.js`'s
 * own "+" button already uses to group Attach/Share-location) - not a
 * second, competing menu implementation.
 */

const STYLE_ID = 'qu-ui-slot-resolver-style';
const STYLE = `
  .qu-slot-resolver { display: inline-flex; align-items: center; gap: 0.2rem; }
  .qu-slot-resolver-item { border: none; background: transparent; cursor: pointer; font-size: 1em; padding: 0.1rem 0.4rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-slot-resolver-item:hover { background: var(--qu-color-border, #8884); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function renderInlineItem(item) {
  if (item.mount) {
    const wrap = document.createElement('span');
    item.mount(wrap);
    return wrap;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qu-slot-resolver-item';
  if (item.icon) btn.textContent = item.icon;
  if (item.label) btn.title = item.label;
  if (item.label && !item.icon) btn.textContent = item.label;
  btn.addEventListener('click', () => item.onClick?.());
  return btn;
}

/**
 * @typedef {Object} SlotItem
 * @property {string} id
 * @property {string} [icon]
 * @property {string} [label]
 * @property {number} [order]
 * @property {() => void} [onClick] - simple item: an inline button, or a menu entry.
 * @property {(el: HTMLElement) => void} [mount] - rich item (e.g. a picker widget) -
 *   `'inline'`/leading part of `'inline-then-menu'` only; a `'menu'`-rendered
 *   entry always falls back to `icon`+`label`+`onClick` (`renderContextMenu()`'s
 *   own item shape has no room for arbitrary mounted DOM).
 * @property {(state: object) => boolean} [when] - `'switch'` strategy only.
 *   Items with no `when` act as the unconditional "else" - put such an item
 *   LAST; an earlier one would simply always win (not enforced by throwing,
 *   same honest-over-defensive posture the rest of this codebase takes).
 */

/**
 * @param {HTMLElement} container - appended into; left otherwise untouched.
 * @param {SlotItem[]} items
 * @param {{strategy?: 'inline'|'menu'|'inline-then-menu'|'switch', threshold?: number, moreIcon?: string, moreLabel?: string}} [options]
 * @returns {{setItems: (items: SlotItem[]) => void, resolve: (state?: object) => void, stop: () => void}}
 */
export function mountResolvedSlot(container, items, { strategy = 'inline', threshold = 2, moreIcon = '⋯', moreLabel = 'More' } = {}) {
  ensureStyle();
  const root = document.createElement('span');
  root.className = 'qu-slot-resolver';
  container.appendChild(root);

  let currentItems = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let switchActiveId = null;

  function clear() {
    root.innerHTML = '';
  }

  function renderInline(list) {
    for (const item of list) root.appendChild(renderInlineItem(item));
  }

  function renderMenu(list) {
    root.appendChild(renderContextMenu({
      trigger: moreIcon,
      triggerTitle: moreLabel,
      getItems: () => list.map((item) => ({ id: item.id, label: item.label ?? item.id, icon: item.icon, onClick: item.onClick })),
    }));
  }

  function renderSwitch(state) {
    const winner = currentItems.find((item) => !item.when || item.when(state)) ?? currentItems[currentItems.length - 1];
    if (!winner) return;
    if (winner.id === switchActiveId) return; // already showing this one - avoid tearing down/rebuilding (and losing e.g. a mounted widget's own internal state) for no change
    switchActiveId = winner.id;
    clear();
    root.appendChild(renderInlineItem(winner));
  }

  function render(state = {}) {
    if (strategy === 'switch') { renderSwitch(state); return; }
    clear();
    switchActiveId = null;
    if (strategy === 'menu') { renderMenu(currentItems); return; }
    if (strategy === 'inline-then-menu' && currentItems.length > threshold) {
      renderInline(currentItems.slice(0, threshold));
      renderMenu(currentItems.slice(threshold));
      return;
    }
    renderInline(currentItems); // 'inline', or 'inline-then-menu' with nothing over threshold
  }

  render();

  return {
    setItems(nextItems) {
      currentItems = [...nextItems].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      render();
    },
    resolve(state = {}) {
      render(state);
    },
    stop() {
      clear();
      root.remove();
    },
  };
}
