import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { PresenceService } from '../src/presence-service.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity, presence: new PresenceService(qu, identity) };
}

test('setPresence()/getPresence() - a just-published "online" status is reported online', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setPresence('board', 'general', 'online');

  const result = await presence.getPresence('board', 'general', [myPub]);
  assert.equal(result[myPub].status, 'online');
  assert.equal(result[myPub].online, true);
});

test('getPresence() treats a stale "online" status (past staleAfterMs) as offline', async () => {
  const { qu, presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const signKey = await identity.getMainKey();
  await qu.put(`/store/board/threads/general/presence/${myPub}`, { status: 'online', lastSeen: Date.now() - 60_000 }, {
    signWith: signKey.privateKeyPkcs8,
    writerPub: signKey.publicKey,
  });

  const result = await presence.getPresence('board', 'general', [myPub], { staleAfterMs: 15_000 });
  assert.equal(result[myPub].status, 'online'); // last published status is preserved...
  assert.equal(result[myPub].online, false); // ...but staleness overrides it for "online" purposes
});

test('getPresence() for a member who never published presence omits them from the result', async () => {
  const { presence } = await freshSetup();
  assert.deepEqual(await presence.getPresence('board', 'general', ['never-seen']), {});
});

test('startHeartbeat() publishes online immediately, then offline once stopped', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const stop = presence.startHeartbeat('board', 'general', { intervalMs: 1_000_000 }); // interval never fires during this test
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the initial fire-and-forget setPresence() land
  assert.equal((await presence.getPresence('board', 'general', [myPub]))[myPub].status, 'online');

  await stop();
  assert.equal((await presence.getPresence('board', 'general', [myPub]))[myPub].status, 'offline');
});

test('setPresence(status, {typing: true}) reports typing: true (gated by online) via getPresence()', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setPresence('board', 'general', 'online', { typing: true });

  const result = await presence.getPresence('board', 'general', [myPub]);
  assert.equal(result[myPub].online, true);
  assert.equal(result[myPub].typing, true);
});

test('setPresence(status) with typing OMITTED preserves the last EXPLICIT typing write - a periodic heartbeat tick never silently clears an active typing signal', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setPresence('board', 'general', 'online', { typing: true });

  // A routine "still online" heartbeat call - no opinion on typing at all.
  await presence.setPresence('board', 'general', 'online');

  const result = await presence.getPresence('board', 'general', [myPub]);
  assert.equal(result[myPub].typing, true, 'typing must survive an unrelated heartbeat write');
});

test('setPresence(status, {typing: false}) is an explicit, real transition - clears a previously-true typing flag', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setPresence('board', 'general', 'online', { typing: true });
  await presence.setPresence('board', 'general', 'online', { typing: false });

  const result = await presence.getPresence('board', 'general', [myPub]);
  assert.equal(result[myPub].typing, false);
});

test('getPresence(): typing never reports true for a STALE record, even if the stored flag itself is still true', async () => {
  const { qu, presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const signKey = await identity.getMainKey();
  await qu.put(`/store/board/threads/general/presence/${myPub}`, { status: 'online', lastSeen: Date.now() - 60_000, typing: true }, {
    signWith: signKey.privateKeyPkcs8,
    writerPub: signKey.publicKey,
  });

  const result = await presence.getPresence('board', 'general', [myPub], { staleAfterMs: 15_000 });
  assert.equal(result[myPub].online, false);
  assert.equal(result[myPub].typing, false, 'a stale record can never show as typing, regardless of the raw stored flag');
});

test('publishReadReceipt()/getReadReceipts() round-trip', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const before = Date.now();
  await presence.publishReadReceipt('board', 'general', 12345);

  const result = await presence.getReadReceipts('board', 'general', [myPub]);
  assert.equal(result[myPub].upto, 12345);
  // readAt is the QuBit's own write ts (when it was actually published),
  // independent of upto (which message ts it claims to have read up to).
  assert.ok(result[myPub].readAt >= before);
});

test('getReadReceipts() for a member who never published a receipt omits them from the result', async () => {
  const { presence } = await freshSetup();
  assert.deepEqual(await presence.getReadReceipts('board', 'general', ['never-read']), {});
});

test('read receipts are PUBLIC (visible via a fresh PresenceService instance on the same store), unlike MessageService.markRead()', async () => {
  const { qu, presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.publishReadReceipt('board', 'general', 999);

  const otherViewer = new PresenceService(qu, identity);
  const result = await otherViewer.getReadReceipts('board', 'general', [myPub]);
  assert.equal(result[myPub].upto, 999);
});
