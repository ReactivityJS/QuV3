/**
 * THEME — the shared design-token layer QuV2 never had. There, every app
 * (and the shell's own `index.html`) hand-coded the same handful of colors
 * and radii independently: `#5b5bd6` (accent), `#8884` (border), `#c00`
 * (danger), `0.3rem`/`0.4rem` (radii) - copied, not shared, so changing the
 * palette meant grepping every app. `ensureTheme()` is the fix: ONE call,
 * idempotent like `injectStyle()` (see `style.js` - same "`mount()` can run
 * more than once, a `<style>` doesn't dedupe itself" reasoning), injects a
 * `:root { --qu-color-accent: ...; }` block every app can reference via
 * `var(--qu-color-accent, #5b5bd6)`.
 *
 * The fallback value in that `var(..., #5b5bd6)` is deliberately always the
 * exact literal QuV2 used - this is what makes the whole system OPTIONAL,
 * not just shared: an app/host that never calls `ensureTheme()` at all
 * renders IDENTICALLY to before (the CSS fallback kicks in), and one that
 * does gets a single place to override the palette. Neither path is
 * "more correct" than the other - `ensureTheme()` is a convenience for a
 * host (e.g. a future `apps/shell`) that wants to reskin every mounted app
 * at once, not a requirement for correctness.
 *
 * Deliberately NOT doing (yet): per-scheme (light/dark) token values. Every
 * token below is either alpha-blended (`#8884` already self-adapts to
 * whatever's underneath, light or dark - this is WHY QuV2 chose an alpha
 * border color in the first place, not an oversight) or a saturated color
 * that reads fine on both (`#5b5bd6`, `#c00`) - `color-scheme: light dark`
 * (kept from QuV2's own `index.html`, verified-correct there) already
 * handles background/text via the `canvas`/`canvastext` keyword colors
 * every app already uses directly. A token that genuinely needs a different
 * value per scheme can be added to `overrides` (or, if it recurs, to
 * `DEFAULT_THEME` itself with a `prefers-color-scheme` rule) once a real
 * app needs it - no such app exists yet.
 */

const STYLE_ID = 'qu-theme';

/** Every shared token this codebase's apps/components actually reference - not a speculative larger design-token catalog. */
export const DEFAULT_THEME = {
  '--qu-color-accent': '#5b5bd6',
  '--qu-color-border': '#8884',
  '--qu-color-danger': '#c00',
  '--qu-radius-sm': '0.3rem',
  '--qu-radius-md': '0.4rem',
  '--qu-font': 'system-ui, sans-serif',
  '--qu-font-mono': 'ui-monospace, monospace',
};

/**
 * Injects the shared token `:root` block, once. A second call - even with
 * different `overrides` - is a no-op, same idempotency contract as
 * `injectStyle()`: the FIRST caller (typically the host/shell, mounted
 * before any individual app) wins.
 * @param {Partial<typeof DEFAULT_THEME>} [overrides] - Replace/add tokens on top of `DEFAULT_THEME`.
 */
export function ensureTheme(overrides = {}) {
  if (document.getElementById(STYLE_ID)) return;
  const tokens = { ...DEFAULT_THEME, ...overrides };
  const declarations = Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join('\n');
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `:root {\n${declarations}\n  color-scheme: light dark;\n}\n`;
  document.head.appendChild(style);
}
