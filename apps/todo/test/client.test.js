import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import {
  ListService, AccessService, SharingService, MessageService, FlagService, ContactsService,
  DirectoryService, ProfileService, ActorService, AssetService, paths,
} from '@qu/services';
import { AssetEngine } from '@qu/engines';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');
const { mountAppTemplate } = await import('@qu/ui');

const TODO_SPACE_ID = '63f5cc6f-62f6-4a43-a889-33900138f8b0'; // real UUID from apps/todo/manifest.quapp

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const assetEngine = new AssetEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias: 'Me' });

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const flags = new FlagService(qu, identity, list);
  const services = {
    actors: new ActorService(identity),
    access,
    messages,
    flags,
    sharing: new SharingService(qu, identity, access, messages, flags),
    contacts: new ContactsService(flags, identity),
    directory: new DirectoryService(qu, identity, list),
    profile: new ProfileService(qu, identity),
    assets: new AssetService(qu, assetEngine, identity),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/** Publishes a SEPARATE identity's profile onto the shared `qu` store - simulating a peer whose profile has already synced in (needed to resolve their X25519 key for an invite). Mirrors apps/calendar/test's own. */
async function publishOtherUser(qu, { alias } = {}) {
  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  const otherIdentity = new QuIdentityEngine(otherQu);
  await otherIdentity.importMnemonic(otherIdentity.generateMnemonic());
  const actorPub = await otherIdentity.publishMainProfile({ alias });
  await qu.putSealed(actorPath(actorPub, 'profile'), await otherQu.get(actorPath(actorPub, 'profile')));
  return actorPub;
}

/** A full second, independent identity + services bundle - a peer who can be mounted as "the app, running as them". Mirrors apps/calendar/test's own createPeer(). */
async function createPeer(ownerQu, { alias } = {}) {
  const peerQu = new QuStore();
  peerQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(peerQu);
  new ThreadEngine(peerQu);
  const assetEngine = new AssetEngine(peerQu);
  const identity = new QuIdentityEngine(peerQu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });
  const list = new ListService(peerQu);
  const access = new AccessService(peerQu, identity);
  const messages = new MessageService(peerQu, identity, list, access);
  const flags = new FlagService(peerQu, identity, list);
  const services = {
    actors: new ActorService(identity), access, messages, flags,
    sharing: new SharingService(peerQu, identity, access, messages, flags),
    contacts: new ContactsService(flags, identity),
    directory: new DirectoryService(peerQu, identity, list),
    profile: new ProfileService(peerQu, identity),
    assets: new AssetService(peerQu, assetEngine, identity),
  };
  const myPub = await services.actors.whoAmI();
  await ownerQu.putSealed(actorPath(myPub, 'profile'), await peerQu.get(actorPath(myPub, 'profile')));
  return { qu: peerQu, identity, services, myPub };
}

async function mirrorPaths(fromQu, toQu, paths_) {
  for (const p of paths_) {
    const bit = await fromQu.get(p);
    if (bit) await toQu.putSealed(p, bit);
  }
}

async function mirrorChildren(fromQu, toQu, parentPath) {
  const entries = await new ListService(fromQu).listDerived(parentPath);
  for (const { path, quBit } of entries) await toQu.putSealed(path, quBit);
}

function noopSubscribe() {}

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
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

