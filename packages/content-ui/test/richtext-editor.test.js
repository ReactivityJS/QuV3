import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { mountRichTextEditor, sanitizeRichTextHtml } = await import('../src/richtext-editor.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('sanitizeRichTextHtml keeps allow-listed tags untouched', () => {
  const html = '<p>Hello <strong>world</strong>, <em>this</em> is <u>fine</u>.</p><ul><li>one</li><li>two</li></ul>';
  assert.equal(sanitizeRichTextHtml(html), html);
});

test('sanitizeRichTextHtml drops <script> tags AND their text content entirely', () => {
  const out = sanitizeRichTextHtml('<p>hi</p><script>alert(1)</script><p>bye</p>');
  assert.equal(out, '<p>hi</p><p>bye</p>');
  assert.doesNotMatch(out, /alert/);
});

test('sanitizeRichTextHtml strips onerror/on* attributes on any tag (even an allowed one)', () => {
  const out = sanitizeRichTextHtml('<p onclick="alert(1)" onmouseover="evil()">text</p>');
  assert.equal(out, '<p>text</p>');
});

test('sanitizeRichTextHtml drops an <img> (not allow-listed) but keeps sibling text', () => {
  const out = sanitizeRichTextHtml('<p>before <img src="x" onerror="alert(1)"> after</p>');
  assert.doesNotMatch(out, /img|onerror|alert/);
  assert.match(out, /before/);
  assert.match(out, /after/);
});

test('sanitizeRichTextHtml unwraps an unrecognized-but-benign tag, keeping its text', () => {
  const out = sanitizeRichTextHtml('<div class="whatever"><font color="red">hi</font></div>');
  assert.equal(out, 'hi');
});

test('sanitizeRichTextHtml keeps an http(s) link, forcing rel/target', () => {
  const out = sanitizeRichTextHtml('<a href="https://example.com">link</a>');
  assert.match(out, /href="https:\/\/example\.com"/);
  assert.match(out, /rel="noopener noreferrer"/);
  assert.match(out, /target="_blank"/);
});

test('sanitizeRichTextHtml drops a javascript: href, keeping the link text but no href', () => {
  const out = sanitizeRichTextHtml('<a href="javascript:alert(1)">click me</a>');
  assert.doesNotMatch(out, /javascript:/);
  assert.match(out, /click me/);
});

test('sanitizeRichTextHtml handles empty/null/undefined input', () => {
  assert.equal(sanitizeRichTextHtml(''), '');
  assert.equal(sanitizeRichTextHtml(null), '');
  assert.equal(sanitizeRichTextHtml(undefined), '');
});

test('mountRichTextEditor renders a sanitized initial value and exposes getHtml/setHtml', () => {
  const host = makeHost();
  const editor = mountRichTextEditor(host, { initialHtml: '<p>hi</p><script>bad()</script>' });
  assert.equal(editor.getHtml(), '<p>hi</p>');
  editor.setHtml('<p onclick="bad()">new <strong>content</strong></p>');
  assert.equal(editor.getHtml(), '<p>new <strong>content</strong></p>');
  editor.stop();
});

test('mountRichTextEditor renders every toolbar button with a real tooltip', () => {
  const host = makeHost();
  const editor = mountRichTextEditor(host, { placeholder: 'Write something…' });
  const buttons = [...host.querySelectorAll('.qu-richtext-toolbar button')];
  for (const label of ['Bold', 'Italic', 'Underline', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list', 'Link']) {
    const btn = buttons.find((b) => b.title === label);
    assert.ok(btn, `expected a "${label}" toolbar button`);
    assert.equal(btn.getAttribute('aria-label'), label);
  }
  editor.stop();
});

test('mountRichTextEditor: clicking a toolbar button does not throw (document.execCommand may be unimplemented in this test env)', () => {
  const host = makeHost();
  const editor = mountRichTextEditor(host);
  const bold = [...host.querySelectorAll('.qu-richtext-toolbar button')].find((b) => b.title === 'Bold');
  assert.doesNotThrow(() => bold.click());
  editor.stop();
});

test('mountRichTextEditor: stop() removes the mounted root from the container', () => {
  const host = makeHost();
  const editor = mountRichTextEditor(host);
  assert.equal(host.children.length, 1);
  editor.stop();
  assert.equal(host.children.length, 0);
});
