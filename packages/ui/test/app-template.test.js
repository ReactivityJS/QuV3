import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { mountAppTemplate, normalizeAppConfig, buildChrome } = await import('../src/app-template.js');

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

// buildChrome() is the extracted primitive apps/shell/src/chrome.js (Chrome
// Inversion) reuses for its own session-scoped chrome, alongside
// mountAppTemplate() - covered directly here so both stay provably
// consistent, not just "mountAppTemplate()'s tests happen to exercise it".
test('buildChrome(): an empty config produces no sidebar and no footer', () => {
  const cfg = normalizeAppConfig({ render: () => {} });
  const built = buildChrome(cfg);
  assert.equal(built.sidebarEl, null);
  assert.equal(built.footerEl, null);
  assert.equal(built.hasChrome, false);
  assert.equal(built.hasMobileFooterContent, false);
  assert.equal(built.fabOnly, false);
});

test('buildChrome(): a lone primaryAction produces a sidebar (one prominent button) and a fab-only footer', () => {
  const cfg = normalizeAppConfig({ render: () => {}, primaryAction: PRIMARY });
  const built = buildChrome(cfg);
  assert.ok(built.sidebarEl.querySelector('.qu-apptpl-primary-desktop'));
  assert.ok(built.footerEl.querySelector('a.qu-apptpl-fab'));
  assert.equal(built.fabOnly, true);
  built.cleanup();
});

