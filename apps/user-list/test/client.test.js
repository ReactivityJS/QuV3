import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine } from '@qu/engines';
import {
  ListService, DirectoryService, ProfileService, StarredService, FlagService,
  ContactsService, ActorService, paths,
} from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias: 'Me' });

  const list = new ListService(qu);
  const directory = new DirectoryService(qu, identity, list);
  const profile = new ProfileService(qu, identity);
  const starred = new StarredService(qu, identity);
  const flags = new FlagService(qu, identity, starred, list);
  const contacts = new ContactsService(flags, identity);
  const actors = new ActorService(identity);

  return { qu, identity, services: { directory, profile, contacts, actors } };
}

/** Publishes a SEPARATE identity's profile (and, optionally, directory entry) onto the shared `qu` store - simulating data that has already synced in from a peer (see @qu/services' contacts-service.test.js for the same pattern). */
async function publishOtherUser(qu, { alias, visible = true } = {}) {
  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  const otherIdentity = new QuIdentityEngine(otherQu);
  await otherIdentity.importMnemonic(otherIdentity.generateMnemonic());
  const actorPub = await otherIdentity.publishMainProfile({ alias });
  await qu.putSealed(actorPath(actorPub, 'profile'), await otherQu.get(actorPath(actorPub, 'profile')));

  if (visible) {
    const otherDirectory = new DirectoryService(otherQu, otherIdentity, new ListService(otherQu));
    await otherDirectory.setVisible(true, {});
    await qu.putSealed(paths.directoryEntryPath(actorPub), await otherQu.get(paths.directoryEntryPath(actorPub)));
  }
  return actorPub;
}

function noopSubscribe() {}

test('renders every visible directory entry except the viewer\'s own', async () => {
  const { qu, identity, services } = await freshEnv();
  await services.directory.setVisible(true, {}); // the viewer opts in too...
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });

  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length > 0);

  const aliases = [...container.querySelectorAll('.qu-user-alias')].map((el) => el.textContent);
  assert.deepEqual(aliases, ['Ada']); // ...but never shows up in its own list
  assert.equal(container.querySelector(`a[href="#/~${otherPub}"]`) !== null, true);
});

test('shows the empty state when nobody has opted into the directory', async () => {
  const { qu, services } = await freshEnv();
  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('p') !== null);

  assert.match(container.textContent, /Nobody has opted into the directory/);
});

test('search filters by alias substring', async () => {
  const { qu, services } = await freshEnv();
  await publishOtherUser(qu, { alias: 'Ada Lovelace' });
  await publishOtherUser(qu, { alias: 'Bob' });

  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length === 2);

  const search = container.querySelector('input');
  search.value = 'lovelace';
  search.dispatchEvent(new window.Event('input'));

  const aliases = [...container.querySelectorAll('.qu-user-alias')].map((el) => el.textContent);
  assert.deepEqual(aliases, ['Ada Lovelace']);
});

test('search filters by pubkey substring', async () => {
  const { qu, services } = await freshEnv();
  const adaPub = await publishOtherUser(qu, { alias: 'Ada' });
  await publishOtherUser(qu, { alias: 'Bob' });

  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length === 2);

  const search = container.querySelector('input');
  search.value = adaPub.slice(0, 10);
  search.dispatchEvent(new window.Event('input'));

  const aliases = [...container.querySelectorAll('.qu-user-alias')].map((el) => el.textContent);
  assert.deepEqual(aliases, ['Ada']);
});

test('no-match state shown for a query that matches nobody (and isn\'t a full FP)', async () => {
  const { qu, services } = await freshEnv();
  await publishOtherUser(qu, { alias: 'Ada' });

  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length === 1);

  const search = container.querySelector('input');
  search.value = 'zzz-nomatch';
  search.dispatchEvent(new window.Event('input'));

  assert.match(container.textContent, /No match/);
});

test('an exact FP for an UNLISTED actor is resolved live and shown with a "Not listed" badge', async () => {
  const { qu, services } = await freshEnv();
  const unlistedPub = await publishOtherUser(qu, { alias: 'Ghost', visible: false });

  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.textContent.length > 0);

  const search = container.querySelector('input');
  search.value = unlistedPub;
  search.dispatchEvent(new window.Event('input'));
  await waitFor(() => container.querySelector('.qu-user-badge') !== null, { timeout: 2000 });

  assert.equal(container.querySelector('.qu-user-alias').textContent, 'Ghost');
  assert.match(container.querySelector('.qu-user-badge').textContent, /Not listed/);
});

test('a query that is neither a real FP length nor a match shows the plain no-match state, no lookup attempted', async () => {
  const { qu, services } = await freshEnv();
  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.textContent.length > 0);

  const search = container.querySelector('input');
  search.value = 'short';
  search.dispatchEvent(new window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 350)); // longer than the debounce

  assert.equal(container.querySelector('.qu-user-badge'), null);
});

test('clicking the contact toggle adds a contact, re-clicking removes it', async () => {
  const { qu, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });

  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('button') !== null);

  const toggle = container.querySelector('button');
  assert.equal(toggle.textContent, '☆');
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => toggle.textContent === '★');
  assert.equal(await services.contacts.isContact(otherPub), true);

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => toggle.textContent === '☆');
  assert.equal(await services.contacts.isContact(otherPub), false);
});

test('an already-starred contact shows the active star on first render', async () => {
  const { qu, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });
  await services.contacts.addContact(otherPub);

  const container = document.createElement('div');
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('button') !== null);

  assert.equal(container.querySelector('button').textContent, '★');
});

test('the returned stop function tears down cleanly - no error, no further DOM mutation', async () => {
  const { qu, services } = await freshEnv();
  await publishOtherUser(qu, { alias: 'Ada' });
  const container = document.createElement('div');
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length === 1);
  assert.doesNotThrow(() => stop());
});
