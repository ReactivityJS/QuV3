import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { mountAppHeaderAction } = await import('../src/app-header-action.js');

function fakeContext(initial) {
  let ctx = initial;
  const listeners = new Set();
  return {
    getContext: () => ctx,
    onContextChange: (cb) => listeners.add(cb),
    set(next) {
      ctx = next;
      for (const cb of listeners) cb();
    },
  };
}

test('renders (and shows) only while getContext().appId matches appId', () => {
  const container = document.createElement('div');
  const { getContext, onContextChange } = fakeContext({ appId: 'other', segments: ['other'] });
  let renderCalls = 0;
  mountAppHeaderAction(container, {
    appId: 'calendar', getContext, onContextChange,
    render: (wrap) => { renderCalls++; wrap.textContent = 'calendar-action'; },
  });

  const wrap = container.querySelector('.qu-app-header-action');
  assert.ok(wrap);
  assert.equal(wrap.hidden, true);
  assert.equal(renderCalls, 0);
});

test('shows and calls render() exactly once when appId matches from the start', () => {
  const container = document.createElement('div');
  const { getContext, onContextChange } = fakeContext({ appId: 'calendar', segments: ['calendar'] });
  let renderCalls = 0;
  mountAppHeaderAction(container, {
    appId: 'calendar', getContext, onContextChange,
    render: (wrap) => { renderCalls++; wrap.textContent = 'calendar-action'; },
  });

  const wrap = container.querySelector('.qu-app-header-action');
  assert.equal(wrap.hidden, false);
  assert.equal(wrap.textContent, 'calendar-action');
  assert.equal(renderCalls, 1);
});

test('onContextChange toggles visibility without re-calling render() while staying active', () => {
  const container = document.createElement('div');
  const ctx = fakeContext({ appId: 'calendar', segments: ['calendar'] });
  let renderCalls = 0;
  mountAppHeaderAction(container, {
    appId: 'calendar', getContext: ctx.getContext, onContextChange: ctx.onContextChange,
    render: (wrap) => { renderCalls++; wrap.textContent = 'calendar-action'; },
  });
  assert.equal(renderCalls, 1);

  // A route change WITHIN the same app (e.g. #/calendar -> #/calendar/manage) must not re-render.
  ctx.set({ appId: 'calendar', segments: ['calendar', 'manage'] });
  assert.equal(renderCalls, 1);
});

test('navigating away hides the wrap and runs the render()-returned cleanup; navigating back re-renders', () => {
  const container = document.createElement('div');
  const ctx = fakeContext({ appId: 'calendar', segments: ['calendar'] });
  let renderCalls = 0;
  let cleanupCalls = 0;
  mountAppHeaderAction(container, {
    appId: 'calendar', getContext: ctx.getContext, onContextChange: ctx.onContextChange,
    render: (wrap) => {
      renderCalls++;
      wrap.textContent = 'calendar-action';
      return () => { cleanupCalls++; };
    },
  });
  const wrap = container.querySelector('.qu-app-header-action');
  assert.equal(wrap.hidden, false);

  ctx.set({ appId: 'chat', segments: ['chat'] });
  assert.equal(wrap.hidden, true);
  assert.equal(cleanupCalls, 1);
  assert.equal(wrap.textContent, '');

  ctx.set({ appId: 'calendar', segments: ['calendar'] });
  assert.equal(wrap.hidden, false);
  assert.equal(renderCalls, 2);
});
