import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { ListService, AccessService, SharingService, MessageService, FlagService, ActorService } from '@qu/services';
import { createGame, inviteChaser, gameThreadId } from '../src/game-service.js';
import { recordTrackPoint, listTrackPoints } from '../src/track-service.js';

const SPACE_ID = 'test-geochase-space';

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias: 'Me' });

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const flags = new FlagService(qu, identity, list);
  const services = {
    actors: new ActorService(identity),
    access,
    messages,
    flags,
    sharing: new SharingService(qu, identity, access, messages, flags),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/** Mirrors game-service.test.js's own createPeer() - a second identity sharing the same store. */
async function createPeer(ownerQu, { alias } = {}) {
  const peerQu = new QuStore();
  peerQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(peerQu);
  new ThreadEngine(peerQu);
  const identity = new QuIdentityEngine(peerQu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });
  const list = new ListService(peerQu);
  const access = new AccessService(peerQu, identity);
  const messages = new MessageService(peerQu, identity, list, access);
  const flags = new FlagService(peerQu, identity, list);
  const services = {
    actors: new ActorService(identity), access, messages, flags,
    sharing: new SharingService(peerQu, identity, access, messages, flags),
  };
  const myPub = await services.actors.whoAmI();
  await ownerQu.putSealed(actorPath(myPub, 'profile'), await peerQu.get(actorPath(myPub, 'profile')));
  return { qu: peerQu, identity, services, myPub };
}

test('recordTrackPoint()/listTrackPoints(): round-trips oldest-first, and the raw QuBit is genuinely encrypted (not plaintext) on the wire', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await createGame(services, SPACE_ID, 'g1');

  await recordTrackPoint(qu, identity, services, SPACE_ID, 'g1', { lat: 1, lng: 1, ts: 1000 });
  await recordTrackPoint(qu, identity, services, SPACE_ID, 'g1', { lat: 2, lng: 2, ts: 2000 });

  const points = await listTrackPoints(qu, identity, services, SPACE_ID, 'g1', myPub);
  assert.deepEqual(points.map((p) => [p.lat, p.lng]), [[1, 1], [2, 2]]);

  // req. 7 - genuinely ciphertext on the relay-backed store, never a plain {lat, lng} object.
  const children = await qu.getChildren(`/store/${SPACE_ID}/threads/${gameThreadId('g1')}/track/${myPub}`, { sort: 'ts' });
  assert.equal(children.length, 2);
  for (const { quBit } of children) {
    assert.equal(typeof quBit.val.ct, 'string', 'expected an encrypted envelope, not a plain point');
    assert.equal(quBit.val.lat, undefined);
  }
});

test('listTrackPoints(): an invited chaser can decrypt the chased player\'s track points written AFTER they were invited', async () => {
  const { qu: ownerQu, identity: ownerIdentity, services: ownerServices, myPub: chasedPub } = await freshEnv();
  const { qu: chaserQu, identity: chaserIdentity, services: chaserServices, myPub: chaserPub } = await createPeer(ownerQu, { alias: 'Chaser' });
  // createPeer() already mirrors the CHASER's own profile into ownerQu (so the
  // owner can encrypt for them) - the reverse is needed here too: the
  // CHASED's own profile, mirrored into the chaser's store, to resolve the
  // sender's X key on decrypt (see decryptEnvelope()'s own doc comment).
  await chaserQu.putSealed(actorPath(chasedPub, 'profile'), await ownerQu.get(actorPath(chasedPub, 'profile')));

  await createGame(ownerServices, SPACE_ID, 'g1');
  await inviteChaser(ownerQu, ownerIdentity, ownerServices, SPACE_ID, 'g1', chaserPub);
  await recordTrackPoint(ownerQu, ownerIdentity, ownerServices, SPACE_ID, 'g1', { lat: 52.5, lng: 13.4, ts: 5000 });

  // Mirror the game thread's ACL + the track point into the chaser's own store, as a real relay sync would.
  const threadId = gameThreadId('g1');
  const trackParent = `/store/${SPACE_ID}/threads/${threadId}/track/${chasedPub}`;
  const aclBit = await ownerQu.get(`/store/${SPACE_ID}/acl/threads/${threadId}`);
  await chaserQu.putSealed(`/store/${SPACE_ID}/acl/threads/${threadId}`, aclBit);
  const entries = await ownerQu.getChildren(trackParent);
  for (const { path, quBit } of entries) await chaserQu.putSealed(path, quBit);

  const points = await listTrackPoints(chaserQu, chaserIdentity, chaserServices, SPACE_ID, 'g1', chasedPub);
  assert.deepEqual(points, [{ lat: 52.5, lng: 13.4, heading: null, speed: null, ts: 5000 }]);
});

test('listTrackPoints(): a stranger who was never invited cannot decrypt the chased player\'s track points', async () => {
  const { qu: ownerQu, identity: ownerIdentity, services: ownerServices, myPub: chasedPub } = await freshEnv();
  const { qu: strangerQu, identity: strangerIdentity, services: strangerServices } = await createPeer(ownerQu, { alias: 'Stranger' });

  await createGame(ownerServices, SPACE_ID, 'g1');
  await recordTrackPoint(ownerQu, ownerIdentity, ownerServices, SPACE_ID, 'g1', { lat: 52.5, lng: 13.4, ts: 5000 });

  const threadId = gameThreadId('g1');
  const trackParent = `/store/${SPACE_ID}/threads/${threadId}/track/${chasedPub}`;
  const entries = await ownerQu.getChildren(trackParent);
  for (const { path, quBit } of entries) await strangerQu.putSealed(path, quBit);

  const points = await listTrackPoints(strangerQu, strangerIdentity, strangerServices, SPACE_ID, 'g1', chasedPub);
  assert.deepEqual(points, []); // undecryptable entries are silently dropped, not thrown
});
