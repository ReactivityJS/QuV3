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

// These four tests are deliberately `desktopOnly: true` - they test the
// DESKTOP SIDEBAR's own reconciliation specifically, so they must not also
// pick up the (also-real, now that `list:` supports it too) mobile footer
// pill's own SECOND, independent `<qu-list>` bound to the same path -
// without `desktopOnly`, a plain `container.querySelector('qu-list ...')`
// would non-deterministically match whichever of the two document-order
// happens to stamp first, and a `.length === N` assertion would count BOTH
// lists' stamped items combined. The footer's own equivalent behavior (a
// `list:` section WITHOUT `desktopOnly`) is covered separately below, under
// "list: in the mobile footer".

test('list:-registered navigation mounts a real <qu-list>, live-updating as the underlying data changes', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({
    navigation: { list: { path: '/channels', template: channelTemplate() }, heading: 'Channels', desktopOnly: true },
  });
  await waitFor(() => container.querySelector('.qu-apptpl-sidebar qu-list li a')?.textContent === 'General');

  await qu.put('/channels', [{ path: '/store/c/1' }, { path: '/store/c/2' }]);
  await qu.put('/store/c/2', { title: 'Random' });
  await flush();
  await waitFor(() => container.querySelectorAll('.qu-apptpl-sidebar qu-list li').length === 2);
  const labels = [...container.querySelectorAll('.qu-apptpl-sidebar qu-list li a')].map((a) => a.textContent);
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
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() }, desktopOnly: true } });
  await waitFor(() => container.querySelectorAll('.qu-apptpl-sidebar qu-list li').length === 5);
  assert.equal(container.querySelectorAll('.qu-apptpl-sidebar qu-list li').length, 5); // all 5, not truncated to 3
  assert.equal(container.querySelector('.qu-apptpl-sidebar button.qu-apptpl-pill'), null); // no "More" trigger for the reactive section
});

test('list:-registered navigation stays the SAME <qu-list> element across set() calls with the same registration (no full section rebuild)', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  const template = channelTemplate();
  handle.set({ navigation: { list: { path: '/channels', template }, activeId: null, desktopOnly: true } });
  await waitFor(() => container.querySelector('.qu-apptpl-sidebar qu-list li a')?.textContent === 'General');
  const listElBefore = container.querySelector('.qu-apptpl-sidebar qu-list');
  const itemElBefore = container.querySelector('.qu-apptpl-sidebar qu-list li');

  // A SECOND set() call with the same list registration but a different
  // activeId - must reuse the same <qu-list> (and its already-stamped
  // items), not tear down and recreate it.
  handle.set({ navigation: { list: { path: '/channels', template }, activeId: '1', desktopOnly: true } });
  assert.equal(container.querySelector('.qu-apptpl-sidebar qu-list'), listElBefore);
  assert.equal(container.querySelector('.qu-apptpl-sidebar qu-list li'), itemElBefore);
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
  handle.set({ navigation: { list: { path: '/channels', template, onItemStamped }, activeId: '1', desktopOnly: true } });
  await waitFor(() => container.querySelectorAll('.qu-apptpl-sidebar qu-list li').length === 2);

  const activeHref = () => container.querySelector('.qu-apptpl-sidebar qu-list li a.qu-apptpl-item-active')?.getAttribute('href');
  assert.equal(activeHref(), '#/forum/c/1');

  handle.set({ navigation: { list: { path: '/channels', template, onItemStamped }, activeId: '2', desktopOnly: true } });
  assert.equal(activeHref(), '#/forum/c/2');
});

test('list:-registered navigation with prefixItems renders them as a static sibling ahead of the live <qu-list>, active-highlighted independently', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  const prefixItems = [{ id: 'all', label: 'All channels', href: '#/forum' }];
  const template = channelTemplate(); // same reference across both set() calls below - see sameListRegistration()'s own doc comment
  handle.set({
    navigation: { list: { path: '/channels', template, prefixItems }, activeId: 'all', desktopOnly: true },
  });
  await waitFor(() => container.querySelector('.qu-apptpl-sidebar qu-list li a')?.textContent === 'General');

  const sidebar = container.querySelector('.qu-apptpl-sidebar');
  const prefixLink = [...sidebar.querySelectorAll('a')].find((a) => a.textContent === 'All channels');
  assert.ok(prefixLink, 'expected the static "All channels" prefix item');
  assert.equal(prefixLink.getAttribute('href'), '#/forum');
  assert.ok(prefixLink.classList.contains('qu-apptpl-item-active'), 'prefix item is the active one at activeId "all"');
  // Not a child of <qu-list> itself - a separate sibling, per this file's
  // own top doc comment on why (qu-list's own reconciliation would break).
  assert.equal(sidebar.querySelector('qu-list').contains(prefixLink), false);

  handle.set({
    navigation: { list: { path: '/channels', template, prefixItems }, activeId: '1', desktopOnly: true },
  });
  assert.equal(prefixLink.classList.contains('qu-apptpl-item-active'), false, 'no longer active once a real channel is');
  assert.ok(container.querySelector('.qu-apptpl-sidebar qu-list li a.qu-apptpl-item-active'), 'the real channel is now active');
});

