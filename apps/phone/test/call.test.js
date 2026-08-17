import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { Transport } from '@qu/sync/transport';
import { readFileSync } from 'node:fs';
import { ListService, AccessService, MessageService, ChatService, NotificationPrefsService, PushSubscriptionService, paths } from '@qu/services';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';
import { installFakeMediaDevices } from './fake-media-devices.js';
import { installDom } from '@qu/ui/testing';
import { PushDeliveryService, createManifestNotificationResolver } from '../../../packages/relay/src/push-delivery.js';
import { PresenceTracker } from '../../../packages/relay/src/presence-tracker.js';

// `../client.js` (imported below, for handleNotificationAction()) transitively
// pulls in `@qu/ui`'s DOM-backed components - needed even though this file's
// own tests never touch the DOM themselves.
installDom();

// The REAL apps/phone/manifest.quapp (not a synthetic stand-in) - the whole
// point of the regression tests below is proving call.js's actual thread
// config and this actual manifest's actual pushActions work together
// through a real PushDeliveryService, not two halves separately mocked to
// look compatible (exactly how the "readers: '*' silently breaks incoming-
// call notifications" bug slipped through in the first place - see this
// plan's own "Bugfix" section).
const PHONE_MANIFEST = JSON.parse(readFileSync(new URL('../manifest.quapp', import.meta.url), 'utf8'));

installFakeRTCPeerConnection();
installFakeMediaDevices();

const { createPhoneCall, declinePhoneCall } = await import('../src/call.js');
const { handleNotificationAction } = await import('../client.js');

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
  // Needed since createPhoneCall() posts a real, encrypted (THREAD_PRESETS.
  // chat()'s reader-restricted config - see call.js's own doc comment on
  // why that's load-bearing, not just privacy) announcement message, which
  // requires every reader's X25519 key to be resolvable - exactly like any
  // other private-thread postMessage() (see message-service.test.js's own
  // reader-restricted-thread tests for the identical requirement).
  await identity.publishMainProfile({});
  const pub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const clientTransport = new ClientTransport(clientPeerId, network);
  const sync = new SyncEngine(qu, clientTransport, { publishAllTo: clientTransport.getPeerId() });

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);

  return { qu, identity, pub, sync, services: { messages } };
}

/**
 * Each `freshParticipant()` is a genuinely SEPARATE `QuStore` instance, and
 * the tests below only ever `sync.subscribe()` the phone call's OWN
 * `spaceId` (never an actor's `/store/actors/~<pub>/profile` path) - so
 * `publishMainProfile()` above never actually reaches the OTHER
 * participant's store through this test harness's sync, unlike a real
 * relay-mediated deployment where both identities' profiles are simply
 * already-synced, ambient data. Manually mirrors each side's published
 * profile into the other's store - the exact same "as if sync had already
 * delivered it" technique `packages/relay/test/push-delivery.test.js`'s own
 * `freshRecipient()`/`readOwnNotifications()` helpers use for the identical
 * reason - so `MessageService.postMessage()`'s `resolveReaderXKeys()` can
 * resolve both readers' X25519 keys, exactly like it would in production
 * once the two contacts have actually met.
 */
async function mirrorProfiles(a, b) {
  const aProfile = await a.qu.get(actorPath(a.pub, 'profile'));
  if (aProfile) await b.qu.putSealed(actorPath(a.pub, 'profile'), aProfile);
  const bProfile = await b.qu.get(actorPath(b.pub, 'profile'));
  if (bProfile) await a.qu.putSealed(actorPath(b.pub, 'profile'), bProfile);
}

