/**
 * CONTEXT MENU — one small, reusable "⋮"-style trigger that reveals a
 * vertical list of labeled actions, same trigger/panel/outside-click-close
 * shape as this package's own `renderEmojiPicker()` (see `emoji.js`'s own
 * doc comment), just rendering items instead of an emoji grid.
 *
 * The intended consumer is a message's own context menu
 * (`content.messageMenu`, a `kind: 'menu'` extension point - see
 * `apps/forum/client.js`/`apps/chat/client.js`'s own doc comments): a host
 * app computes its OWN native items (Edit, Reply, ...) directly, merges
 * them with whatever `ExtensionPointHost.collect()` returns for the point
 * (Pin, Bookmark, ...), sorts the combined list via `@qu/foundation`'s
 * `rankFor()`, and hands the final array here as `getItems` - this
 * component itself has no opinion on WHERE items come from or how they're
 * ordered, only how the trigger/panel/click-to-run interaction works.
 *
 * `getItems` is a function (not a plain array) so the menu can be built
 * lazily, fresh, every time it's opened - the same "no live subscription
 * needed, a menu is transient" reasoning `ExtensionPointHost.collect()`
 * itself already documents (ports like Pin resolve their CURRENT
 * pinned-state fresh on each `collect()` call, not via a standing watcher).
 */
const STYLE_ID = 'qu-thread-ui-context-menu-style';
const STYLE = `
  .qu-thread-ui-context-menu { position: relative; display: inline-flex; }
  .qu-thread-ui-context-menu-trigger { border: none; background: transparent; cursor: pointer; font-size: 1em; padding: 0.1rem 0.4rem; border-radius: var(--qu-radius-sm, 0.3rem); opacity: 0.7; }
  .qu-thread-ui-context-menu-trigger:hover { opacity: 1; background: var(--qu-color-border, #8884); }
  .qu-thread-ui-context-menu-panel { position: absolute; z-index: 20; top: 100%; right: 0; margin-top: 0.2rem; display: flex; flex-direction: column; min-width: 9rem; padding: 0.3rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); background: var(--qu-color-surface, canvas); box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.2); }
  .qu-thread-ui-context-menu-item { display: flex; align-items: center; gap: 0.5rem; border: none; background: transparent; cursor: pointer; font: inherit; text-align: left; padding: 0.35rem 0.5rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-thread-ui-context-menu-item:hover { background: var(--qu-color-border, #8884); }
  .qu-thread-ui-context-menu-empty { padding: 0.35rem 0.5rem; font-size: 0.85em; opacity: 0.6; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {object} options
 * @param {() => Promise<Array<{id: string, label: string, icon?: string, onClick: () => void}>>|Array<object>} options.getItems
 *   Called fresh every time the trigger opens the panel - may be async.
 * @param {string} [options.trigger] - Trigger button glyph/label.
 * @param {string} [options.triggerTitle]
 * @param {string} [options.emptyLabel] - Shown instead of an empty panel when `getItems()` resolves to nothing.
 * @returns {HTMLElement}
 */
export function renderContextMenu({ getItems, trigger = '⋮', triggerTitle = 'More', emptyLabel = null }) {
  ensureStyle();
  const root = document.createElement('span');
  root.className = 'qu-thread-ui-context-menu';

  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'qu-thread-ui-context-menu-trigger';
  triggerBtn.textContent = trigger;
  triggerBtn.title = triggerTitle;
  root.appendChild(triggerBtn);

  let panel = null;
  let opening = false; // re-entrancy guard - see openPanel()'s own comment
  function onDocClick(e) {
    if (panel && !root.contains(e.target)) closePanel();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') closePanel();
  }
  function closePanel() {
    panel?.remove();
    panel = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeydown);
  }
  async function openPanel() {
    if (panel) { closePanel(); return; }
    // getItems() may be async - guard against a second click firing (and
    // starting a SECOND openPanel()) while the first is still awaiting,
    // which would otherwise leave two panels appended.
    if (opening) return;
    opening = true;
    let items;
    try {
      items = (await getItems()) ?? [];
    } finally {
      opening = false;
    }
    if (panel) return; // closed (or reopened) while we were awaiting

    panel = document.createElement('div');
    panel.className = 'qu-thread-ui-context-menu-panel';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qu-thread-ui-context-menu-empty';
      empty.textContent = emptyLabel ?? '···';
      panel.appendChild(empty);
    }
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qu-thread-ui-context-menu-item';
      if (item.icon) {
        const iconEl = document.createElement('span');
        iconEl.textContent = item.icon;
        btn.appendChild(iconEl);
      }
      const labelEl = document.createElement('span');
      labelEl.textContent = item.label;
      btn.appendChild(labelEl);
      btn.addEventListener('click', () => {
        closePanel();
        item.onClick?.();
      });
      panel.appendChild(btn);
    }
    root.appendChild(panel);
    // Deferred one tick - same reasoning as renderEmojiPicker()'s own
    // openPanel(): without it, THIS click would immediately bubble into
    // onDocClick and close the panel it just opened.
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKeydown);
    }, 0);
  }
  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPanel();
  });

  return root;
}
