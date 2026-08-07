import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLinks, URL_RE_GLOBAL } from '../src/link-detect.js';

test('detectLinks() splits plain text and links in order', () => {
  const segments = detectLinks('see https://example.com/page for more');
  assert.deepEqual(segments.map((s) => s.type), ['text', 'link', 'text']);
  assert.equal(segments[1].value, 'https://example.com/page');
  assert.equal(segments[1].hostname, 'example.com');
});

test('detectLinks() of plain text with no links returns one text segment', () => {
  const segments = detectLinks('nothing to see here');
  assert.deepEqual(segments, [{ type: 'text', value: 'nothing to see here' }]);
});

test('detectLinks() finds multiple links', () => {
  const segments = detectLinks('https://a.com then https://b.com');
  const links = segments.filter((s) => s.type === 'link').map((s) => s.value);
  assert.deepEqual(links, ['https://a.com', 'https://b.com']);
});

test('detectLinks() reconstructs the original text by concatenating segment values', () => {
  const text = 'hello https://example.com world';
  const rebuilt = detectLinks(text).map((s) => s.value).join('');
  assert.equal(rebuilt, text);
});

test('URL_RE_GLOBAL is reusable across separate replace() calls without lastIndex state leaking', () => {
  const first = 'https://a.com'.replace(URL_RE_GLOBAL, 'X');
  const second = 'https://a.com'.replace(URL_RE_GLOBAL, 'X');
  assert.equal(first, 'X');
  assert.equal(second, 'X');
});
