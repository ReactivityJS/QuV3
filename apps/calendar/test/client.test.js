import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import {
  ListService, AccessService, MessageService, FlagService, ContactsService,
  DirectoryService, ProfileService, ActorService, paths,
} from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, createEventMenuItem } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
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
    contacts: new ContactsService(flags, identity),
    directory: new DirectoryService(qu, identity, list),
    profile: new ProfileService(qu, identity),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/** Publishes a SEPARATE identity's profile onto the shared `qu` store - simulating a peer whose profile has already synced in (needed to resolve their X25519 key for an invite). */
async function publishOtherUser(qu, { alias } = {}) {
  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  const otherIdentity = new QuIdentityEngine(otherQu);
  await otherIdentity.importMnemonic(otherIdentity.generateMnemonic());
  const actorPub = await otherIdentity.publishMainProfile({ alias });
  await qu.putSealed(actorPath(actorPub, 'profile'), await otherQu.get(actorPath(actorPub, 'profile')));
  return actorPub;
}

function noopSubscribe() {}

/** Must be attached to document.body - reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function segmentsFor(hash) {
  return hash.replace(/^#\//, '').split('/');
}

/** `@qu/ui/testing`'s waitFor() never awaits an async predicate (documented gotcha, docs/building-an-app.md §9) - a real poll loop for conditions that themselves need an `await qu.get(...)`. */
async function waitForAsync(check, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`waitForAsync: condition never became true within ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function createCalendarViaForm(container) {
  await waitFor(() => container.querySelector('.qu-cal-new input') !== null);
  const input = container.querySelector('.qu-cal-new input');
  input.value = 'Team calendar';
  container.querySelector('form.qu-cal-new').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => container.querySelector('.qu-cal-row-title') !== null);
}

// ===== mount() - main view =================================================

test('renders the empty state when there are no calendars yet', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-cal-empty') !== null);
    assert.match(container.querySelector('.qu-cal-empty').textContent, /No calendars yet/);
  } finally {
    stop();
  }
});

test('creating a calendar via the sidebar form shows it under "My calendars" and switches to month view with a FAB', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  try {
    await createCalendarViaForm(container);
    assert.equal(container.querySelector('.qu-cal-row-title').textContent, 'Team calendar');
    assert.equal(container.querySelector('.qu-cal-month-grid') !== null, true);
    assert.equal(container.querySelector('.qu-cal-fab') !== null, true);
  } finally {
    stop();
  }
});

test('a newly created calendar is real, ACL-protected storage: owner-only writer, real member list', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  try {
    await createCalendarViaForm(container);
  } finally {
    stop();
  }

  const [{ id: calId }] = await services.flags.listPrivate('calendar', 'calendar');
  const metaBit = await qu.get(paths.documentPath('ff73365b-144a-4285-8e98-ac7f9928a95f', `cal-${calId}-meta`));
  assert.equal(metaBit.val.ownerPub, myPub);
  assert.deepEqual(metaBit.val.members, [{ actorPub: myPub, role: 'owner', addedAt: metaBit.val.members[0].addedAt }]);

  const acl = await services.access.getAcl('ff73365b-144a-4285-8e98-ac7f9928a95f', 'docs', `cal-${calId}-meta`);
  assert.deepEqual(acl.writers, [myPub]);
});

// ===== Event CRUD ===========================================================

test('adding an event through the New Event page makes it show up in the combined view, and it can be edited and deleted', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(container);
  const [{ id: calId }] = await services.flags.listPrivate('calendar', 'calendar');
  stop();

  // New Event page
  stop = mount(container, { qu, services, segments: segmentsFor(`#/calendar/${calId}/new`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-cal-form') !== null);
  container.querySelector('.qu-cal-form input[placeholder]').value = 'Standup';
  const startInput = container.querySelector('input[type="datetime-local"]');
  startInput.value = '2030-01-15T09:00';
  startInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  container.querySelector('.qu-cal-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => window.location.hash === '#/calendar');
  stop();

  // Back on the main view - the event should be in the events document.
  const eventsBit = await qu.get(paths.documentPath('ff73365b-144a-4285-8e98-ac7f9928a95f', `cal-${calId}-events`));
  assert.equal(eventsBit.val.events.length, 1);
  assert.equal(eventsBit.val.events[0].title, 'Standup');
  const eventId = eventsBit.val.events[0].id;

  // Event detail + edit
  stop = mount(container, { qu, services, segments: segmentsFor(`#/calendar/${calId}/${eventId}`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('h1')?.textContent === 'Standup');
  container.querySelectorAll('.qu-cal-page-actions button')[0].click(); // Edit
  await waitFor(() => container.querySelector('.qu-cal-form') !== null);
  container.querySelector('.qu-cal-form input[placeholder]').value = 'Standup (renamed)';
  container.querySelector('.qu-cal-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => container.querySelector('h1')?.textContent === 'Standup (renamed)');

  const renamedBit = await qu.get(paths.documentPath('ff73365b-144a-4285-8e98-ac7f9928a95f', `cal-${calId}-events`));
  assert.equal(renamedBit.val.events[0].title, 'Standup (renamed)');

  // Delete
  window.confirm = () => true;
  container.querySelectorAll('.qu-cal-page-actions button')[1].click(); // Delete
  await waitFor(() => window.location.hash === '#/calendar');
  const afterDelete = await qu.get(paths.documentPath('ff73365b-144a-4285-8e98-ac7f9928a95f', `cal-${calId}-events`));
  assert.equal(afterDelete.val.events.length, 0);
  stop();
});

// ===== Sharing (invite by pub, autocomplete) ===============================

test('inviteMember flow: inviting a known contact grants them a role, grows the events ACL, and notifies them', async () => {
  const { qu, services, myPub } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Ada' });
  await services.contacts.addContact(otherPub, {});

  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(container);
  const [{ id: calId }] = await services.flags.listPrivate('calendar', 'calendar');
  stop();

  stop = mount(container, { qu, services, segments: segmentsFor(`#/calendar/${calId}/share`), subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-cal-picker input') !== null);
  const picker = container.querySelector('.qu-cal-picker input');
  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-cal-picker-option') !== null);
  container.querySelector('.qu-cal-picker-option').click();

  // `ensureCalendarMembership()` writes the meta doc and then, separately,
  // syncs the events ACL - two distinct documents, not one atomic write (the
  // same non-atomic multi-document trade-off @qu/services' ChannelService
  // already documents for its own multi-step operations) - so the real
  // completion signal to poll for is the SECOND (ACL) write landing, not the
  // meta write alone.
  await waitForAsync(async () => {
    const acl = await services.access.getAcl('ff73365b-144a-4285-8e98-ac7f9928a95f', 'docs', `cal-${calId}-events`);
    return acl.writers.length === 2;
  });
  stop();

  const metaBit = await qu.get(paths.documentPath('ff73365b-144a-4285-8e98-ac7f9928a95f', `cal-${calId}-meta`));
  const invited = metaBit.val.members.find((m) => m.actorPub === otherPub);
  assert.equal(invited.role, 'editor'); // default role option

  const eventsAcl = await services.access.getAcl('ff73365b-144a-4285-8e98-ac7f9928a95f', 'docs', `cal-${calId}-events`);
  assert.deepEqual(new Set(eventsAcl.writers), new Set([myPub, otherPub]));

  // They were notified via their own invite mailbox - a private thread
  // (readers: [otherPub] only) with one message posted into it. Checked at
  // the QuBit level, not via listMessages(): "me" (the sender) is never
  // itself a reader of a mail-preset thread, so "me" can't decrypt the
  // message back - same as @qu/relay's own push-delivery, which never
  // decrypts thread content either (see PushDeliveryService's own doc
  // comment). Existence + correct recipient is exactly what matters here.
  const inviteConfig = await services.messages.getConfig('ff73365b-144a-4285-8e98-ac7f9928a95f', `invite-${otherPub}`);
  assert.deepEqual(inviteConfig.readers, [otherPub]);
  const inviteEntries = await new ListService(qu).listDerived(paths.threadMessagesParentPath('ff73365b-144a-4285-8e98-ac7f9928a95f', `invite-${otherPub}`));
  assert.equal(inviteEntries.length, 1);
});

// ===== content.messageMenu contributor - chat/forum -> calendar bridge ====

test('createEventMenuItem(): resolves a menu entry that prefills sessionStorage from the message body and navigates to the New Event page', async () => {
  const item = await createEventMenuItem({
    qu: { get: async () => null }, spaceId: 'chat-space', threadId: 'room1', messageId: 'm1',
    services: {}, myPub: 'me', mine: true, body: 'Lunch at noon tomorrow?', author: 'them',
  });
  assert.equal(item.id, 'createCalendarEvent');
  assert.equal(item.icon, '📅');

  window.location.hash = '#/somewhere-else';
  await item.onClick();

  const prefill = JSON.parse(window.sessionStorage.getItem('qu-calendar-prefill'));
  assert.equal(prefill.title, 'Lunch at noon tomorrow?');
  assert.equal(prefill.description, 'Lunch at noon tomorrow?');
  assert.equal(window.location.hash, '#/calendar/from-message');
});

test('createEventMenuItem(): prefers a forum topic\'s own title over the message body when the thread resolves to one', async () => {
  const item = await createEventMenuItem({
    qu: { get: async (path) => (path.includes('topic1') ? { val: { title: 'Q3 planning' } } : null) },
    spaceId: 'forum-space', threadId: 'topic1', messageId: 'm1',
    services: {}, myPub: 'me', mine: false, body: 'Let\'s lock the date', author: 'them',
  });
  await item.onClick();
  const prefill = JSON.parse(window.sessionStorage.getItem('qu-calendar-prefill'));
  assert.equal(prefill.title, 'Q3 planning');
  assert.equal(prefill.description, "Let's lock the date");
});

test('#/calendar/from-message consumes the sessionStorage prefill exactly once', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  let stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(container);
  stop();

  window.sessionStorage.setItem('qu-calendar-prefill', JSON.stringify({ title: 'From chat', description: 'the message body' }));
  stop = mount(container, { qu, services, segments: ['calendar', 'from-message'], subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-cal-form') !== null);
  assert.equal(container.querySelector('.qu-cal-form input[placeholder]').value, 'From chat');
  assert.equal(container.querySelector('.qu-cal-notice') !== null, true);
  assert.equal(window.sessionStorage.getItem('qu-calendar-prefill'), null);
  stop();
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-cal-empty') !== null);
  assert.doesNotThrow(() => stop());
});
