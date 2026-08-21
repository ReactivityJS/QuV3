import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, MessageService, PinService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { pinMenuItem, renderPinnedBar } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const list = new ListService(qu);
  // `renderPinnedBar()` reads a pinned message's body through
  // `services.messages.getMessage()` (decrypts it if the thread is
  // private - see apps/pins/client.js's own doc comment on WHY, not a raw
  // `qu.get()`), so this env needs a real MessageService alongside PinService,
  // the same pairing both apps/forum's and apps/chat's own tests already use.
  const services = {
    pins: new PinService(qu, identity, list),
    messages: new MessageService(qu, identity, list, null),
  };
  return { qu, services };
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function basePayload({ qu, services }) {
  return { services, qu, spaceId: 'forum-space', threadId: 'topic1' };
}

// ===== pinMenuItem() - the content.messageMenu contributor =================

test('pinMenuItem(): an unpinned message resolves a "Pin" item whose onClick pins it', async () => {
  const env = await freshEnv();
  const item = await pinMenuItem({ ...basePayload(env), messageId: 'msg1' });
  assert.equal(item.id, 'pin');
  assert.equal(item.label, 'Pin');

  await item.onClick();
  assert.deepEqual(await env.services.pins.listPinned('forum-space', 'topic1'), ['msg1']);
});

test('pinMenuItem(): an ALREADY-pinned message resolves an "Unpin" item whose onClick unpins it', async () => {
  const env = await freshEnv();
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);
  const item = await pinMenuItem({ ...basePayload(env), messageId: 'msg1' });
  assert.equal(item.label, 'Unpin');

  await item.onClick();
  assert.deepEqual(await env.services.pins.listPinned('forum-space', 'topic1'), []);
});

test('pinMenuItem(): resolves the CURRENT state fresh on every call (no stale caching between calls)', async () => {
  const env = await freshEnv();
  assert.equal((await pinMenuItem({ ...basePayload(env), messageId: 'msg1' })).label, 'Pin');
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);
  assert.equal((await pinMenuItem({ ...basePayload(env), messageId: 'msg1' })).label, 'Unpin');
});

// ===== renderPinnedBar() - the content.topicToolbar contributor ===========

test('renderPinnedBar(): renders nothing when the topic has no pins', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderPinnedBar(container, basePayload(env));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(container.querySelector('.qu-pins-bar'), null);
});

test('renderPinnedBar(): lists every pinned message\'s stored body, with an unpin control', async () => {
  const env = await freshEnv();
  await env.qu.put(paths.threadMessagePath('forum-space', 'topic1', 'msg1'), { body: 'pin me' });
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);

  const container = makeContainer();
  await renderPinnedBar(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-pins-bar-row') !== null);
  assert.match(container.querySelector('.qu-pins-bar-row').textContent, /pin me/);

  container.querySelector('.qu-pins-bar-row button').click();
  await waitFor(() => container.querySelector('.qu-pins-bar') === null);
  assert.deepEqual(await env.services.pins.listPinned('forum-space', 'topic1'), []);
});

test('renderPinnedBar(): when the host supplies messagePermalink, the pinned row is a real link built from it - clicking it should scroll to the original post', async () => {
  const env = await freshEnv();
  await env.qu.put(paths.threadMessagePath('forum-space', 'topic1', 'msg1'), { body: 'pin me' });
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);

  const container = makeContainer();
  await renderPinnedBar(container, { ...basePayload(env), messagePermalink: (messageId) => `#/forum/t/topic1/m/${messageId}` });
  await waitFor(() => container.querySelector('.qu-pins-bar-row-text') !== null);
  const link = container.querySelector('.qu-pins-bar-row-text');
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), '#/forum/t/topic1/m/msg1');
});

test('renderPinnedBar(): without messagePermalink (no host route to build one from), the row falls back to a plain, unclickable span', async () => {
  const env = await freshEnv();
  await env.qu.put(paths.threadMessagePath('forum-space', 'topic1', 'msg1'), { body: 'pin me' });
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);

  const container = makeContainer();
  await renderPinnedBar(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-pins-bar-row-text') !== null);
  assert.equal(container.querySelector('.qu-pins-bar-row-text').tagName, 'SPAN');
});

test('renderPinnedBar(): a pin added elsewhere in the SAME store appears live', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderPinnedBar(container, basePayload(env));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(container.querySelector('.qu-pins-bar'), null);

  await env.qu.put(paths.threadMessagePath('forum-space', 'topic1', 'msg1'), { body: 'arrived live' });
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);
  await waitFor(() => container.querySelector('.qu-pins-bar-row')?.textContent.includes('arrived live'));
});

