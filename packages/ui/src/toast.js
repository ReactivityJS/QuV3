/**
 * TOAST — a minimal popup/notification host, the primitive `apps/shell`'s
 * live notification watcher (see its own `notification-popups.js`) stacks
 * toasts into. Deliberately generic: `{title, body, actions, durationMs}`
 * in, nothing here knows about notifications, calls, or any specific app -
 * the Phone-app plan's own "Zwischenlösung" wording ("ein optionales
 * kleines Popup ... konfigurierbar") only needed a place to RENDER a popup,
 * not a place that decides when one should appear (that's the watcher's job).
 */
import { injectStyle } from './style.js';

const STYLE_ID = 'qu-toast-style';
const STYLE = `
  .qu-toast-host { position: fixed; top: 4rem; right: 1rem; z-index: 900; display: flex; flex-direction: column; gap: 0.5rem; max-width: min(22rem, calc(100vw - 2rem)); }
  .qu-toast { background: canvas; color: canvastext; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); box-shadow: 0 0.5rem 1.4rem rgba(0,0,0,0.25); padding: 0.7rem 0.8rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-toast-header { display: flex; align-items: flex-start; gap: 0.5rem; }
  .qu-toast-title { flex: 1; font-weight: 600; }
  .qu-toast-body { font-size: 0.9em; opacity: 0.85; }
  .qu-toast-close { background: none; border: none; cursor: pointer; opacity: 0.6; font-size: 1em; line-height: 1; padding: 0; }
  .qu-toast-close:hover { opacity: 1; }
  .qu-toast-actions { display: flex; gap: 0.5rem; }
  .qu-toast-actions a, .qu-toast-actions button { padding: 0.35rem 0.7rem; border-radius: var(--qu-radius-sm, 0.3rem); border: 1px solid var(--qu-color-border, #8884); background: var(--qu-color-accent, #5b5bd6); color: #fff; text-decoration: none; font: inherit; cursor: pointer; text-align: center; }
  .qu-toast-actions .qu-toast-action-secondary { background: none; color: inherit; }
`;

/**
 * @param {HTMLElement} container - Where the toast stack mounts (e.g. `document.body`).
 * @returns {{
 *   show: (toast: {title?: string, body?: string, actions?: Array<{label: string, href?: string, onClick?: () => void, primary?: boolean}>, durationMs?: number, onDismiss?: () => void}) => (() => void),
 *   destroy: () => void
 * }}
 *   `show()` returns its own `dismiss` function, so a caller can close a
 *   specific toast early (e.g. a call that was answered elsewhere).
 */
export function mountToastHost(container) {
  injectStyle(STYLE_ID, STYLE);
  const host = document.createElement('div');
  host.className = 'qu-toast-host';
  container.appendChild(host);

  function show({ title, body, actions = [], durationMs = 0, onDismiss } = {}) {
    const toast = document.createElement('div');
    toast.className = 'qu-toast';

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      toast.remove();
      onDismiss?.();
    }

    const header = document.createElement('div');
    header.className = 'qu-toast-header';
    if (title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'qu-toast-title';
      titleEl.textContent = title;
      header.appendChild(titleEl);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'qu-toast-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.addEventListener('click', dismiss);
    header.appendChild(closeBtn);
    toast.appendChild(header);

    if (body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'qu-toast-body';
      bodyEl.textContent = body;
      toast.appendChild(bodyEl);
    }

    if (actions.length > 0) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'qu-toast-actions';
      for (const action of actions) {
        const el = action.href ? document.createElement('a') : document.createElement('button');
        if (action.href) el.href = action.href;
        else el.type = 'button';
        if (action.primary === false) el.classList.add('qu-toast-action-secondary');
        el.textContent = action.label;
        el.addEventListener('click', () => {
          action.onClick?.();
          dismiss();
        });
        actionsEl.appendChild(el);
      }
      toast.appendChild(actionsEl);
    }

    host.appendChild(toast);
    if (durationMs > 0) setTimeout(dismiss, durationMs);
    return dismiss;
  }

  return {
    show,
    destroy: () => host.remove(),
  };
}