function segmentsFor(hash) {
  return hash.replace(/^#\//, '').split('/');
}

async function waitForAsync(check, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`waitForAsync: condition never became true within ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function createListViaForm(container, services, title = 'Groceries') {
  await waitFor(() => container.querySelector('.qu-todo-new input') !== null);
  const before = (await services.sharing.listMine('todo', 'list')).length;
  const input = container.querySelector('.qu-todo-new input');
  input.value = title;
  container.querySelector('form.qu-todo-new').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  // Count-based (not existence-based): a SECOND call in the same container
  // would otherwise resolve instantly against a list already created by an
  // EARLIER call, racing ahead of this call's own (still in-flight) qu.put().
  await waitForAsync(async () => (await services.sharing.listMine('todo', 'list')).length > before);
}

// ===== mount() - main view =================================================

test('renders the empty state when there are no lists yet', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-todo-empty') !== null);
    assert.match(container.querySelector('.qu-todo-empty').textContent, /No lists yet/);
  } finally {
    stop();
  }
});

test('creating a list from the default My Tasks page\'s empty state creates a real, unshared list, reachable from the switcher sidebar', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe, chrome });
  try {
    await createListViaForm(container, services);
    const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
    assert.ok(listId);

    await waitFor(() => [...chromeRoot.querySelectorAll('.qu-apptpl-sidebar a')].some((a) => a.textContent.includes('Groceries')));
    const listLink = [...chromeRoot.querySelectorAll('.qu-apptpl-sidebar a')].find((a) => a.textContent.includes('Groceries'));
    assert.equal(listLink.querySelector('.qu-apptpl-badge'), null, 'owner\'s own list carries no "shared" badge');
  } finally {
    stop();
  }
});

test('every page has no bespoke back link - only the shell header\'s Back/Forward', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  for (const hash of ['#/todo', `#/todo/${listId}`, `#/todo/${listId}/new`, '#/todo/all', '#/todo/manage']) {
    const c = makeContainer();
    const s = mount(c, { qu, services, segments: segmentsFor(hash), subscribe: noopSubscribe });
    await waitFor(() => c.children.length > 0);
    assert.equal(c.querySelector('a[href="#back"], .qu-back-link, [data-back]'), null, `unexpected bespoke back link on ${hash}`);
    s();
  }
});