test('disconnecting the pinned-bar widget from the DOM tears down its live subscription (no error)', async () => {
  const env = await freshEnv();
  const barContainer = makeContainer();
  await renderPinnedBar(barContainer, basePayload(env));
  barContainer.remove();

  await assert.doesNotReject(() => env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true));
});

// ===== multiple pins ========================================================

test('renderPinnedBar(): pinning several messages shows every one of them, each a live, independently-clickable link; unpinning one removes ONLY that row', async () => {
  const env = await freshEnv();
  for (const id of ['msg1', 'msg2', 'msg3']) {
    await env.qu.put(paths.threadMessagePath('forum-space', 'topic1', id), { body: `body-${id}` });
  }

  const container = makeContainer();
  await renderPinnedBar(container, { ...basePayload(env), messagePermalink: (messageId) => `#/forum/t/topic1/m/${messageId}` });

  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);
  await waitFor(() => container.querySelectorAll('.qu-pins-bar-row').length === 1);

  await env.services.pins.setPinned('forum-space', 'topic1', 'msg2', true);
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg3', true);
  await waitFor(() => container.querySelectorAll('.qu-pins-bar-row').length === 3);

  const links = [...container.querySelectorAll('a.qu-pins-bar-row-text')];
  assert.deepEqual(links.map((l) => l.getAttribute('href')).sort(), [
    '#/forum/t/topic1/m/msg1', '#/forum/t/topic1/m/msg2', '#/forum/t/topic1/m/msg3',
  ]);
  assert.deepEqual(links.map((l) => l.textContent).sort(), ['body-msg1', 'body-msg2', 'body-msg3']);

  // Unpinning one of several removes ONLY that row, from the SAME bar - the
  // rest stay visible and untouched.
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg2', false);
  await waitFor(() => container.querySelectorAll('.qu-pins-bar-row').length === 2);
  assert.deepEqual(
    [...container.querySelectorAll('.qu-pins-bar-row-text')].map((el) => el.textContent).sort(),
    ['body-msg1', 'body-msg3'],
  );
});

test('renderPinnedBar(): beyond COLLAPSE_ROWS pins, the bar collapses with a "Show all" toggle - clicking it expands to show every pinned message, clicking again collapses back', async () => {
  const env = await freshEnv();
  const ids = ['msg1', 'msg2', 'msg3', 'msg4', 'msg5'];
  for (const id of ids) {
    await env.qu.put(paths.threadMessagePath('forum-space', 'topic1', id), { body: id });
    await env.services.pins.setPinned('forum-space', 'topic1', id, true);
  }

  const container = makeContainer();
  await renderPinnedBar(container, basePayload(env));
  await waitFor(() => container.querySelector('.qu-pins-bar-row') !== null);

  // Collapsed by default: fewer rows than pinned messages, plus a clickable toggle.
  assert.ok(container.querySelectorAll('.qu-pins-bar-row').length < ids.length);
  const toggle = container.querySelector('button.qu-pins-bar-title');
  assert.ok(toggle, 'expected a clickable title button to expand the collapsed bar');
  assert.match(toggle.textContent, /Show all/);

  toggle.click();
  await waitFor(() => container.querySelectorAll('.qu-pins-bar-row').length === ids.length);
  assert.deepEqual(
    [...container.querySelectorAll('.qu-pins-bar-row-text')].map((el) => el.textContent).sort(),
    ids,
  );
  assert.match(container.querySelector('button.qu-pins-bar-title').textContent, /Show less/);

  container.querySelector('button.qu-pins-bar-title').click();
  await waitFor(() => container.querySelectorAll('.qu-pins-bar-row').length < ids.length);
});

test('renderPinnedBar(): at or below COLLAPSE_ROWS pins, every pin is shown directly with no collapse toggle at all', async () => {
  const env = await freshEnv();
  for (const id of ['msg1', 'msg2', 'msg3']) {
    await env.qu.put(paths.threadMessagePath('forum-space', 'topic1', id), { body: id });
    await env.services.pins.setPinned('forum-space', 'topic1', id, true);
  }

  const container = makeContainer();
  await renderPinnedBar(container, basePayload(env));
  await waitFor(() => container.querySelectorAll('.qu-pins-bar-row').length === 3);
  assert.equal(container.querySelector('button.qu-pins-bar-title'), null);
});
