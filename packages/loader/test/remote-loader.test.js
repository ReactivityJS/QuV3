import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Registry } from '@qu/foundation';
import { RemoteLoader } from '../src/remote-loader.js';

const MANIFEST_URL = 'https://packages.example.com/forum/manifest.quapp';
const MAIN_URL = 'https://packages.example.com/forum/index.js';

async function integrityOf(source) {
  return `sha256-${QuCrypto.toBase64(await QuCrypto.sha256(new TextEncoder().encode(source)))}`;
}

/** A minimal, self-contained ES module source (no relative imports - required, see remote-loader.js's own doc comment) that registers a service when loaded. */
function moduleSource(serviceName = 'test-service') {
  return `export async function register(qu, manifest, registry) { registry.registerService('${serviceName}', { loaded: true }); }`;
}

/** Temporarily replaces globalThis.fetch with one that serves fixed responses for given URLs. */
async function withRoutes(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route();
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, status = 200) {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(body, status = 200) {
  return () => new Response(body, { status, headers: { 'content-type': 'text/javascript' } });
}

test('loadRemote() fetches, verifies, and loads a well-formed signed-free remote package', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const registry = new Registry();
  const loader = new RemoteLoader({}, registry);

  await withRoutes(
    {
      [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity }),
      [MAIN_URL]: textResponse(source),
    },
    async () => {
      const mod = await loader.loadRemote(MANIFEST_URL);
      assert.equal(typeof mod.register, 'function');
    }
  );

  assert.equal(registry.getService('test-service').loaded, true);
  assert.equal(loader.isLoaded('forum'), true);
});

test('loadRemote() records the manifest and its origin URL', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const loader = new RemoteLoader({}, new Registry());

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity }), [MAIN_URL]: textResponse(source) },
    () => loader.loadRemote(MANIFEST_URL)
  );

  assert.equal(loader.getManifest('forum').name, 'forum');
  assert.equal(loader.getOriginUrl('forum'), MANIFEST_URL);
  assert.deepEqual(loader.listLoaded(), ['forum']);
  assert.deepEqual(loader.listManifests().map((m) => m.originUrl), [MANIFEST_URL]);
});

test('loadRemote() throws if the manifest has no "integrity" field - refuses unpinned code', async () => {
  const loader = new RemoteLoader({}, new Registry());
  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js' }) },
    async () => {
      await assert.rejects(() => loader.loadRemote(MANIFEST_URL), /no "integrity" field/);
    }
  );
});

test('loadRemote() throws when the fetched module bytes do not match the declared integrity hash', async () => {
  const loader = new RemoteLoader({}, new Registry());
  const wrongIntegrity = await integrityOf('export const x = 1;');
  await withRoutes(
    {
      [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity: wrongIntegrity }),
      [MAIN_URL]: textResponse(moduleSource()), // different bytes than what was hashed
    },
    async () => {
      await assert.rejects(() => loader.loadRemote(MANIFEST_URL), /integrity check failed/);
    }
  );
});

test('loadRemote() throws when the manifest fetch itself returns a non-OK status', async () => {
  const loader = new RemoteLoader({}, new Registry());
  await withRoutes({ [MANIFEST_URL]: jsonResponse({ error: 'not found' }, 404) }, async () => {
    await assert.rejects(() => loader.loadRemote(MANIFEST_URL), /HTTP 404/);
  });
});

test('loadRemote() throws when the main module fetch returns a non-OK status', async () => {
  const integrity = await integrityOf(moduleSource());
  const loader = new RemoteLoader({}, new Registry());
  await withRoutes(
    {
      [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity }),
      [MAIN_URL]: jsonResponse({ error: 'gone' }, 410),
    },
    async () => {
      await assert.rejects(() => loader.loadRemote(MANIFEST_URL), /HTTP 410/);
    }
  );
});

test('a second loadRemote() call for the same package returns the cached module without re-fetching', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const loader = new RemoteLoader({}, new Registry());
  let mainFetchCount = 0;

  await withRoutes(
    {
      [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity }),
      [MAIN_URL]: () => {
        mainFetchCount++;
        return textResponse(source)();
      },
    },
    async () => {
      await loader.loadRemote(MANIFEST_URL);
      await loader.loadRemote(MANIFEST_URL);
    }
  );

  assert.equal(mainFetchCount, 1);
});

test('forceReload: true genuinely re-fetches (bypasses the cache) instead of returning the cached module', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const loader = new RemoteLoader({}, new Registry());
  let mainFetchCount = 0;

  await withRoutes(
    {
      [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity }),
      [MAIN_URL]: () => {
        mainFetchCount++;
        return textResponse(source)();
      },
    },
    async () => {
      await loader.loadRemote(MANIFEST_URL);
      // Registry.registerService() rejects a duplicate name (see registry.js's
      // own "no silent collisions" invariant) - forceReload re-runs the
      // module's register() against the SAME Registry, which already has
      // 'test-service', so this throws. The fetch still genuinely happened a
      // second time (mainFetchCount below), proving forceReload bypassed the
      // cache rather than short-circuiting like the no-forceReload case does.
      await assert.rejects(() => loader.loadRemote(MANIFEST_URL, { forceReload: true }), /already registered/);
    }
  );

  assert.equal(mainFetchCount, 2);
});

