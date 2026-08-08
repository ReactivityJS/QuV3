import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { ensureTheme, DEFAULT_THEME } = await import('../src/theme.js');

test('ensureTheme injects a :root block with every default token', () => {
  ensureTheme();
  const style = document.getElementById('qu-theme');
  assert.ok(style);
  for (const [name, value] of Object.entries(DEFAULT_THEME)) {
    assert.match(style.textContent, new RegExp(`${name}:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`));
  }
});

test('ensureTheme is idempotent - a second call (even with different overrides) is a no-op', () => {
  document.getElementById('qu-theme')?.remove();
  ensureTheme();
  const firstContent = document.getElementById('qu-theme').textContent;
  ensureTheme({ '--qu-color-accent': '#ff0000' });
  const secondContent = document.getElementById('qu-theme').textContent;
  assert.equal(secondContent, firstContent);
  assert.doesNotMatch(secondContent, /#ff0000/);
});

test('an override replaces the corresponding default token when applied to a fresh (unmounted) theme', () => {
  document.getElementById('qu-theme')?.remove();
  ensureTheme({ '--qu-color-accent': '#123456' });
  const style = document.getElementById('qu-theme');
  assert.match(style.textContent, /--qu-color-accent:\s*#123456;/);
  assert.doesNotMatch(style.textContent, /--qu-color-accent:\s*#5b5bd6;/);
});
