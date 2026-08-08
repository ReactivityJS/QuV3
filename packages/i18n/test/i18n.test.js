import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n, detectLocale, getStoredLocale, setLocale, AVAILABLE_LOCALES } from '../src/index.js';

/**
 * Node has no `localStorage` global by default (unlike a browser) and its
 * own built-in `navigator` isn't reassignable by plain `=` (getter with no
 * setter) - both need `Object.defineProperty`/explicit delete to fake for a
 * test, then restore, so tests never leak global state into each other.
 */
function withNavigatorLanguages(languages, fn) {
  const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { languages }, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, 'navigator', orig);
  }
}

function withFakeLocalStorage(fn) {
  const store = new Map();
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const orig = had ? globalThis.localStorage : undefined;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    return fn();
  } finally {
    if (had) globalThis.localStorage = orig;
    else delete globalThis.localStorage;
  }
}

function withNoLocalStorage(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const orig = had ? globalThis.localStorage : undefined;
  if (had) delete globalThis.localStorage;
  try {
    return fn();
  } finally {
    if (had) globalThis.localStorage = orig;
  }
}

// ===== detectLocale =========================================================

test('detectLocale picks the base subtag of the first matching preferred language', () => {
  withNavigatorLanguages(['de-CH', 'en-US'], () => {
    assert.equal(detectLocale(['en', 'de']), 'de');
  });
});

test('detectLocale falls back when nothing in the preference list matches', () => {
  withNavigatorLanguages(['fr-FR'], () => {
    assert.equal(detectLocale(['en', 'de']), 'en');
  });
});

test('detectLocale falls back to the first supported locale if even "fallback" is unsupported', () => {
  withNavigatorLanguages(['fr-FR'], () => {
    assert.equal(detectLocale(['de', 'ja'], 'en'), 'de');
  });
});

// ===== getStoredLocale / setLocale =========================================

test('getStoredLocale returns null when nothing was ever set', () => {
  withFakeLocalStorage(() => {
    assert.equal(getStoredLocale(), null);
  });
});

test('setLocale persists, getStoredLocale reads it back', () => {
  withFakeLocalStorage(() => {
    setLocale('de');
    assert.equal(getStoredLocale(), 'de');
  });
});

test('setLocale(null) clears a previously stored choice', () => {
  withFakeLocalStorage(() => {
    setLocale('de');
    setLocale(null);
    assert.equal(getStoredLocale(), null);
  });
});

test('getStoredLocale returns null (not throw) when localStorage is unavailable', () => {
  withNoLocalStorage(() => {
    assert.equal(getStoredLocale(), null);
  });
});

test('setLocale is a silent no-op when localStorage is unavailable', () => {
  withNoLocalStorage(() => {
    assert.doesNotThrow(() => setLocale('de'));
  });
});

// ===== createI18n / t() =====================================================

const DICT = {
  en: { greeting: 'Hello, {name}!', title: 'Title' },
  de: { greeting: 'Hallo, {name}!', title: 'Titel' },
};

test('t() interpolates named placeholders', () => {
  const { t } = createI18n(DICT, { locale: 'en' });
  assert.equal(t('greeting', { name: 'Ada' }), 'Hello, Ada!');
});

test('an explicit locale option skips auto-detection and the stored preference', () => {
  withFakeLocalStorage(() => {
    setLocale('en');
    withNavigatorLanguages(['en-US'], () => {
      const { locale } = createI18n(DICT, { locale: 'de' });
      assert.equal(locale, 'de');
    });
  });
});

test('a stored locale preference wins over browser auto-detection', () => {
  withFakeLocalStorage(() => {
    setLocale('de');
    withNavigatorLanguages(['en-US'], () => {
      const { locale, t } = createI18n(DICT);
      assert.equal(locale, 'de');
      assert.equal(t('title'), 'Titel');
    });
  });
});

test('without an explicit locale or stored preference, browser auto-detection applies', () => {
  withNoLocalStorage(() => {
    withNavigatorLanguages(['de-DE'], () => {
      const { locale } = createI18n(DICT);
      assert.equal(locale, 'de');
    });
  });
});

test('a stored locale not present in this dictionary falls through to auto-detection', () => {
  withFakeLocalStorage(() => {
    setLocale('fr'); // no French dictionary here
    withNavigatorLanguages(['de-DE'], () => {
      const { locale } = createI18n(DICT);
      assert.equal(locale, 'de');
    });
  });
});

test('a key missing from the resolved locale falls back to the fallback dictionary', () => {
  const partial = { en: { onlyInEnglish: 'English only' }, de: {} };
  const { t } = createI18n(partial, { locale: 'de', fallback: 'en' });
  assert.equal(t('onlyInEnglish'), 'English only');
});

test('a key missing from both the resolved and fallback dictionaries warns and returns the key itself', (t) => {
  const warnCalls = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { t: translate } = createI18n(DICT, { locale: 'en' });
    assert.equal(translate('nonexistent'), 'nonexistent');
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0][0], /missing translation key "nonexistent"/);
  } finally {
    console.warn = origWarn;
  }
});

test('an unresolved placeholder (no matching param) is left untouched', () => {
  const { t } = createI18n(DICT, { locale: 'en' });
  assert.equal(t('greeting', {}), 'Hello, {name}!');
});

test('AVAILABLE_LOCALES lists every locale this codebase actually ships dictionaries for', () => {
  assert.deepEqual(AVAILABLE_LOCALES.map((l) => l.code).sort(), ['de', 'en']);
});
