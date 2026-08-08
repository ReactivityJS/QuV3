import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { HttpRouter } from '../src/http-router.js';
import { saveSettings } from '../src/relay-settings.js';

async function freshEnv() {
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
  const router = new HttpRouter(qu, adminHttp, { adminPubs: ['admin-pub-1'], state });

  const httpServer = createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  return { qu, state, adminHttp, router, port, teardown: () => new Promise((resolve) => httpServer.close(resolve)) };
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

test('an unrecognized route returns 404', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/apps.json`); // deliberately NOT wired - see http-router.js's own doc comment
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
