import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { mountContextSwitcher, renderContextListPage } = await import('../src/context-switcher.js');

const ITEMS = [
  { id: 'general', label: 'General', href: '#/forum/c/general' },
  { id: 'random', label: 'Random', href: '#/forum/c/random', icon: '🔒', badge: '3' },
];

test('variant "tabs": renders the item list, marks the active item, renders content', () => {
  const container = document.createElement('div');
  let renderedContent = null;
  mountContextSwitcher(container, {
    items: ITEMS, activeId: 'random', heading: 'Channels', variant: 'tabs',
    render: (content) => { renderedContent = content; content.textContent = 'board body'; },
  });

  const sidebar = container.querySelector('.qu-ctxswitch-sidebar');
  assert.equal(sidebar.dataset.variant, 'tabs');
  const links = [...container.querySelectorAll('.qu-ctxswitch-list a')];
  assert.equal(links.length, 2);
  assert.equal(links[1].classList.contains('qu-ctxswitch-item-active'), true);
  assert.equal(links[0].classList.contains('qu-ctxswitch-item-active'), false);

  // No titlebar link for 'tabs' - the sidebar is never hidden, so nothing to link to.
  assert.equal(container.querySelector('.qu-ctxswitch-titlebar'), null);

  const content = container.querySelector('.qu-ctxswitch-content');
  assert.equal(content, renderedContent);
  assert.equal(content.textContent, 'board body');
});

test('newItem renders a trailing link only when passed', () => {
  const container = document.createElement('div');
  mountContextSwitcher(container, { items: ITEMS, heading: 'Channels', render: () => {} });
  assert.equal(container.querySelector('.qu-ctxswitch-new'), null);

  const container2 = document.createElement('div');
  mountContextSwitcher(container2, {
    items: ITEMS, heading: 'Channels', newItem: { label: '+ New channel', href: '#/forum/new' }, render: () => {},
  });
  const newLink = container2.querySelector('.qu-ctxswitch-new');
  assert.ok(newLink);
  assert.equal(newLink.textContent, '+ New channel');
  assert.equal(newLink.getAttribute('href'), '#/forum/new');
});

test('variant "page": renders a titlebar link pointing at switchHref with the active label', () => {
  const container = document.createElement('div');
  mountContextSwitcher(container, {
    items: ITEMS, activeId: 'general', heading: 'Calendars', variant: 'page',
    switchHref: '#/calendar/manage', activeLabel: 'Allgemein',
    render: () => {},
  });

  const titleLink = container.querySelector('.qu-ctxswitch-title-link');
  assert.ok(titleLink);
  assert.equal(titleLink.getAttribute('href'), '#/calendar/manage');
  assert.equal(titleLink.textContent, 'Allgemein ›');

  const sidebar = container.querySelector('.qu-ctxswitch-sidebar');
  assert.equal(sidebar.dataset.variant, 'page');
});

test('variant "page" with hideTitleLink: true renders no titlebar link, but the sidebar (and switchHref-independent content) is unaffected', () => {
  const container = document.createElement('div');
  mountContextSwitcher(container, {
    items: ITEMS, activeId: 'general', heading: 'Calendars', variant: 'page',
    switchHref: '#/calendar/manage', activeLabel: 'Allgemein', hideTitleLink: true,
    render: () => {},
  });

  assert.equal(container.querySelector('.qu-ctxswitch-title-link'), null);
  assert.equal(container.querySelector('.qu-ctxswitch-titlebar'), null);
  const sidebar = container.querySelector('.qu-ctxswitch-sidebar');
  assert.equal(sidebar.dataset.variant, 'page');
});

test('renderSidebar overrides the default items list entirely', () => {
  const container = document.createElement('div');
  let sawHost = null;
  mountContextSwitcher(container, {
    renderSidebar: (host) => { sawHost = host; const p = document.createElement('p'); p.textContent = 'custom sidebar'; host.appendChild(p); },
    heading: 'Calendars', render: () => {},
  });
  assert.equal(container.querySelector('.qu-ctxswitch-list'), null);
  // renderSidebar's host IS the sidebar <aside> (heading already appended before this callback runs) - it appends alongside, doesn't replace, the heading.
  assert.equal(sawHost, container.querySelector('.qu-ctxswitch-sidebar'));
  assert.equal(sawHost.querySelector('p').textContent, 'custom sidebar');
});

test('fullHeight: true marks the root with data-full-height and injects the matching CSS rules; omitted/false leaves it unmarked', () => {
  const container = document.createElement('div');
  mountContextSwitcher(container, { items: ITEMS, heading: 'Calendars', fullHeight: true, render: () => {} });
  const root = container.querySelector('.qu-ctxswitch-root');
  assert.equal(root.dataset.fullHeight, 'true');
  const css = document.getElementById('qu-ctxswitch-style-720px').textContent;
  assert.match(css, /\.qu-ctxswitch-root\[data-full-height\]\s*\{[^}]*flex:\s*1/);
  assert.match(css, /\.qu-ctxswitch-root\[data-full-height\]\s*\.qu-ctxswitch-content\s*\{[^}]*min-height:\s*0/);

  const container2 = document.createElement('div');
  mountContextSwitcher(container2, { items: ITEMS, heading: 'Calendars', render: () => {} });
  assert.equal(container2.querySelector('.qu-ctxswitch-root').dataset.fullHeight, undefined);
});

test('renderContextListPage: renders the same list content standalone, with no back link (Rule 1 - global chrome owns it)', () => {
  const container = document.createElement('div');
  renderContextListPage(container, { items: ITEMS, activeId: 'general', heading: 'Calendars' });

  assert.equal(container.querySelector('a.qu-subpage-back'), null);
  const h1 = container.querySelector('.qu-ctxswitch-page-heading');
  assert.equal(h1.textContent, 'Calendars');
  const links = [...container.querySelectorAll('.qu-ctxswitch-list a')];
  assert.equal(links.length, 2);
  assert.equal(links[0].classList.contains('qu-ctxswitch-item-active'), true);
});

test('renderContextListPage: renderSidebar override also works standalone', () => {
  const container = document.createElement('div');
  renderContextListPage(container, {
    renderSidebar: (host) => { host.textContent = 'manage calendars here'; },
    heading: 'Calendars',
  });
  assert.ok(container.textContent.includes('manage calendars here'));
});
