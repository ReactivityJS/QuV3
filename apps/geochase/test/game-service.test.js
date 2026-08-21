import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { ListService, AccessService, SharingService, MessageService, FlagService, ActorService, paths } from '@qu/services';
import { createGame, readGame, inviteChaser, updateGame, listMyGames, discoverInvites, gameThreadId, DEFAULT_SETTINGS, archiveGame, isArchivable, ARCHIVE_AFTER_MS } from '../src/game-service.js';

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

/** A full second, independent identity+services bundle sharing the SAME store - mirrors apps/todo/test's own createPeer(). */
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

async function mirrorPaths(fromQu, toQu, paths_) {
  for (const p of paths_) {
    const bit = await fromQu.get(p);
    if (bit) await toQu.putSealed(p, bit);
  }
}
async function mirrorChildren(fromQu, toQu, parentPath) {
  const entries = await new ListService(fromQu).listDerived(parentPath);
  for (const { path, quBit } of entries) await toQu.putSealed(path, quBit);
}

test('createGame(): writes a pending game with the creator as "chased", default settings, and stars it into listMyGames()', async () => {
  const { services, myPub } = await freshEnv();
  const config = await createGame(services, SPACE_ID, 'g1');
  assert.equal(config.chasedPub, myPub);
  assert.equal(config.status, 'pending');
  assert.deepEqual(config.settings, DEFAULT_SETTINGS);
  assert.deepEqual(config.members, [{ actorPub: myPub, role: 'chased', addedAt: config.members[0].addedAt }]);

  const mine = await listMyGames(services);
  assert.deepEqual(mine.map((g) => g.id), ['g1']);
});

test('createGame(): a settings override shallow-merges over the defaults', async () => {
  const { services } = await freshEnv();
  const config = await createGame(services, SPACE_ID, 'g1', { mapMode: 'osm' });
  assert.equal(config.settings.mapMode, 'osm');
  assert.equal(config.settings.chasedIntervalMs, DEFAULT_SETTINGS.chasedIntervalMs); // untouched
});

test('inviteChaser(): grows members+readers and is idempotent for an already-invited chaser', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  const { myPub: chaserPub } = await createPeer(qu);
  await createGame(services, SPACE_ID, 'g1');

  const updated = await inviteChaser(qu, identity, services, SPACE_ID, 'g1', chaserPub);
  assert.deepEqual(updated.members.map((m) => m.actorPub), [myPub, chaserPub]);
  assert.equal(updated.members[1].role, 'chaser');
  assert.deepEqual(updated.readers, [myPub, chaserPub]);

  // The invite notification lands in the CHASER's own mailbox thread, but
  // DELIBERATELY UNENCRYPTED (readers: '*', not services.messages.notify()'s
  // own encrypted default - see notifyChaserInvite()'s own doc comment on
  // why) - readable straight from the inviter's own side, unlike apps/todo's
  // encrypted equivalent, and carrying the real gameId + a mentions entry
  // for the chaser (what makes @qu/relay's push-delivery notice them at all
  // on a public thread).
  const inviteConfig = await services.messages.getConfig(SPACE_ID, `invite-${chaserPub}`);
  assert.equal(inviteConfig.readers, '*');
  const { messages: inviteMessages } = await services.messages.listMessages(SPACE_ID, `invite-${chaserPub}`);
  assert.equal(inviteMessages.length, 1);
  assert.equal(inviteMessages[0].body, 'geochase-invite');
  assert.equal(inviteMessages[0].gameId, 'g1');
  assert.equal(inviteMessages[0].chasedPub, myPub);
  assert.deepEqual(inviteMessages[0].mentions, [chaserPub]);

  // Idempotent - inviting the same chaser again is a no-op, not a duplicate member.
  const again = await inviteChaser(qu, identity, services, SPACE_ID, 'g1', chaserPub);
  assert.equal(again.members.length, 2);
});

test('inviteChaser(): the ACL itself is chased-only writers - AccessEngine rejects a write signed by anyone else, not just this file\'s own logic', async () => {
  const { qu: ownerQu, identity: ownerIdentity, services: ownerServices } = await freshEnv();
  const { qu: chaserQu, identity: chaserIdentity, services: chaserServices, myPub: chaserPub } = await createPeer(ownerQu, { alias: 'Chaser' });
  await createGame(ownerServices, SPACE_ID, 'g1');
  await inviteChaser(ownerQu, ownerIdentity, ownerServices, SPACE_ID, 'g1', chaserPub);

  // Mirror the game thread (meta + ACL) into the chaser's own store, as a real relay sync would.
  await mirrorPaths(ownerQu, chaserQu, [
    paths.threadMetaPath(SPACE_ID, gameThreadId('g1')),
    paths.aclPath(SPACE_ID, 'threads', gameThreadId('g1')),
  ]);

  await assert.rejects(updateGame(chaserQu, chaserIdentity, chaserServices, SPACE_ID, 'g1', { status: 'active' }));
});

test('updateGame(): patches status and shallow-merges settings without clobbering untouched fields', async () => {
  const { qu, identity, services } = await freshEnv();
  await createGame(services, SPACE_ID, 'g1');

  const started = await updateGame(qu, identity, services, SPACE_ID, 'g1', { status: 'active' });
  assert.equal(started.status, 'active');
  assert.deepEqual(started.settings, DEFAULT_SETTINGS);

  const tuned = await updateGame(qu, identity, services, SPACE_ID, 'g1', { settings: { chaserIntervalMs: 1000 } });
  assert.equal(tuned.status, 'active'); // untouched by this second call
  assert.equal(tuned.settings.chaserIntervalMs, 1000);
  assert.equal(tuned.settings.mapMode, DEFAULT_SETTINGS.mapMode); // untouched

  // The re-read config off the store must be a plain object, not a
  // `{iv, ct, to}` encrypted envelope - see writeThreadMeta()'s own doc
  // comment for why thread meta is signed-only, never encrypted.
  const reread = await readGame(services, SPACE_ID, 'g1');
  assert.equal(reread.status, 'active');
});

