import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, PinService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { pinMenuItem, renderPinnedBar } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const list = new ListService(qu);
  const services = { pins: new PinService(qu, identity, list) };
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

// ===== renderPinnedBar() - the forum.topicToolbar contributor =============

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
