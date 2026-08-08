import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLocalPackages } from '../src/discover.js';

async function freshBaseDir() {
  const base = await mkdtemp(join(tmpdir(), 'qu-discover-'));
  return { base, teardown: () => rm(base, { recursive: true, force: true }) };
}

async function writeManifest(base, name, manifest) {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.quapp'), JSON.stringify(manifest));
  return dir;
}

test('discoverLocalPackages() of a directory that does not exist returns an empty array', async () => {
  assert.deepEqual(await discoverLocalPackages('/nonexistent/path/xyz'), []);
});

test('discoverLocalPackages() finds a package with a valid manifest.quapp', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await writeManifest(base, 'forum', { name: 'forum', version: '1.0.0', main: './index.js' });
    const found = await discoverLocalPackages(base);
    assert.equal(found.length, 1);
    assert.equal(found[0].manifest.name, 'forum');
    assert.equal(found[0].dir, join(base, 'forum'));
  } finally {
    await teardown();
  }
});

test('discoverLocalPackages() finds MULTIPLE packages, one per subdirectory', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await writeManifest(base, 'forum', { name: 'forum', version: '1.0.0', main: './index.js' });
    await writeManifest(base, 'chat', { name: 'chat', version: '1.0.0', main: './index.js' });
    const found = await discoverLocalPackages(base);
    assert.deepEqual(found.map((f) => f.manifest.name).sort(), ['chat', 'forum']);
  } finally {
    await teardown();
  }
});

test('a subdirectory with no manifest.quapp is silently skipped', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await mkdir(join(base, 'not-a-package'), { recursive: true });
    await writeFile(join(base, 'not-a-package', 'readme.txt'), 'hello');
    assert.deepEqual(await discoverLocalPackages(base), []);
  } finally {
    await teardown();
  }
});

test('a subdirectory with an INVALID manifest.quapp is skipped (with a warning), not thrown', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await writeManifest(base, 'broken', { name: 'broken' }); // missing required "version"/"main"
    await writeManifest(base, 'good', { name: 'good', version: '1.0.0', main: './index.js' });
    const found = await discoverLocalPackages(base);
    assert.deepEqual(found.map((f) => f.manifest.name), ['good']);
  } finally {
    await teardown();
  }
});

test('a plain file (not a directory) at the top level is ignored', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    await writeFile(join(base, 'stray-file.txt'), 'hello');
    assert.deepEqual(await discoverLocalPackages(base), []);
  } finally {
    await teardown();
  }
});

test('an empty directory returns an empty array', async () => {
  const { base, teardown } = await freshBaseDir();
  try {
    assert.deepEqual(await discoverLocalPackages(base), []);
  } finally {
    await teardown();
  }
});