test('discoverInvites(): a chaser who never opened the invite mailbox still gets starred once they call it - showing up in their own listMyGames()', async () => {
  const { qu: ownerQu, identity: ownerIdentity, services: ownerServices, myPub: chasedPub } = await freshEnv();
  const { qu: chaserQu, services: chaserServices, myPub: chaserPub } = await createPeer(ownerQu, { alias: 'Chaser' });
  // createPeer() already mirrors the CHASER's own profile into ownerQu (so
  // the owner can resolve their X25519 key to encrypt the invite) - the
  // chaser needs the reverse for decryption: the CHASED's own profile,
  // mirrored into the chaser's store, to resolve the sender's key.
  await chaserQu.putSealed(actorPath(chasedPub, 'profile'), await ownerQu.get(actorPath(chasedPub, 'profile')));

  await createGame(ownerServices, SPACE_ID, 'g1');
  await inviteChaser(ownerQu, ownerIdentity, ownerServices, SPACE_ID, 'g1', chaserPub);

  // Real sync: mirror the game thread + the invite mailbox message into the chaser's own store.
  await mirrorPaths(ownerQu, chaserQu, [
    paths.threadMetaPath(SPACE_ID, gameThreadId('g1')),
    paths.threadMetaPath(SPACE_ID, `invite-${chaserPub}`),
  ]);
  await mirrorChildren(ownerQu, chaserQu, paths.threadMessagesParentPath(SPACE_ID, `invite-${chaserPub}`));

  assert.deepEqual(await listMyGames(chaserServices), []); // not starred yet - discoverInvites() hasn't run
  await discoverInvites(chaserServices, SPACE_ID);
  const mine = await listMyGames(chaserServices);
  assert.deepEqual(mine.map((g) => g.id), ['g1']);
});

test('readGame(): returns null for a game that was never created', async () => {
  const { services } = await freshEnv();
  assert.equal(await readGame(services, SPACE_ID, 'nope'), null);
});

test('updateGame(): starting a game sets startedAt once; ending it derives endedAt/durationMs from it, only on the transition into "ended"', async () => {
  const { qu, identity, services } = await freshEnv();
  await createGame(services, SPACE_ID, 'g1');

  const started = await updateGame(qu, identity, services, SPACE_ID, 'g1', { status: 'active' });
  assert.ok(started.startedAt > 0);
  assert.equal(started.endedAt, null);
  assert.equal(started.durationMs, null);

  // A second "active" patch (e.g. a settings save while already active) must
  // not reset startedAt - it's a one-time mark, not re-derived on every write.
  const stillActive = await updateGame(qu, identity, services, SPACE_ID, 'g1', { settings: { showRadius: false } });
  assert.equal(stillActive.startedAt, started.startedAt);

  const ended = await updateGame(qu, identity, services, SPACE_ID, 'g1', { status: 'ended', caughtBy: 'some-pub' });
  assert.ok(ended.endedAt >= started.startedAt);
  assert.equal(ended.durationMs, ended.endedAt - started.startedAt);
  assert.equal(ended.caughtBy, 'some-pub');

  // Ending an already-ended game again (a stray double-click) must not shift endedAt/durationMs.
  const endedAgain = await updateGame(qu, identity, services, SPACE_ID, 'g1', { status: 'ended' });
  assert.equal(endedAgain.endedAt, ended.endedAt);
  assert.equal(endedAgain.durationMs, ended.durationMs);
  assert.equal(endedAgain.caughtBy, 'some-pub'); // untouched by a patch that didn't pass caughtBy
});

test('updateGame(): startDistances shallow-merges, never overwriting an already-recorded entry', async () => {
  const { qu, identity, services } = await freshEnv();
  await createGame(services, SPACE_ID, 'g1');

  const first = await updateGame(qu, identity, services, SPACE_ID, 'g1', { startDistances: { chaserA: 100 } });
  assert.deepEqual(first.startDistances, { chaserA: 100 });

  const second = await updateGame(qu, identity, services, SPACE_ID, 'g1', { startDistances: { chaserB: 250, chaserA: 999 } });
  // chaserA's ORIGINAL distance survives - a later "first sighting" of the
  // same chaser (e.g. a stale duplicate mesh tick) must never overwrite it.
  assert.deepEqual(second.startDistances, { chaserA: 100, chaserB: 250 });
});

test('isArchivable(): only an ended game older than ARCHIVE_AFTER_MS qualifies', async () => {
  assert.equal(isArchivable({ status: 'pending', endedAt: null }), false);
  assert.equal(isArchivable({ status: 'active', endedAt: null }), false);
  assert.equal(isArchivable({ status: 'ended', endedAt: Date.now() }), false); // just ended
  assert.equal(isArchivable({ status: 'ended', endedAt: Date.now() - ARCHIVE_AFTER_MS - 1000 }), true);
});

test('archiveGame(): unstars the game from THIS identity\'s own listMyGames() without touching the underlying game data', async () => {
  const { services } = await freshEnv();
  await createGame(services, SPACE_ID, 'g1');
  assert.deepEqual((await listMyGames(services)).map((g) => g.id), ['g1']);

  await archiveGame(services, 'g1');
  assert.deepEqual(await listMyGames(services), []);

  // The game itself is untouched - a soft, per-user delete only (see
  // archiveGame()'s own doc comment).
  const meta = await readGame(services, SPACE_ID, 'g1');
  assert.equal(meta.status, 'pending');
});
