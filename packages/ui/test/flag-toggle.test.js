import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { renderFlagToggle } = await import('../src/flag-toggle.js');

function fakeFlags(initiallyActive) {
  let active = initiallyActive;
  const calls = [];
  return {
    async hasPrivate() { return active; },
    async setPrivate(flagType, entityKind, entityRef, on) {
      calls.push({ flagType, entityKind, entityRef, on });
      active = on;
    },
    calls,
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('renders the inactive icon/title initially, then resolves to the real starred state', async () => {
  const flags = fakeFlags(true);
  const btn = renderFlagToggle({ flags, flagType: 'favorite', entityKind: 'user', entityRef: 'pub1', icon: '☆', activeIcon: '★', title: 'Add', activeTitle: 'Remove' });
  assert.equal(btn.textContent, '☆'); // synchronous initial render, before hasPrivate() resolves
  await flush();
  assert.equal(btn.textContent, '★');
  assert.equal(btn.title, 'Remove');
  assert.ok(btn.classList.contains('qu-flag-toggle-active'));
});

test('clicking toggles the flag, updates the button, and broadcasts qu:flag-changed', async () => {
  const flags = fakeFlags(false);
  const btn = renderFlagToggle({ flags, flagType: 'favorite', entityKind: 'app', entityRef: 'notes', icon: '☆', activeIcon: '★', title: 'Add', activeTitle: 'Remove' });
  await flush();
  document.body.appendChild(btn);

  const events = [];
  window.addEventListener('qu:flag-changed', (e) => events.push(e.detail));

  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();

  assert.equal(btn.textContent, '★');
  assert.deepEqual(flags.calls, [{ flagType: 'favorite', entityKind: 'app', entityRef: 'notes', on: true }]);
  assert.deepEqual(events, [{ flagType: 'favorite', entityKind: 'app', entityRef: 'notes', on: true }]);
});

test('the button is disabled only while the click handler is in flight', async () => {
  const flags = fakeFlags(false);
  let resolveSetPrivate;
  flags.setPrivate = () => new Promise((resolve) => { resolveSetPrivate = () => resolve(); });
  const btn = renderFlagToggle({ flags, flagType: 'favorite', entityKind: 'app', entityRef: 'notes', icon: '☆', title: 'Add' });
  await flush();
  document.body.appendChild(btn);

  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(btn.disabled, true);

  resolveSetPrivate();
  await flush();
  assert.equal(btn.disabled, false);
});
