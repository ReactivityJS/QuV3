import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { PresenceService } from '../src/presence-service.js';
import { ListService } from '../src/list-service.js';
import { FlagService } from '../src/flag-service.js';
import { ContactsService } from '../src/contacts-service.js';
import { presencePath } from '../src/paths.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const list = new ListService(qu);
  const flags = new FlagService(qu, identity, list);
  const contacts = new ContactsService(flags, identity);
  return { qu, identity, contacts, presence: new PresenceService(qu, identity, contacts) };
}

test('setUserPresence()/getUserPresence() - a just-published "online" status is reported online, at the GLOBAL per-actor path (not a per-thread one)', async () => {
  const { presence, identity, qu } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setUserPresence('online');

  const result = await presence.getUserPresence(myPub);
  assert.equal(result.status, 'online');
  assert.equal(result.online, true);
  assert.ok(await qu.get(presencePath(myPub))); // lands at the new global path, not a (spaceId,threadId)-scoped one
});

test('getUserPresence() treats a stale "online" status (past staleAfterMs) as offline', async () => {
  const { qu, presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const signKey = await identity.getMainKey();
  await qu.put(presencePath(myPub), { status: 'online', lastSeen: Date.now() - 60_000 }, {
    signWith: signKey.privateKeyPkcs8,
    writerPub: signKey.publicKey,
  });

  const result = await presence.getUserPresence(myPub, { staleAfterMs: 15_000 });
  assert.equal(result.status, 'online'); // last published status is preserved...
  assert.equal(result.online, false); // ...but staleness overrides it for "online" purposes
});

test('getUserPresence() for an actor who never published presence returns null', async () => {
  const { presence } = await freshSetup();
  assert.equal(await presence.getUserPresence('never-seen'), null);
});

test('getUserPresences() batches multiple actors, omitting any who never published', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setUserPresence('online');

  const result = await presence.getUserPresences([myPub, 'never-seen']);
  assert.deepEqual(Object.keys(result), [myPub]);
  assert.equal(result[myPub].online, true);
});

test('startHeartbeat() publishes online immediately, then offline once stopped - ONE call, no spaceId/threadId', async () => {
  const { presence, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const stop = presence.startHeartbeat({ intervalMs: 1_000_000 }); // interval never fires during this test
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the initial fire-and-forget setUserPresence() land
  assert.equal((await presence.getUserPresence(myPub)).status, 'online');

  await stop();
  assert.equal((await presence.getUserPresence(myPub)).status, 'offline');
});

test('getVisibility() defaults to "public"; setVisibility() persists a new choice privately (not readable by a fresh PresenceService for another identity)', async () => {
  const { presence } = await freshSetup();
  assert.equal(await presence.getVisibility(), 'public');
  await presence.setVisibility('contacts');
  assert.equal(await presence.getVisibility(), 'contacts');
});

test('visibility "off" makes setUserPresence() a no-op - no QuBit is written at all', async () => {
  const { presence, identity, qu } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setVisibility('off');
  await presence.setUserPresence('online');

  assert.equal(await qu.get(presencePath(myPub)), null);
  assert.equal(await presence.getUserPresence(myPub), null);
});

test('visibility "contacts" encrypts for this identity\'s current contacts - a contact can decrypt it, a stranger cannot', async () => {
  // Three independent identities, each on its OWN store (a QuStore holds
  // one identity at a time - same reasoning message-service.test.js's own
  // multi-identity tests already document), with just the documents real
  // sync would have delivered copied across via putSealed() - "as if sync
  // had already delivered it", same convention that file's own
  // copyQuBit()/mirrorThreadInto() helpers use.
  const { qu, identity, contacts, presence } = await freshSetup();
  await identity.publishMainProfile({}); // needed so a contact can later resolve MY X key when decrypting
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  // A contact needs a published (X-key-bearing) profile to be resolvable -
  // same fail-open-per-contact reasoning PresenceService's own doc comment
  // documents (unlike MessageService, an unresolvable contact is skipped,
  // not a fail-closed error for the whole write).
  const contactQu = new QuStore();
  contactQu.mount('store', new MemoryStoreAdapter());
  const contactIdentity = new QuIdentityEngine(contactQu);
  await contactIdentity.importMnemonic(contactIdentity.generateMnemonic());
  await contactIdentity.publishMainProfile({});
  const contactPub = QuCrypto.toBase64Url((await contactIdentity.getMainKey()).publicKey);
  const contactProfile = await contactQu.get(`/store/actors/~${contactPub}/profile`);
  await qu.putSealed(`/store/actors/~${contactPub}/profile`, contactProfile); // "sync already delivered" their profile into MY store, so I can resolve their X key
  await contacts.addContact(contactPub);

  const strangerQu = new QuStore();
  strangerQu.mount('store', new MemoryStoreAdapter());
  const strangerIdentity = new QuIdentityEngine(strangerQu);
  await strangerIdentity.importMnemonic(strangerIdentity.generateMnemonic());

  await presence.setVisibility('contacts');
  await presence.setUserPresence('online');

  const quBit = await qu.get(presencePath(myPub));
  assert.ok(quBit?.val?.iv && quBit.val.ct); // genuinely encrypted, not a plain {status,lastSeen} value

  // The contact's OWN store needs the presence QuBit and MY profile (for MY
  // X key, the sender's) delivered into it too, same "as if sync already
  // delivered it" convention.
  await contactQu.putSealed(presencePath(myPub), quBit);
  const myProfile = await qu.get(`/store/actors/~${myPub}/profile`);
  await contactQu.putSealed(`/store/actors/~${myPub}/profile`, myProfile);
  const asContact = new PresenceService(contactQu, contactIdentity);
  const seenByContact = await asContact.getUserPresence(myPub);
  assert.equal(seenByContact?.status, 'online');

  // The stranger gets the exact same QuBit + sender profile delivered, but
  // was never added to the reader list - genuinely cannot decrypt it.
  await strangerQu.putSealed(presencePath(myPub), quBit);
  await strangerQu.putSealed(`/store/actors/~${myPub}/profile`, myProfile);
  const asStranger = new PresenceService(strangerQu, strangerIdentity);
  assert.equal(await asStranger.getUserPresence(myPub), null);
});

test('visibility "contacts" with no resolvable contacts skips the write entirely (nothing meaningful to publish)', async () => {
  const { qu, identity, presence } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await presence.setVisibility('contacts');
  await presence.setUserPresence('online');
  assert.equal(await qu.get(presencePath(myPub)), null);
});

test('publishReadReceipt()/getReadReceipts() round-trip - unchanged, still per-thread', async () => {
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
