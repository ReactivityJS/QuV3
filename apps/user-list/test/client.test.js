import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, AssetEngine } from '@qu/engines';
import {
  ListService, DirectoryService, ProfileService, FlagService,
  ContactsService, ActorService, AssetService, paths,
} from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');
const { mountAppTemplate } = await import('@qu/ui');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
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
  const assets = new AssetService(qu, new AssetEngine(qu), identity);

  return { qu, identity, services: { directory, profile, contacts, actors, assets } };
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

/** Publishes a separate identity's profile onto the shared store and adds them as a contact (the #/user-list default view's own data, distinct from publishOtherUser()'s directory-visibility shape). */
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

function fakeChrome(chromeRoot) {
  let current = {};
  const stopTemplate = mountAppTemplate(chromeRoot, { render: () => {} });
  return {
    get current() { return current; },
    set(partial) {
      current = { ...current, ...partial };
      stopTemplate.update(current);
    },
  };
}

test('passes a given syncFetch through to <qu-list>, called with the directory\'s parent path', async () => {
  const { qu, services } = await freshEnv();
  const calls = [];
  const syncFetch = (prefix) => { calls.push(prefix); return Promise.resolve(); };

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe, syncFetch, segments: ['user-list', 'all'] });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c) => c === paths.directoryEntriesParentPath()));
});

test('renders every visible directory entry except the viewer\'s own', async () => {
  const { qu, identity, services } = await freshEnv();
  await services.directory.setVisible(true, {}); // the viewer opts in too...
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
  await waitFor(() => container.querySelectorAll('li').length > 0);
  await waitFor(() => container.querySelector('.qu-user-alias')?.textContent === 'Ada');

  assert.equal(container.querySelectorAll('li').length, 1); // never itself
  assert.equal(container.querySelector(`a[href="#/~${otherPub}"]`) !== null, true);
});

test('shows no rows when nobody has opted into the directory', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(container.querySelectorAll('li').length, 0);
});

test('the list updates live when a new user becomes visible', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
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
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
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
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
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
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const search = container.querySelector('input');
  search.value = unlistedPub;
  search.dispatchEvent(new window.Event('input'));
  await waitFor(() => container.querySelector('.qu-user-badge') !== null, { timeout: 2000 });

  assert.equal(container.querySelector('.qu-user-unlisted .qu-user-alias').textContent, 'Ghost');
});

test('an exact FP for an UNLISTED actor who uploaded a real image avatar renders it as a <qu-asset>, not a missing/initials badge', async () => {
  // Regression test - reported live: an unlisted user found via FP/pub
  // search showed no avatar at all, even though the SAME profile's avatar
  // rendered correctly on its own profile page. Root cause was two-fold
  // (see @qu/ui/avatar.js's own doc comment): resolveUnlisted() called the
  // plain renderAvatar(), which doesn't understand the "asset:<id>" shape
  // an uploaded avatar's `avatar` field holds - it would show either raw
  // "asset:..." text or fall through to the initials badge, never the
  // real image.
  const { qu, services } = await freshEnv();

  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  otherQu.mount('blob', new MemoryStoreAdapter());
  const otherIdentity = new QuIdentityEngine(otherQu);
  await otherIdentity.importMnemonic(otherIdentity.generateMnemonic());
  const otherAssets = new AssetService(otherQu, new AssetEngine(otherQu), otherIdentity);
  const otherPub = await otherIdentity.publishMainProfile({ alias: 'Ghost' });
  await otherAssets.upload(otherPub, 'avatar1', new TextEncoder().encode('fake png bytes'));
  await new ProfileService(otherQu, otherIdentity).saveProfile({ alias: 'Ghost', avatar: 'asset:avatar1' });
  // Not in the directory (unlisted) - simulate only the profile + asset having synced in, same as publishOtherUser() does for the plain profile-only case.
  await qu.putSealed(actorPath(otherPub, 'profile'), await otherQu.get(actorPath(otherPub, 'profile')));
  await qu.putSealed(`/store/${otherPub}/assets/avatar1/meta`, await otherQu.get(`/store/${otherPub}/assets/avatar1/meta`));
  await qu.putSealed(`/blob/${otherPub}/avatar1/chunk_0`, await otherQu.get(`/blob/${otherPub}/avatar1/chunk_0`));

  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const search = container.querySelector('input');
  search.value = otherPub;
  search.dispatchEvent(new window.Event('input'));
  await waitFor(() => container.querySelector('.qu-user-unlisted qu-asset') !== null, { timeout: 2000 });

  const assetEl = container.querySelector('.qu-user-unlisted qu-asset');
  assert.equal(assetEl.getAttribute('space-id'), otherPub);
  assert.equal(assetEl.getAttribute('asset-id'), 'avatar1');
});