test('caller and callee complete a call handshake, exchange tracks, and can hang up cleanly', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller', network);
  const callee = await freshParticipant('client-callee', network);
  await mirrorProfiles(caller, callee);

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

test('REGRESSION: when ONE side hangs up a connected call, the OTHER side\'s onHungUp() fires - without it, that side was left looking connected forever (a plain RTCPeerConnection close doesn\'t tell the other side anything reliably/promptly)', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller-hangup', network);
  const callee = await freshParticipant('client-callee-hangup', network);
  await mirrorProfiles(caller, callee);

  const spaceId = 'phone-test-space-hangup';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  let callerConnected = false;
  let calleeConnected = false;
  let calleeHungUp = false;

  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true,
    onPeerConnected: () => { callerConnected = true; },
  });
  const calleeCall = await createPhoneCall({
    qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub,
    initiator: false,
    onPeerConnected: () => { calleeConnected = true; },
    onHungUp: () => { calleeHungUp = true; },
  });

  await waitUntil(() => callerConnected && calleeConnected);
  assert.equal(calleeHungUp, false); // not yet - only after the caller actually hangs up

  callerCall.hangUp();
  await waitUntil(() => calleeHungUp);

  calleeCall.hangUp(); // callee's own cleanup - harmless even though the caller's side is already gone
});

test('hanging up BEFORE ever connecting does NOT fire the other side\'s onHungUp() - that call never had anything to "end", declineCall()/onTimeout() already cover it', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller-nohangup', network);
  const callee = await freshParticipant('client-callee-nohangup', network);
  await mirrorProfiles(caller, callee);

  const spaceId = 'phone-test-space-nohangup';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  let calleeHungUp = false;
  const calleeCall = await createPhoneCall({
    qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub,
    initiator: false,
    onHungUp: () => { calleeHungUp = true; },
  });

  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true,
  });
  callerCall.hangUp(); // hung up immediately, before any onPeerConnected() ever fired on either side

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calleeHungUp, false);
  calleeCall.hangUp();
});

test('upgradeToVideo() adds a video track to an already-connected audio-only call, and the callee receives it via onTrack() without a fresh onPeerConnected()', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller9', network);
  const callee = await freshParticipant('client-callee9', network);
  await mirrorProfiles(caller, callee);

  const spaceId = 'phone-test-space-9';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const calleeStreams = [];
  let callerConnectedCount = 0;
  let calleeConnectedCount = 0;

  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true, mode: 'audio',
    onPeerConnected: () => { callerConnectedCount++; },
  });
  const calleeCall = await createPhoneCall({
    qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub,
    initiator: false, mode: 'audio',
    onTrack: (stream) => calleeStreams.push(stream),
    onPeerConnected: () => { calleeConnectedCount++; },
  });

  await waitUntil(() => callerConnectedCount === 1 && calleeConnectedCount === 1);

  assert.equal(callerCall.localStream.getVideoTracks().length, 0); // audio-only so far, confirmed before upgrading

  await callerCall.upgradeToVideo();

  assert.equal(callerCall.localStream.getVideoTracks().length, 1);
  await waitUntil(() => calleeStreams.some((s) => s.getVideoTracks().length > 0));
  // Renegotiation, not a fresh connection - onPeerConnected() must not fire again.
  assert.equal(callerConnectedCount, 1);
  assert.equal(calleeConnectedCount, 1);

  callerCall.hangUp();
  calleeCall.hangUp();
});

