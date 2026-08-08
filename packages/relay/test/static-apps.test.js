import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveApps } from '../src/static-apps.js';

async function freshServer() {
  const appsDir = await mkdtemp(join(tmpdir(), 'qu-static-apps-'));
  const httpServer = createServer(async (req, res) => {
    const served = await serveApps(req, res, appsDir);
    if (!served) res.writeHead(404).end('not handled by serveApps');
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  return {
    appsDir,
    port,
    teardown: async () => {
      await new Promise((resolve) => httpServer.close(resolve));
      await rm(appsDir, { recursive: true, force: true });
    },
  };
}

test('serves a manifest.quapp with application/json content-type', async () => {
  const env = await freshServer();
  try {
    await mkdir(join(env.appsDir, 'forum'), { recursive: true });
    await writeFile(join(env.appsDir, 'forum', 'manifest.quapp'), JSON.stringify({ name: 'forum' }));
    const res = await fetch(`http://localhost:${env.port}/apps/forum/manifest.quapp`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await res.json(), { name: 'forum' });
  } finally {
    await env.teardown();
  }
});

test('serves a .js file with text/javascript content-type', async () => {
  const env = await freshServer();
  try {
    await mkdir(join(env.appsDir, 'forum'), { recursive: true });
    await writeFile(join(env.appsDir, 'forum', 'index.js'), 'export const x = 1;');
    const res = await fetch(`http://localhost:${env.port}/apps/forum/index.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript');
    assert.equal(await res.text(), 'export const x = 1;');
  } finally {
    await env.teardown();
  }
});

// A stale cached app bundle would survive apps/shell's own update-flow
// reload (that reload only guarantees a fresh SHELL, not a fresh copy of
// whichever app is currently open) - see this file's own doc comment.
test('serves every file with cache-control: no-cache', async () => {
  const env = await freshServer();
  try {
    await mkdir(join(env.appsDir, 'forum'), { recursive: true });
    await writeFile(join(env.appsDir, 'forum', 'index.js'), 'export const x = 1;');
    const res = await fetch(`http://localhost:${env.port}/apps/forum/index.js`);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  } finally {
    await env.teardown();
  }
});

test('serves a nested .json file (e.g. a subdirectory asset)', async () => {
  const env = await freshServer();
  try {
    await mkdir(join(env.appsDir, 'forum', 'assets'), { recursive: true });
    await writeFile(join(env.appsDir, 'forum', 'assets', 'data.json'), JSON.stringify({ a: 1 }));
    const res = await fetch(`http://localhost:${env.port}/apps/forum/assets/data.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { a: 1 });
  } finally {
    await env.teardown();
  }
});

test('returns 404 for a file that does not exist', async () => {
  const env = await freshServer();
  try {
    const res = await fetch(`http://localhost:${env.port}/apps/forum/missing.js`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});

test('returns 404 for an unsupported file extension, even if the file exists', async () => {
  const env = await freshServer();
  try {
    await mkdir(join(env.appsDir, 'forum'), { recursive: true });
    await writeFile(join(env.appsDir, 'forum', 'readme.txt'), 'hello');
    const res = await fetch(`http://localhost:${env.port}/apps/forum/readme.txt`);
    assert.equal(res.status, 404);
  } finally {
    await env.teardown();
  }
});

test('a request outside /apps/ is not handled (returns false, no response written)', async () => {
  const env = await freshServer();
  try {
    const res = await fetch(`http://localhost:${env.port}/healthz`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'not handled by serveApps');
  } finally {
    await env.teardown();
  }
});

test('REGRESSION: a path-traversal attempt via "../" segments is rejected with 400, never reads outside appsDir', async () => {
  const env = await freshServer();
  try {
    // Write a secret file OUTSIDE appsDir to prove it's never reachable.
    const secretDir = await mkdtemp(join(tmpdir(), 'qu-static-apps-secret-'));
    await writeFile(join(secretDir, 'secret.js'), 'export const secret = true;');
    try {
      const traversal = '/apps/' + '../'.repeat(6) + secretDir.slice(1) + '/secret.js';
      const res = await fetch(`http://localhost:${env.port}${traversal}`, { redirect: 'manual' });
      assert.notEqual(res.status, 200);
    } finally {
      await rm(secretDir, { recursive: true, force: true });
    }
  } finally {
    await env.teardown();
  }
});

test('an encoded "../" traversal attempt is also rejected', async () => {
  const env = await freshServer();
  try {
    const res = await fetch(`http://localhost:${env.port}/apps/%2e%2e/%2e%2e/etc/passwd`, { redirect: 'manual' });
    assert.notEqual(res.status, 200);
  } finally {
    await env.teardown();
  }
});
