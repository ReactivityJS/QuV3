#!/usr/bin/env node
/**
 * CLI entry point: `node packages/relay/src/server.js` or `npm run relay`
 * from the repo root.
 *
 * Config layering (each layer overrides the one before it):
 *   1. `QuRelay`'s own defaults (see relay.js).
 *   2. `relay.config.json` in the current working directory, if present
 *      (see relay.config.example.json at the repo root for the shape).
 *   3. Environment variables (see ENV_MAPPING below) - the layer a
 *      container orchestrator (docker-compose, Kubernetes, ...) actually
 *      configures, so a deployment never needs to bake a config FILE into
 *      an image or bind-mount one just to set a port or data directory.
 *
 * Both (2) and (3) are optional and independent - a plain `node server.js`
 * with neither present boots with `QuRelay`'s defaults.
 *
 * `QU_LOG_LEVEL` (`debug`/`info`/`warn`/`error`, default `info`) controls
 * every `@qu/log` logger process-wide - it's NOT in `ENV_MAPPING` below
 * because it isn't a `QuRelayOptions` field, `@qu/log` reads
 * `process.env.QU_LOG_LEVEL` itself the moment it's first imported (which
 * happens transitively via `./relay.js`, before this file's first log line
 * could ever fire).
 */
import { readFile } from 'node:fs/promises';
import { createLogger } from '@qu/log';
import { QuRelay } from './relay.js';

const log = createLogger('QuRelay');

function parseBooleanEnv(raw) {
  return !['0', 'false', 'no', ''].includes(raw.trim().toLowerCase());
}

/**
 * @type {Record<string, {key: string, parse?: (raw: string) => *}>}
 * Maps an environment variable to the QuRelayOptions field it overrides.
 * Kept as an explicit table (not "any QU_* var maps to camelCase") so an
 * unrelated QU_-prefixed variable set for some other reason can never
 * silently reconfigure the relay.
 */
const ENV_MAPPING = {
  QU_PORT: { key: 'port', parse: (raw) => Number.parseInt(raw, 10) },
  QU_STORE_DIR: { key: 'storeDir' },
  QU_BLOB_DIR: { key: 'blobDir' },
  QU_APPS_DIR: { key: 'appsDir' },
  QU_SERVE_SHELL: { key: 'serveShell', parse: parseBooleanEnv },
  QU_SHELL_DIR: { key: 'shellDir' },
  QU_IDENTITY_MNEMONIC: { key: 'identityMnemonic' },
  // Comma-separated base64url actor pubkeys - see relay.js's `/config.json`
  // route for what this does (and does not) authorize.
  QU_ADMIN_PUBS: { key: 'adminPubs', parse: (raw) => raw.split(',').map((s) => s.trim()).filter(Boolean) },
  // Web Push (see @qu/push) - pin PUBLIC+PRIVATE together, or omit both to
  // auto-generate-and-persist on first boot (see relay.js's `setupVapidKeys()`).
  QU_VAPID_PUBLIC_KEY: { key: 'vapidPublicKey' },
  QU_VAPID_PRIVATE_KEY: { key: 'vapidPrivateKey' },
  QU_VAPID_SUBJECT: { key: 'vapidSubject' },
  // JSON array, same shape as relay.config.json's "remoteApps" field - the
  // one option that doesn't reduce to a single scalar, so it's still JSON
  // rather than getting its own ad-hoc mini-syntax.
  QU_REMOTE_APPS_JSON: { key: 'remoteApps', parse: (raw) => JSON.parse(raw) },
};

async function loadFileConfig() {
  try {
    return JSON.parse(await readFile('./relay.config.json', 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function applyEnvOverrides(config) {
  const result = { ...config };
  for (const [envVar, { key, parse }] of Object.entries(ENV_MAPPING)) {
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') continue;
    try {
      result[key] = parse ? parse(raw) : raw;
    } catch (err) {
      throw new Error(`Invalid value for ${envVar}="${raw}": ${err.message}`);
    }
  }
  return result;
}

const config = applyEnvOverrides(await loadFileConfig());
const relay = await new QuRelay(config).boot();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log.info(`received ${signal}, shutting down...`);
    await relay.close();
    process.exit(0);
  });
}