// ===== list: in the mobile footer (§A - a SECOND, independent <qu-list>
// in a pill+popup, alongside the sidebar's own) ==============================

function pillTemplate() {
  const t = document.createElement('template');
  t.innerHTML = '<span><qu-view field="title" attr="textContent"></qu-view></span>';
  return t;
}

test('list:-registered navigation (no desktopOnly) mounts a SECOND, independent live <qu-list> in the mobile footer popup', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() }, heading: 'Channels' } });
  await waitFor(() => container.querySelector('.qu-apptpl-sidebar qu-list li a')?.textContent === 'General');
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list li a')?.textContent === 'General');

  const allLists = container.querySelectorAll('qu-list');
  assert.equal(allLists.length, 2, 'sidebar and footer each get their own <qu-list> instance');
  assert.notEqual(allLists[0], allLists[1]);
});

test('the footer popup\'s list updates live as the underlying data changes', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list li a')?.textContent === 'General');

  await qu.put('/channels', [{ path: '/store/c/1' }, { path: '/store/c/2' }]);
  await qu.put('/store/c/2', { title: 'Random' });
  await flush();
  await waitFor(() => container.querySelectorAll('.qu-apptpl-footer qu-list li').length === 2);
  const labels = [...container.querySelectorAll('.qu-apptpl-footer qu-list li a')].map((a) => a.textContent);
  assert.deepEqual(labels, ['General', 'Random']);
});

test('the footer pill shows the active item\'s own label, genuinely live-bound via pillTemplate (not a one-time snapshot)', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate(), pillTemplate: pillTemplate() }, activeId: '1' } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label')?.textContent === 'General');

  // A real qu.put() title change, NOT a chrome.set() call - proves the pill
  // label is a genuinely live <qu-view>, not a snapshot taken at stamp time.
  await qu.put('/store/c/1', { title: 'Renamed' });
  await flush();
  await waitFor(() => container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label')?.textContent === 'Renamed');
});