test('a newly created list is real, ACL-protected storage: owner-only writer, a single-owner member list', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  stop();

  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  const acl = await services.access.getAcl(TODO_SPACE_ID, 'docs', `todo-${listId}-meta`);
  assert.deepEqual(acl.writers, [myPub]);
  const metaBit = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-meta`));
  assert.deepEqual(metaBit.val.members.map((m) => m.role), ['owner']);
});

// ===== Tasks: create/toggle/edit/delete/subtasks ============================

async function createTaskViaForm(container, { title, content = '', dueDate = '' } = {}) {
  await waitFor(() => container.querySelector('.qu-todo-form input[type="text"]') !== null);
  container.querySelector('.qu-todo-form input[type="text"]').value = title;
  if (content) container.querySelector('.qu-todo-form textarea').value = content;
  if (dueDate) container.querySelector('.qu-todo-form input[type="date"]').value = dueDate;
  // Reset first - `window.location.hash` is one shared jsdom global across
  // every test in this file, so without this a hash already left matching
  // the pattern by an EARLIER test would satisfy waitFor() below instantly,
  // racing ahead of this submit's own (still in-flight) qu.put().
  window.location.hash = '';
  container.querySelector('.qu-todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /^#\/todo\/[^/]+$/.test(window.location.hash));
}

test('adding a task through the New Task page makes it show up in the list, and it can be toggled done, edited, and deleted', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await createTaskViaForm(container, { title: 'Buy milk' });
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-task-title') !== null);
  assert.equal(container.querySelector('.qu-todo-task-title').textContent, 'Buy milk');

  const checkbox = container.querySelector('.qu-todo-task-row input[type="checkbox"]');
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForAsync(async () => {
    const doc = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`));
    return doc.val.items[0].done === true;
  });
  stop();

  // Edit: follow the task link, change the title.
  const taskId = (await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`))).val.items[0].id;
  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/${taskId}`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-form input[type="text"]') !== null);
  assert.equal(container.querySelector('.qu-todo-form input[type="text"]').value, 'Buy milk');
  container.querySelector('.qu-todo-form input[type="text"]').value = 'Buy oat milk';
  container.querySelector('.qu-todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitForAsync(async () => {
    const doc = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`));
    return doc.val.items[0].title === 'Buy oat milk';
  });
  stop();

  // Delete.
  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/${taskId}`), subscribe: noopSubscribe });
  window.confirm = () => true;
  await waitFor(() => container.querySelector('.qu-todo-danger') !== null);
  container.querySelector('.qu-todo-danger').click();
  await waitForAsync(async () => {
    const doc = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`));
    return doc.val.items.length === 0;
  });
  stop();
});

test('a subtask renders indented under its parent, and deleting the parent also removes the subtask', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await createTaskViaForm(container, { title: 'Plan trip' });
  stop();
  const parentId = (await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`))).val.items[0].id;

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new/${parentId}`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('h1') !== null && /Plan trip/.test(container.querySelector('h1').textContent));
  await createTaskViaForm(container, { title: 'Book flights' });
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelectorAll('.qu-todo-task-title').length === 2);
  const rows = [...container.querySelectorAll('.qu-todo-task-row')];
  assert.equal(rows[0].classList.contains('qu-todo-task-indent'), false);
  assert.equal(rows[1].classList.contains('qu-todo-task-indent'), true);
  assert.equal(rows[1].querySelector('.qu-todo-task-title').textContent, 'Book flights');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/${parentId}`), subscribe: noopSubscribe });
  window.confirm = () => true;
  await waitFor(() => container.querySelector('.qu-todo-danger') !== null);
  container.querySelector('.qu-todo-danger').click();
  await waitForAsync(async () => {
    const doc = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`));
    return doc.val.items.length === 0; // both parent AND subtask gone
  });
  stop();
});

test('the New Task page offers a list picker (defaulting to the list navigated from) so a task can be created directly into any other editable list, and the assignee defaults to the creator themself', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services, 'List A');
  await createListViaForm(container, services, 'List B');
  const mine = await services.sharing.listMine('todo', 'list');
  assert.equal(mine.length, 2);
  const [listA, listB] = mine.map((l) => l.id);
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listA}/new`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-list-select') !== null);
  const listSelect = container.querySelector('.qu-todo-list-select');
  assert.equal(listSelect.disabled, false);
  assert.deepEqual([...listSelect.options].map((o) => o.value).sort(), [listA, listB].sort());
  assert.equal(listSelect.value, listA); // defaults to the list navigated from

  assert.equal(container.querySelector('.qu-todo-assignee-select').value, myPub, 'assignee must default to the creator themself, not "Unassigned"');

  container.querySelector('.qu-todo-form input[type="text"]').value = 'Landed in list B';
  listSelect.value = listB;
  listSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  window.location.hash = ''; // see createTaskViaForm()'s own comment on why this reset matters
  container.querySelector('.qu-todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => window.location.hash === `#/todo/${listB}`);

  const docA = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listA}-items`));
  assert.deepEqual(docA.val.items, []);
  const docB = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listB}-items`));
  assert.equal(docB.val.items[0]?.title, 'Landed in list B');
  stop();
});

test('a subtask\'s New Task page locks the list picker to its parent\'s own list, showing it disabled rather than offering other lists', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await createTaskViaForm(container, { title: 'Plan trip' });
  stop();
  const parentId = (await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`))).val.items[0].id;

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new/${parentId}`), subscribe: noopSubscribe });
  // Checked on `.disabled` itself (not mere presence): the PREVIOUS mount's
  // own (non-subtask, unlocked) `.qu-todo-list-select` is still sitting in
  // this same, reused `container` - `stop()` halts reactivity, it doesn't
  // clear the DOM - so a presence-only wait would resolve against that
  // stale element instead of this mount's actual (locked) one.
  await waitFor(() => container.querySelector('.qu-todo-list-select')?.disabled === true);
  const listSelect = container.querySelector('.qu-todo-list-select');
  assert.equal(listSelect.disabled, true);
  assert.equal(listSelect.options.length, 1);
  assert.equal(listSelect.value, listId);
  stop();
});

// ===== Sharing (contacts-only invite by pub, autocomplete) ==================

