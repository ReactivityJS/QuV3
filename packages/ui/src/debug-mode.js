/**
 * DEBUG MODE — a device-local toggle that gates the sync byte/rate
 * telemetry displays (header badge, user-settings section, relay-admin
 * traffic section - see whichever of those actually imports this). Stored
 * in `localStorage`, deliberately mirroring `@qu/i18n`'s `getStoredLocale()`/
 * `setLocale()` and this package's own `getStoredTheme()`/`setStoredTheme()`
 * (`theme.js`) exactly - same try/catch shape, same "device preference, not
 * an identity attribute" reasoning: whether THIS device should show its own
 * connection's diagnostic overlay has nothing to do with which identity is
 * logged in, and syncing it through the profile would show a debug overlay
 * on every OTHER device that same identity ever logs into, which is not
 * what "I want to see this here, right now, while debugging" means.
 */

const DEBUG_MODE_STORAGE_KEY = 'qu-debug-mode';

/** @returns {boolean} Whether debug mode is currently on for THIS device/browser. `false` if never set or `localStorage` is unavailable (private browsing, disabled storage). */
export function isDebugMode() {
  try {
    return localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** @param {boolean} enabled */
export function setDebugMode(enabled) {
  try {
    if (enabled) localStorage.setItem(DEBUG_MODE_STORAGE_KEY, '1');
    else localStorage.removeItem(DEBUG_MODE_STORAGE_KEY);
  } catch {
    // localStorage unavailable - the choice just won't persist across reloads, not worth surfacing as an error (same as setStoredTheme()'s own identical catch)
  }
}

/**
 * `12.3 KB/s`/`4.1 MB` - shared formatting so the header badge, settings
 * section, and relay-admin traffic section all render byte counts/rates
 * identically instead of three subtly different implementations.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/** @param {number} bytesPerSecond @returns {string} e.g. "12.3 KB/s". */
export function formatRate(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}