test('REGRESSION: upgradeToVideo() still works AFTER the post-connect signaling-path cleanup has already run - the realistic case, since nobody upgrades to video within the default 5s post-connect window', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller9b', network);
  const callee = await freshParticipant('client-callee9b', network);
  await mirrorProfiles(caller, callee);

  const spaceId = 'phone-test-space-9b';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const calleeStreams = [];
  let callerConnectedCount = 0;
  let calleeConnectedCount = 0;

  // A short cleanupDelayMs (test-only override, see createPhoneCall()'s own
  // doc comment) so this test can actually wait PAST the tombstone without a
  // slow multi-second real-time sleep - proves WebRtcSignalService's
  // `keepPair` (the offer/answer QuBits get tombstoned, but the in-memory
  // pair tracking survives) is what makes a LATE renegotiation still reach
  // the other side, not just an immediate one (already covered by the
  // preceding test).
  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true, mode: 'audio', cleanupDelayMs: 20,
    onPeerConnected: () => { callerConnectedCount++; },
  });
  const calleeCall = await createPhoneCall({
    qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub,
    initiator: false, mode: 'audio', cleanupDelayMs: 20,
    onTrack: (stream) => calleeStreams.push(stream),
    onPeerConnected: () => { calleeConnectedCount++; },
  });

  await waitUntil(() => callerConnectedCount === 1 && calleeConnectedCount === 1);
  await new Promise((resolve) => setTimeout(resolve, 100)); // well past cleanupDelayMs=20 - the offer/answer paths are now tombstoned

  await callerCall.upgradeToVideo();

  assert.equal(callerCall.localStream.getVideoTracks().length, 1);
  await waitUntil(() => calleeStreams.some((s) => s.getVideoTracks().length > 0));

  callerCall.hangUp();
  calleeCall.hangUp();
});

test('REGRESSION: with NO manual sync.subscribe() at the test level at all, and a REALISTIC delay before the callee even starts - createPhoneCall()\'s own subscribe/syncFetch wiring is what makes the handshake reach the other side', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller8', network);
  const callee = await freshParticipant('client-callee8', network);
  await mirrorProfiles(caller, callee);
  const spaceId = 'phone-test-space-8';
  // Deliberately NO caller.sync.subscribe()/callee.sync.subscribe() here -
  // every other test in this file calls these manually, which is exactly
  // the step the real apps/phone/client.js never did before this fix (see
  // this plan's own "Bugfix: WebRTC-Signaling erreicht die Gegenseite nie"
  // section) - this test proves createPhoneCall()'s own subscribe/syncFetch
  // params (passed through from ctx in the real app) are SUFFICIENT on
  // their own, not merely a nice-to-have on top of something else already
  // making it work.
  const callerSubscribe = (prefix) => caller.sync.subscribe(prefix);
  const callerSyncFetch = (prefix) => caller.sync.fetchPrefix(prefix);
  const calleeSubscribe = (prefix) => callee.sync.subscribe(prefix);
  const calleeSyncFetch = (prefix) => callee.sync.fetchPrefix(prefix);

  let callerConnected = false;
  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true, subscribe: callerSubscribe, syncFetch: callerSyncFetch,
    onPeerConnected: () => { callerConnected = true; },
  });

  // The realistic race this bug actually hits in production: the offer is
  // already written and synced to the relay well BEFORE the callee ever
  // opens the call view (they're reacting to a notification, not staring
  // at the screen) - subscribe() alone (future writes only) would still
  // fail here; only the ALSO-required syncFetch() backfill saves it.
  await new Promise((resolve) => setTimeout(resolve, 30));

  let calleeConnected = false;
  const calleeCall = await createPhoneCall({
    qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub,
    initiator: false, subscribe: calleeSubscribe, syncFetch: calleeSyncFetch,
    onPeerConnected: () => { calleeConnected = true; },
  });

  await waitUntil(() => callerConnected && calleeConnected);

  callerCall.hangUp();
  calleeCall.hangUp();
});

test('toggleAudio()/toggleVideo() flip track.enabled without stopping or removing the track', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller2', network);
  const callee = await freshParticipant('client-callee2', network);
  await mirrorProfiles(caller, callee);
  const spaceId = 'phone-test-space-2';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const callerCall = await createPhoneCall({ qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub, initiator: true, mode: 'video' });
  await createPhoneCall({ qu: callee.qu, identity: callee.identity, services: callee.services, spaceId, remotePub: caller.pub, initiator: false, mode: 'video' });

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

test('createPhoneCall({mode: "audio"}) never requests video at all - not just a video track disabled after the fact', async () => {
  const calls = installFakeMediaDevices();
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller2b', network);
  const callee = await freshParticipant('client-callee2b', network);
  await mirrorProfiles(caller, callee);
  const spaceId = 'phone-test-space-2b';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true, mode: 'audio',
  });

  assert.deepEqual(calls, [{ audio: true, video: false }]);
  assert.equal(callerCall.localStream.getVideoTracks().length, 0);
  assert.equal(callerCall.localStream.getAudioTracks().length, 1);

  callerCall.hangUp();
});

