/**
 * DEBUG — the client-facing half of Qu's sync telemetry (see this repo's own
 * `packages/sync/src/transports/websocket-client.js`'s `getBytesIn()`/
 * `getCurrentRateIn()` and `SyncEngine.getTransportStats()`, which is what
 * `syncStats.getStats()` below ultimately reads - see `apps/shell/client.js`'s
 * own doc comment on `syncStats` for how that getter reaches every mounted
 * app/contributor without threading the raw `SyncEngine` around).
 *
 * Two contributions, gated by `@qu/ui`'s `isDebugMode()` (a device-local
 * `localStorage` toggle - see that module's own doc comment for why it's
 * device-local, not synced):
 *
 *   1. `renderHeaderBadge` (`shell.headerAction`) - a compact, always-on
 *      live rate readout next to the header's other icons. Checked ONCE at
 *      mount, since the header itself is mounted once for the whole session
 *      (see `apps/shell/src/header.js`'s own doc comment) - toggling debug
 *      mode in Settings takes effect on the NEXT page load, which the
 *      settings hint below says explicitly.
 *   2. `renderDebugSettings` (`userSettings.contributions`, at the bottom of
 *      `#/~<pub>/settings`) - the toggle itself (works even while OFF, so a
 *      user has a way to turn it on) plus, only while it's on, cumulative +
 *      live-rate stats. Uses a small self-managing Custom Element
 *      (`<qu-debug-stats>`, `connectedCallback`/`disconnectedCallback`) for
 *      its own polling lifecycle - NOT a plain `setInterval` like the header
 *      badge - because `userSettings.contributions` get mounted/unmounted
 *      on every visit to Settings (a routed page), unlike the header, which
 *      lives for the whole session; a `setInterval` with no teardown here
 *      would leak on every visit. Same established pattern
 *      `apps/reactions/client.js`'s own `<qu-reactions-row>` already uses
 *      for the identical "renderSlot() gives no teardown callback, but this
 *      contribution needs its own live lifecycle" problem.
 */
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, isDebugMode, setDebugMode, formatBytes, formatRate } from '@qu/ui';

const DICT = {
  en: {
    headerBadgeTitle: 'Sync traffic (debug mode) - current rate, down/up',
    settingsTitle: 'Debug',
    debugModeLabel: 'Debug mode (show sync traffic)',
    debugModeHint: 'Shows live byte counters for the sync connection here and as a badge in the header. A page reload may be needed for the header badge to appear or disappear right after toggling this.',
    statsTotal: 'Total this session: ↓{in} ↑{out}',
    statsRate: 'Current rate: ↓{inRate} ↑{outRate}',
  },
  de: {
    headerBadgeTitle: 'Sync-Traffic (Debug-Modus) - aktuelle Rate, runter/hoch',
    settingsTitle: 'Debug',
    debugModeLabel: 'Debug-Modus (Sync-Traffic anzeigen)',
    debugModeHint: 'Zeigt Live-Byte-Zähler für die Sync-Verbindung hier und als Badge im Header. Nach dem Umschalten ist ggf. ein Neuladen der Seite nötig, damit das Header-Badge erscheint oder verschwindet.',
    statsTotal: 'Gesamt in dieser Sitzung: ↓{in} ↑{out}',
    statsRate: 'Aktuelle Rate: ↓{inRate} ↑{outRate}',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-debug-style';
const STYLE = `
  /* Defense in depth on top of the shell header's own slot-level
     min-width:0/overflow:hidden fix (apps/shell/src/header.js) - this
     contributor should never rely solely on its host to keep it from
     blowing out the header row on a narrow viewport. max-width + ellipsis
     means the rate text clips gracefully instead of forcing the slot (and
     so the whole row) to its full unclipped width. */
  .qu-debug-header-badge { display: inline-flex; align-items: center; font-size: 0.78em; font-family: var(--qu-font-mono, monospace); opacity: 0.75; padding: 0 0.4rem; white-space: nowrap; max-width: 8rem; overflow: hidden; text-overflow: ellipsis; }
  .qu-debug-settings-hint { font-size: 0.8em; opacity: 0.7; margin: 0.2rem 0 0.5rem; }
  .qu-debug-stats { font-family: var(--qu-font-mono, monospace); font-size: 0.85em; opacity: 0.85; margin-top: 0.4rem; display: flex; flex-direction: column; gap: 0.15rem; }
`;

/**
 * Self-managing live stats readout - see this file's own top doc comment on
 * why a Custom Element (not a plain `setInterval`) is required here.
 */
class QuDebugStatsElement extends HTMLElement {
  #interval = null;
  #syncStats = null;

  /** @param {{getStats: () => {bytesIn:number,bytesOut:number,rateIn:number,rateOut:number}}} value */
  set syncStats(value) {
    this.#syncStats = value;
    this.#render();
  }

  connectedCallback() {
    this.className = 'qu-debug-stats';
    this.#render();
    this.#interval = setInterval(() => this.#render(), 1000);
  }

  disconnectedCallback() {
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = null;
  }

  #render() {
    this.textContent = '';
    if (!this.#syncStats) return;
    const { bytesIn, bytesOut, rateIn, rateOut } = this.#syncStats.getStats();
    const total = document.createElement('div');
    total.textContent = t('statsTotal', { in: formatBytes(bytesIn), out: formatBytes(bytesOut) });
    const rate = document.createElement('div');
    rate.textContent = t('statsRate', { inRate: formatRate(rateIn), outRate: formatRate(rateOut) });
    this.append(total, rate);
  }
}
if (!customElements.get('qu-debug-stats')) customElements.define('qu-debug-stats', QuDebugStatsElement);

/**
 * `shell.headerAction` contributor.
 * @param {HTMLElement} container
 * @param {{syncStats?: {getStats: () => {bytesIn:number,bytesOut:number,rateIn:number,rateOut:number}}}} payload
 */
export function renderHeaderBadge(container, { syncStats }) {
  if (!isDebugMode() || !syncStats) return;
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);

  const badge = document.createElement('span');
  badge.className = 'qu-debug-header-badge';
  badge.title = t('headerBadgeTitle');
  container.appendChild(badge);

  function render() {
    const { rateIn, rateOut } = syncStats.getStats();
    badge.textContent = `↓${formatRate(rateIn)} ↑${formatRate(rateOut)}`;
  }
  render();
  // Session-lifetime, no explicit teardown - matches the header's own
  // "mounted once for the whole session" lifetime (see this file's own top
  // doc comment), not a per-navigation leak.
  setInterval(render, 1000);
}

/**
 * `userSettings.contributions` contributor.
 * @param {HTMLElement} container
 * @param {{syncStats?: {getStats: () => {bytesIn:number,bytesOut:number,rateIn:number,rateOut:number}}}} payload
 */
export function renderDebugSettings(container, { syncStats }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);

  const section = document.createElement('section');
  const title = document.createElement('h2');
  title.textContent = t('settingsTitle');
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = isDebugMode();
  label.append(checkbox, document.createTextNode(t('debugModeLabel')));
  const hint = document.createElement('p');
  hint.className = 'qu-debug-settings-hint';
  hint.textContent = t('debugModeHint');
  const statsHost = document.createElement('div');
  section.append(title, label, hint, statsHost);

  function renderStats() {
    statsHost.textContent = '';
    if (!checkbox.checked || !syncStats) return;
    const el = document.createElement('qu-debug-stats');
    el.syncStats = syncStats;
    statsHost.appendChild(el);
  }
  checkbox.addEventListener('change', () => {
    setDebugMode(checkbox.checked);
    renderStats();
  });
  renderStats();

  container.appendChild(section);
}