test('the share picker only offers Contacts - a non-contact with a published profile is never suggested, and there is no "paste a raw pub" fallback', async () => {
  const { qu, services } = await freshEnv();
  const contactPub = await publishOtherUser(qu, { alias: 'Ada' });
  await services.contacts.addContact(contactPub, {});
  const strangerPub = await publishOtherUser(qu, { alias: 'Zeke' }); // published, but never added as a contact

  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/share`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-actor-picker input') !== null);
  const picker = container.querySelector('.qu-actor-picker input');

  picker.value = 'Zeke';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-actor-picker-empty') !== null);
  assert.equal(container.querySelector('.qu-actor-picker-option'), null, 'a non-contact must never be offered');

  picker.value = strangerPub; // even pasting their exact pub key must not offer them - allowPastedPub: false
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-actor-picker-empty') !== null);
  assert.equal(container.querySelector('.qu-actor-picker-option'), null);

  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-actor-picker-option') !== null);
  stop();
  void contactPub;
});

test('inviteMember flow: inviting a contact grants them editor by default, grows the items ACL, and notifies them', async () => {
  const { qu, services, myPub } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });
  await services.contacts.addContact(otherPub, {});

  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/share`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-actor-picker input') !== null);
  const picker = container.querySelector('.qu-actor-picker input');
  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-actor-picker-option') !== null);
  container.querySelector('.qu-actor-picker-option').click();

  await waitForAsync(async () => {
    const acl = await services.access.getAcl(TODO_SPACE_ID, 'docs', `todo-${listId}-items`);
    return acl.writers.length === 2;
  });
  stop();

  const metaBit = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-meta`));
  const invited = metaBit.val.members.find((m) => m.actorPub === otherPub);
  assert.equal(invited.role, 'editor');
  const itemsAcl = await services.access.getAcl(TODO_SPACE_ID, 'docs', `todo-${listId}-items`);
  assert.deepEqual(new Set(itemsAcl.writers), new Set([myPub, otherPub]));

  const inviteConfig = await services.messages.getConfig(TODO_SPACE_ID, `invite-${otherPub}`);
  assert.deepEqual(inviteConfig.readers, [otherPub]);
});

test('an invited member sees the shared list (and can only be assigned tasks - not an arbitrary actor), and assigning a task to them makes it show up on their own "Assigned to me" page', async () => {
  const { qu: ownerQu, services: ownerServices, myPub: ownerPub } = await freshEnv();
  const { qu: guestQu, services: guestServices, myPub: guestPub } = await createPeer(ownerQu, { alias: 'Ada' });
  await ownerServices.contacts.addContact(guestPub, {});

  const ownerContainer = makeContainer();
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(ownerContainer, ownerServices);
  const [{ id: listId }] = await ownerServices.sharing.listMine('todo', 'list');
  stop();

  // Share it with the guest.
  stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: segmentsFor(`#/todo/${listId}/share`), subscribe: noopSubscribe });
  await waitFor(() => ownerContainer.querySelector('.qu-actor-picker input') !== null);
  const picker = ownerContainer.querySelector('.qu-actor-picker input');
  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => ownerContainer.querySelector('.qu-actor-picker-option') !== null);
  ownerContainer.querySelector('.qu-actor-picker-option').click();
  await waitForAsync(async () => (await ownerServices.access.getAcl(TODO_SPACE_ID, 'docs', `todo-${listId}-items`)).writers.length === 2);
  stop();

  // Add a task and assign it to the guest - the assignee <select> is built
  // from the list's OWN members, so this exercises "only a current member is
  // assignable" for free (there is no free-text actor field on the task form).
  stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await waitFor(() => ownerContainer.querySelector('.qu-todo-assignee-select') !== null);
  ownerContainer.querySelector('.qu-todo-form input[type="text"]').value = 'Book venue';
  const assigneeOptions = [...ownerContainer.querySelectorAll('.qu-todo-assignee-select option')];
  const guestOption = assigneeOptions.find((o) => o.value === guestPub);
  assert.ok(guestOption, 'the invited guest must be a selectable assignee');
  assert.equal(ownerContainer.querySelector('.qu-todo-assignee-select').value, ownerPub, 'assignee must default to the creator themself');
  ownerContainer.querySelector('.qu-todo-assignee-select').value = guestPub;
  window.location.hash = ''; // see createTaskViaForm()'s own comment on why this reset matters
  ownerContainer.querySelector('.qu-todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /^#\/todo\/[^/]+$/.test(window.location.hash));
  stop();

  // Simulate sync: mirror exactly what a real relay connection would
  // deliver to the guest's own client (same technique apps/calendar/test uses).
  await mirrorPaths(ownerQu, guestQu, [
    actorPath(ownerPub, 'profile'),
    paths.documentPath(TODO_SPACE_ID, `todo-${listId}-meta`),
    paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`),
    paths.threadMetaPath(TODO_SPACE_ID, `invite-${guestPub}`),
  ]);
  await mirrorChildren(ownerQu, guestQu, paths.threadMessagesParentPath(TODO_SPACE_ID, `invite-${guestPub}`));

  // The guest's default landing view (#/todo, "Assigned to me") shows the
  // just-assigned task directly, and the switcher sidebar carries the
  // shared list with a "shared" badge (an owner's own list never gets one -
  // see the "creating a list..." test above).
  const guestContainer = makeContainer();
  const guestChromeRoot = makeContainer();
  const guestChrome = fakeChrome(guestChromeRoot);
  stop = mount(guestContainer, { qu: guestQu, services: guestServices, segments: ['todo'], subscribe: noopSubscribe, chrome: guestChrome });
  await waitFor(() => guestContainer.querySelector('.qu-todo-tasks a') !== null);
  assert.match(guestContainer.querySelector('.qu-todo-tasks a').textContent, /Book venue/);

  await waitFor(() => [...guestChromeRoot.querySelectorAll('.qu-apptpl-sidebar a')].some((a) => a.textContent.includes('Groceries')));
  const sharedListLink = [...guestChromeRoot.querySelectorAll('.qu-apptpl-sidebar a')].find((a) => a.textContent.includes('Groceries'));
  assert.ok(sharedListLink.querySelector('.qu-apptpl-badge'), 'expected the shared list to carry a "shared" badge for the guest');
  stop();
});

test('a list can never be deleted or renamed by a non-owner, not just hidden from their own UI - AccessEngine itself enforces owner-only writer on the meta document', async () => {
  const { qu: ownerQu, services: ownerServices } = await freshEnv();
  const { services: guestServices, myPub: guestPub } = await createPeer(ownerQu, { alias: 'Ada' });
  await ownerServices.contacts.addContact(guestPub, {});

  const ownerContainer = makeContainer();
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(ownerContainer, ownerServices);
  const [{ id: listId }] = await ownerServices.sharing.listMine('todo', 'list');
  stop();

  await ownerServices.sharing.inviteMember(TODO_SPACE_ID, 'docs', `todo-${listId}-meta`, guestPub, 'editor', { notifyBody: 'invited' });

  await assert.rejects(() => guestServices.sharing.changeMemberRole(TODO_SPACE_ID, 'docs', `todo-${listId}-meta`, guestPub, 'owner'));
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await waitFor(() => container.children.length > 0);
  assert.doesNotThrow(() => stop());
});

/**
 * "New list"/"New task" now live as each route's own `ctx.chrome.set()`
 * `primaryAction` (docs/app-navigation-standard.md Rule 5a) instead of the
 * older `shell.headerNavPoints` slot - the same move `apps/chat/client.js`
 * already made for "+ New group". On mobile this renders as a circular FAB
 * (`.qu-apptpl-fab`); on desktop, a prominent link at the top of
 * the sidebar (`.qu-apptpl-primary-desktop`) - either is enough to prove the
 * action is wired up. Rendered into a `fakeChrome()` root, not `container` -
 * see that helper's own doc comment above.
 */
function primaryActionLink(chromeRoot) {
  return chromeRoot.querySelector('.qu-apptpl-fab, .qu-apptpl-primary-desktop');
}

test('#/todo\'s own primaryAction is always "New list", and the settings gear always reaches "Listen verwalten" (#/todo/manage)', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe, chrome });
  try {
    await waitFor(() => primaryActionLink(chromeRoot) !== null);
    assert.equal(primaryActionLink(chromeRoot).getAttribute('href'), '#/todo/new');
    const settingsLink = [...chromeRoot.querySelectorAll('a')].find((a) => a.getAttribute('href') === '#/todo/manage');
    assert.ok(settingsLink, 'expected a "Listen verwalten" settings link pointing at #/todo/manage');
  } finally {
    stop();
  }
});

test('an open list\'s own primaryAction is "New task" once the list is editable, pointing straight at that list\'s New Task page', async () => {
  const { qu, services } = await freshEnv();
  const setupContainer = makeContainer();
  let stop = mount(setupContainer, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(setupContainer, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  const container = makeContainer();
  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}`), subscribe: noopSubscribe, chrome });
  try {
    await waitFor(() => primaryActionLink(chromeRoot) !== null);
    assert.equal(primaryActionLink(chromeRoot).getAttribute('href'), `#/todo/${listId}/new`);
  } finally {
    stop();
  }
});

