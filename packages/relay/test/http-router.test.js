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

async function freshEnv({ manifests = [], serveShell = false, shellDir = null, getLinkPreviewImpl, iceServers } = {}) {
  const appsDir = await mkdtemp(join(tmpdir(), 'qu-http-router-apps-'));
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const state = { transport: null, vapidKeys: null, relayPub: null };
  const adminHttp = {
    settingsCalls: 0,
    dataListCalls: 0,
    dataImportCalls: 0,
    handleSettings(req, res) { this.settingsCalls++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); },
    handleDataList(req, res) { this.dataListCalls++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); },
    handleDataImport(req, res) { this.dataImportCalls++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); },
  };
  const loader = fakeLoader(manifests);
  const router = new HttpRouter(qu, adminHttp, loader, { adminPubs: ['admin-pub-1'], appsDir, serveShell, shellDir, state, iceServers, getLinkPreviewImpl });

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

test('GET /config.json defaults iceServers to an empty array when the operator configured none', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/config.json`);
    assert.deepEqual((await res.json()).iceServers, []);
  } finally {
    await env.teardown();
  }
});

test('GET /config.json reflects an operator-configured iceServers list', async () => {
  const iceServers = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }];
  const env = await freshEnv({ iceServers });
  try {
    const res = await fetch(`http://localhost:${env.port}/config.json`);
    assert.deepEqual((await res.json()).iceServers, iceServers);
  } finally {
    await env.teardown();
  }
});

test('GET /config.json returns null relayPub before boot() has established one', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/config.json`);
    assert.equal((await res.json()).relayPub, null);
  } finally {
    await env.teardown();
  }
});

test('GET /config.json reflects state.relayPub once boot() has set it - what apps/app-list checks a catalog entry\'s signer against', async () => {
  const env = await freshEnv();
  try {
    env.state.relayPub = 'relay-pub-abc123';
    const res = await fetch(`http://localhost:${env.port}/config.json`);
    assert.equal((await res.json()).relayPub, 'relay-pub-abc123');
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

test('GET /link-preview?url=... returns the injected getLinkPreview() result, with CORS + a cache-control header', async () => {
  const calls = [];
  const env = await freshEnv({
    getLinkPreviewImpl: async (url) => { calls.push(url); return { url, title: 'A Title', description: 'A description', image: 'https://example.com/img.png', siteName: 'example.com' }; },
  });
  try {
    const res = await fetch(`http://localhost:${env.port}/link-preview?url=${encodeURIComponent('https://example.com/article')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('cache-control')?.includes('max-age'));
    assert.deepEqual(await res.json(), { url: 'https://example.com/article', title: 'A Title', description: 'A description', image: 'https://example.com/img.png', siteName: 'example.com' });
    assert.deepEqual(calls, ['https://example.com/article']);
  } finally {
    await env.teardown();
  }
});

test('GET /link-preview?url=... returns an all-null shape (not an error) when getLinkPreview() resolves null', async () => {
  const env = await freshEnv({ getLinkPreviewImpl: async () => null });
  try {
    const res = await fetch(`http://localhost:${env.port}/link-preview?url=${encodeURIComponent('https://example.com/dead')}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: 'https://example.com/dead', title: null, description: null, image: null, siteName: null });
  } finally {
    await env.teardown();
  }
});

test('GET /link-preview with no url query parameter is a 400', async () => {
  const env = await freshEnv({ getLinkPreviewImpl: async () => { throw new Error('must not be called'); } });
  try {
    const res = await fetch(`http://localhost:${env.port}/link-preview`);
    assert.equal(res.status, 400);
  } finally {
    await env.teardown();
  }
});

test('GET /link-preview is a 404 once an admin has turned linkPreviews.enabled off, and never calls getLinkPreview()', async () => {
  const env = await freshEnv({ getLinkPreviewImpl: async () => { throw new Error('must not be called'); } });
  try {
    await saveSettings(env.qu, { linkPreviews: { enabled: false } });
    const res = await fetch(`http://localhost:${env.port}/link-preview?url=${encodeURIComponent('https://example.com/x')}`);
    assert.equal(res.status, 404);
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

test('the root path 404s when serveShell is off (the default)', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});

// ===== apps/shell serving ==============================================================

async function freshEnvWithShell(files = { 'index.html': '<html>shell</html>' }) {
  const shellDir = await mkdtemp(join(tmpdir(), 'qu-http-router-shell-'));
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(shellDir, name, '..'), { recursive: true });
    await writeFile(join(shellDir, name), contents);
  }
  const env = await freshEnv({ serveShell: true, shellDir });
  const originalTeardown = env.teardown;
  env.teardown = async () => {
    await originalTeardown();
    await rm(shellDir, { recursive: true, force: true });
  };
  return env;
}

test('GET / serves apps/shell\'s index.html when serveShell is on', async () => {
  const env = await freshEnvWithShell();
  try {
    const res = await fetch(`http://localhost:${env.port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.equal(await res.text(), '<html>shell</html>');
  } finally {
    await env.teardown();
  }
});

test('GET /index.html serves the same file as GET /', async () => {
  const env = await freshEnvWithShell();
  try {
    const res = await fetch(`http://localhost:${env.port}/index.html`);
    assert.equal(await res.text(), '<html>shell</html>');
  } finally {
    await env.teardown();
  }
});

test('GET /shell-bundle.js serves the built bundle with the right content-type', async () => {
  const env = await freshEnvWithShell({
    'index.html': '<html>shell</html>',
    'dist/shell-bundle.js': 'console.log("shell");',
  });
  try {
    const res = await fetch(`http://localhost:${env.port}/shell-bundle.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript');
    assert.equal(await res.text(), 'console.log("shell");');
  } finally {
    await env.teardown();
  }
});

test('GET /manifest.webmanifest serves the PWA manifest with the right content-type and cache-control', async () => {
  const env = await freshEnvWithShell({
    'index.html': '<html>shell</html>',
    'manifest.webmanifest': '{"name":"Quniverse"}',
  });
  try {
    const res = await fetch(`http://localhost:${env.port}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/manifest+json');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(await res.json(), { name: 'Quniverse' });
  } finally {
    await env.teardown();
  }
});

test('GET /sw.js serves the built (version-stamped) service worker with no-cache, so a browser never sits on a stale copy', async () => {
  const env = await freshEnvWithShell({
    'index.html': '<html>shell</html>',
    'dist/sw.js': 'const SW_VERSION = "abc123";',
  });
  try {
    const res = await fetch(`http://localhost:${env.port}/sw.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(await res.text(), 'const SW_VERSION = "abc123";');
  } finally {
    await env.teardown();
  }
});

test('a route not among the shell\'s fixed files still falls through to 404, even with serveShell on', async () => {
  const env = await freshEnvWithShell();
  try {
    const res = await fetch(`http://localhost:${env.port}/some-random-path`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});

test('serveShell: true with a missing shellDir file 404s rather than throwing', async () => {
  const env = await freshEnvWithShell({}); // no index.html written
  try {
    const res = await fetch(`http://localhost:${env.port}/`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});
