/**
 * SUBPAGE — the shared "navigate to a real hash route instead of opening a
 * modal" building block. A route like `#/<app>/<...segments>` is a REAL
 * browser history entry - a shell's own header can have working
 * back/forward buttons over that, and the OS/browser back gesture just
 * works too. A `<dialog>` overlay gets none of that for free: closing it
 * isn't a history event, so "how did I get here" and "back" both have to
 * be hand-rolled per app that uses one.
 *
 * This is intentionally tiny: an app still owns its own route parsing
 * (which segment means "create" vs "detail" is app-specific) and its own
 * form fields - this only standardizes the "← back to X" link + content
 * area shell around whatever the app renders, so every subpage in the
 * whole shell looks and behaves the same way.
 *
 * @param {HTMLElement} container - Cleared and (re)populated in place.
 * @param {{backHref?: string, backLabel?: string, showBackLink?: boolean, render: (content: HTMLElement) => void}} options
 *   `backHref`/`backLabel` build the back link (a plain `<a>` - not
 *   `history.back()`, so it works identically whether this subpage was
 *   reached by a link, a direct URL, or the browser's own back/forward).
 *   `showBackLink` (default `true`) - set `false` to skip it entirely, e.g.
 *   when the host shell already has its own persistent back/forward
 *   affordance and a per-subpage one would just be redundant chrome
 *   (`apps/forum/client.js`'s channel/topic views, given the shell header's
 *   own Back/Forward buttons - see that file's own doc comment); `backHref`/
 *   `backLabel` are simply unused when this is `false`.
 *   `render(content)` builds whatever the app needs into a fresh, empty
 *   content element already appended below the back link (if shown).
 */
export function renderSubpage(container, { backHref, backLabel, showBackLink = true, render }) {
  container.textContent = '';

  if (showBackLink) {
    const back = document.createElement('a');
    back.href = backHref;
    back.className = 'qu-subpage-back';
    back.textContent = backLabel;
    container.appendChild(back);
  }

  const content = document.createElement('div');
  content.className = 'qu-subpage-content';
  container.appendChild(content);

  render(content);
}
