import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContent, CONTENT_FORMATS } from '../src/content.js';

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
