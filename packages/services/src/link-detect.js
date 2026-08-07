/**
 * LINK DETECTION — the one place a raw `http(s)://` URL gets found inside
 * plain text. Shared by `thread-formatting.js`'s `formatMarkdown()` (bakes an
 * auto-link into `formattedHtml` at write time) and any app-level renderer
 * that wants the same detection at render time instead (a thread that never
 * opts into `'markdown'` formatting still needs to find links to render as
 * real anchors) - one implementation instead of two independently-drifting
 * regexes.
 */
const URL_RE = /(https?:\/\/[^\s<>"]+)/gi;

/**
 * The one URL-matching pattern itself, exported for a caller that wants to
 * drive its own `.replace()`/`.matchAll()` directly (see
 * `thread-formatting.js`'s `formatMarkdown()`, which builds an HTML string
 * rather than a segment list). Safe to reuse across calls - unlike
 * `.exec()`/`.test()` in a loop, `String.prototype.replace()` and
 * `matchAll()` don't rely on (or mutate, for `matchAll`) a shared
 * `lastIndex` between separate calls on a global regex.
 */
export const URL_RE_GLOBAL = URL_RE;

/**
 * @param {string} text
 * @returns {Array<{type: 'text'|'link', value: string, hostname?: string}>}
 *   The FULL text, split into plain-text and link segments in order - a
 *   caller reconstructs the original by concatenating every segment's
 *   `value`, or renders each segment differently (link vs. plain text).
 */
export function detectLinks(text) {
  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    const index = match.index;
    if (index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, index) });
    let hostname = url;
    try { hostname = new URL(url).hostname; } catch { /* not a real URL - fall back to showing it verbatim */ }
    segments.push({ type: 'link', value: url, hostname });
    lastIndex = index + url.length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}
