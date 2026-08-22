import { mountComposerAutogrow, COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS, insertAtCursor } from '@qu/thread-ui';

/**
 * CONTENT EDITOR — the smallest reusable unit of Quniverse V4's
 * ContentEditor layer (see docs/v4-concept.md §5): a `<textarea>` + submit
 * button + an "actions" slot `EditorExtension`s mount their own UI into.
 * Every app-specific composer (`apps/forum/client.js`'s hand-assembled
 * composer today, this generalizes exactly that assembly) is meant to be
 * built FROM this, not around a bespoke textarea of its own.
 *
 * Reuses `@qu/thread-ui`'s existing, already-proven primitives verbatim -
 * `mountComposerAutogrow()` (built in, not optional - every editor needs it,
 * unlike an `EditorExtension`, which is genuinely optional) and
 * `insertAtCursor()` (wrapped as the `insertText` every extension gets).
 *
 * THE EditorExtension CONTRACT (docs/v4-concept.md §5/§12's "UI Slot" vs.
 * "Editor Extension" distinction): `{id, mount(ctx) -> stopFn|void}`, where
 * `ctx` is `{textarea, actionsEl, insertText}`. An extension with a visible
 * control (e.g. an emoji trigger button) appends into `ctx.actionsEl`; an
 * extension that's a pure input-side behavior with no button of its own
 * (e.g. mention-autocomplete) only ever touches `ctx.textarea` directly. A
 * `mount()` that returns a function gets that function called by this
 * editor's own `stop()` - the same "returns an unregister/stop function"
 * convention `mountComposerAutogrow()`/`mountMentionAutocomplete()`
 * themselves already use, so an extension wrapping one of THEM can usually
 * just return its own stop function unchanged.
 */

const STYLE_ID = 'qu-content-ui-editor-style';
const STYLE = `
  .qu-content-editor { display: flex; align-items: flex-end; gap: 0.4rem; position: relative; }
  .qu-content-editor-input-wrap { flex: 1; min-width: 0; display: flex; align-items: flex-end; gap: 0.3rem; }
  .qu-content-editor-input-wrap textarea { flex: 1; min-width: 0; font: inherit; resize: none; padding: 0.15rem 0; }
  .qu-content-editor-actions { display: flex; align-items: center; gap: 0.2rem; }
  .qu-content-editor-submit { flex-shrink: 0; cursor: pointer; }
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
 * @param {Array<{id: string, mount: (ctx: {textarea: HTMLTextAreaElement, actionsEl: HTMLElement, insertText: (text: string) => void}) => (() => void)|void}>} [options.extensions]
 * @param {string} [options.submitLabel]
 * @returns {{
 *   textarea: HTMLTextAreaElement,
 *   actionsEl: HTMLElement,
 *   getValue: () => string,
 *   setValue: (text: string) => void,
 *   focus: () => void,
 *   onSubmit: (handler: (text: string) => void) => void,
 *   stop: () => void,
 * }}
 */
export function mountContentEditor(container, {
  placeholder = '',
  minRows = COMPOSER_MIN_ROWS,
  maxRows = COMPOSER_MAX_ROWS,
  extensions = [],
  submitLabel = 'Send',
} = {}) {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'qu-content-editor';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'qu-content-editor-input-wrap';

  const textarea = document.createElement('textarea');
  textarea.placeholder = placeholder;
  const stopAutogrow = mountComposerAutogrow(textarea, { minRows, maxRows });

  const actionsEl = document.createElement('div');
  actionsEl.className = 'qu-content-editor-actions';

  inputWrap.append(textarea, actionsEl);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'qu-content-editor-submit';
  submitBtn.textContent = submitLabel;

  root.append(inputWrap, submitBtn);
  container.appendChild(root);

  const insertText = (text) => insertAtCursor(textarea, text);
  const stopFns = extensions.map((ext) => ext.mount({ textarea, actionsEl, insertText })).filter((fn) => typeof fn === 'function');

  let submitHandler = null;
  function submit() {
    if (!submitHandler) return;
    const value = textarea.value;
    if (!value.trim()) return;
    submitHandler(value);
  }
  submitBtn.addEventListener('click', submit);
  // Enter submits, Shift+Enter inserts a real newline - the same convention
  // every chat/forum composer in this codebase already follows.
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  return {
    textarea,
    actionsEl,
    getValue: () => textarea.value,
    setValue: (text) => { textarea.value = text; textarea.dispatchEvent(new CustomEvent('input', { bubbles: true })); },
    focus: () => textarea.focus(),
    onSubmit: (handler) => { submitHandler = handler; },
    stop: () => {
      stopAutogrow();
      for (const stopFn of stopFns) stopFn();
    },
  };
}
