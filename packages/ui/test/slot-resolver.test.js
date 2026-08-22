import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '../src/testing.js';

installDom();
const { mountResolvedSlot } = await import('../src/slot-resolver.js');

function makeHost() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function clickable(id, extra = {}) {
  const calls = [];
  return { item: { id, icon: id, onClick: () => calls.push(id), ...extra }, calls };
}

// ===== 'inline' ==============================================================

test('"inline" (default) renders one button per item, in order', () => {
  const host = makeHost();
  const a = clickable('a');
  const b = clickable('b');
  mountResolvedSlot(host, [b.item, a.item]); // deliberately out of order - "order" defaults to 0 for both, so insertion order (b, a) wins, not alphabetical
  const buttons = host.querySelectorAll('button');
  assert.equal(buttons.length, 2);
  assert.deepEqual([...buttons].map((btn) => btn.textContent), ['b', 'a']);
});

test('"inline" respects explicit "order"', () => {
  const host = makeHost();
  mountResolvedSlot(host, [
    { id: 'z', icon: 'z', order: 2, onClick: () => {} },
    { id: 'a', icon: 'a', order: 1, onClick: () => {} },
  ]);
  const buttons = host.querySelectorAll('button');
  assert.deepEqual([...buttons].map((btn) => btn.textContent), ['a', 'z']);
});

test('"inline" clicking an item calls its onClick', () => {
  const host = makeHost();
  const a = clickable('a');
  mountResolvedSlot(host, [a.item]);
  host.querySelector('button').click();
  assert.deepEqual(a.calls, ['a']);
});

test('an item with mount() renders its own DOM instead of a plain button (inline only)', () => {
  const host = makeHost();
  mountResolvedSlot(host, [{ id: 'rich', mount: (el) => { el.className = 'my-rich-widget'; } }]);
  assert.ok(host.querySelector('.my-rich-widget'));
  assert.equal(host.querySelectorAll('button').length, 0);
});

// ===== 'menu' =================================================================

test('"menu" collapses every item into one trigger', async () => {
  const host = makeHost();
  const a = clickable('a');
  const b = clickable('b');
  mountResolvedSlot(host, [a.item, b.item], { strategy: 'menu' });

  // Only the menu trigger button exists until opened.
  assert.equal(host.querySelectorAll('button').length, 1);
  host.querySelector('button').click();
  await waitFor(() => host.querySelectorAll('.qu-thread-ui-context-menu-item').length === 2);
  host.querySelectorAll('.qu-thread-ui-context-menu-item')[1].click();
  assert.deepEqual(b.calls, ['b']);
});

// ===== 'inline-then-menu' =====================================================

test('"inline-then-menu": items up to threshold render inline, the rest collapse into one "More" trigger', async () => {
  const host = makeHost();
  const items = ['a', 'b', 'c'].map((id) => clickable(id));
  mountResolvedSlot(host, items.map((x) => x.item), { strategy: 'inline-then-menu', threshold: 2 });

  const inlineButtons = host.querySelectorAll('.qu-slot-resolver-item');
  assert.equal(inlineButtons.length, 2); // a, b inline
  assert.deepEqual([...inlineButtons].map((btn) => btn.textContent), ['a', 'b']);

  const moreTrigger = host.querySelector('.qu-thread-ui-context-menu-trigger');
  assert.ok(moreTrigger);
  moreTrigger.click();
  await waitFor(() => host.querySelectorAll('.qu-thread-ui-context-menu-item').length === 1);
  host.querySelector('.qu-thread-ui-context-menu-item').click();
  assert.deepEqual(items[2].calls, ['c']); // the collapsed one - "c"
});

test('"inline-then-menu" with fewer items than the threshold renders everything inline, no "More" trigger', () => {
  const host = makeHost();
  const items = ['a', 'b'].map((id) => clickable(id));
  mountResolvedSlot(host, items.map((x) => x.item), { strategy: 'inline-then-menu', threshold: 5 });
  assert.equal(host.querySelectorAll('.qu-slot-resolver-item').length, 2);
  assert.equal(host.querySelector('.qu-thread-ui-context-menu-trigger'), null);
});

// ===== 'switch' ================================================================

test('"switch" renders the first item whose when(state) is true', () => {
  const host = makeHost();
  const slot = mountResolvedSlot(host, [
    { id: 'send', icon: '➤', when: (s) => s.hasText, onClick: () => {} },
    { id: 'voice', icon: '🎙️', onClick: () => {} }, // no when - the "else"
  ], { strategy: 'switch' });

  slot.resolve({ hasText: false });
  assert.equal(host.querySelector('button').textContent, '🎙️');

  slot.resolve({ hasText: true });
  assert.equal(host.querySelector('button').textContent, '➤');
});

test('"switch" falls back to the last item when nothing else matches, even if it has its own (false) "when"', () => {
  const host = makeHost();
  const slot = mountResolvedSlot(host, [
    { id: 'a', icon: 'a', when: () => false, onClick: () => {} },
    { id: 'b', icon: 'b', when: () => false, onClick: () => {} },
  ], { strategy: 'switch' });
  slot.resolve({});
  assert.equal(host.querySelector('button').textContent, 'b');
});

test('"switch" does not tear down and rebuild the DOM when the winning item is unchanged across resolve() calls', () => {
  const host = makeHost();
  const slot = mountResolvedSlot(host, [
    { id: 'send', icon: '➤', when: (s) => s.hasText, onClick: () => {} },
    { id: 'voice', icon: '🎙️', onClick: () => {} },
  ], { strategy: 'switch' });
  slot.resolve({ hasText: true });
  const btn1 = host.querySelector('button');
  slot.resolve({ hasText: true });
  const btn2 = host.querySelector('button');
  assert.equal(btn1, btn2); // same DOM node, not replaced
});

// ===== setItems() / stop() ====================================================

test('setItems() replaces the rendered items', () => {
  const host = makeHost();
  const slot = mountResolvedSlot(host, [{ id: 'a', icon: 'a', onClick: () => {} }]);
  assert.equal(host.querySelectorAll('button').length, 1);
  slot.setItems([{ id: 'a', icon: 'a', onClick: () => {} }, { id: 'b', icon: 'b', onClick: () => {} }]);
  assert.equal(host.querySelectorAll('button').length, 2);
});

test('stop() removes the rendered root from the DOM', () => {
  const host = makeHost();
  const slot = mountResolvedSlot(host, [{ id: 'a', icon: 'a', onClick: () => {} }]);
  slot.stop();
  assert.equal(host.querySelectorAll('button').length, 0);
});
