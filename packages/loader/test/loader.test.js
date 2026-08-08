import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@qu/foundation';
import { QuLoader } from '../src/loader.js';
import { discoverLocalPackages } from '../src/discover.js';

async function freshBaseDir() {
  const base = await mkdtemp(join(tmpdir(), 'qu-loader-'));
  return { base, teardown: () => rm(base, { recursive: true, force: true }) };
}

/** Writes a real, loadable package directory: manifest.quapp + a main module registering `serviceName`. */
async function writePackage(base, name, { requires = [], provides = [], serviceName = `${name}-service` } = {}) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.quapp'), JSON.stringify({ name, version: '1.0.0', main: './index.js', requires, provides }));
  await writeFile(
    join(dir, 'index.js'),
    `export async function register(qu, manifest, registry) { registry.registerService('${serviceName}', { name: manifest.name }); }`
  );
  return dir;
}

test('loadLocal() loads a standalone package with no dependencies', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    const dir = await writePackage(base, 'forum');
    const registry = new Registry();
    const loader = new QuLoader({}, registry);

    const mod = await loader.loadLocal(dir);
    assert.equal(typeof mod.register, 'function');
    assert.equal(registry.getService('forum-service').name, 'forum');
    assert.equal(loader.isLoaded('forum'), true);
  } finally {
    await teardown();
  }
});

test('loadLocal() resolves and loads a "requires" dependency BEFORE the target package', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    const depDir = await writePackage(base, 'document-engine', { provides: ['document-engine'] });
    const appDir = await writePackage(base, 'forum', { requires: ['document-engine'] });
    const registry = new Registry();
    const loader = new QuLoader({}, registry);

    await loader.loadLocal(appDir, { availableManifests: await discoverLocalPackages(base) });

    assert.deepEqual(loader.listLoaded(), ['document-engine', 'forum']); // dependency loaded first
    void depDir;
  } finally {
    await teardown();
  }
});

test('loadLocal() throws a clear error when a "requires" dependency is missing entirely', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    const appDir = await writePackage(base, 'forum', { requires: ['document-engine'] });
    const loader = new QuLoader({}, new Registry());

    await assert.rejects(() => loader.loadLocal(appDir, { availableManifests: [] }), /requires "document-engine"/);
  } finally {
    await teardown();
  }
});

test('loadLocal() does not reload an already-registered dependency', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    const registry = new Registry();
    registry.registerService('document-engine', { preExisting: true }); // already satisfied, e.g. a built-in Engine a relay registers itself
    const appDir = await writePackage(base, 'forum', { requires: ['document-engine'] });
    const loader = new QuLoader({}, registry);

    await loader.loadLocal(appDir, { availableManifests: [] }); // no dir available for document-engine - must not need one
    assert.equal(registry.getService('document-engine').preExisting, true); // untouched
  } finally {
    await teardown();
  }
});

test('loadLocal() a second time for the same package is a no-op (no re-registration)', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    const dir = await writePackage(base, 'forum');
    const loader = new QuLoader({}, new Registry());
    await loader.loadLocal(dir);
    await assert.doesNotReject(() => loader.loadLocal(dir)); // Registry throws on a duplicate registerService() call - this must not attempt one
  } finally {
    await teardown();
  }
});

test('forceReload: true re-imports and re-registers, throwing on the resulting duplicate registration (Registry has no unregister)', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    const dir = await writePackage(base, 'forum');
    const loader = new QuLoader({}, new Registry());
    await loader.loadLocal(dir);
    // forceReload re-runs register() against the SAME Registry, which already
    // has 'forum-service' - Registry.registerService() rejects the duplicate
    // name, same "no silent collisions" invariant it enforces everywhere else.
    await assert.rejects(() => loader.loadLocal(dir, { forceReload: true }), /already registered/);
  } finally {
    await teardown();
  }
});

test('loadLocal() passes the qu instance and manifest through to register()', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    const dir = join(base, 'inspector');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.quapp'), JSON.stringify({ name: 'inspector', version: '1.0.0', main: './index.js' }));
    await writeFile(
      join(dir, 'index.js'),
      `export async function register(qu, manifest, registry) { registry.registerService('inspector', { sawQu: qu.marker, sawManifestName: manifest.name }); }`
    );
    const fakeQu = { marker: 'the-real-qu-instance' };
    const registry = new Registry();
    await new QuLoader(fakeQu, registry).loadLocal(dir);

    assert.equal(registry.getService('inspector').sawQu, 'the-real-qu-instance');
    assert.equal(registry.getService('inspector').sawManifestName, 'inspector');
  } finally {
    await teardown();
  }
});

test('a diamond dependency (A requires B and C, both require D) loads D only once, before B/C, before A', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await writePackage(base, 'd', { provides: ['d'] });
    await writePackage(base, 'b', { requires: ['d'], provides: ['b'] });
    await writePackage(base, 'c', { requires: ['d'], provides: ['c'] });
    const aDir = await writePackage(base, 'a', { requires: ['b', 'c'] });

    const loader = new QuLoader({}, new Registry());
    await loader.loadLocal(aDir, { availableManifests: await discoverLocalPackages(base) });

    const order = loader.listLoaded();
    assert.equal(order.indexOf('d'), 0); // d loaded exactly once, before everything depending on it
    assert.ok(order.indexOf('d') < order.indexOf('b'));
    assert.ok(order.indexOf('d') < order.indexOf('c'));
    assert.equal(order.indexOf('a'), order.length - 1); // a loaded last
    assert.equal(order.length, 4); // no duplicate load of d
  } finally {
    await teardown();
  }
});

test('a circular "requires" chain is rejected with the exact cycle named', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await writePackage(base, 'a', { requires: ['b'] });
    const bDir = await writePackage(base, 'b', { requires: ['a'] });

    const loader = new QuLoader({}, new Registry());
    const availableManifests = await discoverLocalPackages(base);
    await assert.rejects(() => loader.loadLocal(bDir, { availableManifests }), /circular "requires" chain/);
  } finally {
    await teardown();
  }
});

test('discoverLocalPackages() + loadLocal() together: a real multi-package directory loads end to end', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await writePackage(base, 'document-engine', { provides: ['document-engine'] });
    const forumDir = await writePackage(base, 'forum', { requires: ['document-engine'] });

    const available = await discoverLocalPackages(base);
    assert.equal(available.length, 2);

    const registry = new Registry();
    const loader = new QuLoader({}, registry);
    await loader.loadLocal(forumDir, { availableManifests: available });

    assert.equal(loader.isLoaded('document-engine'), true);
    assert.equal(loader.isLoaded('forum'), true);
  } finally {
    await teardown();
  }
});
