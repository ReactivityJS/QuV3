import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { mountAppTemplate, normalizeAppConfig } = await import('../src/app-template.js');

const NAV = {
  items: [
    { id: 'general', label: 'General', href: '#/app/c/general', icon: '💬' },
    { id: 'random', label: 'Random', href: '#/app/c/random', badge: 3 },
  ],
  activeId: 'random',
  heading: 'Channels',
};
const VIEWS = {
  items: [
    { id: 'latest', label: 'Latest', href: '#/app/v/latest' },
    { id: 'top', label: 'Top', href: '#/app/v/top' },
  ],
  activeId: 'latest',
};
const SETTINGS = {
  items: [{ label: 'Manage channels', href: '#/app/manage' }],
  heading: 'Settings',
};
const PRIMARY = { label: 'New topic', href: '#/app/new', icon: '✏️' };

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('normalizeAppConfig throws without a render function', () => {
  assert.throws(() => normalizeAppConfig({}), /render is required/);
  assert.throws(() => normalizeAppConfig({ render: 'nope' }), /render is required/);
});

test('normalizeAppConfig drops empty/missing sections', () => {
  const cfg = normalizeAppConfig({ render: () => {}, navigation: { items: [] } });
  assert.equal(cfg.navigation, null);
  assert.equal(cfg.views, null);
  assert.equal(cfg.settings, null);
  assert.equal(cfg.primaryAction, null);
  assert.equal(cfg.breakpoint, '720px');
});

test('only render(): no chrome at all, content gets the full container', () => {
  const container = makeContainer();
  let renderedContent = null;
  mountAppTemplate(container, {
    render: (content) => { renderedContent = content; content.textContent = 'hello'; },
  });

  assert.equal(container.querySelector('.qu-apptpl-sidebar'), null);
  assert.equal(container.querySelector('.qu-apptpl-footer'), null);
  const content = container.querySelector('.qu-apptpl-content');
  assert.equal(content, renderedContent);
  assert.equal(content.textContent, 'hello');
  assert.equal(content.classList.contains('qu-apptpl-content--with-bar'), false);
});

test('only primaryAction: a standalone FAB, no bar chrome, no reserved content padding', () => {
  const container = makeContainer();
  mountAppTemplate(container, { primaryAction: PRIMARY, render: () => {} });

  const footer = container.querySelector('.qu-apptpl-footer');
  assert.ok(footer);
  assert.equal(footer.classList.contains('qu-apptpl-footer--fab-only'), true);
  const fab = footer.querySelector('a.qu-apptpl-fab');
  assert.ok(fab);
  assert.equal(fab.getAttribute('href'), '#/app/new');
  assert.equal(fab.title, 'New topic');
  assert.equal(fab.getAttribute('aria-label'), 'New topic');
  // No pills, no gear - nothing else was configured.
  assert.equal(footer.querySelector('.qu-apptpl-pill'), null);
  assert.equal(footer.querySelector('.qu-apptpl-gear'), null);

  const content = container.querySelector('.qu-apptpl-content');
  assert.equal(content.classList.contains('qu-apptpl-content--with-bar'), false);

  // The desktop sidebar still renders (a real button for wide screens), just as
  // a lone primary-action sidebar - no navigation/views/settings sections.
  const sidebar = container.querySelector('.qu-apptpl-sidebar');
  assert.ok(sidebar);
  assert.ok(sidebar.querySelector('.qu-apptpl-primary-desktop'));
  assert.equal(sidebar.querySelector('.qu-apptpl-section'), null);
});

