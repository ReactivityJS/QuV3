import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { ListService, StarredService, FlagService, ContactsService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());

  const list = new ListService(qu);
  const starred = new StarredService(qu, identity);
  const flags = new FlagService(qu, identity, starred, list);
  const contacts = new ContactsService(flags, identity);

  return { qu, services: { contacts } };
}

/** Publishes a separate identity's profile onto the shared store and adds them as a contact - same pattern @qu/services' contacts-service.test.js already uses. */
async function addContact(qu, contacts, { alias }) {
  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  const otherIdentity = new QuIdentityEngine(otherQu);
  await otherIdentity.importMnemonic(otherIdentity.generateMnemonic());
  const actorPub = await otherIdentity.publishMainProfile({ alias });
  await qu.putSealed(actorPath(actorPub, 'profile'), await otherQu.get(actorPath(actorPub, 'profile')));
  await contacts.addContact(actorPub);
  return actorPub;
}

test('shows the empty state with no contacts', async () => {
  const { services } = await freshEnv();
  const container = document.createElement('div');
  mount(container, { services, apps: [] });
  await waitFor(() => container.querySelector('p') !== null);

  assert.match(container.textContent, /No contacts yet/);
});

test('renders every contact with alias and a working profile link', async () => {
  const { qu, services } = await freshEnv();
  const pub = await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = document.createElement('div');
  mount(container, { services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length > 0);

  assert.equal(container.querySelector('.qu-contact-name').textContent, 'Ada');
  assert.equal(container.querySelector(`a[href="#/~${pub}"]`) !== null, true);
});

test('search filters by alias', async () => {
  const { qu, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada Lovelace' });
  await addContact(qu, services.contacts, { alias: 'Bob' });

  const container = document.createElement('div');
  mount(container, { services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 2);

  const search = container.querySelector('input');
  search.value = 'bob';
  search.dispatchEvent(new window.Event('input'));

  const names = [...container.querySelectorAll('.qu-contact-name')].map((el) => el.textContent);
  assert.deepEqual(names, ['Bob']);
});

test('no-match state shown when the search matches no contact', async () => {
  const { qu, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = document.createElement('div');
  mount(container, { services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 1);

  const search = container.querySelector('input');
  search.value = 'zzz-nomatch';
  search.dispatchEvent(new window.Event('input'));

  assert.match(container.textContent, /No contact matches/);
});

test('clicking Remove removes the contact and re-renders (falls back to the empty state)', async () => {
  const { qu, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = document.createElement('div');
  mount(container, { services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 1);

  const removeBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
  removeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => container.querySelector('p') !== null);

  assert.match(container.textContent, /No contacts yet/);
});

test('renders every action another app declared for the "contact-row" slot, with {pub} resolved per contact', async () => {
  const { qu, services } = await freshEnv();
  const pub = await addContact(qu, services.contacts, { alias: 'Ada' });
  const apps = [
    { name: 'chat', actions: [{ slot: 'contact-row', id: 'chat', label: 'Chat', icon: '💬', hrefTemplate: '#/chat/{pub}' }] },
    { name: 'app-list', actions: [] }, // declares no contact-row action - must not add anything
  ];

  const container = document.createElement('div');
  mount(container, { services, apps });
  await waitFor(() => container.querySelectorAll('li').length > 0);

  const actionLink = container.querySelector('.qu-contact-action');
  assert.ok(actionLink);
  assert.equal(actionLink.getAttribute('href'), `#/chat/${pub}`);
  assert.equal(actionLink.textContent, '💬');
});

test('with no app declaring the "contact-row" slot, no action links are rendered', async () => {
  const { qu, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = document.createElement('div');
  mount(container, { services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length > 0);

  assert.equal(container.querySelectorAll('.qu-contact-action').length, 0);
});

test('multiple contacts each get their own resolved action href', async () => {
  const { qu, services } = await freshEnv();
  const pubA = await addContact(qu, services.contacts, { alias: 'Ada' });
  const pubB = await addContact(qu, services.contacts, { alias: 'Bob' });
  const apps = [{ name: 'chat', actions: [{ slot: 'contact-row', id: 'chat', label: 'Chat', hrefTemplate: '#/chat/{pub}' }] }];

  const container = document.createElement('div');
  mount(container, { services, apps });
  await waitFor(() => container.querySelectorAll('li').length === 2);

  const hrefs = [...container.querySelectorAll('.qu-contact-action')].map((a) => a.getAttribute('href')).sort();
  assert.deepEqual(hrefs, [`#/chat/${pubA}`, `#/chat/${pubB}`].sort());
});
