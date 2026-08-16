import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, FlagService, ContactsService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';
import { installFakeMediaDevices } from './fake-media-devices.js';

installFakeRTCPeerConnection();
installFakeMediaDevices();
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
  const flags = new FlagService(qu, identity, list);
  const contacts = new ContactsService(flags, identity);
  const apps = [{ name: 'phone', spaceId: 'test-phone-space' }];
  return { qu, identity, services: { messages, contacts }, apps };
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('#/phone with no contacts shows the empty state', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone'] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-empty') !== null);
  } finally {
    stop();
  }
});

test('#/phone lists a contact with a Call button that navigates to #/phone/<pub>', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const contactPub = (await QuCrypto.generateKeypair()).publicKey;
  const contactPubB64 = QuCrypto.toBase64Url(contactPub);
  await services.contacts.addContact(contactPubB64);

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone'] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-contacts li') !== null);
    const row = container.querySelector('.qu-phone-contacts li');
    // No published profile for this contact yet - formatActorLabel() falls back to a truncated pubkey (same convention apps/contact-list uses).
    assert.ok(row.textContent.includes(contactPubB64.slice(0, 10)));
    row.querySelector('button').click();
    assert.equal(window.location.hash, `#/phone/${contactPubB64}`);
  } finally {
    stop();
  }
});

test('#/phone/<pub> (caller) shows "Calling…" and enables controls once local media is ready', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-a'] });
  try {
    assert.ok(container.querySelector('.qu-phone-status').textContent.match(/calling|rufe an/i));
    await waitFor(() => container.querySelector('.qu-phone-local-video').srcObject != null);
  } finally {
    stop();
  }
});

test('#/phone/<pub>/accept (callee) shows "Ringing…" instead of "Calling…"', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-b', 'accept'] });
  try {
    assert.ok(container.querySelector('.qu-phone-status').textContent.match(/ringing|klingelt/i));
  } finally {
    stop();
  }
});

test('mute/video toggle buttons flip data-active after a click, once the call is ready', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-c'] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-local-video').srcObject != null);
    const [muteBtn, videoBtn] = container.querySelectorAll('.qu-phone-controls button');
    assert.equal(muteBtn.dataset.active, 'true');
    muteBtn.click();
    assert.equal(muteBtn.dataset.active, 'false');
    videoBtn.click();
    assert.equal(videoBtn.dataset.active, 'false');
  } finally {
    stop();
  }
});

test('#/phone/<pub>/decline shows a declined confirmation with no camera/mic view at all', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-d', 'decline'] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-error')?.textContent.match(/declined|abgelehnt/i));
    assert.equal(container.querySelector('.qu-phone-local-video'), null);
  } finally {
    stop();
  }
});

test('getUserMedia() denial shows a visible error instead of a silent failure', async () => {
  installFakeMediaDevices({ deny: true });
  try {
    const { qu, identity, services, apps } = await freshEnv();
    const container = makeContainer();
    const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-e'] });
    try {
      await waitFor(() => container.querySelector('.qu-phone-error') !== null);
      assert.ok(container.querySelector('.qu-phone-controls').hidden);
    } finally {
      stop();
    }
  } finally {
    installFakeMediaDevices({ deny: false });
  }
});
