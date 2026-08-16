import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { renderNavPointsMenu } = await import('../src/nav-points-menu.js');

test('0 items renders nothing', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, { items: [] });
  assert.equal(wrap.children.length, 0);
});

test('1 item renders a single plain link, no dropdown button', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, { items: [{ label: 'New thing', href: '#/app/new' }] });

  const link = wrap.querySelector('a.qu-app-action-btn');
  assert.ok(link);
  assert.equal(link.getAttribute('href'), '#/app/new');
  assert.equal(link.title, 'New thing');
  assert.equal(link.getAttribute('aria-label'), 'New thing');
  assert.equal(wrap.querySelector('button'), null);
});

test('2+ items render a toggle button + dropdown menu of links', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, {
    items: [
      { label: 'New channel', href: '#/forum/new' },
      { label: 'New topic', href: '#/forum/c/1/new-topic' },
    ],
    menuLabel: 'Actions',
  });

  const btn = wrap.querySelector('button.qu-app-action-btn');
  assert.ok(btn);
  assert.equal(btn.title, 'Actions');
  assert.equal(btn.getAttribute('aria-label'), 'Actions');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');

  const menu = wrap.querySelector('.qu-navpoints-menu');
  assert.equal(menu.hidden, true);
  const links = [...menu.querySelectorAll('a')];
  assert.deepEqual(links.map((a) => a.textContent), ['New channel', 'New topic']);
  assert.equal(links[0].getAttribute('href'), '#/forum/new');
  assert.equal(links[1].getAttribute('href'), '#/forum/c/1/new-topic');
});

test('the dropdown button carries a visible caret so it reads as a menu, distinct from the 1-item plain-link case', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, {
    items: [{ label: 'New channel', href: '#/forum/new' }, { label: 'New topic', href: '#/forum/c/1/new-topic' }],
    menuLabel: 'Actions',
  });
  const btn = wrap.querySelector('button.qu-app-action-btn');
  assert.ok(btn.querySelector('.qu-navpoints-caret'), 'expected a caret marking this as a menu trigger');
  assert.equal(btn.querySelector('.qu-navpoints-caret').textContent, '▾');
});

test('omitting menuLabel falls back to the first item\'s label, never the bare icon glyph', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, {
    items: [{ label: 'New channel', href: '#/forum/new' }, { label: 'New topic', href: '#/forum/c/1/new-topic' }],
  });
  const btn = wrap.querySelector('button.qu-app-action-btn');
  assert.equal(btn.title, 'New channel');
  assert.equal(btn.getAttribute('aria-label'), 'New channel');
});

test('the dropdown toggles open/closed on button click', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, {
    items: [{ label: 'A', href: '#/a' }, { label: 'B', href: '#/b' }],
  });
  const btn = wrap.querySelector('button');
  const menu = wrap.querySelector('.qu-navpoints-menu');

  btn.click();
  assert.equal(menu.hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');

  btn.click();
  assert.equal(menu.hidden, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
});

test('clicking outside closes the dropdown', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, {
    items: [{ label: 'A', href: '#/a' }, { label: 'B', href: '#/b' }],
  });
  const btn = wrap.querySelector('button');
  const menu = wrap.querySelector('.qu-navpoints-menu');
  btn.click();
  assert.equal(menu.hidden, false);

  document.body.click();
  assert.equal(menu.hidden, true);
});

test('Escape closes the dropdown', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, {
    items: [{ label: 'A', href: '#/a' }, { label: 'B', href: '#/b' }],
  });
  const btn = wrap.querySelector('button');
  const menu = wrap.querySelector('.qu-navpoints-menu');
  btn.click();
  assert.equal(menu.hidden, false);

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(menu.hidden, true);
});

test('picking a link closes the dropdown', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  renderNavPointsMenu(wrap, {
    items: [{ label: 'A', href: '#/a' }, { label: 'B', href: '#/b' }],
  });
  const btn = wrap.querySelector('button');
  const menu = wrap.querySelector('.qu-navpoints-menu');
  btn.click();
  assert.equal(menu.hidden, false);

  menu.querySelector('a').click();
  assert.equal(menu.hidden, true);
});

test('the returned cleanup removes the document-level listeners (no leak across mounts)', () => {
  const wrap = document.createElement('span');
  document.body.appendChild(wrap);
  const cleanup = renderNavPointsMenu(wrap, {
    items: [{ label: 'A', href: '#/a' }, { label: 'B', href: '#/b' }],
  });
  const btn = wrap.querySelector('button');
  const menu = wrap.querySelector('.qu-navpoints-menu');
  btn.click();
  assert.equal(menu.hidden, false);

  cleanup();
  // Outside click no longer reaches this (now orphaned) menu's own listener.
  document.body.click();
  assert.equal(menu.hidden, false);
});
