/**
 * `renderFlagToggle()` — a small reusable button for `FlagService`'s
 * PRIVATE mode (see @qu/services' `FlagService` doc comment): "star/
 * bookmark this entity", the shared shape a contact toggle and a favorite
 * toggle would otherwise each hand-roll independently.
 *
 * Imperative (not reactive/`watch()`-based) on purpose: it updates itself
 * immediately on its OWN click (no round-trip needed to see your own
 * action), and broadcasts `qu:flag-changed` so any OTHER mounted UI
 * showing this same flag's state stays in sync.
 */
import { injectStyle } from './style.js';

const STYLE_ID = 'qu-flag-toggle-style';
const STYLE = `
  .qu-flag-toggle { background: none; border: none; cursor: pointer; font-size: 1.1em; opacity: 0.6; }
  .qu-flag-toggle:hover { opacity: 1; }
  .qu-flag-toggle.qu-flag-toggle-active { opacity: 1; }
  .qu-flag-toggle:disabled { cursor: default; }
`;

export function renderFlagToggle({ flags, flagType, entityKind, entityRef, icon, activeIcon, title, activeTitle }) {
  injectStyle(STYLE_ID, STYLE);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qu-flag-toggle';
  btn.textContent = icon;
  btn.title = title;
  btn.setAttribute('aria-label', title);

  function render(active) {
    btn.textContent = active ? (activeIcon ?? icon) : icon;
    btn.classList.toggle('qu-flag-toggle-active', active);
    const label = active ? (activeTitle ?? title) : title;
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  flags.hasPrivate(flagType, entityKind, entityRef).then(render);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const active = btn.classList.contains('qu-flag-toggle-active');
    await flags.setPrivate(flagType, entityKind, entityRef, !active);
    render(!active);
    window.dispatchEvent(new CustomEvent('qu:flag-changed', { detail: { flagType, entityKind, entityRef, on: !active } }));
    btn.disabled = false;
  });

  return btn;
}