// ===== signature verification =======================================================

test('an UNSIGNED manifest loads fine with no trustedPublisherPubs given', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const loader = new RemoteLoader({}, new Registry());
  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity }), [MAIN_URL]: textResponse(source) },
    () => loader.loadRemote(MANIFEST_URL)
  );
  assert.equal(loader.isLoaded('forum'), true);
});

test('a SIGNED manifest with no trustedPublisherPubs given loads anyway (warns, does not verify)', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const kp = await QuCrypto.generateKeypair();
  const signature = QuCrypto.toBase64Url(await QuCrypto.sign(new TextEncoder().encode(source), kp.privateKey));
  const loader = new RemoteLoader({}, new Registry());

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity, signature }), [MAIN_URL]: textResponse(source) },
    () => loader.loadRemote(MANIFEST_URL) // no trustedPublisherPubs passed
  );
  assert.equal(loader.isLoaded('forum'), true);
});

test('a SIGNED manifest verifying against a trusted publisher key loads successfully', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const kp = await QuCrypto.generateKeypair();
  const pub = QuCrypto.toBase64Url(kp.publicKey);
  const signature = QuCrypto.toBase64Url(await QuCrypto.sign(new TextEncoder().encode(source), kp.privateKey));
  const loader = new RemoteLoader({}, new Registry());

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity, signature }), [MAIN_URL]: textResponse(source) },
    () => loader.loadRemote(MANIFEST_URL, { trustedPublisherPubs: [pub] })
  );
  assert.equal(loader.isLoaded('forum'), true);
});

test('REGRESSION: a SIGNED manifest whose signature does NOT match any trusted publisher is rejected', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const realKp = await QuCrypto.generateKeypair();
  const impostorKp = await QuCrypto.generateKeypair(); // signs, but we only trust realKp's pub
  const signature = QuCrypto.toBase64Url(await QuCrypto.sign(new TextEncoder().encode(source), impostorKp.privateKey));
  const loader = new RemoteLoader({}, new Registry());

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity, signature }), [MAIN_URL]: textResponse(source) },
    async () => {
      await assert.rejects(
        () => loader.loadRemote(MANIFEST_URL, { trustedPublisherPubs: [QuCrypto.toBase64Url(realKp.publicKey)] }),
        /does not match any trusted publisher/
      );
    }
  );
  assert.equal(loader.isLoaded('forum'), false);
});

test('a signature verifying against ANY one of multiple trustedPublisherPubs is accepted', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const kp = await QuCrypto.generateKeypair();
  const otherKp = await QuCrypto.generateKeypair();
  const signature = QuCrypto.toBase64Url(await QuCrypto.sign(new TextEncoder().encode(source), kp.privateKey));
  const loader = new RemoteLoader({}, new Registry());

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity, signature }), [MAIN_URL]: textResponse(source) },
    () => loader.loadRemote(MANIFEST_URL, { trustedPublisherPubs: [QuCrypto.toBase64Url(otherKp.publicKey), QuCrypto.toBase64Url(kp.publicKey)] })
  );
  assert.equal(loader.isLoaded('forum'), true);
});

// ===== requires (never auto-resolved remotely) =======================================

test('REGRESSION: a remote package\'s "requires" that is NOT already registered is rejected, never fetched transitively', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const loader = new RemoteLoader({}, new Registry());

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity, requires: ['document-service'] }) },
    async () => {
      await assert.rejects(() => loader.loadRemote(MANIFEST_URL), /requires "document-service"/);
    }
  );
  assert.equal(loader.isLoaded('forum'), false);
});

test('a remote package\'s "requires" that IS already registered locally loads successfully', async () => {
  const source = moduleSource();
  const integrity = await integrityOf(source);
  const registry = new Registry();
  registry.registerService('document-service', {}); // already satisfied locally
  const loader = new RemoteLoader({}, registry);

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity, requires: ['document-service'] }), [MAIN_URL]: textResponse(source) },
    () => loader.loadRemote(MANIFEST_URL)
  );
  assert.equal(loader.isLoaded('forum'), true);
});

// ===== provides warning ===============================================================

test('a manifest declaring "provides" a name it never actually registered logs a warning but still loads', async () => {
  const source = `export async function register() { /* registers nothing */ }`;
  const integrity = await integrityOf(source);
  const loader = new RemoteLoader({}, new Registry());

  await withRoutes(
    { [MANIFEST_URL]: jsonResponse({ name: 'forum', version: '1.0.0', main: './index.js', integrity, provides: ['forum-engine'] }), [MAIN_URL]: textResponse(source) },
    () => loader.loadRemote(MANIFEST_URL)
  );
  assert.equal(loader.isLoaded('forum'), true); // still loaded despite the broken promise - a warning, not a hard failure
});