test('"Mir zugewiesen"/Assigned-to-me: each row can be checked off directly (dropping out immediately, since this view is not-done-only) and links back to its own list', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-form select') !== null);
  container.querySelector('.qu-todo-form select').value = myPub; // self-assign
  await createTaskViaForm(container, { title: 'Buy milk' });
  stop();

  stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-task-title') !== null);
  assert.equal(container.querySelector('.qu-todo-task-title').textContent, 'Buy milk');

  const listLink = container.querySelector('.qu-todo-task-list-link');
  assert.ok(listLink, 'expected a link back to the task\'s own list');
  assert.equal(listLink.getAttribute('href'), `#/todo/${listId}`);
  assert.equal(listLink.textContent, 'Groceries');

  const checkbox = container.querySelector('.qu-todo-task-row input[type="checkbox"]');
  assert.equal(checkbox.disabled, false, 'the owner can edit their own list, so the checkbox must be enabled here too');
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-todo-empty') !== null);
  assert.match(container.querySelector('.qu-todo-empty').textContent, /Nothing assigned/);

  // The task itself is DONE now, not deleted - still reachable/editable from the list page.
  const itemsDoc = await qu.get(paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`));
  assert.equal(itemsDoc.val.items[0].done, true);
  stop();
});

test('list page and "Mir zugewiesen" both render a Lists <-> Mir-zugewiesen switcher (ctx.chrome\'s desktop-only navigation sidebar) and a "Copy link" button for an absolute, shareable URL', async () => {
  const { qu, services } = await freshEnv();
  const setupContainer = makeContainer();
  let stop = mount(setupContainer, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(setupContainer, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  const written = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { written.push(text); } } }, configurable: true });
  try {
    const container = makeContainer();
    const chromeRoot = makeContainer();
    const chrome = fakeChrome(chromeRoot);
    stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}`), subscribe: noopSubscribe, chrome });
    await waitFor(() => chromeRoot.querySelector('.qu-apptpl-sidebar') !== null);
    const sidebarLinks = [...chromeRoot.querySelectorAll('.qu-apptpl-sidebar a')].map((a) => a.textContent);
    assert.ok(sidebarLinks.includes('Assigned to me'), 'expected "Mir zugewiesen" in the switcher sidebar');
    assert.ok(sidebarLinks.includes('All tasks'), 'expected "Alle Aufgaben" (all tasks, across every list) in the switcher sidebar');
    assert.ok(sidebarLinks.includes('Groceries'), 'expected the list itself in the switcher sidebar');

    container.querySelector('.qu-todo-copy-link').click();
    await waitFor(() => written.length === 1);
    assert.equal(written[0], `http://localhost/#/todo/${listId}`);
    stop();

    // A fresh container (not a re-mount over the same one) - stop() tears
    // down watches/timers but never blanks the DOM itself (nothing in this
    // app needs it to), so reusing `container` here would leave the list
    // page's own stale nodes satisfying the very next waitFor() instantly,
    // racing ahead of the mine page's real (still in-flight) render.
    const mineContainer = makeContainer();
    const mineChromeRoot = makeContainer();
    const mineChrome = fakeChrome(mineChromeRoot);
    stop = mount(mineContainer, { qu, services, segments: ['todo'], subscribe: noopSubscribe, chrome: mineChrome });
    await waitFor(() => mineChromeRoot.querySelector('.qu-apptpl-sidebar') !== null);
    mineContainer.querySelector('.qu-todo-copy-link').click();
    await waitFor(() => written.length === 2);
    assert.equal(written[1], 'http://localhost/#/todo');
  } finally {
    stop();
    Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  }
});

