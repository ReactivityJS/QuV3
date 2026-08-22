import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContent, renderContent, CONTENT_FORMATS } from '../src/content.js';
import { formatMarkdown } from '../src/thread-formatting.js';

test('createContent() defaults format to "plain" and attachments to an empty array', () => {
  const content = createContent({ text: 'hello' });
  assert.equal(content.text, 'hello');
  assert.equal(content.format, 'plain');
  assert.deepEqual(content.attachments, []);
});

test('createContent() accepts any known format', () => {
  for (const format of CONTENT_FORMATS) {
    const content = createContent({ text: 'x', format });
    assert.equal(content.format, format);
  }
});

test('createContent() rejects an unknown format', () => {
  assert.throws(() => createContent({ text: 'x', format: 'html' }), /unknown format "html"/);
});

test('createContent() rejects non-array attachments', () => {
  assert.throws(() => createContent({ text: 'x', attachments: 'nope' }), /attachments must be an array/);
});

test('createContent() passes attachments through unchanged', () => {
  const attachments = [{ id: 'a1', mime: 'image/png' }];
  const content = createContent({ text: 'x', attachments });
  assert.deepEqual(content.attachments, attachments);
});

// ===== renderContent() =====================================================

test('renderContent() escapes HTML and converts newlines to <br> for "plain"', () => {
  const html = renderContent(createContent({ text: '<b>hi</b>\nline2' }));
  assert.equal(html, '&lt;b&gt;hi&lt;/b&gt;<br>line2');
});

test('renderContent() delegates to formatMarkdown() for "markdown"', () => {
  const content = createContent({ text: '**bold** @mention-like-thing', format: 'markdown' });
  assert.equal(renderContent(content), formatMarkdown(content.text));
});

test('renderContent() throws a documented error for "richtext" (no WYSIWYG editor exists yet to have produced it)', () => {
  const content = createContent({ text: 'x', format: 'richtext' }); // a valid Content shape - createContent() accepts it fine
  assert.throws(() => renderContent(content), /no renderer for format "richtext" yet/);
});
