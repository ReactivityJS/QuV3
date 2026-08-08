import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@qu/log';

const log = createLogger('serveShell');

/**
 * Serves `apps/shell`'s fixed, well-known files - `/` and `/index.html`
 * (the page), `/shell-bundle.js` (+ `.js.map`, the bundle `scripts/
 * build-apps.mjs` produces unconditionally, unlike every other app's
 * `dist/client.js`, which only builds when a `manifest.quapp` declares a
 * `clientMain` - see that script's own doc comment), `/manifest.webmanifest`
 * (PWA installability) and `/sw.js` (the update-flow service worker, also
 * stamped by `build-apps.mjs` - see that script's and `apps/shell/sw.js`'s
 * own doc comments). Unlike `serveApps()`, this is a FIXED small set of
 * exact routes, not a prefix-scanned directory tree - no path-traversal
 * surface to guard against, nothing to normalize.
 *
 * `cache-control: no-cache` (revalidate every time, never serve a stale
 * cached copy silently) on all of them - this is what makes the update flow
 * (`apps/shell/src/pwa.js`) actually work at all: a `sw.js` served from a
 * stale cache would mean the browser never even notices a new one exists,
 * no matter how often the page reloads.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} shellDir
 * @returns {Promise<boolean>} Whether this handler served the request.
 */
export async function serveShell(req, res, shellDir) {
  const route = ROUTES[req.url];
  if (!route) return false;

  try {
    const body = await readFile(join(shellDir, route.file));
    res.writeHead(200, { 'content-type': route.contentType, 'cache-control': 'no-cache' }).end(body);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('Not Found');
    else {
      log.error(err);
      res.writeHead(500).end('Internal Server Error');
    }
  }
  return true;
}

const ROUTES = {
  '/': { file: 'index.html', contentType: 'text/html' },
  '/index.html': { file: 'index.html', contentType: 'text/html' },
  '/shell-bundle.js': { file: 'dist/shell-bundle.js', contentType: 'text/javascript' },
  '/shell-bundle.js.map': { file: 'dist/shell-bundle.js.map', contentType: 'application/json' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', contentType: 'application/manifest+json' },
  '/sw.js': { file: 'dist/sw.js', contentType: 'text/javascript' },
};
