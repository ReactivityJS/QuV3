/**
 * PINS — an admin-toggleable plugin (turn it off via relay-settings'
 * `disabledApps`, see `@qu/foundation`'s `ExtensionPointHost` doc comment)
 * instead of hardcoded forum/chat chrome. Extracted out of
 * `apps/forum/client.js`'s own `mountPinButton()`/`renderPinned()` - same
 * `PinService` underneath, now reached through two extension points both
 * `apps/forum` and `apps/chat` render instead of calling this UI inline:
 * `content.messageMenu` (a Pin/Unpin ENTRY in a message's own "⋮" context
 * menu - see either host's own doc comment for the full menu contract) and
 * a per-topic/room `content.topicToolbar` (the "📌 Pinned" bar at the top of
 * a forum topic OR a chat room, rendered ONCE per view, not once per
 * message - see that point's own payload contract below; host-agnostic on
 * purpose, exactly like `content.composerActions`, so both `apps/forum` and
 * `apps/chat` render the SAME contributor instead of each carrying their own
 * copy of this bar).
 *
 * `content.messageMenu` is `kind: 'menu'` (`ExtensionPointHost.collect()`),
 * NOT `kind: 'ui'` - unlike the always-visible `content.topicToolbar` bar
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
 *  - `content.topicToolbar`: `(container, {services, qu, syncFetch, spaceId,
 *    threadId, messagePermalink?})` - rendered once when a topic/room view
 *    mounts (no `messageId` - this is topic/room-scoped, not per-message),
 *    shows EVERY currently pinned message (no cap - a long pin list scrolls
 *    inside the bar itself rather than hiding entries), each with an inline
 *    "unpin" - empty (renders nothing) when the topic has no pins, same as
 *    the original inline `renderPinned()`'s own "nothing to show" behavior.
 *    Still a live Custom Element (`watchChildren()` self-managed via
 *    `connectedCallback()`/`disconnectedCallback()`, same reasoning
 *    `apps/reactions/client.js`'s own doc comment has) - this bar IS
 *    continuously on-screen, unlike a menu item. `messagePermalink`
 *    (optional - a host may not provide one) is a `(messageId) => string`
 *    href builder, supplied by the HOST app (its own route shape, e.g.
 *    `#/forum/t/<topicId>/m/<id>` vs chat's `#/chat/<peer>/m/<id>`) rather
 *    than hardcoded here - this file stays host-agnostic (per its own top
 *    doc comment: both `apps/forum` and `apps/chat` render this SAME
 *    contributor into `content.topicToolbar`). Falls back to a plain,
 *    unclickable snippet when omitted.
 */
import { watchChildren } from '@qu/reactive';
import { paths } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const DICT = {
  en: { pin: 'Pin', unpin: 'Unpin', pinnedBar: 'Pinned', showAll: 'Show all', showLess: 'Show less' },
  de: { pin: 'Anheften', unpin: 'Lösen', pinnedBar: 'Angeheftet', showAll: 'Alle anzeigen', showLess: 'Weniger anzeigen' },
};
const { t } = createI18n(DICT);

// Above this many simultaneous pins, the bar collapses to the COLLAPSE_ROWS
// most-recently-pinned entries plus a "Show all"/"Show less" toggle (see
// _render() below) instead of growing unbounded - a topic/room with a dozen
// pins would otherwise push the entire message list down every time it
// mounts.
const COLLAPSE_ROWS = 3;

const STYLE_ID = 'qu-pins-style';
const STYLE = `
  .qu-pins-bar { border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.5rem 0.7rem; margin-bottom: 0.6rem; }
  .qu-pins-bar-title { display: flex; align-items: center; gap: 0.4rem; font-weight: 600; font-size: 0.85em; margin-bottom: 0.3rem; }
  button.qu-pins-bar-title { background: none; border: none; cursor: pointer; color: inherit; font: inherit; padding: 0; width: 100%; text-align: left; }
  button.qu-pins-bar-title:hover { opacity: 0.8; }
  .qu-pins-bar-title-chevron { font-size: 0.8em; }
  .qu-pins-bar-rows { max-height: 12rem; overflow-y: auto; }
  .qu-pins-bar-row { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.15rem 0; }
  .qu-pins-bar-row button { background: none; border: none; cursor: pointer; opacity: 0.6; font: inherit; padding: 0; }
  .qu-pins-bar-row button:hover { opacity: 1; }
  .qu-pins-bar-row-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.qu-pins-bar-row-text { color: inherit; text-decoration: none; cursor: pointer; }
  a.qu-pins-bar-row-text:hover { text-decoration: underline; }
`;

