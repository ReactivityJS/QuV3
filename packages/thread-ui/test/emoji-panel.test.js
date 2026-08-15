import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { buildEmojiPanel } = await import('../src/emoji-panel.js');
const { EMOJI_EXTENDED } = await import('../src/emoji.js');

function gridButtons(panel) {
  return [...panel.querySelectorAll('.qu-thread-ui-emoji-panel-grid button')];
}

test('first page shows the first 32 emoji and a "1 / N" label; Prev is disabled', () => {
  const panel = buildEmojiPanel({ extended: EMOJI_EXTENDED, onPick: () => {} });
  const buttons = gridButtons(panel);
  assert.equal(buttons.length, 32);
  assert.deepEqual(buttons.map((b) => b.textContent), EMOJI_EXTENDED.slice(0, 32));

  const pageCount = Math.ceil(EMOJI_EXTENDED.length / 32);
  assert.equal(panel.querySelector('.qu-thread-ui-emoji-panel-pager span').textContent, `1 / ${pageCount}`);
  assert.equal(panel.querySelector('.qu-thread-ui-emoji-panel-pager button').disabled, true);
});

test('Next advances a page; Prev goes back; both disable at their respective ends', () => {
  const panel = buildEmojiPanel({ extended: EMOJI_EXTENDED, onPick: () => {} });
  const [prevBtn, nextBtn] = panel.querySelectorAll('.qu-thread-ui-emoji-panel-pager button');
  const pageCount = Math.ceil(EMOJI_EXTENDED.length / 32);

  nextBtn.click();
  assert.deepEqual(gridButtons(panel).map((b) => b.textContent), EMOJI_EXTENDED.slice(32, 64));
  assert.equal(prevBtn.disabled, false);

  for (let i = 1; i < pageCount - 1; i++) nextBtn.click();
  assert.equal(nextBtn.disabled, true);
  assert.equal(panel.querySelector('.qu-thread-ui-emoji-panel-pager span').textContent, `${pageCount} / ${pageCount}`);

  prevBtn.click();
  assert.equal(nextBtn.disabled, false);
});

test('searching by shortcode name filters the grid and resets to page 1', () => {
  const panel = buildEmojiPanel({ extended: EMOJI_EXTENDED, onPick: () => {} });
  panel.querySelector('.qu-thread-ui-emoji-panel-pager button:last-child').click(); // move off page 1 first
  const search = panel.querySelector('.qu-thread-ui-emoji-panel-search');
  search.value = 'fire';
  search.dispatchEvent(new window.Event('input'));

  const buttons = gridButtons(panel);
  assert.ok(buttons.length >= 1);
  assert.ok(buttons.some((b) => b.textContent === '🔥'));
  assert.equal(panel.querySelector('.qu-thread-ui-emoji-panel-pager span').textContent.startsWith('1 /'), true);
});

test('searching by the glyph itself also matches', () => {
  const panel = buildEmojiPanel({ extended: EMOJI_EXTENDED, onPick: () => {} });
  const search = panel.querySelector('.qu-thread-ui-emoji-panel-search');
  search.value = '🔥';
  search.dispatchEvent(new window.Event('input'));
  assert.deepEqual(gridButtons(panel).map((b) => b.textContent), ['🔥']);
});

test('a query matching nothing shows the empty state, no grid buttons', () => {
  const panel = buildEmojiPanel({ extended: EMOJI_EXTENDED, onPick: () => {} });
  const search = panel.querySelector('.qu-thread-ui-emoji-panel-search');
  search.value = 'zzzznotanemoji';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(gridButtons(panel).length, 0);
  assert.ok(panel.querySelector('.qu-thread-ui-emoji-panel-empty'));
});

test('clicking an emoji button calls onPick with that glyph', () => {
  const picks = [];
  const panel = buildEmojiPanel({ extended: EMOJI_EXTENDED, onPick: (e) => picks.push(e) });
  const btn = gridButtons(panel)[3];
  const expected = btn.textContent;
  btn.click();
  assert.deepEqual(picks, [expected]);
});
