/**
 * CARET POSITION — measures where a `<textarea>`'s current SELECTION lives
 * on screen, in viewport coordinates. Neither `window.getSelection()` nor
 * the `Range` API can do this: both only see real DOM text nodes, and a
 * `<textarea>`'s content is not part of the DOM text tree at all (it's the
 * element's `.value`, rendered by the browser's own internal text-layout
 * engine, invisible to any DOM API) - the standard workaround, used here, is
 * the "mirror div" technique: build an off-screen, visually hidden `<div>`
 * that reproduces the textarea's exact box model and font metrics, fill it
 * with the same text up to the selection, wrap the selected slice in a real
 * `<span>`, and measure THAT span - since the mirror is laid out identically
 * to the real textarea, the span's rect is (as close as a second, separate
 * layout pass can get) where the selection visually sits in the real one.
 *
 * Anchors to the START of the selection (`getClientRects()[0]`, not
 * `getBoundingClientRect()` - the latter returns the union box of every
 * line a multi-line selection spans, which is not where a floating toolbar
 * should appear) - the same place Google Docs/Notion-style selection
 * toolbars anchor.
 *
 * KNOWN LIMITATIONS (not solved here, see this package's own test file for
 * how far automated testing can go):
 *   - jsdom has no layout engine at all - `getClientRects()` always returns
 *     an empty list there, so this can only be verified by hand in a real
 *     browser (desktop first, then mobile).
 *   - A visible scrollbar (composer content past its `maxRows`) can shift
 *     the mirror's own wrap points by the scrollbar-gutter width on
 *     platforms without overlay scrollbars - accepted as a known v1 gap.
 */

// Exact box-model/font properties that affect where text wraps and how tall
// a line is - anything that changes glyph shaping or available width must be
// copied, or the mirror's wrapped lines won't match the real textarea's.
const MIRRORED_PROPERTIES = [
  'boxSizing', 'width', 'height',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign',
  'direction', 'tabSize',
];

function buildMirror(textarea) {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const mirrorStyle = mirror.style;
  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.top = '0';
  mirrorStyle.left = '-9999px';
  // A real <textarea> always wraps this way regardless of what its own
  // computed `white-space`/`word-wrap` report (they don't apply to it the
  // same way they would to a normal block element) - force it explicitly
  // rather than trusting `style.whiteSpace`.
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.wordWrap = 'break-word';
  mirrorStyle.overflowWrap = 'break-word';
  for (const prop of MIRRORED_PROPERTIES) mirrorStyle[prop] = style[prop];
  document.body.appendChild(mirror);
  return mirror;
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @returns {{getBoundingClientRect: () => DOMRect}|null} A duck-typed object
 *   matching `flipUpIfNeeded()`'s own `trigger` parameter shape (so it can
 *   be passed straight into it for horizontal-clamp positioning), or `null`
 *   for a collapsed selection - there is nothing to anchor a toolbar to.
 */
export function getTextareaSelectionRect(textarea) {
  const { selectionStart, selectionEnd, value } = textarea;
  if (selectionStart === selectionEnd) return null;

  const mirror = buildMirror(textarea);
  try {
    const before = document.createTextNode(value.slice(0, selectionStart));
    const span = document.createElement('span');
    span.textContent = value.slice(selectionStart, selectionEnd) || '​';
    const after = document.createTextNode(value.slice(selectionEnd));
    mirror.append(before, span, after);

    // The mirror must scroll identically to the real textarea for a
    // selection past the visible fold to measure correctly.
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;

    const rects = span.getClientRects();
    if (rects.length === 0) return null; // jsdom, or a not-yet-laid-out mirror
    const mirrorRect = mirror.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const spanRect = rects[0];
    // Translate from the mirror's own (off-screen) coordinate space into
    // the real textarea's viewport position.
    const rect = {
      top: textareaRect.top + (spanRect.top - mirrorRect.top),
      left: textareaRect.left + (spanRect.left - mirrorRect.left),
      width: spanRect.width,
      height: spanRect.height,
    };
    return {
      getBoundingClientRect: () => ({
        top: rect.top, left: rect.left, width: rect.width, height: rect.height,
        right: rect.left + rect.width, bottom: rect.top + rect.height,
        x: rect.left, y: rect.top,
      }),
    };
  } finally {
    mirror.remove();
  }
}
