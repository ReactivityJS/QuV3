import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { renderAvatar } = await import('../src/avatar.js');

test('an https:// avatarValue renders as an actual <img>, never as raw text', () => {
  const el = renderAvatar('pub123', 'Ada', 'https://example.com/a.png');
  const img = el.querySelector('img');
  assert.ok(img);
  assert.equal(img.src, 'https://example.com/a.png');
  assert.equal(el.textContent, '');
});

test('a short non-URL avatarValue (emoji) renders as text', () => {
  const el = renderAvatar('pub123', 'Ada', '🚀');
  assert.equal(el.textContent, '🚀');
  assert.equal(el.querySelector('img'), null);
});

test('an unset avatarValue falls back to the label\'s first letter, uppercased', () => {
  const el = renderAvatar('pub123', 'ada', null);
  assert.equal(el.textContent, 'A');
});

test('an unset avatarValue AND label falls back to "?"', () => {
  const el = renderAvatar('', '', null);
  assert.equal(el.textContent, '?');
});

test('the same seed always produces the same badge color (stable across re-renders)', () => {
  const a = renderAvatar('same-seed', 'A', null);
  const b = renderAvatar('same-seed', 'B', null);
  assert.equal(a.style.background, b.style.background);
});

test('size option sets the --qu-avatar-size custom property', () => {
  const el = renderAvatar('pub', 'A', null, { size: '3rem' });
  assert.equal(el.style.getPropertyValue('--qu-avatar-size'), '3rem');
});

test('renderAvatar injects its stylesheet exactly once across multiple calls (uses the shared injectStyle, not a duplicate local copy)', () => {
  document.getElementById('qu-avatar-style')?.remove();
  renderAvatar('a', 'A', null);
  renderAvatar('b', 'B', null);
  assert.equal(document.querySelectorAll('#qu-avatar-style').length, 1);
});