test('buildChrome(): full config produces a sidebar with all four sections and a footer with pills/gear/fab', () => {
  const cfg = normalizeAppConfig({ render: () => {}, navigation: NAV, views: VIEWS, settings: SETTINGS, primaryAction: PRIMARY });
  const built = buildChrome(cfg);
  assert.equal(built.sidebarEl.querySelectorAll('.qu-apptpl-section').length, 3);
  assert.equal(built.footerEl.querySelectorAll('.qu-apptpl-pill').length, 2);
  assert.ok(built.footerEl.querySelector('.qu-apptpl-gear'));
  assert.ok(built.footerEl.querySelector('a.qu-apptpl-fab'));
  assert.equal(built.fabOnly, false);
  built.cleanup();
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

test('primaryAction as a single-item array renders identically to passing that one object', () => {
  const container = makeContainer();
  mountAppTemplate(container, { primaryAction: [PRIMARY], render: () => {} });

  const fab = container.querySelector('.qu-apptpl-footer a.qu-apptpl-fab');
  assert.ok(fab);
  assert.equal(fab.getAttribute('href'), '#/app/new');
  assert.equal(container.querySelector('.qu-apptpl-fab-multi'), null);
});

test('primaryAction: [] (empty array) counts as no primaryAction at all - no fab, no sidebar button', () => {
  const container = makeContainer();
  mountAppTemplate(container, { primaryAction: [], render: () => {} });

  assert.equal(container.querySelector('.qu-apptpl-footer'), null);
  assert.equal(container.querySelector('.qu-apptpl-sidebar'), null);
});

test('2+ primaryAction candidates: desktop sidebar gets one prominent button per candidate (room to spare, no collapsing)', () => {
  const container = makeContainer();
  const SECOND = { label: 'New channel', href: '#/app/new-channel', icon: '📁' };
  mountAppTemplate(container, { primaryAction: [PRIMARY, SECOND], render: () => {} });

  const buttons = [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-primary-desktop')];
  assert.deepEqual(buttons.map((a) => a.getAttribute('href')), ['#/app/new', '#/app/new-channel']);
});

test('2+ primaryAction candidates: mobile gets ONE fab that opens a popup of real links, marked as a menu trigger', () => {
  const container = makeContainer();
  const SECOND = { label: 'New channel', href: '#/app/new-channel', icon: '📁' };
  mountAppTemplate(container, { primaryAction: [PRIMARY, SECOND], render: () => {} });

  const footer = container.querySelector('.qu-apptpl-footer');
  assert.equal(footer.classList.contains('qu-apptpl-footer--fab-only'), true);
  // Exactly one FAB-styled trigger, not one per candidate.
  assert.equal(footer.querySelectorAll('.qu-apptpl-fab').length, 1);
  const trigger = footer.querySelector('.qu-apptpl-fab');
  assert.equal(trigger.classList.contains('qu-apptpl-fab-multi'), true); // the "this is a menu" caret cue
  assert.equal(trigger.tagName, 'BUTTON'); // not a direct link - opens a popup instead

  const popup = footer.querySelector('.qu-apptpl-popup');
  assert.equal(popup.hidden, true);
  trigger.click();
  assert.equal(popup.hidden, false);
  const links = [...popup.querySelectorAll('a')];
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['#/app/new', '#/app/new-channel']);
  assert.deepEqual(links.map((a) => a.textContent.trim()), ['✏️New topic', '📁New channel']);

  document.body.click();
  assert.equal(popup.hidden, true);
});

test('2+ primaryAction candidates alongside navigation: the fab-multi popup listeners are torn down by the returned cleanup', () => {
  const container = makeContainer();
  const SECOND = { label: 'New channel', href: '#/app/new-channel' };
  const stop = mountAppTemplate(container, { navigation: NAV, primaryAction: [PRIMARY, SECOND], render: () => {} });

  const trigger = container.querySelector('.qu-apptpl-fab-multi');
  trigger.click();
  assert.equal(container.querySelector('.qu-apptpl-popup:not([hidden])') !== null, true);

  stop();
  // A stray click after teardown must not throw (no leftover document listener touching removed DOM).
  assert.doesNotThrow(() => document.body.click());
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

// ===== desktopOnly =====

test('normalizeAppConfig defaults a section\'s desktopOnly to false', () => {
  const cfg = normalizeAppConfig({ navigation: NAV, render: () => {} });
  assert.equal(cfg.navigation.desktopOnly, false);
});

test('desktopOnly: true still shows the section in the desktop sidebar', () => {
  const container = makeContainer();
  mountAppTemplate(container, { navigation: { ...NAV, desktopOnly: true }, render: () => {} });
  const links = [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list a')];
  assert.deepEqual(links.map((a) => a.textContent), ['💬General', 'Random3']);
});

test('desktopOnly: true excludes the section from the mobile footer entirely - no pill, and (with nothing else set) no footer at all', () => {
  const container = makeContainer();
  mountAppTemplate(container, { navigation: { ...NAV, desktopOnly: true }, render: () => {} });
  assert.equal(container.querySelector('.qu-apptpl-footer'), null);
  // The desktop sidebar still exists (hasChrome is true from navigation alone).
  assert.ok(container.querySelector('.qu-apptpl-sidebar'));
});

test('desktopOnly navigation + a primaryAction: mobile footer is fab-only (the nav pill is excluded, not just hidden)', () => {
  const container = makeContainer();
  mountAppTemplate(container, {
    navigation: { ...NAV, desktopOnly: true }, primaryAction: PRIMARY, render: () => {},
  });
  const footer = container.querySelector('.qu-apptpl-footer');
  assert.ok(footer);
  assert.equal(footer.classList.contains('qu-apptpl-footer--fab-only'), true);
  assert.equal(footer.querySelector('.qu-apptpl-pill'), null);
  assert.ok(footer.querySelector('a.qu-apptpl-fab'));
  // Desktop sidebar shows both the primaryAction button AND the nav section.
  assert.ok(container.querySelector('.qu-apptpl-sidebar .qu-apptpl-primary-desktop'));
  assert.ok(container.querySelector('.qu-apptpl-sidebar .qu-apptpl-list'));
});

test('desktopOnly navigation alongside a NON-desktopOnly views section: the footer shows only the views pill', () => {
  const container = makeContainer();
  mountAppTemplate(container, {
    navigation: { ...NAV, desktopOnly: true }, views: VIEWS, render: () => {},
  });
  const footer = container.querySelector('.qu-apptpl-footer');
  assert.equal(footer.classList.contains('qu-apptpl-footer--fab-only'), false);
  const pills = footer.querySelectorAll('.qu-apptpl-pill');
  assert.equal(pills.length, 1);
  assert.ok(pills[0].textContent.includes('Latest')); // the views pill, not navigation
});

test('stop.update() can flip a section to desktopOnly later, removing it from an already-built footer', () => {
  const container = makeContainer();
  const stop = mountAppTemplate(container, { navigation: NAV, render: () => {} });
  assert.ok(container.querySelector('.qu-apptpl-footer .qu-apptpl-pill'));

  stop.update({ navigation: { ...NAV, desktopOnly: true } });
  assert.equal(container.querySelector('.qu-apptpl-footer'), null);
  assert.ok(container.querySelector('.qu-apptpl-sidebar .qu-apptpl-list')); // still in the sidebar
});

// ===== filter =====

const FILTERABLE_NAV = {
  items: [
    { id: 'general', label: 'General', href: '#/app/c/general' },
    { id: 'random', label: 'Random Room', href: '#/app/c/random' },
    { id: 'team', label: 'Team Chat', href: '#/app/c/team', searchText: 'Alice Bob' },
  ],
  heading: 'Channels',
  filter: true,
};

test('normalizeAppConfig defaults a section\'s filter to false', () => {
  const cfg = normalizeAppConfig({ navigation: NAV, render: () => {} });
  assert.equal(cfg.navigation.filter, false);
});

test('filter: false (default) renders no search input', () => {
  const container = makeContainer();
  mountAppTemplate(container, { navigation: NAV, render: () => {} });
  assert.equal(container.querySelector('.qu-apptpl-filter'), null);
});

test('filter: true renders a search input in the desktop sidebar, filtering the list by label as you type', () => {
  const container = makeContainer();
  mountAppTemplate(container, { navigation: FILTERABLE_NAV, render: () => {} });
  const input = container.querySelector('.qu-apptpl-sidebar .qu-apptpl-filter');
  assert.ok(input);

  const items = () => [...container.querySelectorAll('.qu-apptpl-sidebar .qu-apptpl-list li')].filter((li) => !li.hidden).map((li) => li.textContent);
  assert.deepEqual(items(), ['General', 'Random Room', 'Team Chat']);

  input.value = 'rand';
  input.dispatchEvent(new window.Event('input'));
  assert.deepEqual(items(), ['Random Room']);

  // Also matches searchText (e.g. a group room's participant names), not just label.
  input.value = 'alice';
  input.dispatchEvent(new window.Event('input'));
  assert.deepEqual(items(), ['Team Chat']);

  input.value = '';
  input.dispatchEvent(new window.Event('input'));
  assert.deepEqual(items(), ['General', 'Random Room', 'Team Chat']);
});

test('filter: true also renders a search input in the mobile popup, filtering independently from the sidebar', () => {
  const container = makeContainer();
  mountAppTemplate(container, { navigation: FILTERABLE_NAV, render: () => {} });
  const pill = container.querySelector('.qu-apptpl-footer .qu-apptpl-pill');
  pill.click(); // open the popup
  const input = container.querySelector('.qu-apptpl-popup .qu-apptpl-filter');
  assert.ok(input);

  const links = () => [...container.querySelectorAll('.qu-apptpl-popup a')].filter((a) => !a.hidden).map((a) => a.textContent);
  assert.equal(links().length, 3);

  input.value = 'team';
  input.dispatchEvent(new window.Event('input'));
  assert.deepEqual(links(), ['Team Chat']);
});
