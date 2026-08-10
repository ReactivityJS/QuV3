/**
 * POPUP POSITION — one small, shared geometry helper for every floating
 * panel in this package (`emoji.js`'s extended-emoji panel, `context-
 * menu.js`'s menu panel, `trigger-autocomplete.js`'s mention/emoji
 * dropdown): all three anchor a panel to their own trigger element via
 * plain CSS (`position: absolute; top: 100%; left: 0` or `right: 0`),
 * which - unchecked - can open PARTLY OFF-SCREEN: below the bottom of the
 * viewport (a message near the bottom of a chat/forum view, or a composer
 * pinned near the bottom of the page) OR past the left/right edge (a
 * `right: 0`-anchored panel, like the context menu's, extends LEFTWARD
 * from its trigger - a trigger near the left edge of a narrow/mobile
 * viewport pushes it straight off the left side; confirmed live, not
 * hypothetical - see this function's own doc comment below).
 *
 * `flipUpIfNeeded()` measures the ALREADY-APPENDED panel (its real size,
 * not a guess) against the surrounding viewport space and does TWO
 * independent corrections:
 *   1. VERTICAL FLIP - adds a caller-supplied CSS class that flips the
 *      panel to `bottom: 100%` instead of `top: 100%` when there isn't
 *      room below (each consumer defines that class itself, e.g.
 *      `.qu-thread-ui-emoji-panel-flip-up`, since the exact margin/inset
 *      differs slightly per panel's own layout).
 *   2. HORIZONTAL CLAMP - an inline `transform: translateX(...)` that
 *      nudges the panel back onto screen if either edge would otherwise
 *      overflow, regardless of whether the panel's own CSS anchors it via
 *      `left: 0` or `right: 0` - a transform shifts whatever position the
 *      panel already ended up at, without needing to know or fight that
 *      positioning model.
 *
 * VIEWPORT SIZE: reads `window.visualViewport` when available (mobile
 * Safari/Chrome) instead of `window.innerWidth`/`window.innerHeight` -
 * those reflect the LAYOUT viewport, which does NOT shrink when an
 * on-screen keyboard opens (a composer's own emoji trigger is focused
 * exactly when a keyboard is very likely showing), so a check against them
 * can conclude "there's room below" while the keyboard is actually
 * covering that space. `visualViewport` tracks the REAL visible area.
 */

function viewportSize() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return {
    width: vv?.width ?? window.innerWidth,
    height: vv?.height ?? window.innerHeight,
  };
}

/**
 * @param {HTMLElement} panel - Already appended to the DOM (so
 *   `getBoundingClientRect()` reflects its real, laid-out size).
 * @param {HTMLElement} trigger - The element the panel is anchored to.
 * @param {string} flipClass - Added to `panel.classList` when there isn't
 *   enough room below `trigger` AND there IS enough room above it (flipping
 *   into a worse overflow the other direction would defeat the point).
 * @param {{margin?: number}} [options] - `margin`: minimum gap (px) kept
 *   between the panel and either horizontal viewport edge. Default 8.
 */
export function flipUpIfNeeded(panel, trigger, flipClass, { margin = 8 } = {}) {
  const { width: viewportWidth, height: viewportHeight } = viewportSize();
  const triggerRect = trigger.getBoundingClientRect();
  const spaceBelow = viewportHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const panelRect = panel.getBoundingClientRect();
  if (spaceBelow < panelRect.height && spaceAbove > spaceBelow) {
    panel.classList.add(flipClass);
  }

  // Flipping (if it happened above) only ever changes the panel's TOP/
  // BOTTOM anchor via the flip class, never its horizontal position - the
  // rect measured before flipping is still accurate for this clamp.
  const overflowRight = panelRect.right - (viewportWidth - margin);
  const overflowLeft = margin - panelRect.left;
  if (overflowRight > 0) {
    panel.style.transform = `translateX(-${overflowRight}px)`;
  } else if (overflowLeft > 0) {
    panel.style.transform = `translateX(${overflowLeft}px)`;
  }
}
