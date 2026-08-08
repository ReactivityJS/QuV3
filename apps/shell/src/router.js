/**
 * ROUTER — pure hash-parsing logic, kept DOM-free so it's testable without
 * a browser. `#/<appId>/<...segments>` - the first segment selects which
 * app's `clientMainUrl` to mount, everything after is that app's own
 * business (unused by every app built so far, but part of the convention
 * from day one so an app CAN read sub-routes later without a router change).
 *
 * Ported near-verbatim from the prototype this is rebuilt from (QuV2's
 * `apps/shell/src/router.js`) - already minimal, already DOM-free, nothing
 * to improve on.
 */

/**
 * @param {string} hash - e.g. "#/notes/inbox" or "" (home).
 * @returns {{appId: string|null, segments: string[]}}
 */
export function parseHash(hash) {
  const clean = (hash || '').replace(/^#\/?/, '');
  const segments = clean.split('/').filter(Boolean);
  return { appId: segments[0] ?? null, segments };
}

/** @param {string} appId @param {string[]} [rest] @returns {string} */
export function buildHash(appId, rest = []) {
  return ['#', appId, ...rest].filter(Boolean).join('/');
}
