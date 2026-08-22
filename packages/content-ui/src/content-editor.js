import { mountComposerAutogrow, COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS, insertAtCursor } from '@qu/thread-ui';
import { mountResolvedSlot } from '@qu/ui';

/**
 * CONTENT EDITOR — the smallest reusable unit of Quniverse V4's
 * ContentEditor layer (see docs/v4-concept.md §5): a `<textarea>` + a
 * leading action slot + a switch-resolved submit control + an "actions"
 * slot `EditorExtension`s mount their own trailing UI into. Every
 * app-specific composer (`apps/forum/client.js`'s hand-assembled composer
 * today, this generalizes exactly that assembly) is meant to be built FROM
 * this, not around a bespoke textarea of its own.
 *
 * Reuses `@qu/thread-ui`'s existing, already-proven primitives verbatim -
 * `mountComposerAutogrow()` (built in, not optional) and `insertAtCursor()`
 * (wrapped as `insertText`) - and `@qu/ui`'s `mountResolvedSlot()` (the
 * Presentation Resolver, docs/v4-concept.md §6) for BOTH the leading action
 * area and the submit control itself, instead of raw, unmanaged DOM.
 *
 * THE EditorExtension CONTRACT (docs/v4-concept.md §5/§12): `{id,
 * mount(ctx) -> stopFn|{stop?, reset?}|void}` - `reset()` (Forum-migration
 * round) is an extension's chance to clear its OWN UI/state whenever
 * `clearContributions()` runs (a normal submit succeeded - see
 * `mountContentComposer()`'s own doc comment), since `contributeContent()`/
 * `retractContent()` alone only track the EDITOR's own merge-map, not
 * whatever DOM an extension rendered for its contribution (e.g.
 * `attachmentExtension()`'s own pending-attachment chip, which would
 * otherwise keep showing - and keep re-attaching itself to every
 * SUBSEQUENT send - after the message it was actually meant for already
 * went out). `ctx`:
 *   - `textarea`, `insertText(text)` - unchanged from the previous round.
 *   - `actionsEl` - the TRAILING slot (still raw DOM - unmanaged, kept for
 *     the existing Emoji/Mention extensions exactly as before).
 *   - `registerAction(item)` / `unregisterAction(id)` - contributes a
 *     `SlotItem` (`@qu/ui`'s `mountResolvedSlot()`) to the LEADING slot,
 *     presented per `options.leadingSlot`'s configured strategy (inline,
 *     collapsed into a menu, or a hybrid threshold) - an extension never
 *     knows or cares which; that's the resolver's job, not the extension's.
 *   - `registerToolbarItem(item)` / `unregisterToolbarItem(id)` - contributes
 *     a `SlotItem` to a SEPARATE row above the textarea, its own
 *     `mountResolvedSlot()` instance (own overflow threshold, own "more"
 *     menu) - deliberately NOT the same slot as `registerAction()`: that one
 *     already carries `attachmentExtension()`'s trigger and any
 *     `content.composerActions` plugin items in Forum's composers, and
 *     mixing text-formatting controls into that same resolver would overflow
 *     it into one menu blending file-attach with Bold/Italic (and reintroduce
 *     the composer-row squeeze a previous round fixed). Empty (no row
 *     rendered) until at least one item is registered, so a plain-format
 *     composer that never adds a toolbar extension shows no empty space.
 *     What `markdownToolbarExtension()` (`markdown-toolbar-extension.js`)
 *     uses.
 *   - `registerSubmitCandidate(item)` / `unregisterSubmitCandidate(id)` -
 *     contributes a CONDITIONAL alternative to the submit button itself
 *     (a `SlotItem` with a `when(state)`), checked BEFORE the built-in
 *     unconditional `send` item - e.g. Voice's mic-morph: "show a record
 *     button INSTEAD of Send while the composer is otherwise empty."
 *   - `contributeContent(id, partial)` / `retractContent(id)` - non-text
 *     submission data (`{attachments?, location?}`), merged into the second
 *     argument `onSubmit(text, extras)` receives, keyed by the
 *     contributing extension's own `id` so retracting one never touches
 *     another's.
 *   - `setChrome(panelEl|null)` - temporarily replaces the editor's entire
 *     normal row with `panelEl` (or restores it for `null`) - what Voice's
 *     recorder panel uses to take over the composer while recording.
 *   - `submitNow(extraPartial?)` - submits IMMEDIATELY with EMPTY text and
 *     ONLY `extraPartial` (never the currently-typed draft, never standing
 *     `contributeContent()` contributions) - what Voice's own Send uses,
 *     independent of whatever the user has (or hasn't) typed.
 */

