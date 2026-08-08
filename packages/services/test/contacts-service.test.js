import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { FlagService } from '../src/flag-service.js';
import { ContactsService } from '../src/contacts-service.js';

async function freshContacts() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  const flags = new FlagService(qu, identity, new ListService(qu));
  return { qu, identity, contacts: new ContactsService(flags, identity) };
}

test('addContact()/isContact() round-trip', async () => {
  const { contacts } = await freshContacts();
  await contacts.addContact('some-actor-pub', { nickname: 'Bob' });
  assert.equal(await contacts.isContact('some-actor-pub'), true);
  assert.equal(await contacts.isContact('nobody'), false);
});

test('removeContact() removes exactly the given contact', async () => {
  const { contacts } = await freshContacts();
  await contacts.addContact('a');
  await contacts.addContact('b');
  await contacts.removeContact('a');
  const list = await contacts.listContacts();
  assert.deepEqual(list.map((c) => c.actorPub), ['b']);
});

test('listContacts() resolves each contact\'s CURRENT public profile', async () => {
  const { qu, contacts } = await freshContacts();

  // A separate identity publishes a profile that gets added as a contact.
  const contactQu = new QuStore();
  contactQu.mount('store', new MemoryStoreAdapter());
  const contactIdentity = new QuIdentityEngine(contactQu);
  await contactIdentity.importMnemonic(contactIdentity.generateMnemonic());
  const contactPub = await contactIdentity.publishMainProfile({ name: 'Carol' });

  // Simulate that profile having synced to our own store (a real sync layer would do this).
  const profileQuBit = await contactQu.get(`/store/actors/~${contactPub}/profile`);
  await qu.putSealed(`/store/actors/~${contactPub}/profile`, profileQuBit);

  await contacts.addContact(contactPub, { nickname: 'Carol at work' });
  const [entry] = await contacts.listContacts();

  assert.equal(entry.actorPub, contactPub);
  assert.equal(entry.nickname, 'Carol at work');
  assert.equal(entry.profile.name, 'Carol');
});

test('listContacts() resolves profile to null for a contact who never published one', async () => {
  const { contacts } = await freshContacts();
  await contacts.addContact('never-published-a-profile');
  const [entry] = await contacts.listContacts();
  assert.equal(entry.profile, null);
});
