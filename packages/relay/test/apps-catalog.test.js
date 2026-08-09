import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppsCatalog } from '../src/apps-catalog.js';

function fakeLoader(entries) {
  return { listManifests: () => entries };
}

test('an app with no clientMain is omitted (nothing for a shell to mount)', () => {
  const loader = fakeLoader([{ manifest: { name: 'document-engine', version: '1.0.0', main: './index.js' }, originUrl: null }]);
  assert.deepEqual(buildAppsCatalog(loader), []);
});

test('a loaded local app with a clientMain gets a full catalog entry', () => {
  const loader = fakeLoader([
    { manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js', label: 'Forum', icon: '💬', navOrder: 10 }, originUrl: null },
  ]);
  const [entry] = buildAppsCatalog(loader);
  assert.equal(entry.name, 'forum');
  assert.equal(entry.label, 'Forum');
  assert.equal(entry.icon, '💬');
  assert.equal(entry.navOrder, 10);
  assert.equal(entry.enabled, true);
});

test('spaceId is passed through when the manifest declares one; undefined otherwise', () => {
  const loader = fakeLoader([
    { manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js', spaceId: '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1' }, originUrl: null },
    { manifest: { name: 'app-list', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null },
  ]);
  const [forum, appList] = buildAppsCatalog(loader);
  assert.equal(forum.spaceId, '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1');
  assert.equal(appList.spaceId, undefined);
});

test('label defaults to name when the manifest omits it', () => {
  const loader = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null }]);
  assert.equal(buildAppsCatalog(loader)[0].label, 'forum');
});

test('a local app\'s clientMainUrl resolves to /apps/<name>/<clientMain>, stripping a leading "./"', () => {
  const loader = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './dist/client.js' }, originUrl: null }]);
  assert.equal(buildAppsCatalog(loader)[0].clientMainUrl, '/apps/forum/dist/client.js');
});

test('a REMOTE app\'s clientMainUrl resolves relative to its manifest\'s originUrl', () => {
  const loader = fakeLoader([
    { manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: 'https://packages.example.com/forum/manifest.quapp' },
  ]);
  assert.equal(buildAppsCatalog(loader)[0].clientMainUrl, 'https://packages.example.com/forum/client.js');
});

test('disabledAppNames marks a matching app enabled: false without removing it', () => {
  const loader = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null }]);
  const [entry] = buildAppsCatalog(loader, ['forum']);
  assert.equal(entry.enabled, false);
});

test('disabledAppNames does not affect a DIFFERENT app', () => {
  const loader = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null }]);
  const [entry] = buildAppsCatalog(loader, ['chat']);
  assert.equal(entry.enabled, true);
});

test('pushActions and actions default to empty arrays when the manifest omits them', () => {
  const loader = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null }]);
  const [entry] = buildAppsCatalog(loader);
  assert.deepEqual(entry.pushActions, []);
  assert.deepEqual(entry.actions, []);
});

test('pushActions and actions are passed through verbatim when present', () => {
  const pushActions = [{ id: 'mention', label: 'Mentions', type: 'mention' }];
  const actions = [{ slot: 'contact-row', id: 'chat', label: 'Chat', hrefTemplate: '#/chat/{pub}' }];
  const loader = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js', pushActions, actions }, originUrl: null }]);
  const [entry] = buildAppsCatalog(loader);
  assert.deepEqual(entry.pushActions, pushActions);
  assert.deepEqual(entry.actions, actions);
});

test('contributes and definesExtensionPoints default to empty arrays when the manifest omits them; passed through verbatim when present', () => {
  const loader = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null }]);
  const [empty] = buildAppsCatalog(loader);
  assert.deepEqual(empty.contributes, []);
  assert.deepEqual(empty.definesExtensionPoints, []);

  const contributes = [{ point: 'content.messageActions', export: 'renderLikeButton' }];
  const definesExtensionPoints = [{ point: 'content.messageActions', kind: 'ui' }];
  const loader2 = fakeLoader([{ manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js', contributes, definesExtensionPoints }, originUrl: null }]);
  const [entry] = buildAppsCatalog(loader2);
  assert.deepEqual(entry.contributes, contributes);
  assert.deepEqual(entry.definesExtensionPoints, definesExtensionPoints);
});

test('clientIntegrity/clientSignature are passed through for a signed remote app', () => {
  const loader = fakeLoader([
    {
      manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js', clientIntegrity: 'sha256-abc', clientSignature: 'sig123' },
      originUrl: 'https://packages.example.com/forum/manifest.quapp',
    },
  ]);
  const [entry] = buildAppsCatalog(loader);
  assert.equal(entry.clientIntegrity, 'sha256-abc');
  assert.equal(entry.clientSignature, 'sig123');
});

test('multiple apps produce one catalog entry each, in load order', () => {
  const loader = fakeLoader([
    { manifest: { name: 'forum', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null },
    { manifest: { name: 'chat', version: '1.0.0', main: './index.js', clientMain: './client.js' }, originUrl: null },
  ]);
  assert.deepEqual(buildAppsCatalog(loader).map((e) => e.name), ['forum', 'chat']);
});
