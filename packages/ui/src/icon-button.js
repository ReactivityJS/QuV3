/**
 * `createIconButton()` — a plain `<button>` whose only visible content is an
 * icon/glyph, with `title` and `aria-label` ALWAYS set together from the
 * same human-readable string. Per `docs/app-navigation-standard.md`'s Rule
 * 4 ("Icons always carry a tooltip"): every icon-only control in this
 * codebase must set both attributes to the same string, and this was
 * drifting into a title-only convention across several apps (a screen
 * reader announces nothing for a title-only button - `aria-label` is the
 * part that actually matters for accessibility, `title` is the hover
 * tooltip on top). One helper means the pairing can't be forgotten again.
 *
 * Not a new pattern - just the existing one (already followed correctly by
 * `apps/phone/client.js` and `apps/shell/src/header.js`) factored out so
 * every OTHER app's icon buttons (chat/forum's reply-cancel "✕", calendar's
 * row actions, ...) can share it instead of re-typing the same four lines.
 */
export function createIconButton({ icon, label, onClick, className }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (className) btn.className = className;
  btn.textContent = icon;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}
