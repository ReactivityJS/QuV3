import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { ReactionService } from '../src/reaction-service.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity, reactions: new ReactionService(qu, identity, new ListService(qu)) };
}

test('setReaction()/getReactions() round-trip for the reacting identity', async () => {
  const { reactions, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  await reactions.setReaction('board', 'general', 'm1', '👍');
  const byEmoji = await reactions.getReactions('board', 'general', 'm1');
  assert.deepEqual(byEmoji, { '👍': [myPub] });
});

test('setReaction() with a different emoji REPLACES the previous one (one reaction per person per message)', async () => {
  const { reactions, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  await reactions.setReaction('board', 'general', 'm1', '👍');
  await reactions.setReaction('board', 'general', 'm1', '❤️');

  const byEmoji = await reactions.getReactions('board', 'general', 'm1');
  assert.deepEqual(byEmoji, { '❤️': [myPub] });
});

test('setReaction(..., null) clears a reaction - getReactions() excludes it', async () => {
  const { reactions } = await freshSetup();
  await reactions.setReaction('board', 'general', 'm1', '👍');
  await reactions.setReaction('board', 'general', 'm1', null);
  assert.deepEqual(await reactions.getReactions('board', 'general', 'm1'), {});
});

test('getReactions() aggregates MULTIPLE different actors reacting to the SAME message', async () => {
  const { qu, reactions, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await reactions.setReaction('board', 'general', 'm1', '👍');

  const kp = await QuCrypto.generateKeypair();
  const otherPub = QuCrypto.toBase64Url(kp.publicKey);
  await qu.put(`/store/board/threads/general/reactions/m1/${otherPub}`, '👍', { signWith: kp.privateKeyPkcs8, writerPub: kp.publicKey });

  const byEmoji = await reactions.getReactions('board', 'general', 'm1');
  assert.deepEqual([...byEmoji['👍']].sort(), [myPub, otherPub].sort());
});

test('reactions on different messages are fully independent', async () => {
  const { reactions } = await freshSetup();
  await reactions.setReaction('board', 'general', 'm1', '👍');
  await reactions.setReaction('board', 'general', 'm2', '❤️');

  assert.deepEqual(Object.keys(await reactions.getReactions('board', 'general', 'm1')), ['👍']);
  assert.deepEqual(Object.keys(await reactions.getReactions('board', 'general', 'm2')), ['❤️']);
});

test('getReactions() of a message nobody reacted to returns an empty object', async () => {
  const { reactions } = await freshSetup();
  assert.deepEqual(await reactions.getReactions('board', 'general', 'never-reacted'), {});
});

// ===== Quniverse V4: generic Entity reactions ===============================

test('setEntityReaction()/getEntityReactions() round-trip for the reacting identity', async () => {
  const { reactions, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  await reactions.setEntityReaction('space1', 'entity1', '👍');
  const byEmoji = await reactions.getEntityReactions('space1', 'entity1');
  assert.deepEqual(byEmoji, { '👍': [myPub] });
});

test('setEntityReaction() with a different emoji REPLACES the previous one', async () => {
  const { reactions, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  await reactions.setEntityReaction('space1', 'entity1', '👍');
  await reactions.setEntityReaction('space1', 'entity1', '❤️');

  assert.deepEqual(await reactions.getEntityReactions('space1', 'entity1'), { '❤️': [myPub] });
});

test('setEntityReaction(..., null) clears a reaction', async () => {
  const { reactions } = await freshSetup();
  await reactions.setEntityReaction('space1', 'entity1', '👍');
  await reactions.setEntityReaction('space1', 'entity1', null);
  assert.deepEqual(await reactions.getEntityReactions('space1', 'entity1'), {});
});

test('getEntityReactions() aggregates multiple different actors reacting to the same entity', async () => {
  const { qu, reactions, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await reactions.setEntityReaction('space1', 'entity1', '👍');

  const kp = await QuCrypto.generateKeypair();
  const otherPub = QuCrypto.toBase64Url(kp.publicKey);
  await qu.put(`/store/space1/entities/entity1/reactions/${otherPub}`, '👍', { signWith: kp.privateKeyPkcs8, writerPub: kp.publicKey });

  const byEmoji = await reactions.getEntityReactions('space1', 'entity1');
  assert.deepEqual([...byEmoji['👍']].sort(), [myPub, otherPub].sort());
});

test('entity reactions and thread-message reactions are fully independent (same id, different address)', async () => {
  const { reactions } = await freshSetup();
  await reactions.setReaction('space1', 'entity1', 'entity1', '❤️'); // a thread/message reaction that happens to share the id
  await reactions.setEntityReaction('space1', 'entity1', '👍');

  assert.deepEqual(Object.keys(await reactions.getReactions('space1', 'entity1', 'entity1')), ['❤️']);
  assert.deepEqual(Object.keys(await reactions.getEntityReactions('space1', 'entity1')), ['👍']);
});

test('setReaction() supports posting as a pseudonymous space identity (asSpaceId)', async () => {
  const { reactions, identity } = await freshSetup();
  const spacePub = QuCrypto.toBase64Url((await identity.getSpaceKey('anon-room')).publicKey);
  const mainPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  assert.notEqual(spacePub, mainPub); // sanity: genuinely a different identity

  await reactions.setReaction('board', 'general', 'm1', '👍', { asSpaceId: 'anon-room' });
  const byEmoji = await reactions.getReactions('board', 'general', 'm1');
  assert.deepEqual(byEmoji, { '👍': [spacePub] });
});
