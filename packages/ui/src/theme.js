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
 * PER-SCHEME (light/dark) TOKENS: every token except `--qu-color-surface`
 * is either alpha-blended (`#8884` already self-adapts to whatever's
 * underneath, light or dark) or a saturated color that reads fine on both
 * (`#5b5bd6`, `#c00`). `--qu-color-surface` is the one token that genuinely
 * needs a different value per scheme - a FLOATING panel (an emoji picker,
 * a context menu, a mention-autocomplete dropdown - `@qu/thread-ui`'s
 * `emoji.js`/`context-menu.js`/`trigger-autocomplete.js`) sits on top of
 * arbitrary content behind it and needs a genuinely OPAQUE background to
 * stay readable, unlike everything else in this file which is fine self-
 * adapting via alpha blending. It used to be read via `var(--qu-color-surface,
 * canvas)` at each call site with no token ever actually DEFINING it - the
 * `canvas` CSS4 system-color keyword is opaque where supported, but on a
 * browser/engine that doesn't recognize it the entire `background`
 * declaration is dropped as invalid, leaving the panel BLENDED INTO
 * whatever's behind it (confirmed real: reported as "the reactions/context-
 * menu overlay is too transparent"). Defined here instead, with a real
 * light AND dark literal (`ensureTheme()` emits both, see below) - never
 * relies on `canvas`/`canvastext` again.
 *
 * `THEME_PRESETS`/`getStoredTheme()`/`setStoredTheme()` (new): a handful of
 * named accent palettes, persisted the exact same way `@qu/i18n`'s
 * `getStoredLocale()`/`setLocale()` persist a locale choice (`localStorage`,
 * try/catch, `null` clears it) - deliberately mirrored, not a new pattern.
 * `ensureTheme()` applies the stored preset automatically, same as
 * `createI18n()` already applies the stored locale automatically. Kept to
 * palette-only presets (just `--qu-color-accent`), not a full custom color
 * picker - the same "small, named set" scope `DEFAULT_THEME` itself already
 * keeps. Reused by `apps/profile` for a profile's own public `style` field
 * too (see that app's own doc comment) - ONE palette system, not two.
 */

const STYLE_ID = 'qu-theme';
const THEME_STORAGE_KEY = 'qu-theme-name';

/** Every shared token this codebase's apps/components actually reference - not a speculative larger design-token catalog. */
export const DEFAULT_THEME = {
  '--qu-color-accent': '#5b5bd6',
  '--qu-color-border': '#8884',
  '--qu-color-danger': '#c00',
  '--qu-color-surface': '#ffffff',
  '--qu-radius-sm': '0.3rem',
  '--qu-radius-md': '0.4rem',
  '--qu-font': 'system-ui, sans-serif',
  '--qu-font-mono': 'ui-monospace, monospace',
};

/**
 * The ONE dark-scheme override this file ships (see `DEFAULT_THEME`'s own
 * doc comment on why `--qu-color-surface` is the one token that needs it) -
 * `ensureTheme()` emits this under a `prefers-color-scheme: dark` media
 * query, layered on top of the plain `:root` block, same "later rule at
 * equal specificity wins" cascade every other override in this file
 * already relies on.
 */
const DARK_THEME_OVERRIDES = {
  '--qu-color-surface': '#242426',
};

/**
 * Named accent palettes a user can pick from (`apps/profile`'s Settings
 * subpath for their own device-propagated preference, and the SAME app's
 * per-profile `style` field) - `'default'` is `DEFAULT_THEME`'s own accent,
 * kept as an explicit, selectable choice (not just "absence of a preset")
 * so a picker UI has something to show as the current value either way.
 */
export const THEME_PRESETS = {
  default: { '--qu-color-accent': '#5b5bd6' },
  ocean: { '--qu-color-accent': '#0891b2' },
  sunset: { '--qu-color-accent': '#ea580c' },
  forest: { '--qu-color-accent': '#15803d' },
  rose: { '--qu-color-accent': '#e11d48' },
};

/** @returns {string|null} The user's explicitly chosen theme preset name, or null if never set (plain `DEFAULT_THEME` applies). Device-local - see this file's own doc comment for why, and how a per-identity preference still reaches it. */
export function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null; // localStorage unavailable (private browsing, disabled storage, no browser at all) - no override
  }
}

/** @param {string|null} name - One of `THEME_PRESETS`'s keys, or null to clear the override. */
export function setStoredTheme(name) {
  try {
    if (name) localStorage.setItem(THEME_STORAGE_KEY, name);
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // localStorage unavailable - the choice just won't persist across reloads, not worth surfacing as an error
  }
}

/**
 * Injects the shared token `:root` block, once. A second call - even with
 * different `overrides` - is a no-op, same idempotency contract as
 * `injectStyle()`: the FIRST caller (typically the host/shell, mounted
 * before any individual app) wins.
 * @param {Partial<typeof DEFAULT_THEME>} [overrides] - Replace/add tokens on
 *   top of `DEFAULT_THEME` AND on top of the stored preset (if any) below -
 *   an explicit caller override always wins, same priority `createI18n()`'s
 *   explicit `locale` option has over the stored locale. Applies to BOTH the
 *   light block and (for any key `DARK_THEME_OVERRIDES` also has) the dark
 *   one - an explicit override always wins over either scheme's own default.
 */
export function ensureTheme(overrides = {}) {
  if (document.getElementById(STYLE_ID)) return;
  const stored = getStoredTheme();
  const preset = (stored && THEME_PRESETS[stored]) || {};
  const tokens = { ...DEFAULT_THEME, ...preset, ...overrides };
  const declarations = Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join('\n');
  const darkTokens = { ...DARK_THEME_OVERRIDES, ...overrides };
  const darkDeclarations = Object.entries(darkTokens).map(([name, value]) => `    ${name}: ${value};`).join('\n');
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `:root {\n${declarations}\n  color-scheme: light dark;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n${darkDeclarations}\n  }\n}\n`;
  document.head.appendChild(style);
}
