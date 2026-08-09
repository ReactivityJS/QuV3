import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { renderEmojiPicker, EMOJI_QUICK, EMOJI_EXTENDED } = await import('../src/emoji.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('standalone trigger (no quick list): renders exactly one button, opens the extended panel on click', () => {
  const host = makeHost();
  const el = renderEmojiPicker({ onPick: () => {}, trigger: '😀' });
  host.appendChild(el);
  const buttons = el.querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, '😀');

  assert.equal(el.querySelector('.qu-thread-ui-emoji-panel'), null);
  buttons[0].click();
  const panel = el.querySelector('.qu-thread-ui-emoji-panel');
  assert.ok(panel);
  assert.equal(panel.querySelectorAll('button').length, EMOJI_EXTENDED.length);
});

test('quick row + trigger: renders one button per quick emoji plus the trigger, clicking a quick button calls onPick with that emoji directly (no panel)', () => {
  const host = makeHost();
  const picks = [];
  const el = renderEmojiPicker({ onPick: (e) => picks.push(e), quick: EMOJI_QUICK, trigger: '+' });
  host.appendChild(el);
  const buttons = [...el.querySelectorAll('button')];
  assert.equal(buttons.length, EMOJI_QUICK.length + 1);
  assert.equal(buttons.at(-1).textContent, '+');

  buttons[0].click();
  assert.deepEqual(picks, [EMOJI_QUICK[0]]);
  assert.equal(el.querySelector('.qu-thread-ui-emoji-panel'), null);
});

test('picking an emoji from the extended panel calls onPick and closes the panel', () => {
  const host = makeHost();
  const picks = [];
  const el = renderEmojiPicker({ onPick: (e) => picks.push(e), trigger: '+' });
  host.appendChild(el);
  el.querySelector('button').click();
  const panel = el.querySelector('.qu-thread-ui-emoji-panel');
  const someButton = panel.querySelectorAll('button')[5];
  const expected = someButton.textContent;
  someButton.click();
  assert.deepEqual(picks, [expected]);
  assert.equal(el.querySelector('.qu-thread-ui-emoji-panel'), null);
});

test('clicking the trigger again while the panel is open closes it (toggle)', () => {
  const host = makeHost();
  const el = renderEmojiPicker({ onPick: () => {}, trigger: '+' });
  host.appendChild(el);
  const trigger = el.querySelector('button');
  trigger.click();
  assert.ok(el.querySelector('.qu-thread-ui-emoji-panel'));
  trigger.click();
  assert.equal(el.querySelector('.qu-thread-ui-emoji-panel'), null);
});

test('clicking outside the picker closes an open panel', async () => {
  const host = makeHost();
  const el = renderEmojiPicker({ onPick: () => {}, trigger: '+' });
  host.appendChild(el);
  el.querySelector('button').click();
  assert.ok(el.querySelector('.qu-thread-ui-emoji-panel'));

  // The outside-click listener is attached one tick after opening (see the
  // module's own doc comment - so the SAME click that opened it doesn't
  // immediately close it) - wait a tick before simulating the outside click.
  await new Promise((resolve) => setTimeout(resolve, 10));
  document.body.click();
  assert.equal(el.querySelector('.qu-thread-ui-emoji-panel'), null);
});
