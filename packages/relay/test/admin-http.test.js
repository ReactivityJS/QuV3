import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuStore, QuCrypto } from '@qu/core';
import { FsAdapter } from '@qu/runtime/fs';
import { AdminHttp } from '../src/admin-http.js';

async function freshEnv() {
  const base = await mkdtemp(join(tmpdir(), 'qu-admin-http-'));
  const storeDir = join(base, 'store');
  const blobDir = join(base, 'blob');
  const qu = new QuStore();
  qu.mount('store', new FsAdapter(storeDir));
  qu.mount('blob', new FsAdapter(blobDir));

  const adminKp = await QuCrypto.generateKeypair();
  const adminPub = QuCrypto.toBase64Url(adminKp.publicKey);
  const state = { transport: null };
  const adminHttp = new AdminHttp(qu, { adminPubs: [adminPub], storeDir, blobDir }, state);

  const httpServer = createServer((req, res) => {
    if (req.url === '/admin/settings' && req.method === 'POST') return adminHttp.handleSettings(req, res);
    if (req.url === '/admin/data/list' && req.method === 'POST') return adminHttp.handleDataList(req, res);
    if (req.url === '/admin/data/import' && req.method === 'POST') return adminHttp.handleDataImport(req, res);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  return {
    qu, adminKp, adminPub, state, adminHttp, port, base,
    teardown: async () => {
      await new Promise((resolve) => httpServer.close(resolve));
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function signedPost(env, path, actorPub, signKp, payloadField, payload) {
  const signature = QuCrypto.toBase64Url(await QuCrypto.sign(new TextEncoder().encode(JSON.stringify(payload)), signKp.privateKey));
  const res = await fetch(`http://localhost:${env.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorPub, [payloadField]: payload, signature }),
  });
  return { status: res.status, body: await res.json() };
}

test('POST /admin/settings with a valid admin signature persists and returns the merged settings', async () => {
  const env = await freshEnv();
  try {
    const { status, body } = await signedPost(env, '/admin/settings', env.adminPub, env.adminKp, 'settings', { defaultLocale: 'de' });
    assert.equal(status, 200);
    assert.equal(body.defaultLocale, 'de');
  } finally {
    await env.teardown();
  }
});

test('POST /admin/settings rejects an actorPub NOT in adminPubs', async () => {
  const env = await freshEnv();
  try {
    const outsiderKp = await QuCrypto.generateKeypair();
    const outsiderPub = QuCrypto.toBase64Url(outsiderKp.publicKey);
    const { status, body } = await signedPost(env, '/admin/settings', outsiderPub, outsiderKp, 'settings', { defaultLocale: 'de' });
    assert.equal(status, 403);
    assert.match(body.error, /not a configured relay admin/);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/settings rejects a signature that does not verify (wrong key signed it)', async () => {
  const env = await freshEnv();
  try {
    const wrongKp = await QuCrypto.generateKeypair(); // signs, but claims to be env.adminPub
    const { status, body } = await signedPost(env, '/admin/settings', env.adminPub, wrongKp, 'settings', { defaultLocale: 'de' });
    assert.equal(status, 403);
    assert.match(body.error, /signature does not verify/);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/settings rejects a signature that verifies a DIFFERENT payload than the one sent (tampered in transit)', async () => {
  const env = await freshEnv();
  try {
    const signature = QuCrypto.toBase64Url(await QuCrypto.sign(new TextEncoder().encode(JSON.stringify({ defaultLocale: 'en' })), env.adminKp.privateKey));
    const res = await fetch(`http://localhost:${env.port}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorPub: env.adminPub, settings: { defaultLocale: 'de' }, signature }), // settings changed after signing
    });
    assert.equal(res.status, 403);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/settings with a malformed body returns 400', async () => {
  const env = await freshEnv();
  try {
    const res = await fetch(`http://localhost:${env.port}/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorPub: env.adminPub }), // missing settings/signature
    });
    assert.equal(res.status, 400);
  } finally {
    await env.teardown();
  }
});

test('a rateLimits change in POST /admin/settings applies LIVE to a wired transport', async () => {
  const env = await freshEnv();
  try {
    const calls = [];
    env.state.transport = { setRateLimit: (n) => calls.push(n) };
    await signedPost(env, '/admin/settings', env.adminPub, env.adminKp, 'settings', { rateLimits: { maxMessagesPerMinute: 42 } });
    assert.deepEqual(calls, [42]);
  } finally {
    await env.teardown();
  }
});

test('a settings change with NO rateLimits field does not touch the transport', async () => {
  const env = await freshEnv();
  try {
    const calls = [];
    env.state.transport = { setRateLimit: (n) => calls.push(n) };
    await signedPost(env, '/admin/settings', env.adminPub, env.adminKp, 'settings', { defaultLocale: 'fr' });
    assert.deepEqual(calls, []);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/list finds a QuBit written through the real QuStore', async () => {
  const env = await freshEnv();
  try {
    await env.qu.put('/store/space/docs/d1', { title: 'hello' });
    const { status, body } = await signedPost(env, '/admin/data/list', env.adminPub, env.adminKp, 'query', { prefix: '/store' });
    assert.equal(status, 200);
    const entry = body.entries.find((e) => e.path === '/store/space/docs/d1');
    assert.equal(entry.value.val.title, 'hello');
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/list filters by the given prefix', async () => {
  const env = await freshEnv();
  try {
    await env.qu.put('/store/space/docs/d1', { title: 'in scope' });
    await env.qu.put('/store/other/docs/d2', { title: 'out of scope' });
    const { body } = await signedPost(env, '/admin/data/list', env.adminPub, env.adminKp, 'query', { prefix: '/store/space' });
    assert.deepEqual(body.entries.map((e) => e.path), ['/store/space/docs/d1']);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/list respects a limit and reports hasMore', async () => {
  const env = await freshEnv();
  try {
    for (let i = 0; i < 5; i++) await env.qu.put(`/store/space/docs/d${i}`, { i });
    const { body } = await signedPost(env, '/admin/data/list', env.adminPub, env.adminKp, 'query', { prefix: '/store', limit: 2 });
    assert.equal(body.entries.length, 2);
    assert.equal(body.total, 5);
    assert.equal(body.hasMore, true);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/list also covers /blob when explicitly requested', async () => {
  const env = await freshEnv();
  try {
    await env.qu.put('/blob/asset1/chunk0', { data: 'xyz' });
    const { body } = await signedPost(env, '/admin/data/list', env.adminPub, env.adminKp, 'query', { prefix: '/blob' });
    assert.equal(body.entries.some((e) => e.path === '/blob/asset1/chunk0'), true);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/list rejects a non-admin the same way settings does', async () => {
  const env = await freshEnv();
  try {
    const outsiderKp = await QuCrypto.generateKeypair();
    const { status } = await signedPost(env, '/admin/data/list', QuCrypto.toBase64Url(outsiderKp.publicKey), outsiderKp, 'query', {});
    assert.equal(status, 403);
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/import restores a QuBit EXACTLY as given (original ts/pub/sig preserved), bypassing normal put()', async () => {
  const env = await freshEnv();
  try {
    const originalQuBit = { path: '/store/space/docs/restored', val: { title: 'restored' }, ts: 12345, pub: 'somepub', sig: 'somesig' };
    const { status, body } = await signedPost(env, '/admin/data/import', env.adminPub, env.adminKp, 'entries', [{ path: originalQuBit.path, value: originalQuBit }]);
    assert.equal(status, 200);
    assert.equal(body.imported, 1);
    assert.equal(body.skipped, 0);

    const stored = await env.qu.get('/store/space/docs/restored');
    assert.equal(stored.ts, 12345); // NOT re-stamped with Date.now() - proves putSealed(), not put()
    assert.equal(stored.pub, 'somepub');
  } finally {
    await env.teardown();
  }
});

test('POST /admin/data/import skips malformed entries but still imports the valid ones, reporting counts', async () => {
  const env = await freshEnv();
  try {
    const entries = [
      { path: '/store/space/docs/good', value: { path: '/store/space/docs/good', val: { ok: true }, ts: 1, pub: null, sig: null } },
      { path: 'not-absolute', value: {} }, // invalid: doesn't start with '/'
      { path: '/store/space/docs/null-value', value: null }, // invalid: null value
    ];
    const { body } = await signedPost(env, '/admin/data/import', env.adminPub, env.adminKp, 'entries', entries);
    assert.equal(body.imported, 1);
    assert.equal(body.skipped, 2);
    assert.equal(body.total, 3);
  } finally {
    await env.teardown();
  }
});
