import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { injectStyle } = await import('../src/style.js');

test('injectStyle appends a <style> with the given id and css', () => {
  injectStyle('qu-test-style-1', '.foo { color: red; }');
  const style = document.getElementById('qu-test-style-1');
  assert.ok(style);
  assert.equal(style.tagName, 'STYLE');
  assert.equal(style.textContent, '.foo { color: red; }');
});

test('injectStyle is idempotent - a second call with the same id does not duplicate or overwrite it', () => {
  injectStyle('qu-test-style-2', '.a { color: red; }');
  injectStyle('qu-test-style-2', '.a { color: blue; }');
  const matches = document.querySelectorAll('#qu-test-style-2');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].textContent, '.a { color: red; }');
});