const STYLE_ID = 'qu-content-ui-editor-style';
const STYLE = `
  .qu-content-editor { display: flex; flex-direction: column; gap: 0.3rem; position: relative; }
  .qu-content-editor-row { display: flex; align-items: flex-end; gap: 0.4rem; }
  .qu-content-editor-input-wrap { flex: 1; min-width: 0; display: flex; align-items: flex-end; gap: 0.3rem; }
  .qu-content-editor-input-wrap textarea { flex: 1; min-width: 0; font: inherit; resize: none; padding: 0.15rem 0; }
  .qu-content-editor-actions { display: flex; align-items: center; gap: 0.2rem; }
  .qu-content-editor-submit-slot { flex-shrink: 0; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {HTMLElement} container - Appended into; left otherwise untouched.
 * @param {object} [options]
 * @param {string} [options.placeholder]
 * @param {number} [options.minRows]
 * @param {number} [options.maxRows]
 * @param {Array<object>} [options.extensions] - See class doc comment for the `EditorExtension` contract.
 * @param {string} [options.submitLabel='Send'] - The submit control's
 *   accessible title/tooltip text.
 * @param {string} [options.submitIcon] - The submit control's VISIBLE text
 *   (a short glyph, e.g. '➤') - defaults to `submitLabel` itself when
 *   omitted, so a caller passing only `submitLabel` behaves exactly as
 *   before this option existed. Pass both to get a compact icon button with
 *   a real, readable tooltip instead of the icon glyph doubling as both.
 * @param {boolean} [options.requireText=true] - When `false`, submitting with
 *   empty text is always allowed (even with no contribution). When `true`
 *   (default), an empty submit is only allowed once some extension has
 *   `contributeContent()`-ed something (e.g. a pending attachment) -
 *   generalizing `apps/chat/client.js`'s own already-proven "a caption is
 *   optional whenever there's an attachment to send instead" rule.
 * @param {{strategy?: string, threshold?: number, moreIcon?: string, moreLabel?: string}} [options.leadingSlot]
 * @param {{strategy?: string, threshold?: number, moreIcon?: string, moreLabel?: string}} [options.toolbarSlot] - See `ctx.registerToolbarItem()` in the class doc comment.
 * @returns {{
 *   textarea: HTMLTextAreaElement,
 *   actionsEl: HTMLElement,
 *   getValue: () => string,
 *   setValue: (text: string) => void,
 *   focus: () => void,
 *   onSubmit: (handler: (text: string, extras: {attachments: object[], location: object|null}, meta: {immediate: boolean}) => void) => void,
 *   clearContributions: () => void,
 *   stop: () => void,
 * }}
 */
export function mountContentEditor(container, {
  placeholder = '',
  minRows = COMPOSER_MIN_ROWS,
  maxRows = COMPOSER_MAX_ROWS,
  extensions = [],
  submitLabel = 'Send',
  submitIcon = submitLabel,
  requireText = true,
  leadingSlot: leadingSlotOptions = {},
  toolbarSlot: toolbarSlotOptions = {},
} = {}) {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'qu-content-editor';

  const toolbarContainer = document.createElement('div');
  toolbarContainer.className = 'qu-content-editor-toolbar';
  toolbarContainer.hidden = true; // shown only once a first item is registered - see registerToolbarItem() below

  const normalRow = document.createElement('div');
  normalRow.className = 'qu-content-editor-row';

  const leadingContainer = document.createElement('div');
  leadingContainer.className = 'qu-content-editor-leading';
  const inputWrap = document.createElement('div');
  inputWrap.className = 'qu-content-editor-input-wrap';

  const textarea = document.createElement('textarea');
  textarea.placeholder = placeholder;
  const stopAutogrow = mountComposerAutogrow(textarea, { minRows, maxRows });

  const actionsEl = document.createElement('div');
  actionsEl.className = 'qu-content-editor-actions';

  inputWrap.append(textarea, actionsEl);

  const submitContainer = document.createElement('div');
  submitContainer.className = 'qu-content-editor-submit-slot';

  normalRow.append(leadingContainer, inputWrap, submitContainer);

  const chromeContainer = document.createElement('div');
  chromeContainer.hidden = true;

  root.append(toolbarContainer, normalRow, chromeContainer);
  container.appendChild(root);

  // ===== leading action slot (docs/v4-concept.md §6 Presentation Resolver) ==
  const leadingActions = new Map();
  const leadingSlotHandle = mountResolvedSlot(leadingContainer, [], { strategy: 'inline-then-menu', threshold: 2, ...leadingSlotOptions });
  function registerAction(item) {
    leadingActions.set(item.id, item);
    leadingSlotHandle.setItems([...leadingActions.values()]);
  }
  function unregisterAction(id) {
    leadingActions.delete(id);
    leadingSlotHandle.setItems([...leadingActions.values()]);
  }

  // ===== toolbar slot (own resolver instance - see this file's own doc =====
  // comment on `registerToolbarItem` for why it's separate from the leading
  // slot above, not a shared one.
  const toolbarItems = new Map();
  // threshold 8: comfortably above markdownToolbarExtension()'s own 5 buttons
  // (Bold/Italic/Link/Code/Spoiler) - those should always render inline, not
  // collapse into a "More" menu on first mount; still collapses further
  // toolbar extensions stacked on top, same mechanism as the leading slot.
  const toolbarSlotHandle = mountResolvedSlot(toolbarContainer, [], { strategy: 'inline-then-menu', threshold: 8, ...toolbarSlotOptions });
  function registerToolbarItem(item) {
    toolbarItems.set(item.id, item);
    toolbarSlotHandle.setItems([...toolbarItems.values()]);
    toolbarContainer.hidden = false;
  }
  function unregisterToolbarItem(id) {
    toolbarItems.delete(id);
    toolbarSlotHandle.setItems([...toolbarItems.values()]);
    toolbarContainer.hidden = toolbarItems.size === 0;
  }

  // ===== content contributions (attachments/location - non-text submit data) =
  const contributions = new Map();
  // Extensions that asked to hear about `clearContributions()` (see this
  // file's own doc comment's `mount()` return shape) - populated below,
  // where `extensions` are actually mounted.
  const resetFns = [];
  function contributeContent(id, partial) {
    contributions.set(id, partial);
    resolveSubmitSlot();
  }
  function retractContent(id) {
    contributions.delete(id);
    resolveSubmitSlot();
  }
  function mergedExtras(extra = {}) {
    const attachments = [];
    let location = null;
    for (const partial of contributions.values()) {
      if (partial.attachments) attachments.push(...partial.attachments);
      if (partial.location) location = partial.location;
    }
    if (extra.attachments) attachments.push(...extra.attachments);
    if (extra.location) location = extra.location;
    return { attachments, location };
  }
  function hasContribution() {
    for (const partial of contributions.values()) {
      if (partial.attachments?.length || partial.location) return true;
    }
    return false;
  }

  // ===== submit control (a 'switch' Presentation Resolver slot) =============
  const insertText = (text) => insertAtCursor(textarea, text);
  let submitHandler = null;

  function submit() {
    if (!submitHandler) return;
    const hasText = !!textarea.value.trim();
    if (!requireText ? false : !(hasText || hasContribution())) return; // requireText: false always passes this gate
    submitHandler(textarea.value, mergedExtras(), { immediate: false });
  }

  const extraSubmitCandidates = [];
  // `icon` (rendered as the button's visible text - see slot-resolver.js's
  // own renderInlineItem()) and `label` (rendered as its title/tooltip only)
  // are DECOUPLED via `submitIcon`/`submitLabel` - a caller wanting a
  // compact icon button (e.g. Forum's reply/new-topic composers, both '➤')
  // still gets a real, readable tooltip instead of the icon glyph itself.
  // `submitIcon` defaults to `submitLabel` (see this function's own params)
  // so a caller passing only `submitLabel` behaves exactly as before.
  const sendItem = { id: 'send', icon: submitIcon, label: submitLabel, onClick: submit }; // no `when` - the unconditional "else", must stay last
  const submitSlotHandle = mountResolvedSlot(submitContainer, [...extraSubmitCandidates, sendItem], { strategy: 'switch' });
  function resolveSubmitSlot() {
    submitSlotHandle.resolve({ hasText: !!textarea.value.trim(), hasContribution: hasContribution() });
  }
  function registerSubmitCandidate(item) {
    extraSubmitCandidates.push(item);
    submitSlotHandle.setItems([...extraSubmitCandidates, sendItem]);
    resolveSubmitSlot();
  }
  function unregisterSubmitCandidate(id) {
    const idx = extraSubmitCandidates.findIndex((c) => c.id === id);
    if (idx !== -1) extraSubmitCandidates.splice(idx, 1);
    submitSlotHandle.setItems([...extraSubmitCandidates, sendItem]);
    resolveSubmitSlot();
  }
  function submitNow(extraPartial = {}) {
    if (!submitHandler) return;
    // Deliberately bypasses `contributions` entirely (unlike the normal
    // `submit()` path) - see class doc comment: independent of the typed
    // draft AND of standing contributions, only ever `extraPartial` itself.
    // `{immediate: true}` tells a caller like `mountContentComposer()` NOT
    // to clear the draft/contributions afterward - there is nothing of
    // THIS submission's own to clear; clearing here would wrongly wipe out
    // an unrelated typed draft or a pending attachment meant for the NEXT,
    // separate normal submit.
    submitHandler('', { attachments: extraPartial.attachments ?? [], location: extraPartial.location ?? null }, { immediate: true });
  }

  textarea.addEventListener('input', resolveSubmitSlot);
  resolveSubmitSlot();

  // Enter submits, Shift+Enter inserts a real newline - the same convention
  // every chat/forum composer in this codebase already follows.
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  // ===== chrome swap (docs/v4-concept.md §5 - what Voice's recorder panel uses) =
  function setChrome(panelEl) {
    if (panelEl) {
      chromeContainer.innerHTML = '';
      chromeContainer.appendChild(panelEl);
      chromeContainer.hidden = false;
      normalRow.hidden = true;
    } else {
      chromeContainer.hidden = true;
      chromeContainer.innerHTML = '';
      normalRow.hidden = false;
    }
  }

  const stopFns = [];
  for (const ext of extensions) {
    const result = ext.mount({
      textarea, actionsEl, insertText,
      registerAction, unregisterAction,
      registerToolbarItem, unregisterToolbarItem,
      registerSubmitCandidate, unregisterSubmitCandidate,
      contributeContent, retractContent,
      setChrome, submitNow,
    });
    // `mount()` may return a plain stopFn (unchanged, most extensions), OR
    // `{stop?, reset?}` for one that also wants to hear about
    // `clearContributions()` (`reset` - e.g. `attachmentExtension()`
    // clearing its own pending-chip UI once a submit it contributed to
    // actually went through, not just the editor's own `contributions` Map -
    // see that file's own doc comment) - `void` means neither.
    if (typeof result === 'function') stopFns.push(result);
    else if (result) {
      if (typeof result.stop === 'function') stopFns.push(result.stop);
      if (typeof result.reset === 'function') resetFns.push(result.reset);
    }
  }

  return {
    textarea,
    actionsEl,
    getValue: () => textarea.value,
    setValue: (text) => { textarea.value = text; textarea.dispatchEvent(new CustomEvent('input', { bubbles: true })); },
    focus: () => textarea.focus(),
    onSubmit: (handler) => { submitHandler = handler; },
    clearContributions: () => {
      contributions.clear();
      for (const reset of resetFns) reset();
      resolveSubmitSlot();
    },
    stop: () => {
      stopAutogrow();
      leadingSlotHandle.stop();
      toolbarSlotHandle.stop();
      submitSlotHandle.stop();
      for (const stopFn of stopFns) stopFn();
    },
  };
}
