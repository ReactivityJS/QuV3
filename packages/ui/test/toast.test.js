import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
const { mountToastHost } = await import('../src/toast.js');

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('show() renders title, body, and a close button; close button dismisses it', () => {
  const { show } = mountToastHost(makeContainer());
  show({ title: 'Incoming call', body: 'peer-a is calling' });

  const toast = document.querySelector('.qu-toast');
  assert.ok(toast);
  assert.equal(toast.querySelector('.qu-toast-title').textContent, 'Incoming call');
  assert.equal(toast.querySelector('.qu-toast-body').textContent, 'peer-a is calling');

  toast.querySelector('.qu-toast-close').click();
  assert.equal(document.querySelector('.qu-toast'), null);
});

test('actions render as links (href) or buttons (onClick), both dismiss on click', () => {
  const { show } = mountToastHost(makeContainer());
  let declined = false;
  show({
    title: 'Incoming call',
    actions: [
      { label: 'Accept', href: '#/phone/peer-a/accept' },
      { label: 'Decline', onClick: () => { declined = true; }, primary: false },
    ],
  });

  const [acceptEl, declineEl] = document.querySelectorAll('.qu-toast-actions > *');
  assert.equal(acceptEl.tagName, 'A');
  assert.equal(acceptEl.getAttribute('href'), '#/phone/peer-a/accept');
  assert.equal(declineEl.tagName, 'BUTTON');
  assert.ok(declineEl.classList.contains('qu-toast-action-secondary'));

  declineEl.click();
  assert.ok(declined);
  assert.equal(document.querySelector('.qu-toast'), null);
});

test('actions support an optional tone (positive/danger) for color, and an icon prepended to the label', () => {
  const container = makeContainer();
  const { show } = mountToastHost(container);
  const dismiss = show({
    title: 'Incoming call',
    actions: [
      { label: 'Accept', href: '#/phone/peer-a/accept', tone: 'positive', icon: '📞' },
      { label: 'Decline', onClick: () => {}, tone: 'danger', icon: '📵' },
    ],
  });

  const [acceptEl, declineEl] = container.querySelectorAll('.qu-toast-actions > *');
  assert.ok(acceptEl.classList.contains('qu-toast-action-positive'));
  assert.equal(acceptEl.textContent, '📞 Accept');
  assert.ok(declineEl.classList.contains('qu-toast-action-danger'));
  assert.equal(declineEl.textContent, '📵 Decline');
  dismiss(); // other tests in this file query the shared global `document`, not just this test's own container
});

test('an action with neither tone nor icon renders exactly as before (plain label, no extra class)', () => {
  const container = makeContainer();
  const { show } = mountToastHost(container);
  const dismiss = show({ title: 'x', actions: [{ label: 'Open', href: '#/somewhere' }] });
  const el = container.querySelector('.qu-toast-actions > *');
  assert.equal(el.textContent, 'Open');
  assert.equal(el.classList.contains('qu-toast-action-positive'), false);
  assert.equal(el.classList.contains('qu-toast-action-danger'), false);
  dismiss();
});

test('durationMs auto-dismisses the toast without a click', async () => {
  const { show } = mountToastHost(makeContainer());
  show({ title: 'Auto-dismiss', durationMs: 5 });
  assert.ok(document.querySelector('.qu-toast'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(document.querySelector('.qu-toast'), null);
});

test('the dismiss function show() returns closes that toast directly, and onDismiss fires exactly once', () => {
  const { show } = mountToastHost(makeContainer());
  let dismissCount = 0;
  const dismiss = show({ title: 'x', onDismiss: () => { dismissCount++; } });
  assert.ok(document.querySelector('.qu-toast'));
  dismiss();
  assert.equal(document.querySelector('.qu-toast'), null);
  assert.equal(dismissCount, 1);
  dismiss(); // idempotent - a second call must not double-fire onDismiss
  assert.equal(dismissCount, 1);
});

test('multiple show() calls stack multiple toasts', () => {
  const { show } = mountToastHost(makeContainer());
  show({ title: 'First' });
  show({ title: 'Second' });
  const toasts = document.querySelectorAll('.qu-toast');
  assert.equal(toasts.length, 2);
});

test('destroy() removes the whole host, including any still-open toasts', () => {
  const container = makeContainer();
  const { show, destroy } = mountToastHost(container);
  show({ title: 'x' });
  assert.ok(container.querySelector('.qu-toast-host'));
  destroy();
  assert.equal(container.querySelector('.qu-toast-host'), null);
});
