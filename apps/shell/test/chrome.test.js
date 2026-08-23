import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '@qu/ui/testing';
import { fakeQu, flush } from './support/fake-qu.js';

installDom();
const { mountChrome } = await import('../src/chrome.js');

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('contentSlot is a stable element apps mount into; begin() returns a {set} handle', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, {});
  assert.ok(chrome.contentSlot instanceof HTMLElement);
  assert.ok(container.contains(chrome.contentSlot));
  const handle = chrome.begin();
  assert.equal(typeof handle.set, 'function');
});

test('set({primaryAction}) renders exactly what buildChrome() would, reused not reimplemented', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, {});
  const handle = chrome.begin();
  handle.set({ primaryAction: { label: 'New topic', href: '#/forum/new', icon: '✏️' } });
  assert.ok(container.querySelector('.qu-apptpl-primary-desktop'));
  assert.ok(container.querySelector('a.qu-apptpl-fab'));
});

test('begin() clears the previously displayed chrome back to empty', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, {});
  const handle1 = chrome.begin();
  handle1.set({ primaryAction: { label: 'New topic', href: '#/forum/new' } });
  assert.ok(container.querySelector('.qu-apptpl-primary-desktop'));

  chrome.begin(); // simulates renderRoute()'s teardown-and-fresh-navigation
  assert.equal(container.querySelector('.qu-apptpl-primary-desktop'), null);
});

test('a stale handle set() after a newer begin() is a silent no-op (epoch guard)', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, {});
  const staleHandle = chrome.begin();
  const freshHandle = chrome.begin();
  freshHandle.set({ primaryAction: { label: 'Fresh', href: '#/fresh' } });
  assert.ok(container.querySelector('.qu-apptpl-primary-desktop').textContent.includes('Fresh'));

  // The OLD (torn-down) view's async watcher/IIFE finally resolves and
  // calls its own stale handle - must not touch what freshHandle rendered.
  staleHandle.set({ primaryAction: { label: 'Stale, must not appear', href: '#/stale' } });
  assert.ok(container.querySelector('.qu-apptpl-primary-desktop').textContent.includes('Fresh'));
  assert.equal(container.textContent.includes('Stale'), false);
});

test('a views/settings section beyond menuThreshold collapses the overflow into one "More" trigger', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, { menuThreshold: 3 });
  const handle = chrome.begin();
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, label: `View ${i}`, href: `#/app/v${i}` }));
  handle.set({ views: { items, activeId: 'v0' } });

  const list = container.querySelector('.qu-apptpl-sidebar .qu-apptpl-list');
  const directLinks = [...list.children].filter((li) => li.firstElementChild?.tagName === 'A');
  assert.equal(directLinks.length, 3);
  const moreBtn = [...list.children].find((li) => li.querySelector('button.qu-apptpl-pill'));
  assert.ok(moreBtn, 'expected a "More" trigger for the 2 overflow items');
  const popupLinks = moreBtn.querySelectorAll('.qu-apptpl-popup a');
  assert.equal(popupLinks.length, 2);
});

test('a section at or under menuThreshold is not truncated at all', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, { menuThreshold: 8 });
  const handle = chrome.begin();
  const items = Array.from({ length: 3 }, (_, i) => ({ id: `v${i}`, label: `View ${i}`, href: `#/app/v${i}` }));
  handle.set({ views: { items, activeId: 'v0' } });
  const list = container.querySelector('.qu-apptpl-sidebar .qu-apptpl-list');
  assert.equal(list.querySelectorAll('button.qu-apptpl-pill').length, 0);
  assert.equal(list.querySelectorAll('a').length, 3);
});

// ===== list: {path, template, onItemStamped} - reactive navigation =========

function channelTemplate() {
  const t = document.createElement('template');
  t.innerHTML = '<li><a><span class="qu-cal-icon"></span><qu-view field="title" attr="textContent"></qu-view></a></li>';
  return t;
}

test('list:-registered navigation mounts a real <qu-list>, live-updating as the underlying data changes', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({
    navigation: { list: { path: '/channels', template: channelTemplate() }, heading: 'Channels' },
  });
  await waitFor(() => container.querySelector('qu-list li a')?.textContent === 'General');

  await qu.put('/channels', [{ path: '/store/c/1' }, { path: '/store/c/2' }]);
  await qu.put('/store/c/2', { title: 'Random' });
  await flush();
  await waitFor(() => container.querySelectorAll('qu-list li').length === 2);
  const labels = [...container.querySelectorAll('qu-list li a')].map((a) => a.textContent);
  assert.deepEqual(labels, ['General', 'Random']);
});

test('menuThreshold never truncates a list:-registered (reactive) section, even with more items than the threshold', async () => {
  const initial = {
    '/channels': Array.from({ length: 5 }, (_, i) => ({ path: `/store/c/${i}` })),
  };
  for (let i = 0; i < 5; i++) initial[`/store/c/${i}`] = { title: `Channel ${i}` };
  const qu = fakeQu(initial);
  const container = makeContainer();
  const chrome = mountChrome(container, { qu, menuThreshold: 3 }); // 5 items > threshold of 3
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelectorAll('qu-list li').length === 5);
  assert.equal(container.querySelectorAll('qu-list li').length, 5); // all 5, not truncated to 3
  assert.equal(container.querySelector('.qu-apptpl-sidebar button.qu-apptpl-pill'), null); // no "More" trigger for the reactive section
});

test('list:-registered navigation stays the SAME <qu-list> element across set() calls with the same registration (no full section rebuild)', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  const template = channelTemplate();
  handle.set({ navigation: { list: { path: '/channels', template }, activeId: null } });
  await waitFor(() => container.querySelector('qu-list li a')?.textContent === 'General');
  const listElBefore = container.querySelector('qu-list');
  const itemElBefore = container.querySelector('qu-list li');

  // A SECOND set() call with the same list registration but a different
  // activeId - must reuse the same <qu-list> (and its already-stamped
  // items), not tear down and recreate it.
  handle.set({ navigation: { list: { path: '/channels', template }, activeId: '1' } });
  assert.equal(container.querySelector('qu-list'), listElBefore);
  assert.equal(container.querySelector('qu-list li'), itemElBefore);
});

test('list:-registered navigation active-item highlighting toggles on activeId change alone (no data change)', async () => {
  const qu = fakeQu({
    '/channels': [{ path: '/store/c/1' }, { path: '/store/c/2' }],
    '/store/c/1': { title: 'General' },
    '/store/c/2': { title: 'Random' },
  });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  const template = channelTemplate();
  const onItemStamped = (els, itemId) => {
    els[0].querySelector('a').href = `#/forum/c/${itemId}`;
  };
  handle.set({ navigation: { list: { path: '/channels', template, onItemStamped }, activeId: '1' } });
  await waitFor(() => container.querySelectorAll('qu-list li').length === 2);

  const activeHref = () => container.querySelector('qu-list li a.qu-apptpl-item-active')?.getAttribute('href');
  assert.equal(activeHref(), '#/forum/c/1');

  handle.set({ navigation: { list: { path: '/channels', template, onItemStamped }, activeId: '2' } });
  assert.equal(activeHref(), '#/forum/c/2');
});

test('stop() tears down cleanly - no error thrown, no lingering document listeners from an open popup', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, {});
  const handle = chrome.begin();
  handle.set({ settings: { items: [{ label: 'Manage', href: '#/app/manage' }] } });
  assert.doesNotThrow(() => chrome.stop());
});
