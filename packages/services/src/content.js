/**
 * CONTENT — the universal persisted payload (Quniverse V4, see
 * docs/v4-concept.md §3.2/§5). Deliberately NOT the editor: `createContent()`
 * only normalizes and validates the STORED shape (`{text, format,
 * attachments}`) that a `ContentEditor`/`ContentComposer` (a later, UI-layer
 * concept - see docs/v4-concept.md §5) would produce. This module has no
 * storage path of its own - Content is a FIELD embedded in whatever
 * Entity/Thread-message document carries it (`entity.content`), never
 * persisted at its own address.
 *
 * `extensions[]` (inline semantic content - emoji, mentions, link previews,
 * location) is deliberately NOT included yet - docs/v4-concept.md §3.2
 * explicitly defers it until at least two real cases need it, to avoid
 * building a generic registry ahead of a real caller.
 */

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