test('declinePhoneCall() before the callee ever creates a PhoneCall reaches the caller\'s onDeclined()', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller3', network);
  const callee = await freshParticipant('client-callee3', network);
  await mirrorProfiles(caller, callee);
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

test('handleNotificationAction() (the content.notificationAction contributor the in-app toast\'s "Ablehnen" button calls) reaches the caller\'s onDeclined() from just a {actionId, url} payload - no navigation, no /decline route involved', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller3c', network);
  const callee = await freshParticipant('client-callee3c', network);
  await mirrorProfiles(caller, callee);
  const spaceId = 'phone-test-space-3c';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  let declined = false;
  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true,
    onDeclined: () => { declined = true; },
  });

  await handleNotificationAction({
    actionId: 'decline', url: `#/phone/${caller.pub}/decline`,
    qu: callee.qu, identity: callee.identity, apps: [{ name: 'phone', spaceId }],
  });

  await waitUntil(() => declined);
  callerCall.hangUp();
});

test('handleNotificationAction() is a no-op for "accept" (a plain href navigation instead, see notification-popups.js) and for a URL it doesn\'t own', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const callee = await freshParticipant('client-callee3d', network);
  const apps = [{ name: 'phone', spaceId: 'phone-test-space-3d' }];

  // None of these should throw, touch the network, or need a caller at all.
  await handleNotificationAction({ actionId: 'accept', url: '#/phone/someone/accept', qu: callee.qu, identity: callee.identity, apps });
  await handleNotificationAction({ actionId: 'decline', url: '#/not-a-phone-url', qu: callee.qu, identity: callee.identity, apps });
  await handleNotificationAction({ actionId: 'decline', url: `#/phone/someone/decline`, qu: callee.qu, identity: callee.identity, apps: [] });
});

test('onTimeout() fires when the callee never answers at all - the "stuck on Calling… forever" gap this Bugfix closes', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller3b', network);
  const callee = await freshParticipant('client-callee3b', network);
  await mirrorProfiles(caller, callee);
  const spaceId = 'phone-test-space-3b';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  let timedOut = false;
  let connected = false;
  const callerCall = await createPhoneCall({
    qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub,
    initiator: true,
    negotiationTimeoutMs: 30, // short override - see createPhoneCall()'s own doc comment on why this exists
    onPeerConnected: () => { connected = true; },
    onTimeout: () => { timedOut = true; },
  });
  // The callee NEVER calls createPhoneCall()/declinePhoneCall() at all - a
  // classic no-usable-ICE-candidate-pair failure (no TURN, symmetric NAT)
  // looks exactly like this from the caller's own perspective: silence.

  await waitUntil(() => timedOut);
  assert.equal(connected, false);
  callerCall.hangUp();
});

test('the CALLER (only) posts exactly one real thread message announcing the call - what actually triggers the relay\'s push/toast notification pipeline for the callee', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller5', network);
  const callee = await freshParticipant('client-callee5', network);
  await mirrorProfiles(caller, callee);
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

test('REGRESSION: the call thread\'s stored config uses an ARRAY of readers, not "*" - the exact property deliverThreadMessage() branches on to decide "private, notify every other reader" vs. "public, mentions only"', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller6', network);
  const callee = await freshParticipant('client-callee6', network);
  await mirrorProfiles(caller, callee);
  const spaceId = 'phone-test-space-6';
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const callerCall = await createPhoneCall({ qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub, initiator: true });
  const threadId = await ChatService.roomId([caller.pub, callee.pub]);

  const config = await caller.services.messages.getConfig(spaceId, threadId);
  assert.ok(Array.isArray(config.readers), `expected config.readers to be an array of the two participants, got: ${JSON.stringify(config.readers)}`);
  assert.deepEqual([...config.readers].sort(), [caller.pub, callee.pub].sort());

  callerCall.hangUp();
});

