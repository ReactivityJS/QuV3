/**
 * REACTIONS — an admin-toggleable plugin (turn it off via relay-settings'
 * `disabledApps`, see `@qu/foundation`'s `ExtensionPointHost` doc comment on
 * how a disabled app's `contributes` entries stop firing entirely) instead
 * of hardcoded forum/chat chrome. Extracted out of `apps/forum/client.js`'s
 * own `mountReactions()` - same `ReactionService` underneath, now reached
 * through `content.messageFooter` (the per-message footer ROW - menu
 * trigger, timestamp, read-tick, reactions - both `apps/forum` and
 * `apps/chat` render, see either's own doc comment), no forum/chat-specific
 * code in this file either direction (this file never imports either host;
 * neither host imports this file - see `apps/bookmarks/client.js`'s own doc
 * comment for the established shape this follows). Its position WITHIN that
 * row (leftmost by this codebase's own default - see either host's
 * `DEFAULT_FOOTER_ORDER`) is admin-configurable via relay-settings'
 * `extensionOrder['content.messageFooter']`, keyed by this app's own
 * manifest `name` ("reactions") - see `@qu/foundation`'s `rankFor()`.
 *
 * UX MODEL - modeled after QuV2's chat app (`apps/chat/client.js`), not
 * this app's own QuV2-forum predecessor (which had no reactions at all) or
 * V3's own first-round forum implementation (a fixed 5-emoji row, always
 * visible, whether used or not): only emoji that actually have >=1 reactor
 * render, as small pills with a count, the current identity's own reaction
 * (if any) highlighted - plus a single, always-present "+" trigger
 * (`@qu/thread-ui`'s `renderEmojiPicker()`, unmodified - the same shared
 * primitive the forum composer's own emoji-insert button already uses) that
 * reveals the full curated emoji grid to add a new reaction. A message with
 * zero reactions so far shows just the "+" - never an empty row of unused
 * quick-picks.
 *
 * LIVENESS: `ExtensionPointHost.renderSlot()` is fire-and-forget - a
 * contributor's rendered DOM gets no teardown callback threaded back to the
 * host app (see that class's own doc comment: contributors are expected to
 * mount their own DOM into the container they're handed and nothing more).
 * A live reaction row still needs to update the moment someone (else)
 * reacts, without the whole message list re-rendering - solved with a tiny
 * Custom Element (`<qu-reactions-row>`) instead of a plain render function:
 * `connectedCallback()`/`disconnectedCallback()` are the browser's own
 * "this got inserted/removed from the DOM" hooks, so the live
 * `watchChildren()` subscription self-manages its lifecycle exactly in step
 * with the row's own DOM lifetime - no cooperation from the host required,
 * same reasoning `@qu/ui`'s own `<qu-view>`/`<qu-list>` already use (see
 * `packages/ui/src/components.js`'s own doc comment).
 *
 * CONTRIBUTOR PAYLOAD CONTRACT (`content.messageFooter`): `(container,
 * payload)` where `payload` is `{services, qu, syncFetch, spaceId,
 * threadId, messageId, myPub}` - `qu`/`syncFetch` (not part of
 * `content.messageActions`' own payload shape) are needed here because a
 * live reaction count genuinely needs `watchChildren()`, not just a
 * `services.reactions` call.
 *
 * QUNIVERSE V4 (Forum-migration round, docs/v4-concept.md §4): a second
 * export, `renderEntityReactionWidget()`, contributes the SAME widget to a
 * new `content.entityFooter` point - for reacting to an Entity's own
 * content (e.g. a Forum Topic's opening post), not one of its comments.
 * `<qu-reactions-row>` is generalized rather than duplicated: its
 * `configure()` payload now takes EITHER `{threadId, messageId}` (message-
 * scoped, `threadReactionsParentPath()`/`setReaction()`/`getReactions()`) OR
 * `{entityId}` (entity-scoped, `entityReactionsParentPath()`/
 * `setEntityReaction()`/`getEntityReactions()`) - exactly one of the two
 * shapes, picked once in `connectedCallback()`/`_render()`, no other logic
 * forks on it. Admin-togglable via the exact same `disabledApps` mechanism
 * already covering the message-scoped contribution - one manifest, one
 * `enabled` flag, two points.
 */
import { watchChildren } from '@qu/reactive';
import { paths } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';
import { renderEmojiPicker } from '@qu/thread-ui';

