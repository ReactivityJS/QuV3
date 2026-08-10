import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, PinService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { renderPinToggle, renderPinnedBar } = await import('../client.js');

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

// ===== renderPinToggle() - the content.messagePinToggle contributor =======

test('renderPinToggle(): shows "Pin" for an unpinned message, toggles to "Unpin" on click', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderPinToggle(container, { ...basePayload(env), messageId: 'msg1' });
  await waitFor(() => container.querySelector('button')?.textContent === 'Pin');

  container.querySelector('button').click();
  await waitFor(() => container.querySelector('button')?.textContent === 'Unpin');
  assert.deepEqual(await env.services.pins.listPinned('forum-space', 'topic1'), ['msg1']);
});

test('renderPinToggle(): reflects an ALREADY-pinned message as "Unpin" on mount', async () => {
  const env = await freshEnv();
  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);
  const container = makeContainer();
  await renderPinToggle(container, { ...basePayload(env), messageId: 'msg1' });
  await waitFor(() => container.querySelector('button')?.textContent === 'Unpin');
});

test('renderPinToggle(): a pin toggled elsewhere in the SAME store updates an already-mounted toggle, live', async () => {
  const env = await freshEnv();
  const container = makeContainer();
  await renderPinToggle(container, { ...basePayload(env), messageId: 'msg1' });
  await waitFor(() => container.querySelector('button')?.textContent === 'Pin');

  await env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true);
  await waitFor(() => container.querySelector('button')?.textContent === 'Unpin');
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

test('disconnecting either widget from the DOM tears down its live subscription (no error)', async () => {
  const env = await freshEnv();
  const toggleContainer = makeContainer();
  await renderPinToggle(toggleContainer, { ...basePayload(env), messageId: 'msg1' });
  await waitFor(() => toggleContainer.querySelector('button') !== null);
  toggleContainer.remove();

  const barContainer = makeContainer();
  await renderPinnedBar(barContainer, basePayload(env));
  barContainer.remove();

  await assert.doesNotReject(() => env.services.pins.setPinned('forum-space', 'topic1', 'msg1', true));
});