test('full config: desktop sidebar renders all four sections, footer renders pills/gear/fab', () => {
  const container = makeContainer();
  let renderedContent = null;
  mountAppTemplate(container, {
    navigation: NAV, views: VIEWS, settings: SETTINGS, primaryAction: PRIMARY,
    render: (content) => { renderedContent = content; },
  });

  const sidebar = container.querySelector('.qu-apptpl-sidebar');
  assert.ok(sidebar.querySelector('.qu-apptpl-primary-desktop'));
  const sections = sidebar.querySelectorAll('.qu-apptpl-section');
  assert.equal(sections.length, 3);
  assert.equal(sections[2].classList.contains('qu-apptpl-section--settings'), true);

  const navLinks = [...sections[0].querySelectorAll('a')];
  assert.deepEqual(navLinks.map((a) => a.textContent), ['💬General', 'Random3']);
  assert.equal(navLinks[1].classList.contains('qu-apptpl-item-active'), true);
  assert.equal(navLinks[0].classList.contains('qu-apptpl-item-active'), false);

  const footer = container.querySelector('.qu-apptpl-footer');
  assert.equal(footer.classList.contains('qu-apptpl-footer--fab-only'), false);
  const pills = footer.querySelectorAll('.qu-apptpl-pill');
  assert.equal(pills.length, 2); // navigation + views
  assert.ok(footer.querySelector('.qu-apptpl-gear'));
  assert.ok(footer.querySelector('a.qu-apptpl-fab'));

  const content = container.querySelector('.qu-apptpl-content');
  assert.equal(content, renderedContent);
  assert.equal(content.classList.contains('qu-apptpl-content--with-bar'), true);
});

test('navigation pill shows the active item and opens/closes a popup of real links', () => {
  const container = makeContainer();
  mountAppTemplate(container, { navigation: NAV, render: () => {} });

  const footer = container.querySelector('.qu-apptpl-footer');
  const pillBtn = footer.querySelector('.qu-apptpl-pill');
  assert.ok(pillBtn.textContent.includes('Random')); // active item's label shown on the pill itself

  const popup = footer.querySelector('.qu-apptpl-popup');
  assert.equal(popup.hidden, true);

  pillBtn.click();
  assert.equal(popup.hidden, false);
  const links = [...popup.querySelectorAll('a')];
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['#/app/c/general', '#/app/c/random']);

  document.body.click();
  assert.equal(popup.hidden, true);
});

test('settings gear opens a popup listing settings items', () => {
  const container = makeContainer();
  mountAppTemplate(container, { settings: SETTINGS, render: () => {} });

  const gear = container.querySelector('.qu-apptpl-gear');
  assert.ok(gear);
  const popup = container.querySelector('.qu-apptpl-popup');
  assert.equal(popup.hidden, true);

  gear.click();
  assert.equal(popup.hidden, false);
  assert.equal(popup.querySelector('a').textContent, 'Manage channels');

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(popup.hidden, true);
});

test('the returned cleanup removes document-level popup listeners', () => {
  const container = makeContainer();
  const stop = mountAppTemplate(container, { navigation: NAV, render: () => {} });

  const pillBtn = container.querySelector('.qu-apptpl-pill');
  const popup = container.querySelector('.qu-apptpl-popup');
  pillBtn.click();
  assert.equal(popup.hidden, false);

  stop();
  document.body.click();
  // No longer reachable/meaningful, but should not throw and should not have
  // re-closed via a listener that's supposed to be gone - the important
  // contract is simply that calling stop() doesn't throw and leaves no
  // listener attached to `document` for this instance.
  assert.equal(popup.hidden, false);
});

// ===== fullHeight =====

test('normalizeAppConfig defaults fullHeight to false', () => {
  const cfg = normalizeAppConfig({ render: () => {} });
  assert.equal(cfg.fullHeight, false);
});

test('fullHeight: false (default) never adds the full-height root/content classes', () => {
  const container = makeContainer();
  mountAppTemplate(container, { navigation: NAV, render: () => {} });
  const root = container.querySelector('.qu-apptpl-root');
  assert.equal(root.classList.contains('qu-apptpl-root--full-height'), false);
  assert.equal(root.classList.contains('qu-apptpl-root--has-footer-bar'), false);
  assert.equal(container.querySelector('.qu-apptpl-content').classList.contains('qu-apptpl-content--with-bar'), true);
});

test('fullHeight: true with chrome adds the full-height root class and the has-footer-bar modifier (not the with-bar padding class, to avoid double-reserving the footer space)', () => {
  const container = makeContainer();
  mountAppTemplate(container, { fullHeight: true, navigation: NAV, render: () => {} });
  const root = container.querySelector('.qu-apptpl-root');
  assert.equal(root.classList.contains('qu-apptpl-root--full-height'), true);
  assert.equal(root.classList.contains('qu-apptpl-root--has-footer-bar'), true);
  assert.equal(container.querySelector('.qu-apptpl-content').classList.contains('qu-apptpl-content--with-bar'), false);
});

