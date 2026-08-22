import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { AccessService } from '../src/access-service.js';
import { MessageService, THREAD_PRESETS } from '../src/message-service.js';
import { threadMessagesParentPath } from '../src/paths.js';

async function freshIdentity(qu) {
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return identity;
}

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = await freshIdentity(qu);
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  return { qu, identity, list, access, messages };
}

async function copyQuBit(fromQu, toQu, path) {
  const quBit = await fromQu.get(path);
  if (quBit) await toQu.putSealed(path, quBit);
  return quBit;
}

// Two messages posted within the SAME millisecond tie-break on `rel` (their
// path, which starts with a random UUID - see message-service.js's own
// `listMessages()` doc comment), not on posting order - a real property of
// QuStore's (ts,rel) contract, not a test bug. Tests that assert exact
// chronological order space calls apart with this so `ts` genuinely differs.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

test('createThread() creates a config; calling it again returns the SAME config unchanged (idempotent)', async () => {
  const { messages } = await freshSetup();
  const config = await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  assert.equal(config.writers, '*');

  const again = await messages.createThread('board', 'general', { writers: [] }); // would be a very different config if this landed
  assert.deepEqual(again, config);
});

test('getConfig() of a never-created thread returns null', async () => {
  const { messages } = await freshSetup();
  assert.equal(await messages.getConfig('board', 'nope'), null);
});

test('postMessage()/listMessages() round-trip on a public thread, oldest-first by default', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await messages.postMessage('board', 'general', { body: 'first' });
  await tick();
  await messages.postMessage('board', 'general', { body: 'second' });

  const { messages: list, nextCursor } = await messages.listMessages('board', 'general');
  assert.deepEqual(list.map((m) => m.body), ['first', 'second']);
  assert.equal(nextCursor, null);
});

test('postMessage() needs no separate index write - the message path alone is what listMessages() enumerates (DERIVED list)', async () => {
  const { qu, messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const { id } = await messages.postMessage('board', 'general', { body: 'hi' });

  const entries = await qu.getChildren(threadMessagesParentPath('board', 'general'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path.endsWith(`/${id}`), true);
});

test('postMessage() applies markdown + mentions formatting per the thread config', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum()); // markdown + mentions
  const message = await messages.postMessage('board', 'general', { body: '**bold** @' + 'a'.repeat(20) });

  assert.ok(message.formattedHtml.includes('<strong>bold</strong>'));
  assert.deepEqual(message.mentions, ['a'.repeat(20)]);
});

test('postMessage() applies markdown formatting for THREAD_PRESETS.chat()/.group() too (Chat-migration round - these used to be mentions-only)', async () => {
  const { identity, messages } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await identity.publishMainProfile({ name: 'Me' }); // reader-restricted threads need each reader's own published X key to encrypt for them
  await messages.createThread('board', 'dm', THREAD_PRESETS.chat([myPub]));
  const dm = await messages.postMessage('board', 'dm', { body: '**bold**' });
  assert.ok(dm.formattedHtml.includes('<strong>bold</strong>'));

  await messages.createThread('board', 'group', THREAD_PRESETS.group([myPub], 'Group'));
  const group = await messages.postMessage('board', 'group', { body: '*italic*' });
  assert.ok(group.formattedHtml.includes('<em>italic</em>'));
});

test('postMessage() to a nonexistent thread throws', async () => {
  const { messages } = await freshSetup();
  await assert.rejects(() => messages.postMessage('board', 'nope', { body: 'hi' }));
});

test('postMessage() rejects an unauthorized writer (AccessEngine ACL enforcement)', async () => {
  const { qu, messages } = await freshSetup();
  await messages.createThread('board', 'closed', { writers: ['someone-else-entirely'], readers: '*' });

  // The creator's own identity was NOT auto-added (includeSelfAsWriter:false
  // - see MessageService.createThread()'s own comment) - so posting as the
  // creator itself must fail too.
  await assert.rejects(() => messages.postMessage('board', 'closed', { body: 'hi' }));
});

test('editMessage() updates the body and re-applies formatting', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const { id } = await messages.postMessage('board', 'general', { body: 'original' });
  const edited = await messages.editMessage('board', 'general', id, { body: '**edited**' });

  assert.equal(edited.body, '**edited**');
  assert.ok(edited.formattedHtml.includes('<strong>edited</strong>'));
  assert.ok(typeof edited.editedAt === 'number');
});