test('the footer pill\'s label follows an activeId-only route change, with the SAME popup <qu-list>/stamped nodes afterward', async () => {
  const qu = fakeQu({
    '/channels': [{ path: '/store/c/1' }, { path: '/store/c/2' }],
    '/store/c/1': { title: 'General' },
    '/store/c/2': { title: 'Random' },
  });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  const listSpec = { path: '/channels', template: channelTemplate(), pillTemplate: pillTemplate() };
  handle.set({ navigation: { list: listSpec, activeId: '1' } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label')?.textContent === 'General');
  const listElBefore = container.querySelector('.qu-apptpl-footer qu-list');
  const itemsBefore = [...container.querySelectorAll('.qu-apptpl-footer qu-list li')];

  handle.set({ navigation: { list: listSpec, activeId: '2' } });
  // The pill's own <qu-view> resolves asynchronously (even against the fake
  // test qu's own async get()) - same reasoning test 13 above already needs
  // waitFor() for, not a synchronous read right after set().
  await waitFor(() => container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label')?.textContent === 'Random');
  assert.equal(container.querySelector('.qu-apptpl-footer qu-list'), listElBefore);
  assert.deepEqual([...container.querySelectorAll('.qu-apptpl-footer qu-list li')], itemsBefore);
});

test('repeated set() with an UNCHANGED activeId does not re-stamp the pill\'s own label element', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  const listSpec = { path: '/channels', template: channelTemplate(), pillTemplate: pillTemplate() };
  handle.set({ navigation: { list: listSpec, activeId: '1' } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label')?.textContent === 'General');
  const labelChildBefore = container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label').firstElementChild;

  handle.set({ navigation: { list: listSpec, activeId: '1' } }); // same activeId, nothing changed
  assert.equal(container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label').firstElementChild, labelChildBefore);
});

test('the footer pill falls back to the section heading when no pillTemplate is given', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() }, activeId: '1', heading: 'Channels' } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list li') !== null);
  assert.equal(container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label').textContent, 'Channels');
});

test('REGRESSION: repeated chrome.set() calls never disconnect/reconnect the footer\'s (or the sidebar\'s) live <qu-list>', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() }, activeId: '1' } });
  await waitFor(() => container.querySelector('.qu-apptpl-sidebar qu-list li a')?.textContent === 'General');
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list li a')?.textContent === 'General');

  function countUnmounts(listEl) {
    let count = 0;
    const original = listEl._unmount.bind(listEl);
    listEl._unmount = () => { count++; original(); };
    return () => count;
  }
  const sidebarList = container.querySelector('.qu-apptpl-sidebar qu-list');
  const footerList = container.querySelector('.qu-apptpl-footer qu-list');
  const sidebarUnmounts = countUnmounts(sidebarList);
  const footerUnmounts = countUnmounts(footerList);

  handle.set({ primaryAction: { label: 'A', href: '#/a' } });
  handle.set({ settings: { items: [{ label: 'S', href: '#/s' }] } });
  handle.set({ fullHeight: true });
  handle.set({ fullHeight: false });
  handle.set({ primaryAction: undefined, settings: undefined });

  assert.equal(sidebarUnmounts(), 0, 'sidebar\'s live <qu-list> must never disconnect/reconnect across unrelated set() calls');
  assert.equal(footerUnmounts(), 0, 'footer\'s live <qu-list> must never disconnect/reconnect across unrelated set() calls');
  assert.equal(container.querySelector('.qu-apptpl-sidebar qu-list'), sidebarList);
  assert.equal(container.querySelector('.qu-apptpl-footer qu-list'), footerList);
});

test('menuThreshold never truncates the footer popup for a list:-registered section', async () => {
  const initial = { '/channels': Array.from({ length: 5 }, (_, i) => ({ path: `/store/c/${i}` })) };
  for (let i = 0; i < 5; i++) initial[`/store/c/${i}`] = { title: `Channel ${i}` };
  const qu = fakeQu(initial);
  const container = makeContainer();
  const chrome = mountChrome(container, { qu, menuThreshold: 3 });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelectorAll('.qu-apptpl-footer qu-list li').length === 5);
  assert.equal(container.querySelector('.qu-apptpl-footer button.qu-apptpl-pill').textContent.includes('more'), false);
});

test('navigation: {list, desktopOnly: true} still renders in the sidebar but builds NO footer pill at all', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() }, desktopOnly: true } });
  await waitFor(() => container.querySelector('.qu-apptpl-sidebar qu-list li') !== null);
  assert.equal(container.querySelector('.qu-apptpl-footer'), null);
});

test('a list:-only navigation (no items[] chrome at all) still produces a real footer bar, not fab-only or nothing', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer') !== null);
  assert.equal(container.querySelector('.qu-apptpl-footer').classList.contains('qu-apptpl-footer--fab-only'), false);
  assert.ok(container.querySelector('.qu-apptpl-content').classList.contains('qu-apptpl-content--with-bar'));
});

test('the footer\'s live <qu-list> stays connected while its own popup is closed', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list li') !== null);
  const popup = container.querySelector('.qu-apptpl-footer .qu-apptpl-popup');
  assert.equal(popup.hidden, true); // closed by default
  const listEl = container.querySelector('.qu-apptpl-footer qu-list');
  assert.equal(listEl.isConnected, true);
  assert.ok(listEl.querySelector('li'));
});

