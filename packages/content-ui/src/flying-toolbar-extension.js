import { getTextareaSelectionRect, flipUpIfNeeded } from '@qu/thread-ui';

/**
 * FLYING TOOLBAR EXTENSION — a selection-anchored, floating alternative to
 * `markdownToolbarExtension()`'s fixed row: select text in the textarea, a
 * small Bold/Italic/Strikethrough panel appears right at the selection
 * (Google Docs/Notion-style), instead of a permanent row above the textarea.
 * Built for Chat, where the fixed row's extra buttons (Link/Code/Spoiler)
 * turned out to be more than the composer needed - links are pasted rather
 * than typed, and code/spoiler are rare in a chat message - while the
 * "select then format" gesture was the one piece of real, missing capability.
 *
 * Neither existing `ContentEditor` slot fits this: `registerToolbarItem()`
 * is a fixed row (the very thing this replaces), and `registerAction()` is
 * the leading-slot row - neither slot is built to appear/disappear at an
 * arbitrary, selection-dependent screen position. This extension manages
 * its own floating panel directly via `ctx.textarea`/`ctx.insertText`,
 * exactly like Voice's own recorder panel manages its own chrome via
 * `ctx.setChrome()` rather than fitting into either slot.
 *
 * Built on `@qu/thread-ui`'s `getTextareaSelectionRect()` (the mirror-div
 * selection-measurement utility, `caret-position.js`) and `flipUpIfNeeded()`
 * (reused for its HORIZONTAL clamp only - genuinely position-model-agnostic;
 * its own CSS-class-based VERTICAL flip doesn't compose with the `top` pixel
 * value this extension computes directly, so vertical placement is done by
 * hand instead, preferring ABOVE the selection - the standard selection-
 * toolbar convention - and flipping below only when there isn't room above).
 *
 * `wrapSelection()` duplicates `markdown-toolbar-extension.js`'s own small
 * helper rather than sharing it via a new file - the two toolbar modules are
 * deliberately independent, swappable peers (a composer picks one or the
 * other, see docs/v4-concept.md §10.2), and a few lines of duplication is
 * cheaper than a dependency between them. Wraps `**`/`*`/`~~` - the
 * strikethrough marker matches `@qu/services`' `thread-formatting.js`
 * exactly, so what this button produces actually renders once sent.
 *
 * KNOWN, EXPLICITLY OUT-OF-SCOPE GAPS (not built, not silently ignored):
 *   - No touch/tap selection gesture - no precedent anywhere in this
 *     codebase for `touchstart`/`pointerdown`-driven text selection, and no
 *     way to verify one without a real device. Desktop-first for this round.
 *   - Mobile browsers' own native selection-callout UI may visually collide
 *     with this panel on touch devices - an unresolved UX question flagged
 *     for later, not solved here.
 */

