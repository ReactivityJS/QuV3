import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '@qu/ui/testing';

installDom();
const { renderContextMenu } = await import('../src/context-menu.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('renders just the trigger button until clicked', () => {
  const host = makeHost();
  const el = renderContextMenu({ getItems: () => [{ id: 'a', label: 'A', onClick: () => {} }], trigger: '⋮' });
  host.appendChild(el);
  const buttons = el.querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, '⋮');
  assert.equal(el.querySelector('.qu-thread-ui-context-menu-panel'), null);
});

test('clicking the trigger opens the panel with one button per item, in the given order', async () => {
  const host = makeHost();
  const el = renderContextMenu({
    getItems: () => [{ id: 'edit', label: 'Edit', icon: '✏️', onClick: () => {} }, { id: 'pin', label: 'Pin', onClick: () => {} }],
  });
  host.appendChild(el);
  el.querySelector('button').click();
  await tick();

  const panel = el.querySelector('.qu-thread-ui-context-menu-panel');
  assert.ok(panel);
  const items = panel.querySelectorAll('.qu-thread-ui-context-menu-item');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Edit/);
  assert.match(items[1].textContent, /Pin/);
});

test('getItems() is called fresh on every open (supports async, live-computed items)', async () => {
  const host = makeHost();
  let calls = 0;
  const el = renderContextMenu({
    getItems: async () => { calls++; return [{ id: 'pin', label: calls === 1 ? 'Pin' : 'Unpin', onClick: () => {} }]; },
  });
  host.appendChild(el);
  const trigger = el.querySelector('button');

  trigger.click();
  await tick();
  assert.match(el.querySelector('.qu-thread-ui-context-menu-item').textContent, /Pin$/);

  trigger.click(); // close
  await tick();
  trigger.click(); // reopen - fresh getItems() call
  await tick();
  assert.equal(calls, 2);
  assert.match(el.querySelector('.qu-thread-ui-context-menu-item').textContent, /Unpin/);
});

test('clicking an item runs its onClick and closes the panel', async () => {
  const host = makeHost();
  let clicked = false;
  const el = renderContextMenu({ getItems: () => [{ id: 'edit', label: 'Edit', onClick: () => { clicked = true; } }] });
  host.appendChild(el);
  el.querySelector('button').click();
  await tick();
  el.querySelector('.qu-thread-ui-context-menu-item').click();

  assert.equal(clicked, true);
  assert.equal(el.querySelector('.qu-thread-ui-context-menu-panel'), null);
});

test('an empty item list shows the empty-state label instead of a blank panel', async () => {
  const host = makeHost();
  const el = renderContextMenu({ getItems: () => [], emptyLabel: 'Nothing here' });
  host.appendChild(el);
  el.querySelector('button').click();
  await tick();
  assert.match(el.querySelector('.qu-thread-ui-context-menu-panel').textContent, /Nothing here/);
});

test('clicking the trigger again while open closes it (toggle)', async () => {
  const host = makeHost();
  const el = renderContextMenu({ getItems: () => [{ id: 'a', label: 'A', onClick: () => {} }] });
  host.appendChild(el);
  const trigger = el.querySelector('button');
  trigger.click();
  await tick();
  assert.ok(el.querySelector('.qu-thread-ui-context-menu-panel'));
  trigger.click();
  assert.equal(el.querySelector('.qu-thread-ui-context-menu-panel'), null);
});

test('clicking outside the menu closes an open panel', async () => {
  const host = makeHost();
  const el = renderContextMenu({ getItems: () => [{ id: 'a', label: 'A', onClick: () => {} }] });
  host.appendChild(el);
  el.querySelector('button').click();
  await tick();
  assert.ok(el.querySelector('.qu-thread-ui-context-menu-panel'));

  document.body.click();
  assert.equal(el.querySelector('.qu-thread-ui-context-menu-panel'), null);
});

test('destroy() closes an open panel and removes the document-level listeners, even after the root was detached', async () => {
  const host = makeHost();
  const el = renderContextMenu({ getItems: () => [{ id: 'a', label: 'A', onClick: () => {} }] });
  host.appendChild(el);
  el.querySelector('button').click();
  await tick();
  assert.ok(el.querySelector('.qu-thread-ui-context-menu-panel'));

  el.remove(); // simulate a row being torn down while its menu is still open
  el.destroy();
  assert.equal(el.querySelector('.qu-thread-ui-context-menu-panel'), null);

  // If the document-level listeners weren't removed, a stray click here
  // would throw trying to close an already-removed panel a second time (or
  // otherwise misbehave) - this only passes cleanly if destroy() actually
  // tore them down.
  assert.doesNotThrow(() => document.body.click());
});

test('destroy() is a harmless no-op when no panel is open', () => {
  const host = makeHost();
  const el = renderContextMenu({ getItems: () => [{ id: 'a', label: 'A', onClick: () => {} }] });
  host.appendChild(el);
  assert.doesNotThrow(() => el.destroy());
});

test('opening near the bottom of the viewport flips the panel upward (flipUpIfNeeded)', async () => {
  const host = makeHost();
  const el = renderContextMenu({ getItems: () => [{ id: 'a', label: 'A', onClick: () => {} }] });
  host.appendChild(el);
  const trigger = el.querySelector('button');
  window.innerHeight = 400;
  trigger.getBoundingClientRect = () => ({ top: 380, bottom: 395, left: 0, right: 0, width: 0, height: 15 });

  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('qu-thread-ui-context-menu-panel')) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 200 };
    return original.call(this);
  };
  try {
    trigger.click();
    await tick();
    const panel = el.querySelector('.qu-thread-ui-context-menu-panel');
    assert.ok(panel);
    assert.equal(panel.classList.contains('qu-thread-ui-context-menu-panel-flip-up'), true);
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = original;
  }
});
