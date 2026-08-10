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

test('opening near the bottom of the viewport flips the panel upward (flipUpIfNeeded)', () => {
  const host = makeHost();
  const el = renderEmojiPicker({ onPick: () => {}, trigger: '+' });
  host.appendChild(el);
  const trigger = el.querySelector('button');
  window.innerHeight = 400;
  trigger.getBoundingClientRect = () => ({ top: 380, bottom: 395, left: 0, right: 0, width: 0, height: 15 });

  // The panel doesn't exist until openPanel() creates+appends it inside
  // trigger.click() itself, so its own rect can't be stubbed beforehand -
  // patch the shared prototype method just for this test instead, keyed by
  // class name (real elements/tests are unaffected: this test's own host
  // elements have no matching class).
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('qu-thread-ui-emoji-panel')) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 200 };
    return original.call(this);
  };
  try {
    trigger.click();
    const panel = el.querySelector('.qu-thread-ui-emoji-panel');
    assert.ok(panel);
    assert.equal(panel.classList.contains('qu-thread-ui-emoji-panel-flip-up'), true);
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = original;
  }
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
