import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { ExtensionPointHost, listDefinedPoints } from '../src/extension-points.js';
import { QuEvents } from '@qu/core';

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

test('renderSlot(): a contributor from an admin-disabled app (enabled: false) contributes nothing', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'bookmarks', clientMainUrl: PLUGIN_B_URL, enabled: false, contributes: [{ point: 'content.actions', export: 'renderBookmark' }] },
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'content.actions', export: 'renderLike' }] },
  ));
  const container = document.createElement('div');
  await host.renderSlot('content.actions', container, { id: 'msg1' });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].dataset.contributorApp, 'likes');
});

test('collect(): a contributor from an admin-disabled app (enabled: false) contributes nothing', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'broken', clientMainUrl: PLUGIN_A_URL, enabled: false, contributes: [{ point: 'p', export: 'getMenuItems' }] },
  ));
  assert.deepEqual(await host.collect('p', { id: 'msg1' }), []);
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

test('renderSlot(): calling the same point twice does not double-register contributors (no duplicate DOM per call)', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'content.actions', export: 'renderLike' }] },
  ));
  const containerFirst = document.createElement('div');
  await host.renderSlot('content.actions', containerFirst, { id: 'msg1' });
  const containerSecond = document.createElement('div');
  await host.renderSlot('content.actions', containerSecond, { id: 'msg2' });

  assert.equal(containerFirst.children.length, 1);
  assert.equal(containerSecond.children.length, 1);
  assert.equal(containerSecond.querySelector('button').textContent, 'like:msg2');
});

test('a local host.events.on() handler runs alongside manifest-declared contributors for the same point - same shape as Core\'s QuEvents', async () => {
  const host = new ExtensionPointHost(apps(
    { name: 'likes', clientMainUrl: PLUGIN_A_URL, contributes: [{ point: 'content.actions', export: 'renderLike', order: 5 }] },
  ));
  host.events.on('content.actions', ({ container }) => {
    const span = document.createElement('span');
    span.textContent = 'local-addition';
    container.appendChild(span);
  }, { order: 0 });

  const container = document.createElement('div');
  await host.renderSlot('content.actions', container, { id: 'msg1' });

  assert.equal(container.children.length, 2);
  assert.equal(container.children[0].textContent, 'local-addition'); // order 0 before the contributor's order 5
});

test('a caller-supplied shared QuEvents instance is used instead of a private one', () => {
  const shared = new QuEvents();
  const host = new ExtensionPointHost(apps(), { events: shared });
  assert.equal(host.events, shared);
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