test('fullHeight: true with only a primaryAction (fab-only footer) does not add has-footer-bar - the fab floats over content, nothing to reserve', () => {
  const container = makeContainer();
  mountAppTemplate(container, { fullHeight: true, primaryAction: PRIMARY, render: () => {} });
  const root = container.querySelector('.qu-apptpl-root');
  assert.equal(root.classList.contains('qu-apptpl-root--full-height'), true);
  assert.equal(root.classList.contains('qu-apptpl-root--has-footer-bar'), false);
});

test('fullHeight: true with no chrome at all still gets the full-height root class, just no sidebar/footer', () => {
  const container = makeContainer();
  mountAppTemplate(container, { fullHeight: true, render: () => {} });
  const root = container.querySelector('.qu-apptpl-root');
  assert.equal(root.classList.contains('qu-apptpl-root--full-height'), true);
  assert.equal(root.classList.contains('qu-apptpl-root--has-footer-bar'), false);
  assert.equal(container.querySelector('.qu-apptpl-sidebar'), null);
  assert.equal(container.querySelector('.qu-apptpl-footer'), null);
});

// ===== stop.update() - late-arriving chrome data =====

test('stop.update() adds chrome that was absent at mount time, without re-calling render()', () => {
  const container = makeContainer();
  let renderCalls = 0;
  let renderedContent = null;
  const stop = mountAppTemplate(container, {
    primaryAction: PRIMARY,
    render: (content) => { renderCalls++; renderedContent = content; content.textContent = 'app content'; },
  });
  assert.equal(renderCalls, 1);
  assert.equal(container.querySelector('.qu-apptpl-list'), null); // no navigation yet

  stop.update({ navigation: NAV });

  assert.equal(renderCalls, 1); // render() never called again
  assert.equal(container.querySelector('.qu-apptpl-content'), renderedContent); // same content node, untouched
  assert.equal(renderedContent.textContent, 'app content'); // app's own DOM survives the chrome rebuild
  const navLinks = [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')];
  assert.deepEqual(navLinks.map((a) => a.textContent), ['💬General', 'Random3']);
  // The footer switches from fab-only (floating) to a real bar now that
  // there's navigation content to show alongside the primary action.
  assert.equal(container.querySelector('.qu-apptpl-footer').classList.contains('qu-apptpl-footer--fab-only'), false);
  assert.ok(container.querySelector('.qu-apptpl-footer .qu-apptpl-pill'));
});

test('stop.update() replaces previously-set chrome (a second update overrides, not merges, a given section)', () => {
  const container = makeContainer();
  const stop = mountAppTemplate(container, { navigation: NAV, render: () => {} });
  stop.update({ navigation: { items: [{ id: 'x', label: 'X', href: '#/x' }] } });
  const navLinks = [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')];
  assert.deepEqual(navLinks.map((a) => a.textContent), ['X']);
});

test('stop.update() cleans up the previous footer\'s popup listeners before rebuilding (no leak across rebuilds)', () => {
  const container = makeContainer();
  const stop = mountAppTemplate(container, { navigation: NAV, render: () => {} });
  const firstPill = container.querySelector('.qu-apptpl-pill');
  firstPill.click();
  assert.equal(container.querySelector('.qu-apptpl-popup').hidden, false);

  stop.update({ navigation: { items: [{ id: 'x', label: 'X', href: '#/x' }] } });
  // The OLD popup/listener is gone - clicking the document doesn't touch a
  // dangling reference to it (would throw/leak if the old cleanup wasn't run).
  assert.doesNotThrow(() => document.body.click());
  const newPopup = container.querySelector('.qu-apptpl-popup');
  assert.equal(newPopup.hidden, true);
});

test('stop() after an update() still tears down the CURRENT footer\'s listeners', () => {
  const container = makeContainer();
  const stop = mountAppTemplate(container, { render: () => {} });
  stop.update({ navigation: NAV });
  const pill = container.querySelector('.qu-apptpl-pill');
  pill.click();
  assert.equal(container.querySelector('.qu-apptpl-popup').hidden, false);

  stop();
  assert.doesNotThrow(() => document.body.click());
});
