import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { ensureTheme, DEFAULT_THEME, THEME_PRESETS, getStoredTheme, setStoredTheme } = await import('../src/theme.js');

// installDom() doesn't copy localStorage onto globalThis (same gap @qu/i18n's
// own tests already document/work around) - a plain in-memory fake, installed
// once for this whole file since every test below needs it.
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
})();

function resetTheme() {
  document.getElementById('qu-theme')?.remove();
  setStoredTheme(null);
}

test('ensureTheme injects a :root block with every default token', () => {
  ensureTheme();
  const style = document.getElementById('qu-theme');
  assert.ok(style);
  for (const [name, value] of Object.entries(DEFAULT_THEME)) {
    assert.match(style.textContent, new RegExp(`${name}:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`));
  }
});

test('ensureTheme is idempotent - a second call (even with different overrides) is a no-op', () => {
  resetTheme();
  ensureTheme();
  const firstContent = document.getElementById('qu-theme').textContent;
  ensureTheme({ '--qu-color-accent': '#ff0000' });
  const secondContent = document.getElementById('qu-theme').textContent;
  assert.equal(secondContent, firstContent);
  assert.doesNotMatch(secondContent, /#ff0000/);
});

test('ensureTheme emits a real, opaque --qu-color-surface (light) and a dark-scheme override under prefers-color-scheme: dark', () => {
  resetTheme();
  ensureTheme();
  const content = document.getElementById('qu-theme').textContent;
  assert.match(content, /--qu-color-surface:\s*#ffffff;/);
  assert.match(content, /@media \(prefers-color-scheme: dark\)/);
  assert.match(content, /--qu-color-surface:\s*#242426;/);
  // the dark override lives INSIDE the media block, not the plain :root one
  const mediaBlockStart = content.indexOf('@media');
  assert.ok(content.indexOf('#242426') > mediaBlockStart);
});

test('an explicit override applies to the dark block too, when the overridden key is also a dark-scheme token', () => {
  resetTheme();
  ensureTheme({ '--qu-color-surface': '#111111' });
  const content = document.getElementById('qu-theme').textContent;
  const mediaBlockStart = content.indexOf('@media');
  assert.match(content.slice(0, mediaBlockStart), /--qu-color-surface:\s*#111111;/);
  assert.match(content.slice(mediaBlockStart), /--qu-color-surface:\s*#111111;/);
  assert.doesNotMatch(content.slice(mediaBlockStart), /#242426/);
});

test('an override replaces the corresponding default token when applied to a fresh (unmounted) theme', () => {
  resetTheme();
  ensureTheme({ '--qu-color-accent': '#123456' });
  const style = document.getElementById('qu-theme');
  assert.match(style.textContent, /--qu-color-accent:\s*#123456;/);
  assert.doesNotMatch(style.textContent, /--qu-color-accent:\s*#5b5bd6;/);
});

// ===== THEME_PRESETS / getStoredTheme / setStoredTheme ================================

test('getStoredTheme returns null when nothing was ever set', () => {
  resetTheme();
  assert.equal(getStoredTheme(), null);
});

test('setStoredTheme persists a preset name, getStoredTheme reads it back', () => {
  resetTheme();
  setStoredTheme('ocean');
  assert.equal(getStoredTheme(), 'ocean');
});

test('setStoredTheme(null) clears a previously stored preset', () => {
  resetTheme();
  setStoredTheme('ocean');
  setStoredTheme(null);
  assert.equal(getStoredTheme(), null);
});

test('ensureTheme applies the stored preset\'s tokens on top of DEFAULT_THEME', () => {
  resetTheme();
  setStoredTheme('ocean');
  ensureTheme();
  const style = document.getElementById('qu-theme');
  assert.match(style.textContent, new RegExp(`--qu-color-accent:\\s*${THEME_PRESETS.ocean['--qu-color-accent']};`));
});

test('an explicit ensureTheme() override still wins over the stored preset', () => {
  resetTheme();
  setStoredTheme('ocean');
  ensureTheme({ '--qu-color-accent': '#123456' });
  const style = document.getElementById('qu-theme');
  assert.match(style.textContent, /--qu-color-accent:\s*#123456;/);
});

test('an unrecognized stored preset name is ignored - falls back to DEFAULT_THEME, does not throw', () => {
  resetTheme();
  setStoredTheme('not-a-real-preset');
  assert.doesNotThrow(() => ensureTheme());
  const style = document.getElementById('qu-theme');
  assert.match(style.textContent, new RegExp(`--qu-color-accent:\\s*${DEFAULT_THEME['--qu-color-accent'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`));
});

test('getStoredTheme()/setStoredTheme() tolerate no localStorage at all - no throw, ensureTheme falls back to DEFAULT_THEME', () => {
  resetTheme();
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.doesNotThrow(() => setStoredTheme('ocean'));
    assert.equal(getStoredTheme(), null);
    assert.doesNotThrow(() => ensureTheme());
    const style = document.getElementById('qu-theme');
    assert.match(style.textContent, new RegExp(`--qu-color-accent:\\s*${DEFAULT_THEME['--qu-color-accent'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`));
  } finally {
    globalThis.localStorage = saved;
  }
});
