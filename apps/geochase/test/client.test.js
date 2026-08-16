import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';

installFakeRTCPeerConnection();
installDom();
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const apps = [{ name: 'geochase', spaceId: 'test-geochase-space' }];
  return { qu, identity, services: { messages }, apps };
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('mounting shows the title, an initially-disabled share button, and "no players yet" once the mesh is ready', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['geochase'] });
  try {
    assert.ok(container.querySelector('h1').textContent.includes('default'));

    const shareBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.match(/shar|teil/i));
    assert.ok(shareBtn);
    assert.equal(shareBtn.disabled, true); // mesh is still being created asynchronously

    await waitFor(() => !shareBtn.disabled);
    await waitFor(() => container.querySelector('.qu-geochase-empty') !== null);
  } finally {
    stop();
  }
});

test('a named game id from the URL renders in the heading', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['geochase', 'my-game'] });
  try {
    assert.ok(container.querySelector('h1').textContent.includes('my-game'));
  } finally {
    stop();
  }
});
