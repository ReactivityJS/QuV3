import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { normalizeRoute, buildPageTree, applyPageStyle } = await import('../client.js');

test('normalizeRoute lowercases, slugifies each segment, and drops empties', () => {
  assert.equal(normalizeRoute('About Me'), 'about-me');
  assert.equal(normalizeRoute('Blog / 2026-08-28 / My Post!'), 'blog/2026-08-28/my-post');
  assert.equal(normalizeRoute('  '), '');
  assert.equal(normalizeRoute(''), '');
  assert.equal(normalizeRoute(null), '');
  assert.equal(normalizeRoute('//a//b//'), 'a/b');
});

test('buildPageTree finds the home page (route "") separately from roots', () => {
  const pages = [
    { _id: 'home', title: 'Home', route: '', order: 0 },
    { _id: 'about', title: 'About', route: 'about-me', order: 0 },
  ];
  const { home, roots } = buildPageTree(pages);
  assert.equal(home._id, 'home');
  assert.equal(roots.length, 1);
  assert.equal(roots[0]._id, 'about');
});

test('buildPageTree nests a page under its parent purely from the route path, no parentId', () => {
  const pages = [
    { _id: 'blog', title: 'Blog', route: 'blog', order: 0 },
    { _id: 'post1', title: 'First post', route: 'blog/2026-08-28/my-post', order: 0 },
  ];
  const { roots, byId } = buildPageTree(pages);
  // "blog/2026-08-28/my-post" has no page at the intermediate "blog/2026-08-28"
  // route, so it surfaces as its own top-level entry rather than being lost -
  // see buildPageTree()'s own doc comment.
  assert.equal(roots.length, 2);
  assert.deepEqual(roots.map((n) => n._id).sort(), ['blog', 'post1']);
  assert.equal(byId.get('post1').depth, 3);
});

test('buildPageTree sorts siblings by order then title', () => {
  const pages = [
    { _id: 'b', title: 'Bravo', route: 'bravo', order: 1 },
    { _id: 'a', title: 'Alpha', route: 'alpha', order: 1 },
    { _id: 'z', title: 'Zulu', route: 'zulu', order: 0 },
  ];
  const { roots } = buildPageTree(pages);
  assert.deepEqual(roots.map((n) => n._id), ['z', 'a', 'b']);
});

test('buildPageTree nests direct children onto their parent page node', () => {
  const pages = [
    { _id: 'about', title: 'About', route: 'about', order: 0 },
    { _id: 'team', title: 'Team', route: 'about/team', order: 0 },
    { _id: 'history', title: 'History', route: 'about/history', order: 1 },
  ];
  const { roots } = buildPageTree(pages);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].children.map((n) => n._id), ['team', 'history']);
});

test('applyPageStyle sets validated custom properties and ignores garbage input', () => {
  const el = document.createElement('div');
  applyPageStyle(el, { background: '#223344', text: 'not-a-color', font: 'serif', maxWidth: 'nonsense' });
  assert.equal(el.style.getPropertyValue('--cms-bg'), '#223344');
  assert.equal(el.style.getPropertyValue('--cms-text'), '');
  assert.match(el.style.getPropertyValue('--cms-font'), /Georgia/);
  assert.equal(el.style.getPropertyValue('--cms-maxwidth'), '');
});

test('applyPageStyle with no overrides clears every custom property', () => {
  const el = document.createElement('div');
  applyPageStyle(el, {});
  for (const prop of ['--cms-bg', '--cms-text', '--cms-accent', '--cms-font', '--cms-maxwidth']) {
    assert.equal(el.style.getPropertyValue(prop), '');
  }
});