class QuPinnedBarElement extends HTMLElement {
  configure(opts) {
    this._opts = opts;
  }

  connectedCallback() {
    ensureTheme();
    injectStyle(STYLE_ID, STYLE);
    this._token = 0;
    // Collapsed by default - see COLLAPSE_ROWS' own doc comment. Lives on
    // the element itself (not re-derived per render) so toggling it survives
    // the live re-renders watchChildren() below triggers on every pin/unpin,
    // instead of snapping back closed the instant something else changes.
    this._expanded = false;
    const { qu, syncFetch, spaceId, threadId } = this._opts;
    this._off = watchChildren(qu, paths.threadPinsParentPath(spaceId, threadId), () => this._render(), { syncFetch });
    this._render();
  }

  disconnectedCallback() {
    this._off?.();
  }

  async _render() {
    const token = ++this._token;
    const { services, spaceId, threadId, messagePermalink } = this._opts;
    const pinnedIds = await services.pins.listPinned(spaceId, threadId);
    if (token !== this._token) return;
    this.textContent = '';
    if (pinnedIds.length === 0) return;

    const collapsible = pinnedIds.length > COLLAPSE_ROWS;
    const expanded = this._expanded || !collapsible;
    const visibleIds = expanded ? pinnedIds : pinnedIds.slice(0, COLLAPSE_ROWS);

    const box = document.createElement('div');
    box.className = 'qu-pins-bar';

    // A plain, non-interactive label when there's nothing to expand/collapse
    // (nothing hidden); a real <button> toggling `_expanded` + re-rendering
    // when there is - clicking it (or the "Show all"/"Show less" hint it
    // carries) is how "see every pinned message" works once there are more
    // than COLLAPSE_ROWS of them.
    const title = document.createElement(collapsible ? 'button' : 'div');
    title.className = 'qu-pins-bar-title';
    if (collapsible) title.type = 'button';
    const titleLabel = document.createElement('span');
    titleLabel.textContent = `📌 ${t('pinnedBar')} (${pinnedIds.length})`;
    title.appendChild(titleLabel);
    if (collapsible) {
      const hint = document.createElement('span');
      hint.className = 'qu-pins-bar-title-chevron';
      hint.textContent = expanded ? `▲ ${t('showLess')}` : `▼ ${t('showAll')}`;
      title.appendChild(hint);
      title.addEventListener('click', () => {
        this._expanded = !this._expanded;
        this._render();
      });
    }
    box.appendChild(title);

    const rows = document.createElement('div');
    rows.className = 'qu-pins-bar-rows';
    for (const messageId of visibleIds) {
      // `services.messages.getMessage()`, NOT a raw `qu.get(threadMessagePath(...))`
      // read - a forum topic's thread is plaintext, so the raw QuBit's own
      // `.val.body` happened to work there, but a chat room's thread is
      // END-TO-END ENCRYPTED (see MessageService's own `#decryptMessage()`):
      // reading the raw QuBit directly showed ciphertext/undefined instead
      // of the pinned message's real text. Going through the Service that
      // already knows how to decrypt it (exactly what every OTHER message
      // read in this codebase does) fixes both hosts uniformly.
      const message = await services.messages.getMessage(spaceId, threadId, messageId);
      if (token !== this._token) return;
      const row = document.createElement('div');
      row.className = 'qu-pins-bar-row';
      // A real link to the pinned message's own permalink when the host
      // supplies one (clicking it scrolls to/highlights the original post -
      // see this file's own top doc comment) - a plain, unclickable span
      // otherwise (no host-specific route to build one from).
      const textEl = document.createElement(messagePermalink ? 'a' : 'span');
      textEl.className = 'qu-pins-bar-row-text';
      if (messagePermalink) textEl.href = messagePermalink(messageId);
      textEl.textContent = message?.body ?? messageId;
      const unpinBtn = document.createElement('button');
      unpinBtn.type = 'button';
      unpinBtn.textContent = '✕';
      unpinBtn.title = t('unpin');
      unpinBtn.addEventListener('click', () => services.pins.setPinned(spaceId, threadId, messageId, false));
      row.append(textEl, unpinBtn);
      rows.appendChild(row);
    }
    box.appendChild(rows);
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
 * The `content.topicToolbar` contributor - see this file's own top doc
 * comment for the full payload contract.
 * @param {HTMLElement} container
 * @param {{services: object, qu: object, syncFetch?: Function, spaceId: string, threadId: string}} payload
 */
export async function renderPinnedBar(container, payload) {
  const el = document.createElement('qu-pinned-bar');
  el.configure(payload);
  container.appendChild(el);
}
