/**
 * CONTENT — the universal persisted payload (Quniverse V4, see
 * docs/v4-concept.md §3.2/§5). Deliberately NOT the editor: `createContent()`
 * only normalizes and validates the STORED shape (`{text, format,
 * attachments}`) that a `ContentEditor`/`ContentComposer`
 * (`packages/content-ui`, see docs/v4-concept.md §5) produces. This module
 * has no storage path of its own - Content is a FIELD embedded in whatever
 * Entity/Thread-message document carries it (`entity.content`), never
 * persisted at its own address.
 *
 * `renderContent()` is `createContent()`'s read-side counterpart: Content →
 * HTML, format-driven, exactly the "Content is the shared data model between
 * Editor and Renderer" split docs/v4-concept.md §5/§16 describes. It is
 * deliberately DOM-free (a pure string transform, like `thread-formatting.js`'s
 * own `formatMarkdown()`) and lives here, not in `packages/content-ui` -
 * only the EDITOR half genuinely needs a browser.
 *
 * `extensions[]` (inline semantic content - emoji, mentions, link previews,
 * location) is deliberately NOT included yet - docs/v4-concept.md §3.2
 * explicitly defers it until at least two real cases need it, to avoid
 * building a generic registry ahead of a real caller.
 */
import { escapeHtml, formatMarkdown } from './thread-formatting.js';

/** The known, storable `format` values - see docs/v4-concept.md §5's format-selection resolution order (global default -> per-EntityType -> per-device -> user preference). */
export const CONTENT_FORMATS = ['plain', 'markdown', 'richtext'];

/**
 * @param {{text: string, format?: string, attachments?: Array<object>}} input
 * @returns {{text: string, format: string, attachments: Array<object>}}
 * @throws {Error} If `format` is set but not one of `CONTENT_FORMATS`, or
 *   `attachments` is set but not an array.
 */
export function createContent({ text, format = 'plain', attachments = [] }) {
  if (!CONTENT_FORMATS.includes(format)) {
    throw new Error(`createContent: unknown format "${format}" - expected one of ${CONTENT_FORMATS.join(', ')}`);
  }
  if (!Array.isArray(attachments)) {
    throw new Error('createContent: attachments must be an array');
  }
  return { text, format, attachments };
}

/**
 * The `ContentRenderer` - Content → HTML, dispatched on `content.format`.
 * @param {{text: string, format: string}} content - As returned by `createContent()`.
 * @returns {string} HTML-safe markup.
 * @throws {Error} For `'richtext'` - no WYSIWYG editor exists in this
 *   codebase yet to have produced richtext Content in the first place, so
 *   this is an honest, documented gap, not a silently wrong-looking
 *   fallback (see docs/v4-concept.md's ContentEditor-layer plan).
 */
export function renderContent(content) {
  if (content.format === 'plain') return escapeHtml(content.text).replace(/\n/g, '<br>');
  if (content.format === 'markdown') return formatMarkdown(content.text);
  throw new Error(`renderContent: no renderer for format "${content.format}" yet`);
}
