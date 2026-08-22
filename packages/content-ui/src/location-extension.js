/**
 * LOCATION EXTENSION — generalizes `apps/chat/client.js`'s own proven
 * `shareLocation()` (`navigator.geolocation.getCurrentPosition()` → `{lat,
 * lng}`) into a `ContentEditor` `EditorExtension`. Registers a `📍` trigger
 * via `ctx.registerAction()`.
 *
 * DELIBERATE IMPROVEMENT over `apps/chat/client.js`'s current behavior: the
 * original `shareLocation()` posts the message the INSTANT a position
 * resolves - a one-shot, immediate send with no chance to add a caption or
 * cancel. This extension instead `ctx.contributeContent()`s the location
 * (same `{lat, lng}` shape) and waits for the user's own Send, exactly like
 * an attachment - so a location can now carry an optional caption, or be
 * removed before sending. The underlying geolocation call and data shape
 * are otherwise identical.
 */

const STYLE_ID = 'qu-content-ui-location-style';
const STYLE = `
  .qu-content-ui-location-chip { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.85em; padding: 0.15rem 0.4rem; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; }
  .qu-content-ui-location-chip button { border: none; background: transparent; cursor: pointer; opacity: 0.7; font: inherit; padding: 0; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/**
 * @param {{trigger?: string, triggerTitle?: string, label?: string, chipContainer?: HTMLElement}} [options]
 *   `label` - shown on the pending-location chip (default "Location attached").
 * @returns {{id: string, mount: (ctx: object) => (() => void)}}
 */
export function locationExtension({ trigger = '📍', triggerTitle = 'Share my location', label = 'Location attached', chipContainer } = {}) {
  return {
    id: 'location',
    mount(ctx) {
      ensureStyle();

      const chipEl = chipContainer ?? document.createElement('div');
      if (!chipContainer) ctx.textarea.parentNode.appendChild(chipEl);

      function clearChip() {
        chipEl.innerHTML = '';
      }
      function renderChip() {
        clearChip();
        const chip = document.createElement('span');
        chip.className = 'qu-content-ui-location-chip';
        const text = document.createElement('span');
        text.textContent = `📍 ${label}`;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
          ctx.retractContent('location');
          clearChip();
        });
        chip.append(text, removeBtn);
        chipEl.appendChild(chip);
      }

      let busy = false; // re-entrancy guard - same reasoning apps/chat/client.js's own shareLocationBusy documents
      function shareLocation() {
        if (busy || !navigator.geolocation) return;
        busy = true;
        navigator.geolocation.getCurrentPosition(
          (position) => {
            busy = false;
            ctx.contributeContent('location', { location: { lat: position.coords.latitude, lng: position.coords.longitude } });
            renderChip();
          },
          () => { busy = false; } // permission denied / unavailable - silently no-ops, same as the original
        );
      }

      ctx.registerAction({ id: 'location', icon: trigger, label: triggerTitle, onClick: shareLocation });

      return () => {
        ctx.unregisterAction('location');
        ctx.retractContent('location');
        if (!chipContainer) chipEl.remove();
      };
    },
  };
}
