import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { AccessService } from '../src/access-service.js';
import { MessageService } from '../src/message-service.js';
import { ChatService } from '../src/chat-service.js';

async function freshIdentity(qu) {
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return identity;
}

async function freshPeer() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = await freshIdentity(qu);
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const chat = new ChatService(messages, identity);
  const pub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  return { qu, identity, messages, chat, pub };
}

async function copyQuBit(fromQu, toQu, path) {
  const quBit = await fromQu.get(path);
  if (quBit) await toQu.putSealed(path, quBit);
  return quBit;
}

test('roomId() is deterministic and order-independent', async () => {
  const a = await ChatService.roomId(['alice-pub', 'bob-pub']);
  const b = await ChatService.roomId(['bob-pub', 'alice-pub']);
  assert.equal(a, b);
  assert.match(a, /^r-[0-9a-f]{32}$/);
});

test('roomId() differs for a different member set', async () => {
  const a = await ChatService.roomId(['alice-pub', 'bob-pub']);
  const c = await ChatService.roomId(['alice-pub', 'carol-pub']);
  assert.notEqual(a, c);
});

test('ensureRoom() creates a reader-restricted [myPub, theirPub] thread, idempotently', async () => {
  const alice = await freshPeer();
  const bob = await freshPeer();
  await alice.identity.publishMainProfile({ name: 'Alice' });
  await bob.identity.publishMainProfile({ name: 'Bob' });
  await copyQuBit(bob.qu, alice.qu, `/store/actors/~${bob.pub}/profile`);
  await copyQuBit(alice.qu, alice.qu, `/store/actors/~${alice.pub}/profile`); // no-op, self already local

  const roomId = await alice.chat.ensureRoom('chat-space', bob.pub);
  const config = await alice.messages.getConfig('chat-space', roomId);
  assert.deepEqual([...config.readers].sort(), [alice.pub, bob.pub].sort());

  // Bob deriving the same room independently lands on the identical id.
  const bobRoomId = await bob.chat.ensureRoom('chat-space', alice.pub);
  assert.equal(bobRoomId, roomId);

  // Idempotent: calling again doesn't reset/lose the existing config.
  const again = await alice.chat.ensureRoom('chat-space', bob.pub);
  assert.equal(again, roomId);
});

test('createGroup() posts an invite into every OTHER member\'s mailbox; listMyGroups() reads it back', async () => {
  const alice = await freshPeer();
  const bob = await freshPeer();
  await alice.identity.publishMainProfile({ name: 'Alice' });
  await bob.identity.publishMainProfile({ name: 'Bob' });
  await copyQuBit(bob.qu, alice.qu, `/store/actors/~${bob.pub}/profile`);
  await copyQuBit(alice.qu, bob.qu, `/store/actors/~${alice.pub}/profile`);

  const { groupId, memberPubs } = await alice.chat.createGroup('chat-space', { name: 'Team', memberPubs: [bob.pub] });
  assert.deepEqual([...memberPubs].sort(), [alice.pub, bob.pub].sort());

  // Alice never invites herself - only Bob's mailbox gets the invite message.
  const aliceOwnGroups = await alice.chat.listMyGroups();
  assert.deepEqual(aliceOwnGroups, []);

  // Simulate the invite syncing to Bob's own store.
  const inviteSpace = `chat-invites-${bob.pub}`;
  const metaBit = await alice.qu.get(`/store/${inviteSpace}/threads/groups/meta`);
  await bob.qu.putSealed(`/store/${inviteSpace}/threads/groups/meta`, metaBit);
  const entries = await alice.qu.getChildren(`/store/${inviteSpace}/threads/groups/msgs`);
  for (const entry of entries) await bob.qu.putSealed(entry.path, entry.quBit);

  const bobGroups = await bob.chat.listMyGroups();
  assert.deepEqual(bobGroups, [groupId]);

  const groupConfig = await bob.messages.getConfig('chat-space', groupId);
  assert.equal(groupConfig, null); // the group THREAD itself lives under the caller's chat spaceId, not synced in this test - listMyGroups() only needs the invite mailbox
});

test('myInviteSpace() is this identity\'s own chat-invites-<pub> namespace', async () => {
  const alice = await freshPeer();
  assert.equal(await alice.chat.myInviteSpace(), `chat-invites-${alice.pub}`);
});
