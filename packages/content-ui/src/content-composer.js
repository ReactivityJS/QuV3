import { createContent } from '@qu/services';
import { mountContentEditor } from './content-editor.js';

/**
 * CONTENT COMPOSER — wraps a `ContentEditor` for an interactive posting
 * context (docs/v4-concept.md §5): the layer a Chat message box, a Forum
 * reply box, or a comment box is meant to be built from. `ContentComposer`
 * uses `ContentEditor` internally rather than being a second, competing
 * primitive - the only thing it adds is turning a submitted string into a
 * real `createContent()`-shaped `Content` object and clearing the editor
 * afterward, so a caller's `onSubmit` always receives storage-ready Content,
 * never a raw string it would have to normalize itself.
 *
 * `format` is a plain, explicit option for now, not resolved through a
 * global/per-context/per-device/user-preference chain (docs/v4-concept.md
 * §5 describes that chain as the eventual goal) - there is no persisted
 * config store yet for a resolver to read from (`EntityType` is still
 * static-only, see docs/v4-concept.md §10), so building that resolution
 * chain now would be speculative ahead of a real caller.
 *
 * `ContentEditor`'s `extras` (attachments/location, contributed by
 * extensions via `contributeContent()`/`submitNow()` - see
 * `content-editor.js`'s own doc comment) are folded straight into the
 * `createContent()` call, so `onSubmit` always receives one complete,
 * storage-ready `Content` object regardless of whether it came from typed
 * text, a picked attachment, a shared location, or (Voice) an
 * attachment-only `submitNow()` call with no text at all.
 *
 * The draft/standing contributions are only cleared after a NORMAL submit
 * (`meta.immediate === false`) - an `submitNow()`-driven submit
 * (`meta.immediate === true`, Voice's own independent Send) has nothing of
 * its own to clear and must NOT wipe an unrelated typed draft or a pending
 * attachment meant for the next, separate normal submit.
 */

/**
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {string} [options.format='plain'] - One of `CONTENT_FORMATS` (`@qu/services`).
 * @param {boolean} [options.requireText=true] - See `mountContentEditor()`'s own doc comment.
 * @param {(content: {text: string, format: string, attachments: object[], location: object|null}) => void} [options.onSubmit]
 * @param {string} [options.placeholder]
 * @param {number} [options.minRows]
 * @param {number} [options.maxRows]
 * @param {Array<object>} [options.extensions] - See `mountContentEditor()`'s own doc comment for the `EditorExtension` contract.
 * @param {string} [options.submitLabel]
 * @param {object} [options.leadingSlot] - See `mountContentEditor()`'s own doc comment.
 * @returns {{editor: ReturnType<typeof mountContentEditor>, stop: () => void}}
 */
export function mountContentComposer(container, { format = 'plain', onSubmit, ...editorOptions } = {}) {
  const editor = mountContentEditor(container, editorOptions);

  editor.onSubmit((text, extras, meta) => {
    const content = createContent({ text, format, attachments: extras.attachments, location: extras.location });
    onSubmit?.(content);
    if (!meta.immediate) {
      editor.setValue('');
      editor.clearContributions();
    }
  });

  return { editor, stop: () => editor.stop() };
}
