import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { Transport } from '@qu/sync/transport';
import { ListService, AccessService, MessageService, FlagService, ContactsService, ProfileService } from '@qu/services';
import { actorPath } from '@qu/identity';
import { installDom, waitFor } from '@qu/ui/testing';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';
import { installFakeMediaDevices } from './fake-media-devices.js';

installFakeRTCPeerConnection();
installFakeMediaDevices();
installDom();
const { mount, renderCallMenuItems } = await import('../client.js');

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
  const profile = new ProfileService(qu, identity);
  const apps = [{ name: 'phone', spaceId: 'test-phone-space' }];
  return { qu, identity, services: { messages, contacts, profile }, apps };
}

/**
 * Publishes a real, signed profile (with an alias) for a SECOND identity, in
 * its OWN separate `QuStore` (a `QuStore` holds exactly one identity's seed
 * at a time - see `QuIdentityEngine.importMnemonic()`'s own guard), then
 * copies just the resulting signed profile QuBit into `env.qu` via
 * `putSealed()` - exactly `call.test.js`'s own `mirrorProfiles()` technique,
 * simulating "as if sync had already delivered it" without a real
 * SyncEngine/relay for these single-store DOM tests. Returns the second
 * identity's own pub - use it as `remotePub` in a `mount()` call to prove
 * alias resolution actually works end-to-end.
 */
async function publishedContact(env, alias) {
  const contactQu = new QuStore();
  contactQu.mount('store', new MemoryStoreAdapter());
  const contactIdentity = new QuIdentityEngine(contactQu);
  await contactIdentity.importMnemonic(contactIdentity.generateMnemonic());
  await contactIdentity.publishMainProfile({ alias });
  const contactPub = QuCrypto.toBase64Url((await contactIdentity.getMainKey()).publicKey);
  const profileQuBit = await contactQu.get(actorPath(contactPub, 'profile'));
  await env.qu.putSealed(actorPath(contactPub, 'profile'), profileQuBit);
  return contactPub;
}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// ===== Two REAL, connected client.js mounts - a genuine client-relay star,
// same TestNetwork/RelayTransport/ClientTransport pattern as
// apps/phone/test/call.test.js and apps/geochase/test/mesh.test.js. Every
// test above this point mounts only ONE side against fake/unreachable
// `remote-pub-*` strings - enough to test THAT side's own UI reacting to
// its own state, but not whether a track this side sends actually reaches
// the OTHER side's DOM. `remoteVideo.srcObject` (the actual `onTrack` ->
// DOM wiring in mountActiveCall()) was never exercised by any test until
// this section - see this plan's own "Bugfix-Runde" section on the
// investigation that found this gap. =====

