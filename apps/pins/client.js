/**
 * PINS — an admin-toggleable plugin (turn it off via relay-settings'
 * `disabledApps`, see `@qu/foundation`'s `ExtensionPointHost` doc comment)
 * instead of hardcoded forum chrome. Extracted out of
 * `apps/forum/client.js`'s own `mountPinButton()`/`renderPinned()` - same
 * `PinService` underneath, now reached through two extension points
 * `apps/forum` defines instead of calling this UI inline: a per-message
 * `content.messagePinToggle` (the Pin/Unpin button in a message's own
 * action row) and a per-topic `forum.topicToolbar` (the "📌 Pinned" bar at
 * the top of a topic, rendered ONCE per topic view, not once per message -
 * see that point's own payload contract below).
 *
 * LIVENESS: same reasoning as `apps/reactions/client.js`'s own doc comment
 * - `ExtensionPointHost.renderSlot()` threads no teardown handle back to
 * the host app, so both widgets here are tiny Custom Elements whose
 * `connectedCallback()`/`disconnectedCallback()` self-manage their own
 * `watchChildren()` subscription in step with their own DOM lifetime.
 *
 * CONTRIBUTOR PAYLOAD CONTRACTS:
 *  - `content.messagePinToggle`: `(container, {services, qu, syncFetch,
 *    spaceId, threadId, messageId})` - one button, reflecting/toggling
 *    whether THIS message is pinned.
 *  - `forum.topicToolbar`: `(container, {services, qu, syncFetch, spaceId,
 *    threadId})` - rendered once when a topic view mounts (no `messageId` -
 *    this is topic-scoped, not per-message), shows every currently pinned
 *    message with an inline "unpin" - empty (renders nothing) when the
 *    topic has no pins, same as the original inline `renderPinned()`'s own
 *    "nothing to show" behavior.
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

class QuPinToggleElement extends HTMLElement {
  /** Set BEFORE this element is appended - see `apps/reactions/client.js`'s own doc comment on why. */
  configure(opts) {
    this._opts = opts;
  }

  connectedCallback() {
    const { qu, syncFetch, spaceId, threadId } = this._opts;
    this._btn = document.createElement('button');
    this._btn.type = 'button';
    this.appendChild(this._btn);
    this._token = 0;
    this._off = watchChildren(qu, paths.threadPinsParentPath(spaceId, threadId), () => this._render(), { syncFetch });
    this._render();
  }

  disconnectedCallback() {
    this._off?.();
  }

  async _render() {
    const token = ++this._token;
    const { services, spaceId, threadId, messageId } = this._opts;
    const pinnedIds = await services.pins.listPinned(spaceId, threadId);
    if (token !== this._token) return;
    const pinned = pinnedIds.includes(messageId);
    this._btn.textContent = pinned ? t('unpin') : t('pin');
    this._btn.onclick = () => services.pins.setPinned(spaceId, threadId, messageId, !pinned);
  }
}
if (!customElements.get('qu-pin-toggle')) customElements.define('qu-pin-toggle', QuPinToggleElement);

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
 * The `content.messagePinToggle` contributor - see this file's own top doc
 * comment for the full payload contract.
 * @param {HTMLElement} container
 * @param {{services: object, qu: object, syncFetch?: Function, spaceId: string, threadId: string, messageId: string}} payload
 */
export async function renderPinToggle(container, payload) {
  const el = document.createElement('qu-pin-toggle');
  el.configure(payload);
  container.appendChild(el);
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
