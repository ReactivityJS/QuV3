/**
 * PINS — an admin-toggleable plugin (turn it off via relay-settings'
 * `disabledApps`, see `@qu/foundation`'s `ExtensionPointHost` doc comment)
 * instead of hardcoded forum/chat chrome. Extracted out of
 * `apps/forum/client.js`'s own `mountPinButton()`/`renderPinned()` - same
 * `PinService` underneath, now reached through two extension points both
 * `apps/forum` and `apps/chat` render instead of calling this UI inline:
 * `content.messageMenu` (a Pin/Unpin ENTRY in a message's own "⋮" context
 * menu - see either host's own doc comment for the full menu contract) and
 * a per-topic `forum.topicToolbar` (the "📌 Pinned" bar at the top of a
 * forum topic, rendered ONCE per topic view, not once per message - see
 * that point's own payload contract below; chat has no equivalent toolbar
 * today, a real, valid follow-up).
 *
 * `content.messageMenu` is `kind: 'menu'` (`ExtensionPointHost.collect()`),
 * NOT `kind: 'ui'` - unlike the always-visible `forum.topicToolbar` bar
 * below (still a live Custom Element, since it's on-screen continuously),
 * a context-menu ITEM only needs to be correct at the moment the menu
 * opens: `pinMenuItem()` resolves the CURRENT pinned state fresh on every
 * `collect()` call (the menu is transient - closed, then reopened, not a
 * standing subscription), so no Custom Element/`watchChildren()` is needed
 * for this half of the file anymore.
 *
 * CONTRIBUTOR PAYLOAD CONTRACTS:
 *  - `content.messageMenu`: `(payload) -> {id, label, icon, onClick}` where
 *    `payload` is `{services, qu, syncFetch, spaceId, threadId, messageId,
 *    myPub, mine}` - see either host's own doc comment for the full shape.
 *  - `forum.topicToolbar`: `(container, {services, qu, syncFetch, spaceId,
 *    threadId})` - rendered once when a topic view mounts (no `messageId` -
 *    this is topic-scoped, not per-message), shows every currently pinned
 *    message with an inline "unpin" - empty (renders nothing) when the
 *    topic has no pins, same as the original inline `renderPinned()`'s own
 *    "nothing to show" behavior. Still a live Custom Element (`watchChildren()`
 *    self-managed via `connectedCallback()`/`disconnectedCallback()`, same
 *    reasoning `apps/reactions/client.js`'s own doc comment has) - this bar
 *    IS continuously on-screen, unlike a menu item.
 */
import { watchChildren } from '@qu/reactive';
import { paths } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const DICT = {
  en: { pin: 'Pin', unpin: 'Unpin', pinnedBar: 'Pinned' },
  de: { pin: 'Anheften', unpin: 'Lösen', pinnedBar: 'Angeheftet' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-pins-style';
const STYLE = `
  .qu-pins-bar { border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.5rem 0.7rem; margin-bottom: 0.6rem; }
  .qu-pins-bar-title { font-weight: 600; font-size: 0.85em; margin-bottom: 0.3rem; }
  .qu-pins-bar-row { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.15rem 0; }
  .qu-pins-bar-row button { background: none; border: none; cursor: pointer; opacity: 0.6; font: inherit; padding: 0; }
  .qu-pins-bar-row button:hover { opacity: 1; }
`;

class QuPinnedBarElement extends HTMLElement {
  configure(opts) {
    this._opts = opts;
  }

  connectedCallback() {
    ensureTheme();
    injectStyle(STYLE_ID, STYLE);
    this._token = 0;
    const { qu, syncFetch, spaceId, threadId } = this._opts;
    this._off = watchChildren(qu, paths.threadPinsParentPath(spaceId, threadId), () => this._render(), { syncFetch });
    this._render();
  }

  disconnectedCallback() {
    this._off?.();
  }

  async _render() {
    const token = ++this._token;
    const { services, qu, spaceId, threadId } = this._opts;
    const pinnedIds = await services.pins.listPinned(spaceId, threadId);
    if (token !== this._token) return;
    this.textContent = '';
    if (pinnedIds.length === 0) return;

    const box = document.createElement('div');
    box.className = 'qu-pins-bar';
    const title = document.createElement('div');
    title.className = 'qu-pins-bar-title';
    title.textContent = `📌 ${t('pinnedBar')} (${pinnedIds.length})`;
    box.appendChild(title);

    for (const messageId of pinnedIds) {
      const quBit = await qu.get(paths.threadMessagePath(spaceId, threadId, messageId));
      if (token !== this._token) return;
      const row = document.createElement('div');
      row.className = 'qu-pins-bar-row';
      const span = document.createElement('span');
      span.textContent = quBit?.val?.body ?? messageId;
      const unpinBtn = document.createElement('button');
      unpinBtn.type = 'button';
      unpinBtn.textContent = '✕';
      unpinBtn.title = t('unpin');
      unpinBtn.addEventListener('click', () => services.pins.setPinned(spaceId, threadId, messageId, false));
      row.append(span, unpinBtn);
      box.appendChild(row);
    }
    this.appendChild(box);
  }
}
if (!customElements.get('qu-pinned-bar')) customElements.define('qu-pinned-bar', QuPinnedBarElement);

/**
 * The `content.messageMenu` contributor - see this file's own top doc
 * comment for the full payload contract. Resolves the CURRENT pinned state
 * fresh (no live subscription - see this file's own top doc comment on why
 * that's fine for a menu item).
 * @param {{services: object, spaceId: string, threadId: string, messageId: string}} payload
 * @returns {Promise<{id: string, label: string, icon: string, onClick: () => void}>}
 */
export async function pinMenuItem({ services, spaceId, threadId, messageId }) {
  const pinnedIds = await services.pins.listPinned(spaceId, threadId);
  const pinned = pinnedIds.includes(messageId);
  return {
    id: 'pin',
    label: pinned ? t('unpin') : t('pin'),
    icon: '📌',
    onClick: () => services.pins.setPinned(spaceId, threadId, messageId, !pinned),
  };
}

/**
 * The `forum.topicToolbar` contributor - see this file's own top doc
 * comment for the full payload contract.
 * @param {HTMLElement} container
 * @param {{services: object, qu: object, syncFetch?: Function, spaceId: string, threadId: string}} payload
 */
export async function renderPinnedBar(container, payload) {
  const el = document.createElement('qu-pinned-bar');
  el.configure(payload);
  container.appendChild(el);
}
