import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine } from '@qu/engines';
import {
  ListService, DirectoryService, ProfileService, FlagService,
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
  const flags = new FlagService(qu, identity, list);
  const contacts = new ContactsService(flags, identity);
  const actors = new ActorService(identity);

  return { qu, identity, services: { directory, profile, contacts, actors } };
}

/** Publishes a SEPARATE identity's profile (and, optionally, directory entry) onto the shared `qu` store - simulating data that has already synced in from a peer. */
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

/** Must be attached to document.body - <qu-list>/<qu-view> only fire connectedCallback() once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('renders every visible directory entry except the viewer\'s own', async () => {
  const { qu, identity, services } = await freshEnv();
  await services.directory.setVisible(true, {}); // the viewer opts in too...
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length > 0);
  await waitFor(() => container.querySelector('.qu-user-alias')?.textContent === 'Ada');

  assert.equal(container.querySelectorAll('li').length, 1); // never itself
  assert.equal(container.querySelector(`a[href="#/~${otherPub}"]`) !== null, true);
});

test('shows no rows when nobody has opted into the directory', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(container.querySelectorAll('li').length, 0);
});

test('the list updates live when a new user becomes visible', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(container.querySelectorAll('li').length, 0);

  await publishOtherUser(qu, { alias: 'Ada' });
  await waitFor(() => container.querySelectorAll('li').length === 1);
});

test('search hides rows whose alias/pub does not match the query', async () => {
  const { qu, services } = await freshEnv();
  await publishOtherUser(qu, { alias: 'Ada Lovelace' });
  await publishOtherUser(qu, { alias: 'Bob' });

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length === 2);
  await waitFor(() => [...container.querySelectorAll('.qu-user-alias')].every((el) => el.textContent));

  const search = container.querySelector('input');
  search.value = 'lovelace';
  search.dispatchEvent(new window.Event('input'));

  const visible = [...container.querySelectorAll('li')].filter((li) => !li.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0].textContent, /Ada Lovelace/);
});

test('search also matches by pubkey substring', async () => {
  const { qu, services } = await freshEnv();
  const adaPub = await publishOtherUser(qu, { alias: 'Ada' });
  await publishOtherUser(qu, { alias: 'Bob' });

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length === 2);
  await waitFor(() => [...container.querySelectorAll('.qu-user-alias')].every((el) => el.textContent));

  const search = container.querySelector('input');
  search.value = adaPub.slice(0, 10);
  search.dispatchEvent(new window.Event('input'));

  const visible = [...container.querySelectorAll('li')].filter((li) => !li.hidden);
  assert.equal(visible.length, 1);
});

test('an exact FP for an UNLISTED actor is resolved live and shown with a "Not listed" badge', async () => {
  const { qu, services } = await freshEnv();
  const unlistedPub = await publishOtherUser(qu, { alias: 'Ghost', visible: false });

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const search = container.querySelector('input');
  search.value = unlistedPub;
  search.dispatchEvent(new window.Event('input'));
  await waitFor(() => container.querySelector('.qu-user-badge') !== null, { timeout: 2000 });

  assert.equal(container.querySelector('.qu-user-unlisted .qu-user-alias').textContent, 'Ghost');
});

test('a query too short to be an FP never triggers the unlisted lookup', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const search = container.querySelector('input');
  search.value = 'short';
  search.dispatchEvent(new window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(container.querySelector('.qu-user-badge'), null);
});

test('clicking the contact toggle adds a contact, re-clicking removes it', async () => {
  const { qu, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('button') !== null);

  const toggle = container.querySelector('button');
  await waitFor(() => toggle.textContent === '☆');
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

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('button') !== null);
  await waitFor(() => container.querySelector('button').textContent === '★');
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  await publishOtherUser(qu, { alias: 'Ada' });
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('li').length === 1);
  assert.doesNotThrow(() => stop());
});

// Regression: a directory entry whose signer doesn't match the path it
// lives at (a forged/mismatched entry) must never be trusted or rendered -
// same convention DirectoryService.listVisible() already enforces.
test('a directory entry signed by someone OTHER than the actor its path names is never rendered', async () => {
  const { qu, services } = await freshEnv();
  const { QuCrypto } = await import('@qu/core');
  const realPub = await publishOtherUser(qu, { alias: 'Real', visible: false });
  const forgerKp = await QuCrypto.generateKeypair();
  await qu.put(paths.directoryEntryPath(realPub), { actorPub: realPub, forged: true }, {
    signWith: forgerKp.privateKey,
    writerPub: forgerKp.publicKey,
  });

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(container.querySelectorAll('li').length, 0);
});
