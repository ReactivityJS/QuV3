import '@qu/ui'; // registers <qu-asset-upload> as a side effect - see @qu/ui's own top doc comment

/**
 * ATTACHMENT EXTENSION — generalizes `apps/chat/client.js`'s own proven
 * "attach a file" flow (its composer's "+" menu → `attachUpload.
 * openPicker()` → `qu-asset-uploaded` → `pendingAttachment`) into a
 * `ContentEditor` `EditorExtension`. Drives `@qu/ui`'s `<qu-asset-upload
 * hide-picker>` Custom Element rather than reimplementing upload/chunking/
 * progress UI - that element's own doc comment states its `hide-picker`
 * attribute + `.openPicker()` method exist SPECIFICALLY for this
 * "a host folds Attach into its own action menu" case, so this is the
 * intended integration path, not a workaround.
 *
 * Registers a `📎` trigger via `ctx.registerAction()` (presented per the
 * editor's configured `leadingSlot` strategy, same as any other leading
 * action - this extension has no opinion on inline-vs-collapsed). On a
 * successful upload, `ctx.contributeContent()`s the attachment (supports
 * more than one - each upload appends) and renders a small removable chip
 * (label + ✕), the same shape `apps/chat/client.js`'s own
 * `pendingAttachmentEl` already uses; removing the last one
 * `ctx.retractContent()`s.
 *
 * KNOWN GAP: never calls `<qu-asset-upload>`'s own `.confirmSent(assetId)` -
 * the `EditorExtension` contract (`content-editor.js`) has no "your
 * contribution was actually submitted" hook for an extension to react to
 * (only pre-submit `contributeContent()`/`retractContent()`), so this
 * extension can't yet start the deferred sync-out verification/progress
 * phase `<qu-asset-upload>`'s own doc comment describes. The asset itself
 * still syncs normally via the outbox regardless (already durably written
 * locally the moment `qu-asset-uploaded` fires) - this only means no
 * dedicated verify/retry progress UI for it. Real follow-up work (extending
 * the `EditorExtension` contract with a post-submit hook), not fixed here -
 * `apps/chat/client.js`'s own still-hand-wired composer is unaffected (it
 * calls `confirmSent()` itself, directly).
 */

const STYLE_ID = 'qu-content-ui-attachment-style';
const STYLE = `
  .qu-content-ui-attachments { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .qu-content-ui-attachment-chip { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85em; padding: 0.15rem 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; }
  .qu-content-ui-attachment-chip button { border: none; background: transparent; cursor: pointer; opacity: 0.7; font: inherit; padding: 0; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {{assetService: object, spaceId: string|number, readerPubs?: string[], asSpaceId?: string|number, trigger?: string, triggerTitle?: string, chipContainer?: HTMLElement}} options
 *   `chipContainer` - where the removable "pending attachment" chips render;
 *   defaults to a small element appended right after the editor's own root
 *   (a host that wants them somewhere specific - e.g. above the composer,
 *   matching `apps/chat/client.js`'s own `pendingAttachmentEl` placement -
 *   passes its own container here).
 * @returns {{id: string, mount: (ctx: object) => {stop: () => void, reset: () => void}}}
 */
export function attachmentExtension({ assetService, spaceId, readerPubs, asSpaceId, trigger = '📎', triggerTitle = 'Attach file', chipContainer } = {}) {
  return {
    id: 'attachment',
    mount(ctx) {
      ensureStyle();

      const uploadEl = document.createElement('qu-asset-upload');
      uploadEl.setAttribute('space-id', String(spaceId));
      uploadEl.setAttribute('hide-picker', '');
      // A message's own attachments[] was already multi-value (repeated
      // sequential picks already worked, see the class doc comment above) -
      // this just lets ONE trip through the native file dialog pick several
      // at once too. See <qu-asset-upload>'s own "multiple" doc comment
      // (@qu/ui's asset-components.js) for why this is opt-in there, not
      // the default.
      uploadEl.setAttribute('multiple', '');
      uploadEl.assetService = assetService;
      if (readerPubs) uploadEl.readerPubs = readerPubs;
      if (asSpaceId) uploadEl.asSpaceId = asSpaceId;
      uploadEl.hidden = true;
      ctx.textarea.parentNode.appendChild(uploadEl); // needs to be connected to receive .openPicker()/upload the file

      const chipsEl = chipContainer ?? document.createElement('div');
      if (!chipContainer) {
        chipsEl.className = 'qu-content-ui-attachments';
        ctx.textarea.parentNode.appendChild(chipsEl);
      }

      let pending = [];
      function renderChips() {
        chipsEl.innerHTML = '';
        for (const attachment of pending) {
          const chip = document.createElement('span');
          chip.className = 'qu-content-ui-attachment-chip';
          const label = document.createElement('span');
          label.textContent = `📎 ${attachment.meta.name}`;
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.textContent = '✕';
          removeBtn.addEventListener('click', () => {
            pending = pending.filter((a) => a.assetId !== attachment.assetId);
            if (pending.length === 0) ctx.retractContent('attachment');
            else ctx.contributeContent('attachment', { attachments: pending.map((a) => ({ assetId: a.assetId, ...a.meta })) });
            renderChips();
          });
          chip.append(label, removeBtn);
          chipsEl.appendChild(chip);
        }
      }

      function onUploaded(e) {
        pending = [...pending, e.detail];
        ctx.contributeContent('attachment', { attachments: pending.map((a) => ({ assetId: a.assetId, ...a.meta })) });
        renderChips();
      }
      uploadEl.addEventListener('qu-asset-uploaded', onUploaded);

      ctx.registerAction({ id: 'attachment', icon: trigger, label: triggerTitle, onClick: () => uploadEl.openPicker() });

      return {
        stop: () => {
          uploadEl.removeEventListener('qu-asset-uploaded', onUploaded);
          uploadEl.remove();
          if (!chipContainer) chipsEl.remove();
          ctx.unregisterAction('attachment');
          ctx.retractContent('attachment');
        },
        // A successful submit already carried `pending` out via
        // `mergedExtras()` - clear OUR OWN chip UI now, or it would keep
        // showing (and keep re-attaching itself to every SUBSEQUENT send)
        // after the message it was actually meant for already went out -
        // see `content-editor.js`'s own doc comment on this hook.
        reset: () => {
          pending = [];
          renderChips();
        },
      };
    },
  };
}