test('editMessage() is AUTHOR-ONLY, even on a public (writers: "*") thread', async () => {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const alice = await freshIdentity(qu);
  const messagesAsAlice = new MessageService(qu, alice, new ListService(qu), new AccessService(qu, alice));
  await messagesAsAlice.createThread('board', 'general', THREAD_PRESETS.forum());
  const { id } = await messagesAsAlice.postMessage('board', 'general', { body: 'alice wrote this' });

  // A second identity, same store/space, same public thread - can post (writers:'*'),
  // but must NOT be able to edit Alice's message.
  const bob = new QuIdentityEngine(qu);
  // Can't importMnemonic() a second seed into the same store (one-seed-per-store
  // guard) - use a raw keypair standing in for "some other writer" instead,
  // exactly like flag-service.test.js's "other actors" pattern.
  const bobKp = await QuCrypto.generateKeypair();
  await qu.put('/store/board/threads/general/msgs/bob-msg', { _id: 'bob-msg', body: 'bob', author: 'bob' }, {
    signWith: bobKp.privateKeyPkcs8,
    writerPub: bobKp.publicKey,
  });

  const messagesAsBob = new MessageService(qu, { getMainKey: async () => bobKp, getProfile: async () => null }, new ListService(qu), new AccessService(qu, alice));
  await assert.rejects(() => messagesAsBob.editMessage('board', 'general', id, { body: 'hijacked' }));
});

test('addReader()/removeReader() grow/shrink a thread\'s reader list', async () => {
  const { messages, identity } = await freshSetup();
  const ownerPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await messages.createThread('board', 'inbox', THREAD_PRESETS.mail(ownerPub));

  const grown = await messages.addReader('board', 'inbox', 'new-reader-pub');
  assert.deepEqual(grown.readers, [ownerPub, 'new-reader-pub']);

  const shrunk = await messages.removeReader('board', 'inbox', 'new-reader-pub');
  assert.deepEqual(shrunk.readers, [ownerPub]);
});

test('addReader() is a no-op for an already-public ("*") thread', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const config = await messages.addReader('board', 'general', 'anyone');
  assert.equal(config.readers, '*');
});

test('markRead()/getLastReadAt() round-trip (PRIVATE per-identity marker)', async () => {
  const { messages } = await freshSetup();
  assert.equal(await messages.getLastReadAt('board', 'general'), 0);
  await messages.markRead('board', 'general');
  assert.ok((await messages.getLastReadAt('board', 'general')) > 0);
});

test('listReplies() returns only messages whose replyTo matches the given parent', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const { id: rootId } = await messages.postMessage('board', 'general', { body: 'root' });
  await messages.postMessage('board', 'general', { body: 'reply 1', replyTo: rootId });
  await messages.postMessage('board', 'general', { body: 'unrelated' });

  const replies = await messages.listReplies('board', 'general', rootId);
  assert.deepEqual(replies.map((m) => m.body), ['reply 1']);
});

test('getMessage() returns a single message by id, same shape listMessages() entries have', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const { id } = await messages.postMessage('board', 'general', { body: 'hello' });

  const found = await messages.getMessage('board', 'general', id);
  assert.equal(found.id, id);
  assert.equal(found.body, 'hello');
  assert.ok(found.ts > 0);
});

test('getMessage() returns null for a missing message, no throw', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  assert.equal(await messages.getMessage('board', 'general', 'nope'), null);
});

test('getMessage() decrypts a private (reader-restricted) thread\'s message, same as listMessages()', async () => {
  const { qu, identity, messages } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await identity.publishMainProfile({ name: 'Me' });

  await messages.createThread('board', 'private-room', THREAD_PRESETS.chat([myPub]));
  const { id } = await messages.postMessage('board', 'private-room', { body: 'secret' });

  const found = await messages.getMessage('board', 'private-room', id);
  assert.equal(found.body, 'secret');
  void qu;
});

test('notify() creates a mail thread and posts one message to it', async () => {
  const { qu, messages } = await freshSetup();

  // notify() posts into a reader-restricted (mail) thread, which genuinely
  // encrypts for the recipient - needs a REAL identity with a published,
  // resolvable X25519 key, same as postMessage() would for any private
  // thread (see the "fails closed" test below for the opposite case).
  const recipientQu = new QuStore();
  recipientQu.mount('store', new MemoryStoreAdapter());
  const recipient = await freshIdentity(recipientQu);
  const recipientPub = QuCrypto.toBase64Url((await recipient.getMainKey()).publicKey);
  await recipient.publishMainProfile({ name: 'Recipient' });
  await copyQuBit(recipientQu, qu, `/store/actors/~${recipientPub}/profile`);

  const stored = await messages.notify('inbox-space', recipientPub, 'you have mail');
  assert.equal(stored.body, 'you have mail');

  const config = await messages.getConfig('inbox-space', `invite-${recipientPub}`);
  assert.deepEqual(config.readers, [recipientPub]);
});