test('a query too short to be an FP never triggers the unlisted lookup', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
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
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
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
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
  await waitFor(() => container.querySelector('button') !== null);
  await waitFor(() => container.querySelector('button').textContent === '★');
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  await publishOtherUser(qu, { alias: 'Ada' });
  const container = makeContainer();
  const stop = mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
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
  mount(container, { qu, services, subscribe: noopSubscribe, segments: ['user-list', 'all'] });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(container.querySelectorAll('li').length, 0);
});

// ===== #/user-list - Contacts (default view, merged from the former apps/contact-list) =====

test('Contacts view: passes a given syncFetch through to <qu-list>, called with this identity\'s own private contacts path', async () => {
  const { qu, identity, services } = await freshEnv();
  const { QuCrypto } = await import('@qu/core');
  const selfPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const calls = [];
  const syncFetch = (prefix) => { calls.push(prefix); return Promise.resolve(); };

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [], syncFetch });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(calls.length >= 1);
  assert.ok(calls.every((c) => c === paths.privateFlagParentPath(selfPub, 'favorite', 'user')));
});

test('Contacts view: shows no rows with no contacts', async () => {
  const { qu, identity, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(container.querySelectorAll('li').length, 0);
});

test('Contacts view: renders every contact with alias and a working profile link', async () => {
  const { qu, identity, services } = await freshEnv();
  const pub = await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length > 0);
  await waitFor(() => container.querySelector('.qu-user-alias')?.textContent === 'Ada');

  assert.equal(container.querySelector(`a[href="#/~${pub}"]`) !== null, true);
});

test('Contacts view: the list updates live when a new contact is added', async () => {
  const { qu, identity, services } = await freshEnv();
  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(container.querySelectorAll('li').length, 0);

  await addContact(qu, services.contacts, { alias: 'Ada' });
  await waitFor(() => container.querySelectorAll('li').length === 1);
});

test('Contacts view: clicking Remove removes the contact and the row disappears live (no manual refresh)', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 1);

  const pub = container.querySelector('.qu-user-info').getAttribute('href').slice('#/~'.length);
  container.querySelector('.qu-user-remove').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => container.querySelectorAll('li').length === 0);
  assert.equal(await services.contacts.isContact(pub), false);
});

test('Contacts view: search hides rows whose name does not match the query', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada Lovelace' });
  await addContact(qu, services.contacts, { alias: 'Bob' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 2);
  await waitFor(() => [...container.querySelectorAll('.qu-user-alias')].every((el) => el.textContent));

  const search = container.querySelector('input');
  search.value = 'bob';
  search.dispatchEvent(new window.Event('input'));

  const visible = [...container.querySelectorAll('li')].filter((li) => !li.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0].textContent, /Bob/);
});

test('Contacts view: renders every action another app declared for the "contact-row" slot, with {pub} resolved per contact', async () => {
  const { qu, identity, services } = await freshEnv();
  const pub = await addContact(qu, services.contacts, { alias: 'Ada' });
  const apps = [
    { name: 'chat', actions: [{ slot: 'contact-row', id: 'chat', label: 'Chat', icon: '💬', hrefTemplate: '#/chat/{pub}' }] },
  ];

  const container = makeContainer();
  mount(container, { qu, identity, services, apps });
  await waitFor(() => container.querySelector('.qu-user-action') !== null);

  const actionLink = container.querySelector('.qu-user-action');
  assert.equal(actionLink.getAttribute('href'), `#/chat/${pub}`);
  assert.equal(actionLink.textContent, '💬');
});

test('Contacts view: with no app declaring the "contact-row" slot, no action links are rendered', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const container = makeContainer();
  mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length > 0);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(container.querySelectorAll('.qu-user-action').length, 0);
});

test('Contacts view: the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps: [] });
  await waitFor(() => container.querySelectorAll('li').length === 1);
  assert.doesNotThrow(() => stop());
});

// ===== ctx.chrome's views pill - the Contacts <-> All users switch =====

test('the views pill shows both routes as real links, with the current route marked active', async () => {
  const { qu, identity, services } = await freshEnv();
  await addContact(qu, services.contacts, { alias: 'Ada' });

  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, apps: [], subscribe: noopSubscribe, segments: ['user-list'], chrome });
  try {
    await waitFor(() => container.querySelectorAll('li').length === 1);
    const popupLinks = [...chromeRoot.querySelectorAll('.qu-apptpl-popup a')];
    assert.deepEqual(popupLinks.map((a) => a.getAttribute('href')), ['#/user-list', '#/user-list/all']);
  } finally {
    stop();
  }

  const chromeRoot2 = makeContainer();
  const chrome2 = fakeChrome(chromeRoot2);
  const container2 = makeContainer();
  const stop2 = mount(container2, { qu, identity, services, apps: [], subscribe: noopSubscribe, segments: ['user-list', 'all'], chrome: chrome2 });
  try {
    await waitFor(() => chromeRoot2.querySelector('.qu-apptpl-pill') !== null);
    assert.ok(chromeRoot2.querySelector('.qu-apptpl-pill').textContent.includes('All'));
  } finally {
    stop2();
  }
});
