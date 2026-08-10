/**
 * POPUP POSITION — one small, shared geometry helper for every floating
 * panel in this package (`emoji.js`'s extended-emoji panel, `context-
 * menu.js`'s menu panel, `trigger-autocomplete.js`'s mention/emoji
 * dropdown): all three anchor a panel below their own trigger element via
 * plain CSS (`position: absolute; top: 100%`), which - unchecked - can open
 * PARTLY OFF-SCREEN at the bottom of the viewport (a message near the
 * bottom of a chat/forum view, or a composer near the bottom of the page).
 *
 * `flipUpIfNeeded()` measures the ALREADY-APPENDED panel (its real height,
 * not a guess) against the remaining viewport space below its trigger, and
 * adds a caller-supplied CSS class that flips the panel to `bottom: 100%`
 * instead when there isn't room - each consumer defines that class itself
 * (e.g. `.qu-thread-ui-emoji-panel-flip-up`) since the exact margin/inset
 * differs slightly per panel's own layout.
 */

/**
 * @param {HTMLElement} panel - Already appended to the DOM (so
 *   `getBoundingClientRect()` reflects its real, laid-out size).
 * @param {HTMLElement} trigger - The element the panel is anchored below.
 * @param {string} flipClass - Added to `panel.classList` when there isn't
 *   enough room below `trigger` AND there IS enough room above it (flipping
 *   into a worse overflow the other direction would defeat the point).
 */
export function flipUpIfNeeded(panel, trigger, flipClass) {
  const triggerRect = trigger.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const spaceBelow = window.innerHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  if (spaceBelow < panelRect.height && spaceAbove > spaceBelow) {
    panel.classList.add(flipClass);
  }
}
