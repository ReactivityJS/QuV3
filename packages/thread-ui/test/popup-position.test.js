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

test('flipUpIfNeeded(): shifts a panel back on-screen (translateX) when it overflows the RIGHT edge - the context menu\'s own "right: 0" anchor, reported opening off the left, is really this same overflow from the other trigger position', () => {
  window.innerWidth = 400;
  window.innerHeight = 600;
  const trigger = document.createElement('button');
  rectStub(trigger, { top: 100, bottom: 120 });
  const panel = document.createElement('div');
  rectStub(panel, { height: 50, left: 350, right: 450, width: 100 }); // right edge (450) overflows a 400px-wide viewport by 50px (+8px margin)

  flipUpIfNeeded(panel, trigger, 'flip-up');
  assert.equal(panel.style.transform, 'translateX(-58px)');
});

test('flipUpIfNeeded(): shifts a panel back on-screen when it overflows the LEFT edge', () => {
  window.innerWidth = 400;
  window.innerHeight = 600;
  const trigger = document.createElement('button');
  rectStub(trigger, { top: 100, bottom: 120 });
  const panel = document.createElement('div');
  rectStub(panel, { height: 50, left: -20, right: 80, width: 100 }); // left edge is 20px past the viewport's own left edge

  flipUpIfNeeded(panel, trigger, 'flip-up');
  assert.equal(panel.style.transform, 'translateX(28px)'); // 20px overflow + the 8px margin
});

test('flipUpIfNeeded(): no horizontal shift when the panel already fits with room to spare', () => {
  window.innerWidth = 1024;
  window.innerHeight = 800;
  const trigger = document.createElement('button');
  rectStub(trigger, { top: 100, bottom: 120 });
  const panel = document.createElement('div');
  rectStub(panel, { height: 50, left: 400, right: 500, width: 100 });

  flipUpIfNeeded(panel, trigger, 'flip-up');
  assert.equal(panel.style.transform, '');
});

test('flipUpIfNeeded(): clamps against the nearest overflow-y:auto ancestor (a sidebar-adjacent content column), not the raw window - a panel that fits the WINDOW but overflows past that column\'s own left edge still gets shifted', () => {
  window.innerWidth = 1000;
  window.innerHeight = 600;

  // A desktop sidebar + scrollable content column layout, e.g. .qu-apptpl-
  // sidebar (14rem/224px) beside .qu-chat-messages-scroll - the column's
  // own bounding rect starts at 224, well short of the window's own 0.
  const scrollContainer = document.createElement('div');
  scrollContainer.style.overflowY = 'auto';
  rectStub(scrollContainer, { left: 224, right: 1000 });
  const trigger = document.createElement('button');
  scrollContainer.appendChild(trigger);
  document.body.appendChild(scrollContainer);
  try {
    rectStub(trigger, { top: 100, bottom: 120 });
    const panel = document.createElement('div');
    // Anchored via the context menu's own "right: 0" - sits comfortably
    // inside the 1000px WINDOW, but its left edge (200) is still 24px
    // short of the scroll container's own left edge (224).
    rectStub(panel, { height: 50, left: 200, right: 300, width: 100 });

    flipUpIfNeeded(panel, trigger, 'flip-up');
    assert.equal(panel.style.transform, 'translateX(24px)'); // 224 (column's own left edge) - 200 (panel's left) - the column's edge already dominates the 8px margin, not on top of it
  } finally {
    scrollContainer.remove();
  }
});

test('flipUpIfNeeded(): with NO scrollable ancestor at all (e.g. the composer\'s own emoji trigger, outside the message list), the clamp still falls back to the full window - unchanged from before', () => {
  window.innerWidth = 1000;
  window.innerHeight = 600;
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  try {
    rectStub(trigger, { top: 100, bottom: 120 });
    const panel = document.createElement('div');
    rectStub(panel, { height: 50, left: 200, right: 300, width: 100 }); // well within the window - no ancestor bound is tighter than that
    flipUpIfNeeded(panel, trigger, 'flip-up');
    assert.equal(panel.style.transform, '');
  } finally {
    trigger.remove();
  }
});

test('flipUpIfNeeded(): prefers window.visualViewport over window.innerHeight/innerWidth when available - the mobile on-screen-keyboard case', () => {
  // A real mobile browser's innerHeight stays the full LAYOUT viewport even
  // once the keyboard is showing (e.g. a composer's emoji trigger, focused
  // exactly when a keyboard is very likely open) - visualViewport is what
  // actually shrinks, and is what a "is there really room below" check
  // needs to trust instead, or it flips (or clamps) based on space the
  // keyboard is actually covering.
  window.innerWidth = 400;
  window.innerHeight = 800; // stale/layout value - would say "plenty of room below"
  window.visualViewport = { width: 400, height: 300 }; // the REAL visible height, keyboard open
  try {
    const trigger = document.createElement('button');
    rectStub(trigger, { top: 250, bottom: 270 }); // within the real 300px visual viewport, near its bottom
    const panel = document.createElement('div');
    rectStub(panel, { height: 100, left: 50, right: 150, width: 100 }); // 100px doesn't fit in the 30px really left below (300-270)

    flipUpIfNeeded(panel, trigger, 'flip-up');
    assert.equal(panel.classList.contains('flip-up'), true);
  } finally {
    delete window.visualViewport;
  }
});
