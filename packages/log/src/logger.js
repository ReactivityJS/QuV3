/**
 * @qu/log — scoped, level-filterable logging over plain `console.*`, not a
 * replacement for it. The problem this fixes: every package/app in this
 * codebase used bare `console.log/warn/error` with a hand-written
 * `[ModuleName]` prefix and no way to raise/lower verbosity without editing
 * source - fine for a handful of call sites, a real debugging obstacle once
 * a relay AND a browser client are both running unfamiliar new code
 * (`apps/shell`, a real `WebSocketClientTransport` round-trip) and an
 * operator needs to turn on `debug` output without a rebuild.
 *
 * Level resolution happens ONCE at import time (not re-read on every log
 * call - `setLogLevel()` is the only way to change it afterward, so a
 * caller can flip verbosity live without re-importing):
 *   - Node (a relay process): `process.env.QU_LOG_LEVEL`.
 *   - Browser: `localStorage.getItem('qu:logLevel')` - lets an operator run
 *     `quLog.setLevel('debug')` in DevTools (see `apps/shell/client.js`,
 *     which attaches `window.quLog`) and have it persist across reloads,
 *     without touching build config.
 *   - Default: `'info'` in both, if nothing set or the stored value isn't a
 *     recognized level.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function isNode() {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function resolveLevel() {
  if (isNode() && process.env.QU_LOG_LEVEL) return process.env.QU_LOG_LEVEL;
  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem('qu:logLevel');
      if (stored) return stored;
    } catch {
      // Some browser contexts (private mode, sandboxed iframes) throw on
      // any localStorage access at all - fall through to the default.
    }
  }
  return 'info';
}

let currentLevel = LEVELS[resolveLevel()] ?? LEVELS.info;

/** @param {'debug'|'info'|'warn'|'error'} level */
export function setLogLevel(level) {
  if (!(level in LEVELS)) {
    throw new Error(`@qu/log: unknown level "${level}" - expected one of ${Object.keys(LEVELS).join(', ')}`);
  }
  currentLevel = LEVELS[level];
}

/** @returns {'debug'|'info'|'warn'|'error'} */
export function getLogLevel() {
  return Object.keys(LEVELS).find((name) => LEVELS[name] === currentLevel);
}

/**
 * @param {string} scope - Shown as a `[scope]` prefix on every line, e.g.
 *   `createLogger('QuRelay')`, `createLogger('shell:sync')`.
 * @returns {{debug: Function, warn: Function, info: Function, error: Function}}
 */
export function createLogger(scope) {
  const prefix = `[${scope}]`;
  // Resolves `console[methodName]` FRESH on every call rather than
  // capturing a reference once at createLogger() time - deliberate, not an
  // oversight: plenty of legitimate code (test suites asserting on
  // console.error output, error-tracking SDKs) monkey-patches `console.*`
  // AFTER a logger was already created, and a captured-at-creation
  // reference would silently keep writing to the ORIGINAL function,
  // invisible to whatever replaced it.
  const make = (levelName, methodName) => (...args) => {
    if (LEVELS[levelName] < currentLevel) return;
    const fn = console[methodName] ?? console.log;
    // Node output goes to files/journald/`docker compose logs`, none of
    // which timestamp a line by default - a browser DevTools console
    // already timestamps (and colors) every entry far better than a text
    // prefix could, so this is Node-only.
    if (isNode()) fn(`${new Date().toISOString()} ${prefix}`, ...args);
    else fn(prefix, ...args);
  };
  return {
    debug: make('debug', 'debug'),
    info: make('info', 'log'),
    warn: make('warn', 'warn'),
    error: make('error', 'error'),
  };
}
