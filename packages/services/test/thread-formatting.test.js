import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMentions, formatMarkdown, applyFormatting } from '../src/thread-formatting.js';

test('extractMentions() finds every unique @mention token', () => {
  const body = `hey @${'a'.repeat(20)} and @${'b'.repeat(20)}, also @${'a'.repeat(20)} again`;
  const mentions = extractMentions(body);
  assert.equal(mentions.length, 2);
});

test('extractMentions() ignores a short token that does not meet the minimum length', () => {
  assert.deepEqual(extractMentions('hey @short'), []);
});

test('formatMarkdown() escapes raw HTML first', () => {
  assert.equal(formatMarkdown('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('formatMarkdown() renders bold/italic', () => {
  assert.equal(formatMarkdown('**bold** and *italic*'), '<strong>bold</strong> and <em>italic</em>');
});

test('formatMarkdown() protects fenced code from other transforms (e.g. *not* italicized inside)', () => {
  const html = formatMarkdown('```\n*not italic*\n```');
  assert.ok(html.includes('<pre class="qu-code-block">'));
  assert.ok(html.includes('*not italic*')); // literal, not <em>-wrapped
});

test('formatMarkdown() protects inline code the same way', () => {
  const html = formatMarkdown('`*not italic*`');
  assert.equal(html, '<code class="qu-inline-code">*not italic*</code>');
});

test('formatMarkdown() renders a markdown-style link with rel="noopener noreferrer"', () => {
  const html = formatMarkdown('[click here](https://example.com)');
  assert.equal(html, '<a href="https://example.com" rel="noopener noreferrer">click here</a>');
});

test('formatMarkdown() auto-links a bare URL, and does not double-wrap a markdown-style one', () => {
  const bare = formatMarkdown('see https://example.com for more');
  assert.ok(bare.includes('<a href="https://example.com" rel="noopener noreferrer">https://example.com</a>'));

  const mdStyle = formatMarkdown('[text](https://example.com)');
  assert.equal((mdStyle.match(/<a /g) || []).length, 1); // exactly one anchor, not two
});

test('formatMarkdown() only auto-links http(s) - never javascript:/data: URLs', () => {
  const html = formatMarkdown('click javascript:alert(1) now');
  assert.ok(!html.includes('<a '));
});

test('formatMarkdown() renders a spoiler span', () => {
  assert.equal(formatMarkdown('||secret||'), '<span class="qu-spoiler">secret</span>');
});

test('formatMarkdown() renders a hashtag but does not link it', () => {
  const html = formatMarkdown('#news today');
  assert.ok(html.includes('<span class="qu-hashtag">#news</span>'));
  assert.ok(!html.includes('<a '));
});

test('formatMarkdown() does not treat a URL fragment (#section) as a hashtag', () => {
  const html = formatMarkdown('see https://example.com/page#section');
  assert.ok(!html.includes('qu-hashtag'));
});

test('formatMarkdown() renders a mention as a profile link, carrying the raw pub in data-pub for render-time alias resolution', () => {
  const pub = 'a'.repeat(20);
  const html = formatMarkdown(`hi @${pub}`);
  assert.ok(html.includes(`<a href="#/~${pub}" class="qu-mention" data-pub="${pub}">`));
});

test('formatMarkdown() converts newlines to <br>', () => {
  assert.equal(formatMarkdown('line one\nline two'), 'line one<br>line two');
});

test('applyFormatting() with no formatters returns null html and empty mentions', () => {
  assert.deepEqual(applyFormatting('hello @' + 'a'.repeat(20)), { formattedHtml: null, mentions: [] });
});

test('applyFormatting() with only "mentions" extracts mentions but does not render HTML', () => {
  const result = applyFormatting('hello @' + 'a'.repeat(20), ['mentions']);
  assert.equal(result.formattedHtml, null);
  assert.equal(result.mentions.length, 1);
});

test('applyFormatting() with only "markdown" renders HTML but leaves mentions empty', () => {
  const result = applyFormatting('**hi** @' + 'a'.repeat(20), ['markdown']);
  assert.ok(result.formattedHtml.includes('<strong>hi</strong>'));
  assert.deepEqual(result.mentions, []); // mentions extraction is opt-in independently of rendering
});
