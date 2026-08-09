import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ExtensionPointHost, listDefinedPoints } from '../src/extension-points.js';
import { HookBus } from '../src/hooks.js';

// renderSlot() calls document.createElement - a minimal DOM is enough here,
// unlike @qu/ui's own installDom() this doesn't need HTMLElement/
// customElements (extension-points.js defines no Custom Elements).
globalThis.document = new JSDOM('<!doctype html><html><body></body></html>').window.document;

const PLUGIN_A_URL = new URL('./fixtures/plugin-a.js', import.meta.url).href;
const PLUGIN_B_URL = new URL('./fixtures/plugin-b.js', import.meta.url).href;

function apps(...entries) {
  return entries;
}

test('renderSlot(): every contributor for the point mounts its own DOM into its own child container, in order', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'bookmarks', clientMainUrl: PLUGIN_B_URL, contributes: [{ point: 'content.actions', export: 'renderBookmark', order: 10 }] },
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'content.actions', export: 'renderLike', order: 0 }] },
  ));
  const container = document.createElement('div');
  await host.renderSlot('content.actions', container, { id: 'msg1' });

  assert.equal(container.children.length, 2);
  // "likes" has order 0, "bookmarks" order 10 - likes renders first regardless of catalog array order.
  assert.equal(container.children[0].dataset.contributorApp, 'likes');
  assert.equal(container.children[0].querySelector('button').textContent, 'like:msg1');
  assert.equal(container.children[1].dataset.contributorApp, 'bookmarks');
  assert.equal(container.children[1].querySelector('button').textContent, 'bookmark:msg1');
});

test('renderSlot(): a different point id sees only ITS OWN contributors', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'content.actions', export: 'renderLike' }] },
  ));
  const container = document.createElement('div');
  await host.renderSlot('some.other.point', container, { id: 'msg1' });
  assert.equal(container.children.length, 0);
});

test('renderSlot(): a contributor throwing is isolated - removed from the DOM, other contributors unaffected', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'broken', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'content.actions', export: 'throwingRender', order: 0 }] },
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'content.actions', export: 'renderLike', order: 1 }] },
  ));
  const container = document.createElement('div');
  await host.renderSlot('content.actions', container, { id: 'msg1' });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].dataset.contributorApp, 'likes');
});

test('renderSlot(): a contributor whose module fails to load is skipped without creating any DOM for it', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'missing', clientMainUrl: new URL('./fixtures/does-not-exist.js', import.meta.url).href, contributes: [{ point: 'content.actions', export: 'render' }] },
  ));
  const container = document.createElement('div');
  await host.renderSlot('content.actions', container, { id: 'msg1' });
  assert.equal(container.children.length, 0);
});

test('collect(): gathers every contributor\'s items, tagged with appId, sorted by order', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'bookmarks', clientMainUrl: PLUGIN_B_URL, contributes: [{ point: 'contextMenu.forumMessage', export: 'getMenuItems', order: 10 }] },
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'contextMenu.forumMessage', export: 'getMenuItems', order: 0 }] },
  ));
  const items = await host.collect('contextMenu.forumMessage', { id: 'msg1' });

  assert.deepEqual(items, [
    { id: 'like', label: 'Like msg1', appId: 'likes' },
    { id: 'bookmark', label: 'Bookmark msg1', appId: 'bookmarks' },
  ]);
});

test('collect(): a throwing contributor is skipped, others still contribute', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'broken', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'p', export: 'throwingCollect', order: 0 }] },
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'p', export: 'getMenuItems', order: 1 }] },
  ));
  const items = await host.collect('p', { id: 'msg1' });
  assert.deepEqual(items, [{ id: 'like', label: 'Like msg1', appId: 'likes' }]);
});

test('run(): manifest-declared contributors are lazily registered onto the underlying HookBus and run with its sequential+patching semantics', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'thread.beforePostMessage', export: 'onBeforeSave', order: 0 }] },
    { name: 'bookmarks', clientMainUrl: PLUGIN_B_URL, contributes: [{ point: 'thread.beforePostMessage', export: 'onBeforeSave', order: 1 }] },
  ));
  const result = await host.run('thread.beforePostMessage', { body: 'hi', order: [] });

  assert.equal(result.seenByA, true);
  assert.equal(result.seenByB, true);
  assert.deepEqual(result.order, ['a', 'b']); // order 0 (likes) ran before order 1 (bookmarks)
  assert.equal(result.body, 'hi'); // untouched fields survive the merge
});

test('run(): a point with no contributors returns the payload unchanged', async () => {
  const host = new ExtensionPointHost(apps());
  const result = await host.run('nothing.registered', { a: 1 });
  assert.deepEqual(result, { a: 1 });
});

test('notify(): manifest-declared contributors run as side effects; calling twice runs them exactly twice (no duplicate registration)', async () => {
  globalThis.__pluginASideEffects = 0;
  const host = new ExtensionPointHost(apps(
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'notification.dispatch', export: 'sideEffect' }] },
  ));
  await host.notify('notification.dispatch', {});
  await host.notify('notification.dispatch', {});
  assert.equal(globalThis.__pluginASideEffects, 2);
});

test('a local host.hooks.on() handler runs alongside manifest-declared contributors for the same point', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'thread.beforePostMessage', export: 'onBeforeSave', order: 5 }] },
  ));
  host.hooks.on('thread.beforePostMessage', (payload) => ({ seenLocally: true, order: [...(payload.order ?? []), 'local'] }), { order: 0 });

  const result = await host.run('thread.beforePostMessage', { order: [] });
  assert.equal(result.seenLocally, true);
  assert.equal(result.seenByA, true);
  assert.deepEqual(result.order, ['local', 'a']);
});

test('listDefinedPoints(): discovers every declared point across the catalog, tagged with who defined it', () => {
  const found = listDefinedPoints(apps(
    { name: 'forum', definesExtensionPoints: [{ point: 'content.messageActions', kind: 'ui', description: 'extra action buttons per forum message' }] },
    { name: 'thread-engine', definesExtensionPoints: [{ point: 'thread.beforePostMessage', kind: 'hook' }] },
    { name: 'no-definitions-app' },
  ));

  assert.deepEqual(found, [
    { point: 'content.messageActions', kind: 'ui', description: 'extra action buttons per forum message', definedBy: 'forum' },
    { point: 'thread.beforePostMessage', kind: 'hook', description: null, definedBy: 'thread-engine' },
  ]);
});

test('listDefinedPoints(): an empty/omitted catalog yields an empty list', () => {
  assert.deepEqual(listDefinedPoints(undefined), []);
  assert.deepEqual(listDefinedPoints([]), []);
});

test('a caller-supplied shared HookBus is used instead of a private one', async () => {
  const shared = new HookBus();
  shared.on('x', () => ({ fromShared: true }));
  const host = new ExtensionPointHost(apps(), { hooks: shared });
  assert.equal(host.hooks, shared);

  const result = await host.run('x', {});
  assert.equal(result.fromShared, true);
});