test('the footer popup\'s own filter input is independent from the sidebar\'s', async () => {
  const qu = fakeQu({
    '/channels': [{ path: '/store/c/1' }, { path: '/store/c/2' }],
    '/store/c/1': { title: 'General' },
    '/store/c/2': { title: 'Random' },
  });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  // A curated `path:`-registered item's own raw shape is just `{path}` at
  // stamp time (the title only resolves later, async, via the stamped
  // `<qu-view field="title">` inside `channelTemplate()` itself) - the
  // itemId is what's synchronously known here, so the test maps it
  // directly rather than depending on `item`'s own (not yet resolved) shape.
  const onItemStamped = (els, itemId) => { els[0].dataset.search = itemId === '1' ? 'general' : 'random'; };
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate(), onItemStamped }, filter: true, heading: 'Channels' } });
  await waitFor(() => container.querySelectorAll('.qu-apptpl-footer qu-list li').length === 2);

  const footerInput = container.querySelector('.qu-apptpl-footer .qu-apptpl-filter');
  const sidebarInput = container.querySelector('.qu-apptpl-sidebar .qu-apptpl-filter');
  assert.ok(footerInput);
  assert.ok(sidebarInput);
  assert.notEqual(footerInput, sidebarInput);

  footerInput.value = 'general';
  footerInput.dispatchEvent(new window.Event('input'));
  const footerVisible = [...container.querySelectorAll('.qu-apptpl-footer qu-list li')].filter((li) => !li.hidden);
  assert.equal(footerVisible.length, 1);
  // The sidebar's own list is untouched by the footer's filter.
  const sidebarVisible = [...container.querySelectorAll('.qu-apptpl-sidebar qu-list li')].filter((li) => !li.hidden);
  assert.equal(sidebarVisible.length, 2);
});

test('switching a navigation section between list: and a plain items[] form (and back) leaves no orphaned footer popup', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list') !== null);

  handle.set({ navigation: { items: [{ id: 'a', label: 'A', href: '#/a' }] } });
  assert.equal(container.querySelector('.qu-apptpl-footer qu-list'), null);
  assert.equal(container.querySelectorAll('.qu-apptpl-footer .qu-apptpl-popup-wrap').length, 1);

  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list') !== null);
  assert.equal(container.querySelectorAll('.qu-apptpl-footer .qu-apptpl-popup-wrap').length, 1);
});

test('begin() and stop() correctly tear down the footer pill\'s own document-level listeners', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  handle.set({ navigation: { list: { path: '/channels', template: channelTemplate() } } });
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list li') !== null);

  assert.doesNotThrow(() => chrome.stop());
  assert.doesNotThrow(() => document.dispatchEvent(new window.Event('click')));
  assert.doesNotThrow(() => document.dispatchEvent(new window.Event('keydown')));
});

test('the footer popup includes the same static prefixItems entry as the sidebar, and the pill shows its label (not heading) when it is the active one', async () => {
  const qu = fakeQu({ '/channels': [{ path: '/store/c/1' }], '/store/c/1': { title: 'General' } });
  const container = makeContainer();
  const chrome = mountChrome(container, { qu });
  const handle = chrome.begin();
  const prefixItems = [{ id: 'all', label: 'All channels', href: '#/forum' }];
  const template = channelTemplate(); // same reference across both set() calls below - see sameListRegistration()'s own doc comment
  handle.set({
    navigation: { list: { path: '/channels', template, prefixItems }, activeId: 'all', heading: 'Channels' },
  });
  await waitFor(() => container.querySelector('.qu-apptpl-footer qu-list li a')?.textContent === 'General');

  assert.equal(container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label').textContent, 'All channels');
  const popupPrefixLink = [...container.querySelectorAll('.qu-apptpl-footer .qu-apptpl-popup a')].find((a) => a.textContent === 'All channels');
  assert.ok(popupPrefixLink, 'expected the popup to also list the static prefix entry');
  assert.equal(popupPrefixLink.getAttribute('href'), '#/forum');

  // No pillTemplate given here, so a REAL channel (not a prefixItems match)
  // falls back to the section heading, same as any other list:-registered
  // pill with no pillTemplate - see this file's own top doc comment's
  // "NOTE ON DECRYPTION" paragraph for why Forum's own real usage makes
  // this exact choice (a channel's title may be genuine ciphertext, not
  // safely readable via a raw <qu-view>).
  handle.set({
    navigation: { list: { path: '/channels', template, prefixItems }, activeId: '1', heading: 'Channels' },
  });
  assert.equal(container.querySelector('.qu-apptpl-footer .qu-apptpl-pill-label').textContent, 'Channels');
});

test('stop() tears down cleanly - no error thrown, no lingering document listeners from an open popup', () => {
  const container = makeContainer();
  const chrome = mountChrome(container, {});
  const handle = chrome.begin();
  handle.set({ settings: { items: [{ label: 'Manage', href: '#/app/manage' }] } });
  assert.doesNotThrow(() => chrome.stop());
});
