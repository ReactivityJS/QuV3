import { readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { QuCrypto } from '@qu/core';
import { createLogger } from '@qu/log';
import { saveSettings } from './relay-settings.js';
import { publishAppsCatalog } from './apps-catalog-store.js';

const log = createLogger('AdminHttp');

/**
 * ADMIN HTTP — the relay's privileged, signature-gated HTTP surface:
 * changing operational settings, and Relay Admin's Data Explorer
 * (list/restore raw QuBits straight off disk, for debugging). Every route
 * here shares ONE gate (`verifyAdmin()`): `actorPub` must be in the
 * configured `adminPubs` list AND `signature` must actually verify over the
 * exact payload the client claims to have signed - a request merely
 * CLAIMING to be from an admin pubkey proves nothing on its own.
 *
 * Split out of the relay's own composition root on purpose
 * (docs/v3-technical-concept.md §2.1: "no file wires more than one
 * cross-cutting concern's worth of behavior directly") - this is exactly
 * one such concern (privileged HTTP admin actions), registered into
 * `RuntimeContainer` like any other module, not a method on a growing
 * `QuRelay` class.
 */
export class AdminHttp {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {{adminPubs: string[], storeDir: string, blobDir: string, identity: import('@qu/identity').QuIdentityEngine, loader: import('@qu/loader').QuLoader}} options -
   *   `identity`/`loader` are only needed for `handleSettings()`'s
   *   re-publish of the app catalog (see `apps-catalog-store.js`) after a
   *   `disabledApps` change - both are stable, already-constructed
   *   references by the time this module is ever resolved (unlike
   *   `state.transport` below, neither is populated lazily during `boot()`).
   * @param {{transport: import('./transports/websocket-server-transport.js').WebSocketServerTransport|null}} [state] -
   *   Optional, a mutable shared reference (same pattern `http-router.js`
   *   uses) - if `state.transport` is set by the time a settings change
   *   including `rateLimits` arrives (see `handleSettings()`), it applies
   *   LIVE: an admin changing the rate limit shouldn't require restarting
   *   the relay (which would drop every connected client) to take effect.
   *   Read fresh on every call rather than captured once at construction,
   *   since `transport` isn't created until partway through `boot()` (see
   *   `relay.js`) - by the time any HTTP request can actually arrive it
   *   will be, but this module doesn't need to assume that ordering itself.
   */
  constructor(qu, { adminPubs, storeDir, blobDir, identity, loader }, state = { transport: null }) {
    this.qu = qu;
    this.adminPubs = adminPubs;
    this.storeDir = storeDir;
    this.blobDir = blobDir;
    this.identity = identity;
    this.loader = loader;
    this.state = state;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {number} [maxBytes=64KiB] - A settings payload is tiny; a Data
   *   Explorer import (see `handleDataImport()`) is a bulk restore of
   *   potentially many QuBits, so callers with genuinely larger bodies pass
   *   a bigger cap explicitly rather than this default growing for everyone.
   * @returns {Promise<object>} Parsed JSON body.
   * @throws {Error} On a body over `maxBytes` or malformed JSON.
   */
  async #readJsonBody(req, maxBytes = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('request body too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  /**
   * Shared gate for every admin-only route. Writes a 403 response and
   * returns `false` itself on any failure, so a call site only needs to
   * check the return value.
   * @param {import('node:http').ServerResponse} res
   * @param {string} actorPub @param {string} signature @param {*} signedPayload - Must match exactly what the client signed.
   * @returns {Promise<boolean>}
   */
  async #verifyAdmin(res, actorPub, signature, signedPayload) {
    if (!this.adminPubs.includes(actorPub)) {
      log.warn(`rejected: ~${String(actorPub).slice(0, 10)}… is not a configured relay admin`);
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not a configured relay admin' }));
      return false;
    }
    let verified = false;
    try {
      verified = await QuCrypto.verify(
        new TextEncoder().encode(JSON.stringify(signedPayload)),
        QuCrypto.fromBase64Url(signature),
        QuCrypto.fromBase64Url(actorPub)
      );
    } catch {
      verified = false; // malformed base64/signature - treat exactly like "did not verify"
    }
    if (!verified) {
      log.warn(`rejected: signature from ~${actorPub.slice(0, 10)}… does not verify`);
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'signature does not verify' }));
      return false;
    }
    return true;
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async handleSettings(req, res) {
    let body;
    try {
      body = await this.#readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      return;
    }

    const { actorPub, settings, signature } = body ?? {};
    if (typeof actorPub !== 'string' || typeof signature !== 'string' || typeof settings !== 'object' || settings === null) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected { actorPub, settings, signature }' }));
      return;
    }
    if (!(await this.#verifyAdmin(res, actorPub, signature, settings))) return;

    const merged = await saveSettings(this.qu, settings);
    if (settings.rateLimits) this.state.transport?.setRateLimit(merged.rateLimits.maxMessagesPerMinute);
    // An enable/disable (or app-list visibility) change takes effect for
    // every connected client immediately - re-publishing is what a
    // <qu-list parent="/store/apps/catalog"> reacts to, no relay restart
    // needed (see apps-catalog-store.js's own doc comment).
    if (settings.disabledApps || settings.hiddenFromAppList) await publishAppsCatalog(this.qu, this.identity, this.loader, merged);

    log.info(`settings updated by ~${actorPub.slice(0, 10)}…:`, Object.keys(settings).join(', '));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(merged));
  }

  /**
   * Lists every stored QuBit whose logical path starts with `query.prefix`
   * (default `/store`, the mount `paths.js`'s helpers all write under -
   * `/blob` is included too if explicitly asked for, since asset chunks
   * live there under the exact same `FsAdapter`/JSON-file shape). Debugging
   * tool, not a Service - there is no in-store wildcard query anywhere else
   * in this codebase, so this walks the adapters' files directly.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   */
  async handleDataList(req, res) {
    let body;
    try {
      body = await this.#readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      return;
    }

    const { actorPub, query, signature } = body ?? {};
    if (typeof actorPub !== 'string' || typeof signature !== 'string' || typeof query !== 'object' || query === null) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected { actorPub, query, signature }' }));
      return;
    }
    if (!(await this.#verifyAdmin(res, actorPub, signature, query))) return;

    const prefix = typeof query.prefix === 'string' && query.prefix ? query.prefix : '/store';
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);

    const candidates = [
      ...(await walkJsonFiles(this.storeDir)).map((file) => fileToLogicalPath(file, this.storeDir, '/store')),
      ...(await walkJsonFiles(this.blobDir)).map((file) => fileToLogicalPath(file, this.blobDir, '/blob')),
    ]
      .filter((path) => path.startsWith(prefix))
      .sort();

    const MAX_VALUE_BYTES = 200 * 1024; // a debug preview, not a bulk export - see handleDataImport() for the real bulk path
    const entries = [];
    for (const path of candidates.slice(0, limit)) {
      const { adapter, rel } = this.qu.resolveMount(path);
      let raw;
      try {
        raw = await adapter.get(rel);
      } catch {
        entries.push({ path, error: 'unreadable on disk' });
        continue;
      }
      const size = raw ? JSON.stringify(raw).length : 0;
      if (size > MAX_VALUE_BYTES) entries.push({ path, truncated: true, byteLength: size });
      else entries.push({ path, value: raw });
    }

    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ entries, total: candidates.length, hasMore: candidates.length > limit }));
  }

  /**
   * The write half of the Data Explorer: restores previously-exported
   * QuBits EXACTLY as they were (original signature/encryption/timestamp
   * intact) via `QuStore.putSealed()` - never through the normal
   * Engine-mediated `qu.put()` pipeline, which would re-stamp/re-sign
   * everything under THIS admin's own identity instead of preserving
   * original authorship. Deliberately not restricted to any path prefix:
   * an admin restoring their own relay's data is already trusted with its
   * entire disk.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   */
  async handleDataImport(req, res) {
    let body;
    try {
      body = await this.#readJsonBody(req, 20 * 1024 * 1024); // a bulk restore, not a settings tweak - see #readJsonBody's own doc comment
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      return;
    }

    const { actorPub, entries, signature } = body ?? {};
    if (typeof actorPub !== 'string' || typeof signature !== 'string' || !Array.isArray(entries)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected { actorPub, entries, signature }' }));
      return;
    }
    if (!(await this.#verifyAdmin(res, actorPub, signature, entries))) return;

    let imported = 0;
    let skipped = 0;
    for (const entry of entries) {
      const path = entry?.path;
      const value = entry?.value;
      if (typeof path !== 'string' || !path.startsWith('/') || value === null || typeof value !== 'object') {
        skipped++;
        continue;
      }
      try {
        await this.qu.putSealed(path, value);
        imported++;
      } catch {
        skipped++;
      }
    }

    log.info(`data import by ~${actorPub.slice(0, 10)}…: ${imported} imported, ${skipped} skipped, ${entries.length} total`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ imported, skipped, total: entries.length }));
  }
}

