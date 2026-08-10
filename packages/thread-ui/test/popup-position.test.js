import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { flipUpIfNeeded } = await import('../src/popup-position.js');

function rectStub(el, rect) {
  el.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...rect });
}

test('flipUpIfNeeded(): adds the flip class when there is not enough room below but there IS enough room above', () => {
  window.innerHeight = 600;
  const trigger = document.createElement('button');
  rectStub(trigger, { top: 550, bottom: 570 }); // near the bottom - only 30px left below
  const panel = document.createElement('div');
  rectStub(panel, { height: 200 }); // needs 200px - doesn't fit below (30px), fits above (550px)

  flipUpIfNeeded(panel, trigger, 'flip-up');
  assert.equal(panel.classList.contains('flip-up'), true);
});

test('flipUpIfNeeded(): does NOT add the flip class when there is enough room below', () => {
  window.innerHeight = 600;
  const trigger = document.createElement('button');
  rectStub(trigger, { top: 100, bottom: 120 });
  const panel = document.createElement('div');
  rectStub(panel, { height: 200 }); // fits comfortably in the 480px below

  flipUpIfNeeded(panel, trigger, 'flip-up');
  assert.equal(panel.classList.contains('flip-up'), false);
});

test('flipUpIfNeeded(): does NOT flip when there is MORE room below than above, even if the panel technically overflows both', () => {
  window.innerHeight = 600;
  const trigger = document.createElement('button');
  rectStub(trigger, { top: 50, bottom: 70 }); // 50px above, 530px below
  const panel = document.createElement('div');
  rectStub(panel, { height: 5000 }); // doesn't fit either way - stay put (more room below than above)

  flipUpIfNeeded(panel, trigger, 'flip-up');
  assert.equal(panel.classList.contains('flip-up'), false);
});