const STYLE_ID = 'qu-content-ui-flying-toolbar-style';
const STYLE = `
  .qu-content-ui-flying-toolbar { position: fixed; display: flex; gap: 0.2rem; padding: 0.25rem; border-radius: var(--qu-radius-md, 0.4rem); background: var(--qu-color-surface, #ffffff); border: 1px solid var(--qu-color-border, #8884); box-shadow: 0 0.3rem 0.8rem rgba(0,0,0,0.2); z-index: 30; }
  .qu-content-ui-flying-toolbar[hidden] { display: none; }
  .qu-content-ui-flying-toolbar button { border: none; background: none; cursor: pointer; padding: 0.2rem 0.45rem; border-radius: var(--qu-radius-sm, 0.3rem); font: inherit; line-height: 1; }
  .qu-content-ui-flying-toolbar button:hover { background: var(--qu-color-border, #8884); }
  .qu-content-ui-flying-toolbar-bold { font-weight: bold; }
  .qu-content-ui-flying-toolbar-italic { font-style: italic; }
  .qu-content-ui-flying-toolbar-strike { text-decoration: line-through; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// Duplicated from markdown-toolbar-extension.js on purpose - see this
// file's own doc comment on why these two modules stay independent.
function wrapSelection(ctx, before, after = before) {
  const { textarea } = ctx;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const selected = textarea.value.slice(start, end);
  ctx.insertText(`${before}${selected}${after}`);
}

const GAP = 8; // px kept between the panel and the selection/viewport edge

/**
 * @returns {{id: string, mount: (ctx: object) => (() => void)}}
 */
export function flyingToolbarExtension() {
  return {
    id: 'flying-toolbar',
    mount(ctx) {
      ensureStyle();
      const { textarea } = ctx;

      const panel = document.createElement('div');
      panel.className = 'qu-content-ui-flying-toolbar';
      panel.hidden = true;
      document.body.appendChild(panel);

      function hide() {
        panel.hidden = true;
      }

      function makeButton(icon, label, extraClass, before, after) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = extraClass;
        btn.textContent = icon;
        btn.title = label;
        // mousedown + preventDefault, not click - a plain click blurs the
        // textarea first, which collapses the selection before the handler
        // ever runs. Same fix already precedented in
        // trigger-autocomplete.js's own renderList().
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          wrapSelection(ctx, before, after);
          hide();
        });
        return btn;
      }
      panel.append(
        makeButton('B', 'Bold', 'qu-content-ui-flying-toolbar-bold', '**'),
        makeButton('I', 'Italic', 'qu-content-ui-flying-toolbar-italic', '*'),
        makeButton('S', 'Strikethrough', 'qu-content-ui-flying-toolbar-strike', '~~'),
      );

      function position() {
        const anchor = getTextareaSelectionRect(textarea);
        if (!anchor) { hide(); return; }
        panel.hidden = false;
        const rect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const spaceAbove = rect.top;
        const spaceBelow = viewportHeight - rect.bottom;
        let top;
        if (spaceAbove >= panelRect.height + GAP) {
          top = rect.top - panelRect.height - GAP; // preferred: above the selection
        } else if (spaceBelow >= panelRect.height + GAP) {
          top = rect.bottom + GAP; // flipped: below, when there's no room above
        } else {
          top = Math.max(GAP, rect.top - panelRect.height - GAP); // neither fits - stay above, clamped to the viewport
        }
        panel.style.top = `${top}px`;
        panel.style.left = `${rect.left}px`;
        panel.style.transform = ''; // reset - flipUpIfNeeded() below recomputes it from scratch
        // Reused for its horizontal clamp only - see this file's own doc
        // comment on why the vertical flip above is computed by hand instead.
        flipUpIfNeeded(panel, anchor, 'qu-content-ui-flying-toolbar-unused-flip-class');
      }

      function onSelectionChange() {
        if (textarea.selectionStart === textarea.selectionEnd) { hide(); return; }
        position();
      }
      // A position:fixed panel doesn't track scroll on its own - hide it
      // rather than show it drifted away from the selection; it reappears
      // on the next mouseup/keyup. Capture phase: a scroll inside any
      // ancestor (not just window) still needs to hide it.
      function onScroll() { hide(); }
      const onBlur = () => setTimeout(hide, 150); // deferred so a button's own mousedown lands first - same pattern as trigger-autocomplete.js

      textarea.addEventListener('mouseup', onSelectionChange);
      textarea.addEventListener('keyup', onSelectionChange);
      textarea.addEventListener('input', hide);
      textarea.addEventListener('blur', onBlur);
      window.addEventListener('scroll', onScroll, true);

      return () => {
        textarea.removeEventListener('mouseup', onSelectionChange);
        textarea.removeEventListener('keyup', onSelectionChange);
        textarea.removeEventListener('input', hide);
        textarea.removeEventListener('blur', onBlur);
        window.removeEventListener('scroll', onScroll, true);
        panel.remove();
      };
    },
  };
}