test('INTEGRATION: a real createPhoneCall({initiator:true}) announcement, run through the REAL PushDeliveryService + the REAL apps/phone/manifest.quapp, notifies exactly the callee with the incomingCall action - the end-to-end path that regressed silently when the thread was briefly made "readers: \'*\'"', async () => {
  const network = new TestNetwork();
  const relayQu = new QuStore();
  relayQu.mount('store', new MemoryStoreAdapter());
  new SyncEngine(relayQu, new RelayTransport(network));

  const caller = await freshParticipant('client-caller7', network);
  const callee = await freshParticipant('client-callee7', network);
  await mirrorProfiles(caller, callee);
  // The REAL manifest's own spaceId, not an arbitrary test string -
  // createManifestNotificationResolver() matches candidates by
  // `manifest.spaceId === spaceId` (see push-delivery.js's own doc
  // comment), so this is what makes it actually recognize this thread as
  // Phone's, not fall through to the generic per-spaceId wording.
  const spaceId = PHONE_MANIFEST.spaceId;
  caller.sync.subscribe(paths.spacePath(spaceId));
  callee.sync.subscribe(paths.spacePath(spaceId));

  const callerCall = await createPhoneCall({ qu: caller.qu, identity: caller.identity, services: caller.services, spaceId, remotePub: callee.pub, initiator: true });
  const threadId = await ChatService.roomId([caller.pub, callee.pub]);

  const { messages: callerView } = await caller.services.messages.listMessages(spaceId, threadId);
  assert.equal(callerView.length, 1);
  const announcement = callerView[0];
  // deliverThreadMessage() expects the RAW on-wire QuBit shape (see
  // packages/relay/test/push-delivery.test.js's own postAndDeliver() doc
  // comment), not postMessage()'s own plain return value.
  const rawQuBit = await caller.qu.get(`/store/${spaceId}/threads/${threadId}/msgs/${announcement.id}`);

  const list = new ListService(caller.qu);
  const notifiedFor = [];
  const delivery = new PushDeliveryService({
    messages: caller.services.messages,
    notificationPrefs: new NotificationPrefsService(caller.qu, null),
    pushSubscriptions: new PushSubscriptionService(caller.qu, null, list),
    presence: new PresenceTracker(),
    vapidKeys: null, // only the in-app write matters for this test
    resolveNotification: createManifestNotificationResolver({ listManifests: () => [{ manifest: PHONE_MANIFEST, originUrl: null }] }),
  });
  const seen = [];
  const originalPost = caller.services.messages.postMessage.bind(caller.services.messages);
  caller.services.messages.postMessage = async (...args) => {
    seen.push(args);
    return originalPost(...args);
  };

  await delivery.deliverThreadMessage(spaceId, threadId, rawQuBit);

  // Exactly one in-app notification write happened, for the callee's OWN
  // notifications thread (postMessage() was called a second time, beyond
  // the original "📞" announcement itself).
  const inAppWrites = seen.filter(([writeSpaceId]) => writeSpaceId === paths.notificationsSpaceId(callee.pub));
  assert.equal(inAppWrites.length, 1, `expected exactly one in-app notification write for the callee, got ${inAppWrites.length}`);
  const [, , { extra }] = inAppWrites[0];
  assert.equal(extra.appId, 'phone');
  assert.equal(extra.url, `#/phone/${caller.pub}/accept`);
  assert.deepEqual(extra.actions, [
    { action: 'accept', title: 'Annehmen', url: `#/phone/${caller.pub}/accept` },
    { action: 'decline', title: 'Ablehnen', url: `#/phone/${caller.pub}/decline` },
  ]);

  caller.services.messages.postMessage = originalPost;
  callerCall.hangUp();
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