test('listMessages() with a limit returns a nextCursor that pages through the rest', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'general', THREAD_PRESETS.forum());
  for (let i = 0; i < 4; i++) {
    await messages.postMessage('board', 'general', { body: `m${i}` });
    await tick();
  }

  const page1 = await messages.listMessages('board', 'general', { limit: 2 });
  assert.deepEqual(page1.messages.map((m) => m.body), ['m0', 'm1']);
  assert.ok(page1.nextCursor);

  const page2 = await messages.listMessages('board', 'general', { limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.messages.map((m) => m.body), ['m2', 'm3']);
  // page2 happens to be exactly `limit` long too (4 messages, limit 2) - the
  // same "was this page full?" heuristic applies again, so nextCursor is
  // still set. A follow-up call resolves the ambiguity, same as
  // `ListService`/`QuStore.getChildren()`'s own contract: nothing claims
  // "no more data" without one page coming back short.
  assert.ok(page2.nextCursor);

  const page3 = await messages.listMessages('board', 'general', { limit: 2, cursor: page2.nextCursor });
  assert.deepEqual(page3.messages, []);
  assert.equal(page3.nextCursor, null);
});

// ===== private (reader-restricted, genuinely encrypted) threads ==================

test('a reader-restricted thread genuinely encrypts messages - the intended reader can decrypt them via a synced copy', async () => {
  const aliceQu = new QuStore();
  aliceQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(aliceQu);
  new ThreadEngine(aliceQu);
  const alice = await freshIdentity(aliceQu);
  await alice.publishMainProfile({ name: 'Alice' }); // Bob needs this to resolve Alice's X key when decrypting
  const aliceServices = { access: new AccessService(aliceQu, alice), list: new ListService(aliceQu) };
  const aliceMessages = new MessageService(aliceQu, alice, aliceServices.list, aliceServices.access);

  const bobQu = new QuStore();
  bobQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(bobQu);
  new ThreadEngine(bobQu);
  const bob = await freshIdentity(bobQu);
  const bobPub = QuCrypto.toBase64Url((await bob.getMainKey()).publicKey);
  await bob.publishMainProfile({ name: 'Bob' });

  // Alice needs Bob's profile (for his X25519 key) to encrypt for him -
  // simulate that having synced already.
  await copyQuBit(bobQu, aliceQu, `/store/actors/~${bobPub}/profile`);

  await aliceMessages.createThread('mail-space', 'invite-' + bobPub, THREAD_PRESETS.mail(bobPub));
  const alicePub = QuCrypto.toBase64Url((await alice.getMainKey()).publicKey);
  // postMessage() hands back the PLAINTEXT message it just built (see its
  // own doc comment) - the sender isn't necessarily a listed reader (Alice
  // isn't, here), so this is the only way Alice herself learns the
  // messageId, NOT a round-trip through listMessages()/decryption.
  const { id: messageId } = await aliceMessages.postMessage('mail-space', 'invite-' + bobPub, { body: 'secret for bob' });

  // The stored QuBit is genuinely ciphertext, not the plain body.
  const raw = await aliceQu.get(`/store/mail-space/threads/invite-${bobPub}/msgs/${messageId}`);
  assert.notEqual(raw.val, 'secret for bob');
  assert.equal(typeof raw.val.iv, 'string');

  // Simulate sync: the thread's meta/config, the message, and Alice's own
  // profile (so Bob can resolve the SENDER's X key) all land on Bob's store.
  await copyQuBit(aliceQu, bobQu, `/store/mail-space/threads/invite-${bobPub}/meta`);
  const bobsView = await aliceQu.getChildren(threadMessagesParentPath('mail-space', 'invite-' + bobPub));
  for (const entry of bobsView) await bobQu.putSealed(entry.path, entry.quBit);
  await copyQuBit(aliceQu, bobQu, `/store/actors/~${alicePub}/profile`);

  const bobMessages = new MessageService(bobQu, bob, new ListService(bobQu), new AccessService(bobQu, bob));
  const { messages } = await bobMessages.listMessages('mail-space', 'invite-' + bobPub);
  assert.deepEqual(messages.map((m) => m.body), ['secret for bob']);
});

test('postMessage() to a reader-restricted thread fails closed if a reader has no resolvable profile/X key', async () => {
  const { messages } = await freshSetup();
  await messages.createThread('board', 'private-thread', { writers: '*', readers: ['nobody-ever-published-a-profile'] });
  await assert.rejects(() => messages.postMessage('board', 'private-thread', { body: 'hi' }), /resolveReaderXKeys/);
});