/**
 * Recursively lists every `.json` file `FsAdapter` has ever written under
 * `dir` (see `@qu/runtime`'s `fs-adapter.js` - one file per stored QuBit,
 * path structure mirrored 1:1 onto the filesystem). Used by
 * `handleDataList()` to enumerate stored data - there is no in-store
 * wildcard/prefix query anywhere in this codebase, so listing has to walk
 * the adapter's own files directly, one directory below the relay's own
 * process.
 * @param {string} dir
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function walkJsonFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // directory doesn't exist yet (e.g. blobDir on a relay that's never stored an asset) - nothing to list
  }
  const out = [];
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkJsonFiles(full)));
    // FsAdapter's atomic write leaves a `<path>.<uuid>.tmp` file briefly mid-rename - never a finished, readable QuBit.
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * @param {string} filePath - As returned by `walkJsonFiles()`.
 * @param {string} baseDir - The adapter's own base directory.
 * @param {string} mountPrefix - e.g. '/store' or '/blob'.
 * @returns {string} The logical Qu path this file corresponds to.
 */
function fileToLogicalPath(filePath, baseDir, mountPrefix) {
  const rel = relative(baseDir, filePath).split(sep).join('/');
  return `${mountPrefix}/${rel.replace(/\.json$/, '')}`;
}
