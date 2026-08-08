import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { FlagService } from '../src/flag-service.js';
import { privateFlagPath } from '../src/paths.js';

async function identityOn(qu) {
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return identity;
}

async function freshFlagService() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = await identityOn(qu);
  return { qu, identity, flags: new FlagService(qu, identity, new ListService(qu)) };
}

// ===== private mode ==============================================================

test('setPrivate()/listPrivate()/hasPrivate() round-trip', async () => {
  const { flags } = await freshFlagService();
  await flags.setPrivate('favorite', 'app', 'forum', true);

  assert.equal(await flags.hasPrivate('favorite', 'app', 'forum'), true);
  const list = await flags.listPrivate('favorite', 'app');
  assert.deepEqual(list.map((i) => i.id), ['forum']);
});

// Regression: private mode used to route through StarredService, one
// self-encrypted BLOB per (flagType, entityKind) containing the whole list
// as an inline array - every mutation re-encrypted the ENTIRE list. The
// redesign (docs/v3-technical-concept.md §4.2's derived-list shape, applied
// to self-encrypted data) makes each flag its own path - this asserts that
// shape directly: setPrivate() writes ONE new QuBit at its own path, not a
// growing shared document.
test('setPrivate() writes each flag at its OWN path, not a shared document', async () => {
  const { qu, identity, flags } = await freshFlagService();
  await flags.setPrivate('favorite', 'app', 'a', true);
  await flags.setPrivate('favorite', 'app', 'b', true);

  const mainPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const aBit = await qu.get(privateFlagPath(mainPub, 'favorite', 'app', 'a'));
  const bBit = await qu.get(privateFlagPath(mainPub, 'favorite', 'app', 'b'));
  assert.ok(aBit); // 'a' has its own QuBit...
  assert.ok(bBit); // ...independent of 'b's, not entries inside one shared array
});

// Regression: a re-flag after unflagging must actually come back (not stay
// stuck on a stale tombstone) - the exact "toggle on/off/on" cycle a UI
// star button does.
test('a flag can be toggled off then on again', async () => {
  const { flags } = await freshFlagService();
  await flags.setPrivate('favorite', 'app', 'forum', true);
  await flags.setPrivate('favorite', 'app', 'forum', false);
  await flags.setPrivate('favorite', 'app', 'forum', true);

  assert.equal(await flags.hasPrivate('favorite', 'app', 'forum'), true);
  assert.deepEqual((await flags.listPrivate('favorite', 'app')).map((i) => i.id), ['forum']);
});

test('setPrivate(..., false) unflags', async () => {
  const { flags } = await freshFlagService();
  await flags.setPrivate('favorite', 'app', 'forum', true);
  await flags.setPrivate('favorite', 'app', 'forum', false);
  assert.equal(await flags.hasPrivate('favorite', 'app', 'forum'), false);
});

test('private flags are namespaced by BOTH flagType and entityKind - no cross-contamination', async () => {
  const { flags } = await freshFlagService();
  await flags.setPrivate('favorite', 'app', 'x', true);
  await flags.setPrivate('bookmark', 'app', 'x', true); // same entityRef, different flagType
  await flags.setPrivate('favorite', 'user', 'x', true); // same entityRef, different entityKind

  assert.equal(await flags.hasPrivate('favorite', 'app', 'x'), true);
  assert.equal((await flags.listPrivate('favorite', 'app')).length, 1);
  assert.equal((await flags.listPrivate('bookmark', 'app')).length, 1);
  assert.equal((await flags.listPrivate('favorite', 'user')).length, 1);
});

// ===== public mode ================================================================

test('setPublic()/hasPublicFlag() round-trip for the flagging identity', async () => {
  const { flags, identity } = await freshFlagService();
  const mainPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  await flags.setPublic('board', 'like', 'thread-message', 'm1', true);
  assert.equal(await flags.hasPublicFlag('board', 'like', 'thread-message', 'm1', mainPub), true);
});

test('setPublic(..., false) clears the flag - hasPublicFlag() becomes false, getPublicFlags() excludes it', async () => {
  const { flags, identity } = await freshFlagService();
  const mainPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  await flags.setPublic('board', 'like', 'thread-message', 'm1', true);
  await flags.setPublic('board', 'like', 'thread-message', 'm1', false);

  assert.equal(await flags.hasPublicFlag('board', 'like', 'thread-message', 'm1', mainPub), false);
  const { count, actorPubs } = await flags.getPublicFlags('board', 'like', 'thread-message', 'm1');
  assert.equal(count, 0);
  assert.deepEqual(actorPubs, []);
});

test('getPublicFlags() aggregates multiple DIFFERENT actors flagging the SAME entity', async () => {
  const { flagPath } = await import('../src/paths.js');
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = await identityOn(qu); // one real identity, backing the FlagService instance itself
  const flags = new FlagService(qu, identity, new ListService(qu));

  await flags.setPublic('board', 'like', 'thread-message', 'm1', true); // flagger #1: the FlagService's own identity

  // Flaggers #2 and #3: raw keypairs writing their own signed slot directly
  // (exactly the shape setPublic() itself produces) - simulates OTHER actors
  // on the same shared space without needing a full separate
  // QuIdentityEngine+store per actor (which couldn't share this `qu` anyway,
  // per @qu/identity's one-seed-per-store rule).
  const otherActorPubs = [];
  for (let i = 0; i < 2; i++) {
    const kp = await QuCrypto.generateKeypair();
    const actorPub = QuCrypto.toBase64Url(kp.publicKey);
    otherActorPubs.push(actorPub);
    await qu.put(
      flagPath('board', 'like', 'thread-message', 'm1', actorPub),
      { flaggedAt: Date.now() },
      { signWith: kp.privateKey, writerPub: kp.publicKey }
    );
  }

  const mainPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const { count, actorPubs } = await flags.getPublicFlags('board', 'like', 'thread-message', 'm1');
  assert.equal(count, 3);
  assert.deepEqual([...actorPubs].sort(), [mainPub, ...otherActorPubs].sort());
});

test('hasPublicFlag() for an actor who never flagged returns false', async () => {
  const { flags } = await freshFlagService();
  await flags.setPublic('board', 'like', 'thread-message', 'm1', true);
  assert.equal(await flags.hasPublicFlag('board', 'like', 'thread-message', 'm1', 'someone-else-entirely'), false);
});

test('FlagService.PUBLIC_SPACE is a stable, non-empty constant for entity kinds with no natural space', () => {
  assert.equal(typeof FlagService.PUBLIC_SPACE, 'string');
  assert.ok(FlagService.PUBLIC_SPACE.length > 0);
});
