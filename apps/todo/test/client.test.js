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
const { mount, renderHeaderNavPoints } = await import('../client.js');

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

async function createListViaForm(container) {
  await waitFor(() => container.querySelector('.qu-todo-new input') !== null);
  const input = container.querySelector('.qu-todo-new input');
  input.value = 'Groceries';
  container.querySelector('form.qu-todo-new').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => container.querySelector('.qu-todo-row-title') !== null);
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

test('creating a list via the sidebar form shows it under "My lists" and navigating into it shows the empty task state', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  try {
    await createListViaForm(container);
    assert.equal(container.querySelector('.qu-todo-row-title').textContent, 'Groceries');
    assert.equal(container.querySelector('.qu-todo-badge'), null); // owner's own list carries no "shared" badge
  } finally {
    stop();
  }
});

test('every page has no bespoke back link - only the shell header\'s Back/Forward', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  for (const hash of ['#/todo', `#/todo/${listId}`, `#/todo/${listId}/new`, '#/todo/mine', '#/todo/manage']) {
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
  await createListViaForm(container);
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
  await createListViaForm(container);
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
  await createListViaForm(container);
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

// ===== Sharing (contacts-only invite by pub, autocomplete) ==================

test('the share picker only offers Contacts - a non-contact with a published profile is never suggested, and there is no "paste a raw pub" fallback', async () => {
  const { qu, services } = await freshEnv();
  const contactPub = await publishOtherUser(qu, { alias: 'Ada' });
  await services.contacts.addContact(contactPub, {});
  const strangerPub = await publishOtherUser(qu, { alias: 'Zeke' }); // published, but never added as a contact

  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container);
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
  await createListViaForm(container);
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
  const { qu: ownerQu, services: ownerServices } = await freshEnv();
  const { qu: guestQu, services: guestServices, myPub: guestPub } = await createPeer(ownerQu, { alias: 'Ada' });
  await ownerServices.contacts.addContact(guestPub, {});

  const ownerContainer = makeContainer();
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(ownerContainer);
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
  await waitFor(() => ownerContainer.querySelector('.qu-todo-form select') !== null);
  ownerContainer.querySelector('.qu-todo-form input[type="text"]').value = 'Book venue';
  const assigneeOptions = [...ownerContainer.querySelectorAll('.qu-todo-form select option')];
  const guestOption = assigneeOptions.find((o) => o.value === guestPub);
  assert.ok(guestOption, 'the invited guest must be a selectable assignee');
  ownerContainer.querySelector('.qu-todo-form select').value = guestPub;
  window.location.hash = ''; // see createTaskViaForm()'s own comment on why this reset matters
  ownerContainer.querySelector('.qu-todo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /^#\/todo\/[^/]+$/.test(window.location.hash));
  stop();

  // Simulate sync: mirror exactly what a real relay connection would
  // deliver to the guest's own client (same technique apps/calendar/test uses).
  const ownerPub = await ownerServices.actors.whoAmI();
  await mirrorPaths(ownerQu, guestQu, [
    actorPath(ownerPub, 'profile'),
    paths.documentPath(TODO_SPACE_ID, `todo-${listId}-meta`),
    paths.documentPath(TODO_SPACE_ID, `todo-${listId}-items`),
    paths.threadMetaPath(TODO_SPACE_ID, `invite-${guestPub}`),
  ]);
  await mirrorChildren(ownerQu, guestQu, paths.threadMessagesParentPath(TODO_SPACE_ID, `invite-${guestPub}`));

  const guestContainer = makeContainer();
  stop = mount(guestContainer, { qu: guestQu, services: guestServices, segments: ['todo'], subscribe: noopSubscribe });
  await waitFor(() => guestContainer.querySelector('.qu-todo-row-title') !== null);
  assert.equal(guestContainer.querySelector('.qu-todo-row-title').textContent, 'Groceries');
  assert.ok(guestContainer.querySelector('.qu-todo-badge'), 'expected the shared list to carry a "shared" badge for the guest');
  stop();

  stop = mount(guestContainer, { qu: guestQu, services: guestServices, segments: ['todo', 'mine'], subscribe: noopSubscribe });
  await waitFor(() => guestContainer.querySelector('.qu-todo-tasks a') !== null);
  assert.match(guestContainer.querySelector('.qu-todo-tasks a').textContent, /Book venue/);
  stop();
});

test('a list can never be deleted or renamed by a non-owner, not just hidden from their own UI - AccessEngine itself enforces owner-only writer on the meta document', async () => {
  const { qu: ownerQu, services: ownerServices } = await freshEnv();
  const { services: guestServices, myPub: guestPub } = await createPeer(ownerQu, { alias: 'Ada' });
  await ownerServices.contacts.addContact(guestPub, {});

  const ownerContainer = makeContainer();
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(ownerContainer);
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

function navPointLink(wrap, label) {
  return [...wrap.querySelectorAll('a')].find((a) => a.textContent === label);
}

test('renderHeaderNavPoints(): hidden while another app is active; shown as a "New list"/"New task" dropdown once ToDo becomes active, "New task" upgraded to the first editable list\'s New Task page', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stopMain = mount(makeContainer(), { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(document.body.lastElementChild);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stopMain();

  let appId = 'chat';
  const listeners = [];
  renderHeaderNavPoints(container, {
    getContext: () => ({ appId, segments: [appId] }),
    onContextChange: (cb) => listeners.push(cb),
    services, qu,
  });
  const wrap = container.querySelector('.qu-app-header-action');
  assert.equal(wrap.hidden, true);

  appId = 'todo';
  listeners.forEach((cb) => cb());
  assert.equal(wrap.hidden, false);
  // 2 always-present items (see renderHeaderNavPoints()'s own doc comment) -
  // renderNavPointsMenu() renders these as a real dropdown, not a plain link.
  assert.equal(navPointLink(wrap, 'New list')?.getAttribute('href'), '#/todo/new');
  assert.equal(navPointLink(wrap, 'New task')?.getAttribute('href'), '#/todo');
  await waitFor(() => navPointLink(wrap, 'New task')?.getAttribute('href') === `#/todo/${listId}/new`);
});

test('"Mir zugewiesen"/Assigned-to-me: each row can be checked off directly (dropping out immediately, since this view is not-done-only) and links back to its own list', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}/new`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-todo-form select') !== null);
  container.querySelector('.qu-todo-form select').value = myPub; // self-assign
  await createTaskViaForm(container, { title: 'Buy milk' });
  stop();

  stop = mount(container, { qu, services, segments: ['todo', 'mine'], subscribe: noopSubscribe });
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

test('list page and "Mir zugewiesen" both render a Lists <-> Mir-zugewiesen switcher (sidebar items + a mobile switch link) and a "Copy link" button for an absolute, shareable URL', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['todo'], subscribe: noopSubscribe });
  await createListViaForm(container);
  const [{ id: listId }] = await services.sharing.listMine('todo', 'list');
  stop();

  const written = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (text) => { written.push(text); } } }, configurable: true });
  try {
    stop = mount(container, { qu, services, segments: segmentsFor(`#/todo/${listId}`), subscribe: noopSubscribe });
    await waitFor(() => container.querySelector('.qu-ctxswitch-sidebar') !== null);
    const sidebarLinks = [...container.querySelectorAll('.qu-ctxswitch-sidebar a')].map((a) => a.textContent);
    assert.ok(sidebarLinks.includes('Assigned to me'), 'expected "Mir zugewiesen" in the switcher sidebar');
    assert.ok(sidebarLinks.includes('Groceries'), 'expected the list itself in the switcher sidebar');
    assert.equal(container.querySelector('.qu-ctxswitch-title-link')?.getAttribute('href'), '#/todo', 'the mobile "{list} ›" link must point at the shared #/todo picker page');

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
    stop = mount(mineContainer, { qu, services, segments: ['todo', 'mine'], subscribe: noopSubscribe });
    await waitFor(() => mineContainer.querySelector('.qu-ctxswitch-sidebar') !== null);
    mineContainer.querySelector('.qu-todo-copy-link').click();
    await waitFor(() => written.length === 2);
    assert.equal(written[1], 'http://localhost/#/todo/mine');
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
