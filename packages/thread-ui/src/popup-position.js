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
 *
 * HORIZONTAL CLAMP BOUNDS: the raw browser viewport width is too generous
 * a bound once a persistent desktop sidebar is on screen
 * (`packages/ui/src/app-template.js`'s `.qu-apptpl-sidebar`, a FLEX
 * SIBLING of the content column, `.qu-apptpl-content`) - confirmed live as
 * a message's context menu opening UNDER/BEHIND the sidebar, because
 * "room to the left" was measured against the whole window, which very
 * much includes the sidebar's own screen area even though it isn't part
 * of the scrollable content column the menu's trigger actually lives in.
 * `nearestScrollableAncestor()` below walks up from the trigger to find
 * that column (chat's/forum's own `overflow-y: auto` message list,
 * `.qu-chat-messages-scroll`/`.qu-forum-messages-scroll` - a flex sibling
 * of the sidebar, so its OWN bounding rect already excludes the sidebar's
 * width) and clamps against THAT instead, whenever one exists. Falls back
 * to the full viewport - today's original behavior, unchanged - for any
 * trigger with no such ancestor (e.g. the composer's own emoji button,
 * which sits outside the scrollable message list entirely).
 */

/**
 * @param {HTMLElement} el
 * @returns {HTMLElement|null} The nearest ancestor styled `overflow-y:
 *   auto` or `scroll`, or `null` if none exists (the caller then falls
 *   back to the full viewport, its original bound) - see this file's own
 *   top doc comment's "HORIZONTAL CLAMP BOUNDS" section. Deliberately
 *   never `document.documentElement` itself as that fallback value - its
 *   own `getBoundingClientRect()` doesn't reliably track the viewport
 *   (zeroed out entirely absent real layout, e.g. this package's own test
 *   DOM) the way `window.innerWidth` already does.
 */
function nearestScrollableAncestor(el) {
  let node = el.parentElement;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

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
  //
  // Bounded by the nearest scrollable ancestor when one exists (a sidebar-
  // adjacent content column), not the raw browser viewport - see this
  // file's own top doc comment's "HORIZONTAL CLAMP BOUNDS" section. No
  // such ancestor -> the exact original {0, viewportWidth} bound (the
  // max/min below is then a no-op either way).
  const boundsEl = nearestScrollableAncestor(trigger);
  const boundsRect = boundsEl ? boundsEl.getBoundingClientRect() : { left: 0, right: viewportWidth };
  const leftBound = Math.max(margin, boundsRect.left);
  const rightBound = Math.min(viewportWidth - margin, boundsRect.right);
  const overflowRight = panelRect.right - rightBound;
  const overflowLeft = leftBound - panelRect.left;
  if (overflowRight > 0) {
    panel.style.transform = `translateX(-${overflowRight}px)`;
  } else if (overflowLeft > 0) {
    panel.style.transform = `translateX(${overflowLeft}px)`;
  }
}
