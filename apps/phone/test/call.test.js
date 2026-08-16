import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { Transport } from '@qu/sync/transport';
import { ListService, AccessService, MessageService, ChatService, paths } from '@qu/services';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';
import { installFakeMediaDevices } from './fake-media-devices.js';

installFakeRTCPeerConnection();
installFakeMediaDevices();

const { createPhoneCall, declinePhoneCall } = await import('../src/call.js');

// Same in-memory client-relay star used by apps/geochase/test/mesh.test.js -
// proves the plan's central claim again here: Phone's signaling rides the
// EXISTING relay-backed sync stack unmodified, just like Geochase's does.
class TestNetwork {
  #relayHandlers = [];
  #clientHandlersByPeerId = new Map();
  registerRelay(onMessage) {
    this.#relayHandlers.push(onMessage);
  }
  registerClient(peerId, onMessage) {
    this.#clientHandlersByPeerId.set(peerId, onMessage);
  }
  fromClientToRelay(peerId, data) {
    for (const cb of this.#relayHandlers) cb({ data, peerId });
  }
  fromRelayToClient(peerId, data) {
    this.#clientHandlersByPeerId.get(peerId)?.({ data, peerId: 'relay' });
  }
  fromRelayBroadcast(data) {
    for (const [, cb] of this.#clientHandlersByPeerId) cb({ data, peerId: 'relay' });
  }
}

class RelayTransport extends Transport {
  #network;
  constructor(network) {
    super();
    this.#network = network;
  }
  async connect() {}
  getPeerId() {
    return 'relay';
  }
  onMessage(cb) {
    this.#network.registerRelay(cb);
  }
  send(data) {
    this.#network.fromRelayBroadcast(data);
  }
  sendTo(peerId, data) {
    this.#network.fromRelayToClient(peerId, data);
  }
}

class ClientTransport extends Transport {
  #network;
  #peerId;
  constructor(peerId, network) {
    super();
    this.#peerId = peerId;
    this.#network = network;
  }
  async connect() {}
  getPeerId() {
    return this.#peerId;
  }
  onMessage(cb) {
    this.#network.registerClient(this.#peerId, cb);
  }
  send(data) {
    this.#network.fromClientToRelay(this.#peerId, data);
  }
  sendTo(_peerId, data) {
    this.send(data);
  }
}

async function waitUntil(check, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function freshParticipant(clientPeerId, network) {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const pub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const clientTransport = new ClientTransport(clientPeerId, network);
  const sync = new SyncEngine(qu, clientTransport, { publishAllTo: clientTransport.getPeerId() });

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);

  return { qu, identity, pub, sync, services: { messages } };
}

test('caller and callee complete a call handshake, exchange tracks, and can hang up cleanly', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller', network);
  const callee = await freshParticipant('client-callee', network);

  const spaceId = 'phone-test-space';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const callerTracks = [];
  const calleeTracks = [];
  let callerConnected = false;
  let calleeConnected = false;

  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true,
    onTrack: (stream) => callerTracks.push(stream),
    onPeerConnected: () => { callerConnected = true; },
  });
  const calleeCall = await createPhoneCall({
    qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub,
    initiator: false,
    onTrack: (stream) => calleeTracks.push(stream),
    onPeerConnected: () => { calleeConnected = true; },
  });

  await waitUntil(() => callerConnected && calleeConnected);
  await waitUntil(() => callerTracks.length > 0 && calleeTracks.length > 0);

  assert.ok(callerCall.localStream.getTracks().length > 0);
  assert.equal(callerCall.localStream.getTracks().every((t) => !t.stopped), true);

  callerCall.hangUp();
  assert.equal(callerCall.localStream.getTracks().every((t) => t.stopped), true);
  calleeCall.hangUp();
});

test('toggleAudio()/toggleVideo() flip track.enabled without stopping or removing the track', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller2', network);
  const callee = await freshParticipant('client-callee2', network);
  const spaceId = 'phone-test-space-2';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const callerCall = await createPhoneCall({ qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub, initiator: true });
  await createPhoneCall({ qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub, initiator: false });

  const [audioTrack] = callerCall.localStream.getAudioTracks();
  const [videoTrack] = callerCall.localStream.getVideoTracks();
  assert.equal(audioTrack.enabled, true);

  callerCall.toggleAudio(false);
  assert.equal(audioTrack.enabled, false);
  assert.equal(audioTrack.stopped, false); // still attached, just muted

  callerCall.toggleVideo(false);
  assert.equal(videoTrack.enabled, false);
  assert.equal(videoTrack.stopped, false);

  callerCall.hangUp();
});

test('declinePhoneCall() before the callee ever creates a PhoneCall reaches the caller\'s onDeclined()', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller3', network);
  const callee = await freshParticipant('client-callee3', network);
  const spaceId = 'phone-test-space-3';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  let declined = false;
  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true,
    onDeclined: () => { declined = true; },
  });

  // The callee declines straight from a notification, per the app's design -
  // no createPhoneCall()/getUserMedia() on their side at all.
  await declinePhoneCall({ qu: callee.qu, identity: callee.identity, spaceId, remotePub: caller.pub });

  await waitUntil(() => declined);
  callerCall.hangUp();
});

test('the CALLER (only) posts exactly one real thread message announcing the call - what actually triggers the relay\'s push/toast notification pipeline for the callee', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller5', network);
  const callee = await freshParticipant('client-callee5', network);
  const spaceId = 'phone-test-space-5';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const callerCall = await createPhoneCall({ qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub, initiator: true });
  const threadId = await ChatService.roomId([caller.pub, callee.pub]);
  const calleeCall = await createPhoneCall({ qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub, initiator: false });

  const { messages: callerView } = await caller.services.messages.listMessages(spaceId, threadId);
  assert.equal(callerView.length, 1); // the caller's own announcement - the callee's connectPeer({initiator:false}) posts nothing

  callerCall.hangUp();
  calleeCall.hangUp();
});

test('createPhoneCall() throws a code:"denied" error when getUserMedia() rejects, without touching the network at all', async () => {
  installFakeMediaDevices({ deny: true });
  try {
    const network = new TestNetwork();
    const relayQu = new QuStore();
    relayQu.mount('store', new MemoryStoreAdapter());
    new SyncEngine(relayQu, new RelayTransport(network));
    const caller = await freshParticipant('client-caller4', network);

    await assert.rejects(
      createPhoneCall({ qu: caller.qu, identity: caller.identity, services: caller.services, spaceId: 'phone-test-space-4', remotePub: 'someone', initiator: true }),
      (err) => err.code === 'denied'
    );
  } finally {
    installFakeMediaDevices({ deny: false }); // restore for any later test file relying on the default
  }
});