test('#/todo/new creates a list and redirects straight to it', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['todo', 'new'], subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-todo-new input') !== null);
    container.querySelector('.qu-todo-new input').value = 'Packing list';
    window.location.hash = '';
    container.querySelector('form.qu-todo-new').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => /^#\/todo\/[^/]+$/.test(window.location.hash));
    const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
    assert.equal(window.location.hash, `#/todo/${listId}`);
  } finally {
    stop();
  }
});

// ===== Default view + "All tasks" filtering ================================

test('#/todo (the default landing view) only shows tasks assigned to ME, while #/todo/all shows every task in every list regardless of assignee - two genuinely different sets', async () => {
  const { qu, services, myPub } = await freshEnv();
  const guestPub = await createPeer(qu, { alias: 'Ada' }).then((peer) => peer.myPub);
  await services.contacts.addContact(guestPub, {});

  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container, services);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  // Share the list so the guest becomes a valid assignee.
  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/share`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-actor-picker input') !== null);
  const picker = container.querySelector('.qu-actor-picker input');
  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-actor-picker-option') !== null);
  container.querySelector('.qu-actor-picker-option').click();
  await waitForAsync(async () => (await services.access.getAcl(TODO_SPACE_ID, 'docs', `todo-${listId}-items`)).writers.length === 2);
  stop();

  // A task assigned to ME.
  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-assignee-select') !== null);
  container.querySelector('.qu-todo-assignee-select').value = myPub;
  await createTaskViaForm(container, { title: 'My task' });
  stop();

  // A task assigned to the GUEST, not me.
  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-assignee-select') !== null);
  container.querySelector('.qu-todo-assignee-select').value = guestPub;
  await createTaskViaForm(container, { title: 'Guest task' });
  stop();

  // #/todo - "assigned to me" - only ever shows MY task.
  stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-task-title') !== null);
  await waitForAsync(async () => container.querySelectorAll('.qu-todo-task-title').length === 1);
  assert.deepEqual([...container.querySelectorAll('.qu-todo-task-title')].map((a) => a.textContent), ['My task']);
  stop();

  // #/todo/all - literally every task, regardless of who it's assigned to.
  stop = mount(container, { qu, services, segments: segmentsFor('#/todo/all'), subscribe: noopSubscribe });
  await waitForAsync(async () => container.querySelectorAll('.qu-todo-task-title').length === 2);
  const allTitles = [...container.querySelectorAll('.qu-todo-task-title')].map((a) => a.textContent).sort();
  assert.deepEqual(allTitles, ['Guest task', 'My task']);
  stop();
});

test('#/todo/all falls back to the "create your first list" empty state exactly like #/todo does, when there are no lists yet', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: segmentsFor('#/todo/all'), subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-todo-empty') !== null);
    assert.match(container.querySelector('.qu-todo-empty').textContent, /No lists yet/);
    assert.ok(container.querySelector('.qu-todo-new input'), 'expected the inline "create a list" form too');
  } finally {
    stop();
  }
});