class TestNetwork {
  #relayHandlers = [];
  #clientHandlersByPeerId = new Map();
  registerRelay(onMessage) { this.#relayHandlers.push(onMessage); }
  registerClient(peerId, onMessage) { this.#clientHandlersByPeerId.set(peerId, onMessage); }
  fromClientToRelay(peerId, data) { for (const cb of this.#relayHandlers) cb({ data, peerId }); }
  fromRelayToClient(peerId, data) { this.#clientHandlersByPeerId.get(peerId)?.({ data, peerId: 'relay' }); }
  fromRelayBroadcast(data) { for (const [, cb] of this.#clientHandlersByPeerId) cb({ data, peerId: 'relay' }); }
}

class RelayTransport extends Transport {
  #network;
  constructor(network) { super(); this.#network = network; }
  async connect() {}
  getPeerId() { return 'relay'; }
  onMessage(cb) { this.#network.registerRelay(cb); }
  send(data) { this.#network.fromRelayBroadcast(data); }
  sendTo(peerId, data) { this.#network.fromRelayToClient(peerId, data); }
}

class ClientTransport extends Transport {
  #network; #peerId;
  constructor(peerId, network) { super(); this.#peerId = peerId; this.#network = network; }
  async connect() {}
  getPeerId() { return this.#peerId; }
  onMessage(cb) { this.#network.registerClient(this.#peerId, cb); }
  send(data) { this.#network.fromClientToRelay(this.#peerId, data); }
  sendTo(_peerId, data) { this.send(data); }
}

async function freshParticipant(clientPeerId, network) {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({}); // see call.test.js's own freshParticipant() doc comment - needed for postMessage()'s encryption step
  const pub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const clientTransport = new ClientTransport(clientPeerId, network);
  const sync = new SyncEngine(qu, clientTransport, { publishAllTo: clientTransport.getPeerId() });

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const apps = [{ name: 'phone', spaceId: 'phone-e2e-space' }];

  return {
    qu, identity, pub, apps,
    services: { messages },
    subscribe: (prefix) => sync.subscribe(prefix),
    syncFetch: (prefix) => sync.fetchPrefix(prefix),
  };
}

test('E2E: when the CALLER upgrades to video mid-call, the CALLEE\'s remoteVideo DOM element gets the video track too - without the callee doing anything', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('dom-caller', network);
  const callee = await freshParticipant('dom-callee', network);

  const callerContainer = makeContainer();
  const calleeContainer = makeContainer();
  const stopCaller = mount(callerContainer, {
    qu: caller.qu, identity: caller.identity, services: caller.services, apps: caller.apps,
    segments: ['phone', callee.pub], subscribe: caller.subscribe, syncFetch: caller.syncFetch,
  });
  const stopCallee = mount(calleeContainer, {
    qu: callee.qu, identity: callee.identity, services: callee.services, apps: callee.apps,
    segments: ['phone', caller.pub, 'accept'], subscribe: callee.subscribe, syncFetch: callee.syncFetch,
  });

  try {
    await waitFor(() => callerContainer.querySelector('.qu-phone-status').textContent.match(/connected|verbunden/i) !== null);
    await waitFor(() => calleeContainer.querySelector('.qu-phone-status').textContent.match(/connected|verbunden/i) !== null);

    // Caller upgrades to video - audio-only by default, so this is a real
    // renegotiation (see call.js's own upgradeToVideo() doc comment), not a
    // pre-existing track just being unmuted.
    const [, callerVideoBtn] = callerContainer.querySelectorAll('.qu-phone-controls button');
    callerVideoBtn.click();

    // The callee never touches its own video button - this asserts the
    // ACTUAL DOM binding (mountActiveCall()'s `onTrack: (stream) => {
    // remoteVideo.srcObject = stream; }`), not just the underlying
    // transport/service layer (already covered by call.test.js's own
    // "upgradeToVideo() adds a video track..." test).
    await waitFor(() => {
      const remoteVideo = calleeContainer.querySelector('.qu-phone-remote-video');
      return remoteVideo?.srcObject?.getVideoTracks?.().length > 0;
    }, 3000);
  } finally {
    stopCaller();
    stopCallee();
  }
});

// ===== Post-call summary (Anrufstatistik) on hangup =====

test('hanging up AFTER connecting shows a summary (contact, date, duration, back link) instead of navigating away immediately', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('summary-caller', network);
  const callee = await freshParticipant('summary-callee', network);

  const container = makeContainer();
  const calleeContainer = makeContainer();
  const stopCaller = mount(container, {
    qu: caller.qu, identity: caller.identity, services: caller.services, apps: caller.apps,
    segments: ['phone', callee.pub], subscribe: caller.subscribe, syncFetch: caller.syncFetch,
  });
  const stopCallee = mount(calleeContainer, {
    qu: callee.qu, identity: callee.identity, services: callee.services, apps: callee.apps,
    segments: ['phone', caller.pub, 'accept'], subscribe: callee.subscribe, syncFetch: callee.syncFetch,
  });

  try {
    await waitFor(() => container.querySelector('.qu-phone-status').textContent.match(/connected|verbunden/i) !== null);
    await new Promise((resolve) => setTimeout(resolve, 50)); // a non-zero, assertable call duration

    const originalHash = window.location.hash;
    const [, , hangupBtn] = container.querySelectorAll('.qu-phone-controls button');
    hangupBtn.click();

    await waitFor(() => container.querySelector('.qu-phone-summary') !== null);
    assert.equal(window.location.hash, originalHash); // no navigation yet - the summary replaced the view in place
    assert.ok(container.querySelector('.qu-phone-summary-name').textContent.length > 0);
    assert.match(container.querySelector('.qu-phone-summary-meta').textContent, /\d+:\d{2}/); // m:ss duration
    assert.equal(container.querySelector('.qu-phone-controls'), null); // old call controls are gone

    container.querySelector('.qu-phone-summary-back').click();
    assert.equal(window.location.hash, '#/phone');
  } finally {
    stopCaller();
    stopCallee();
  }
});

test('hanging up BEFORE ever connecting still navigates back immediately - nothing to summarize', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  // remote-pub-never-answers never exists as a real peer - the call stays on "Rufe an…" forever.
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-never-answers'] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-status').textContent.match(/calling|rufe an/i) !== null);
    const [, , hangupBtn] = container.querySelectorAll('.qu-phone-controls button');
    hangupBtn.click();
    assert.equal(window.location.hash, '#/phone');
    assert.equal(container.querySelector('.qu-phone-summary'), null);
  } finally {
    stop();
  }
});

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

test('#/phone/<pub> (caller, audio-only default) never requests video up front, and hides the local PiP until upgraded', async () => {
  const calls = installFakeMediaDevices();
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-audio'] });
  try {
    assert.ok(container.querySelector('.qu-phone-status').textContent.match(/calling|rufe an/i)); // still the CALLER
    await waitFor(() => calls.length > 0); // getUserMedia() only actually runs inside the async createPhoneCall() below
    assert.deepEqual(calls, [{ audio: true, video: false }]);
    assert.equal(container.querySelector('.qu-phone-local-video').hidden, true);
    // Mute, video (now an "upgrade to video" trigger, not a toggle), and hangup are all visible.
    assert.equal(container.querySelectorAll('.qu-phone-controls button:not([hidden])').length, 3);
  } finally {
    stop();
    installFakeMediaDevices(); // restore the default (both tracks) for any later test in this file
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

test('a call that never connects shows a distinct "could not connect" error after negotiationTimeoutMs, instead of hanging on "Calling…" forever', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  // Short override (see mountActiveCall()'s own doc comment) - remote-pub-f
  // never answers at all, exactly the no-usable-ICE-candidate-pair failure
  // this Bugfix addresses (see the plan's own "Bugfix: Keine WebRTC-
  // Verbindung..." section).
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-f'], negotiationTimeoutMs: 30 });
  try {
    await waitFor(() => container.querySelector('.qu-phone-status').textContent.match(/could not connect|nicht verbunden werden/i));
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

// ===== Alias-first identity display (formatActorLabel(), same convention
// apps/chat already uses) - "wir arbeiten immer lieber mit dem Alias" =====

test('the active call view shows the OTHER party\'s published alias, not their raw pub', async () => {
  const env = await freshEnv();
  const contactPub = await publishedContact(env, 'Bob Contact');
  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: env.apps, segments: ['phone', contactPub] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-peer-name')?.textContent === 'Bob Contact');
    assert.equal(container.querySelector('.qu-phone-peer-name').textContent.includes(contactPub), false);
  } finally {
    stop();
  }
});

test('the active call view falls back to a truncated pub when the other party has no published profile', async () => {
  const { qu, identity, services, apps } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps, segments: ['phone', 'remote-pub-noprofile'] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-peer-name') !== null);
    // formatActorLabel()'s own no-profile fallback shape (~<truncated pub>…),
    // set synchronously on mount and left alone once the (failed/empty)
    // profile lookup settles - never the raw, un-truncated segment.
    assert.ok(container.querySelector('.qu-phone-peer-name').textContent.startsWith('~'));
  } finally {
    stop();
  }
});

test('the declined confirmation shows the OTHER party\'s published alias too', async () => {
  const env = await freshEnv();
  const contactPub = await publishedContact(env, 'Carol Contact');
  const container = makeContainer();
  const stop = mount(container, { qu: env.qu, identity: env.identity, services: env.services, apps: env.apps, segments: ['phone', contactPub, 'decline'] });
  try {
    await waitFor(() => container.querySelector('.qu-phone-error')?.textContent.includes('Carol Contact'));
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

// ===== renderCallMenuItems() - the content.chatRoomMenu contributor =====

test('renderCallMenuItems() returns nothing for a group (no contactPub) - Phone has no notion of a group call', () => {
  assert.deepEqual(renderCallMenuItems({ contactPub: null }), []);
});

test('renderCallMenuItems() returns Audio Call/Video Call for a 1:1 room, linking to #/phone/<pub> (audio default) and #/phone/<pub>/video', () => {
  const items = renderCallMenuItems({ contactPub: 'peer-a' });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.id), ['audioCall', 'videoCall']);

  const originalHash = window.location.hash;
  try {
    items.find((i) => i.id === 'audioCall').onClick();
    assert.equal(window.location.hash, '#/phone/peer-a');
    items.find((i) => i.id === 'videoCall').onClick();
    assert.equal(window.location.hash, '#/phone/peer-a/video');
  } finally {
    window.location.hash = originalHash;
  }
});
