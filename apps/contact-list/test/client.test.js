import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { ListService, FlagService, ContactsService, ProfileService } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());

  const list = new ListService(qu);
  const flags = new FlagService(qu, identity, list);
  const contacts = new ContactsService(flags, identity);
  const profile = new ProfileService(qu, identity);

  return { qu, identity, services: { contacts, profile } };
}

/** Publishes a separate identity's profile onto the shared store and adds them as a contact. */
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

/** Must be attached to document.body - <qu-list>/<qu-view> only fire connectedCallback() once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('shows no rows with no contacts', async () => {
  const { qu, identity, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(container.querySelectorAll('li').length, 0);
});

test('renders every contact with alias and a working profile link', async () => {
  const { qu, identity, services } = await freshEnv();
  const pub = await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length > 0);
  await waitFor(() => container.querySelector('.qu-contact-name')?.textContent === 'Ada');

  assert.equal(container.querySelector(`a[href="#/~${pub}"]`) !== null, true);
});

test('the list updates live when a new contact is added', async () => {
  const { qu, identity, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(container.querySelectorAll('li').length, 0);

  await addContact(qu, services.contacts, { alias: 'Ada' });
  await waitFor(() => container.querySelectorAll('li').length === 1);
});

test('clicking Remove removes the contact and the row disappears live (no manual refresh)', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 1);

  const pub = container.querySelector('.qu-contact-name').getAttribute('href').slice('#/~'.length);
  container.querySelector('.qu-contact-remove').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => container.querySelectorAll('li').length === 0);
  assert.equal(await services.contacts.isContact(pub), false);
});

test('search hides rows whose name does not match the query', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada Lovelace' });
  await addContact(qu, services.contacts, { alias: 'Bob' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 2);
  await waitFor(() => [...container.querySelectorAll('.qu-contact-name')].every((el) => el.textContent));

  const search = container.querySelector('input');
  search.value = 'bob';
  search.dispatchEvent(new window.Event('input'));

  const visible = [...container.querySelectorAll('li')].filter((li) => !li.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0].textContent, /Bob/);
});

test('renders every action another app declared for the "contact-row" slot, with {pub} resolved per contact', async () => {
  const { qu, identity, services } = await freshEnv();
  const pub = await addContact(qu, services.contacts, { alias: 'Ada' });
  const apps = [
    { name: 'chat', actions: [{ slot: 'contact-row', id: 'chat', label: 'Chat', icon: '💬', hrefTemplate: '#/chat/{pub}' }] },
  ];

  const container = makeContainer();
  mount(container, { qu, identity, services, apps });
  await waitFor(() => container.querySelector('.qu-contact-action') !== null);

  const actionLink = container.querySelector('.qu-contact-action');
  assert.equal(actionLink.getAttribute('href'), `#/chat/${pub}`);
  assert.equal(actionLink.textContent, '💬');
});

test('with no app declaring the "contact-row" slot, no action links are rendered', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length > 0);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(container.querySelectorAll('.qu-contact-action').length, 0);
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 1);
  assert.doesNotThrow(() => stop());
});
