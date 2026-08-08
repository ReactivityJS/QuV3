import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { HttpRouter } from '../src/http-router.js';
import { saveSettings } from '../src/relay-settings.js';

function fakeLoader(manifests = []) {
  return { listManifests: () => manifests.map((manifest) => ({ manifest, originUrl: null })) };
}

async function freshEnv({ manifests = [] } = {}) {
  const appsDir = await mkdtemp(join(tmpdir(), 'qu-http-router-apps-'));
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const state = { transport: null, vapidKeys: null };
  const adminHttp = {
    settingsCalls: 0,
    dataListCalls: 0,
    dataImportCalls: 0,
    handleSettings(req, res) { this.settingsCalls++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); },
    handleDataList(req, res) { this.dataListCalls++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); },
    handleDataImport(req, res) { this.dataImportCalls++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); },
  };
  const loader = fakeLoader(manifests);
  const router = new HttpRouter(qu, adminHttp, loader, { adminPubs: ['admin-pub-1'], appsDir, state });

  const httpServer = createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  return {
    qu, state, adminHttp, router, port, appsDir,
    teardown: async () => {
      await new Promise((resolve) => httpServer.close(resolve));
      await rm(appsDir, { recursive: true, force: true });
    },
  };
}

test('GET /healthz reports ok with a null peerId before the transport exists', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', peerId: null });
  } finally {
    await env.teardown();
  }
});

test('GET /healthz reports the transport\'s peerId once state.transport is set', async () => {
  const env = await freshEnv();
  try {
    env.state.transport = { getPeerId: () => 'relay-abc123' };
    const res = await fetch(`http://localhost:${env.port}/healthz`);
    assert.deepEqual(await res.json(), { status: 'ok', peerId: 'relay-abc123' });
  } finally {
    await env.teardown();
  }
});

test('GET /config.json returns adminPubs and current settings, with CORS allowed', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/config.json`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.deepEqual(body.adminPubs, ['admin-pub-1']);
    assert.equal(body.settings.defaultLocale, 'en');
  } finally {
    await env.teardown();
  }
});

test('GET /config.json reflects a saved settings change', async () => {
  const env = await freshEnv();
  try {
    await saveSettings(env.qu, { defaultLocale: 'de' });
    const res = await fetch(`http://localhost:${env.port}/config.json`);
    const body = await res.json();
    assert.equal(body.settings.defaultLocale, 'de');
  } finally {
    await env.teardown();
  }
});

test('GET /push/vapid-public-key returns null before vapidKeys are resolved', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/push/vapid-public-key`);
    assert.deepEqual(await res.json(), { publicKey: null });
  } finally {
    await env.teardown();
  }
});

test('GET /push/vapid-public-key returns the public key once state.vapidKeys is set', async () => {
  const env = await freshEnv();
  try {
    env.state.vapidKeys = { publicKey: 'the-public-key' };
    const res = await fetch(`http://localhost:${env.port}/push/vapid-public-key`);
    assert.deepEqual(await res.json(), { publicKey: 'the-public-key' });
  } finally {
    await env.teardown();
  }
});

test('POST /admin/settings dispatches to AdminHttp.handleSettings()', async () => {
  const env = await freshEnv();
  try {
    await fetch(`http://localhost:${env.port}/admin/settings`, { method: 'POST', body: '{}' });
    assert.equal(env.adminHttp.settingsCalls, 1);
  } finally {
    await env.teardown();
  }
});

test('GET /admin/settings (wrong method) does NOT dispatch - falls through to 404', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/admin/settings`, { method: 'GET' });
    assert.equal(res.status, 404);
    assert.equal(env.adminHttp.settingsCalls, 0);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/list dispatches to AdminHttp.handleDataList()', async () => {
  const env = await freshEnv();
  try {
    await fetch(`http://localhost:${env.port}/admin/data/list`, { method: 'POST', body: '{}' });
    assert.equal(env.adminHttp.dataListCalls, 1);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/import dispatches to AdminHttp.handleDataImport()', async () => {
  const env = await freshEnv();
  try {
    await fetch(`http://localhost:${env.port}/admin/data/import`, { method: 'POST', body: '{}' });
    assert.equal(env.adminHttp.dataImportCalls, 1);
  } finally {
    await env.teardown();
  }
});

// ===== /apps.json ====================================================================

test('GET /apps.json returns an empty array when no apps are loaded', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/apps.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await res.json(), []);
  } finally {
    await env.teardown();
  }
});

test('GET /apps.json lists a loaded app with a clientMain', async () => {
  const env = await freshEnv({
    manifests: [{ name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js', label: 'Forum', icon: '💬' }],
  });
  try {
    const res = await fetch(`http://localhost:${env.port}/apps.json`);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'forum');
    assert.equal(body[0].clientMainUrl, '/apps/forum/client.js');
  } finally {
    await env.teardown();
  }
});

test('GET /apps.json marks an app disabled via settings, without removing it from the list', async () => {
  const env = await freshEnv({
    manifests: [{ name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }],
  });
  try {
    await saveSettings(env.qu, { disabledApps: ['forum'] });
    const res = await fetch(`http://localhost:${env.port}/apps.json`);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].enabled, false);
  } finally {
    await env.teardown();
  }
});

// ===== static app serving =============================================================

test('GET /apps/<name>/manifest.quapp serves a local app\'s manifest file', async () => {
  const env = await freshEnv();
  try {
    await mkdir(join(env.appsDir, 'forum'), { recursive: true });
    await writeFile(join(env.appsDir, 'forum', 'manifest.quapp'), JSON.stringify({ name: 'forum' }));
    const res = await fetch(`http://localhost:${env.port}/apps/forum/manifest.quapp`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { name: 'forum' });
  } finally {
    await env.teardown();
  }
});

test('GET /apps/<name>/index.js serves a local app\'s JS file with the right content-type', async () => {
  const env = await freshEnv();
  try {
    await mkdir(join(env.appsDir, 'forum'), { recursive: true });
    await writeFile(join(env.appsDir, 'forum', 'index.js'), 'export const x = 1;');
    const res = await fetch(`http://localhost:${env.port}/apps/forum/index.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript');
  } finally {
    await env.teardown();
  }
});

test('GET /apps/<name>/missing.js returns 404 for a file that does not exist', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/apps/forum/missing.js`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});

test('a path-traversal attempt under /apps/ is rejected, not served', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/apps/../../../../etc/passwd`, { redirect: 'manual' });
    assert.notEqual(res.status, 200);
  } finally {
    await env.teardown();
  }
});

test('an unrecognized route returns 404', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/totally-unknown-path`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});

test('the root path is not served (no shell in this milestone)', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});