const DICT = {
  en: { react: 'React' },
  de: { react: 'Reagieren' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-reactions-style';
const STYLE = `
  .qu-reactions-row { display: flex; gap: 0.3rem; margin-top: 0.4rem; flex-wrap: wrap; align-items: center; }
  .qu-reactions-pill { border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; background: transparent; cursor: pointer; padding: 0.1rem 0.5rem; font-size: 0.9em; }
  .qu-reactions-pill-mine { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 20%, transparent); border-color: var(--qu-color-accent, #5b5bd6); }
`;

class QuReactionsRowElement extends HTMLElement {
  /**
   * Set BEFORE this element is appended - `connectedCallback()` runs
   * synchronously on insertion (same ordering constraint `@qu/ui`'s own
   * Custom Elements document), so `renderReactionWidget()`/
   * `renderEntityReactionWidget()` below always call this first.
   *
   * EITHER the message-scoped shape (`{spaceId, threadId, messageId}`) OR
   * the entity-scoped shape (`{spaceId, entityId}`) - never both - see this
   * file's own top doc comment.
   * @param {{services: object, qu: object, syncFetch?: Function, spaceId: string, threadId?: string, messageId?: string, entityId?: string, myPub: string}} opts
   */
  configure(opts) {
    this._opts = opts;
  }

  #watchPath() {
    const { spaceId, threadId, messageId, entityId } = this._opts;
    return entityId != null ? paths.entityReactionsParentPath(spaceId, entityId) : paths.threadReactionsParentPath(spaceId, threadId, messageId);
  }

  #getReactions() {
    const { services, spaceId, threadId, messageId, entityId } = this._opts;
    return entityId != null ? services.reactions.getEntityReactions(spaceId, entityId) : services.reactions.getReactions(spaceId, threadId, messageId);
  }

  #setReaction(emoji) {
    const { services, spaceId, threadId, messageId, entityId } = this._opts;
    return entityId != null ? services.reactions.setEntityReaction(spaceId, entityId, emoji) : services.reactions.setReaction(spaceId, threadId, messageId, emoji);
  }

  connectedCallback() {
    ensureTheme();
    injectStyle(STYLE_ID, STYLE);
    this._token = 0;
    const { qu, syncFetch } = this._opts;
    this._off = watchChildren(qu, this.#watchPath(), () => this._render(), { syncFetch });
    this._render();
  }

  disconnectedCallback() {
    this._off?.();
  }

  async _render() {
    const token = ++this._token;
    const { myPub } = this._opts;
    const reactions = await this.#getReactions();
    if (token !== this._token) return; // a newer render already superseded this one (two watchChildren() fires racing) - see this file's own doc comment

    this.textContent = '';
    const row = document.createElement('div');
    row.className = 'qu-reactions-row';

    let myReaction = null;
    for (const [emoji, reactors] of Object.entries(reactions)) {
      if (reactors.includes(myPub)) { myReaction = emoji; break; }
    }

    for (const [emoji, reactors] of Object.entries(reactions)) {
      if (reactors.length === 0) continue; // only emoji someone actually picked ever render as a pill
      const mine = emoji === myReaction;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qu-reactions-pill' + (mine ? ' qu-reactions-pill-mine' : '');
      btn.textContent = `${emoji} ${reactors.length}`;
      btn.addEventListener('click', () => this.#setReaction(mine ? null : emoji));
      row.appendChild(btn);
    }

    row.appendChild(renderEmojiPicker({
      onPick: (emoji) => this.#setReaction(emoji === myReaction ? null : emoji),
      trigger: '+',
      triggerTitle: t('react'),
    }));
    this.appendChild(row);
  }
}
if (!customElements.get('qu-reactions-row')) customElements.define('qu-reactions-row', QuReactionsRowElement);

/**
 * The `content.messageFooter` contributor - see this file's own top doc
 * comment for the full payload contract.
 * @param {HTMLElement} container
 * @param {{services: object, qu: object, syncFetch?: Function, spaceId: string, threadId: string, messageId: string, myPub: string}} payload
 */
export async function renderReactionWidget(container, payload) {
  const el = document.createElement('qu-reactions-row');
  el.configure(payload);
  container.appendChild(el);
}

/**
 * The `content.entityFooter` contributor - reacting to an Entity's own
 * content (Quniverse V4, Forum-migration round) rather than one of its
 * comments. See this file's own top doc comment for the payload contract.
 * @param {HTMLElement} container
 * @param {{services: object, qu: object, syncFetch?: Function, spaceId: string, entityId: string, myPub: string}} payload
 */
export async function renderEntityReactionWidget(container, payload) {
  const el = document.createElement('qu-reactions-row');
  el.configure(payload);
  container.appendChild(el);
}
