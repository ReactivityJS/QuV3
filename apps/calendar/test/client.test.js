import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import {
  ListService, AccessService, SharingService, MessageService, FlagService, ContactsService,
  DirectoryService, ProfileService, ActorService, paths,
} from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount, createEventMenuItem, renderHeaderNavPoints } = await import('../client.js');

const CAL_SPACE_ID = 'ff73365b-144a-4285-8e98-ac7f9928a95f'; // real UUID from apps/calendar/manifest.quapp

/** Writes an event directly into a calendar's events document - faster/more reliable than driving the New Event form when a test just needs some events to exist, with no dependency on "today"'s date. */
async function upsertEventDirectly(qu, services, calId, { title, start = Date.now(), end = Date.now() + 30 * 60 * 1000 }) {
  const resourceId = `cal-${calId}-events`;
  const doc = (await qu.get(paths.documentPath(CAL_SPACE_ID, resourceId)))?.val ?? { events: [] };
  const events = [...doc.events, { id: crypto.randomUUID(), title, description: '', start, end, allDay: false, guests: [] }];
  const writeOptions = await services.access.writeOptionsFor(CAL_SPACE_ID, 'docs', resourceId);
  await qu.put(paths.documentPath(CAL_SPACE_ID, resourceId), { events }, writeOptions);
}

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
    sharing: new SharingService(qu, identity, access, messages, flags),
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

/**
 * A full second, INDEPENDENT identity (own QuStore - `QuIdentityEngine`
 * refuses a second seed on a store that already holds one, same as two real
 * browsers) + services bundle - a peer who can be mounted as "the app,
 * running as them" to check what THEY actually see, not just inspect the
 * owner's own writes. Mirrors this peer's own profile onto `ownerQu` (same
 * as `publishOtherUser()`) so the owner's side can resolve their X25519 key
 * to invite them.
 */
async function createPeer(ownerQu, { alias } = {}) {
  const peerQu = new QuStore();
  peerQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(peerQu);
  new ThreadEngine(peerQu);
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
  };
  const myPub = await services.actors.whoAmI();
  await ownerQu.putSealed(actorPath(myPub, 'profile'), await peerQu.get(actorPath(myPub, 'profile')));
  return { qu: peerQu, identity, services, myPub };
}

/** Copies whichever of `paths_` actually exist from one QuStore to another - simulates "this peer's client has synced these specific paths in", the same shape every real-sync test in this codebase uses (see e.g. apps/forum/test/client.test.js's own mirrorThreadInto()). */
async function mirrorPaths(fromQu, toQu, paths_) {
  for (const p of paths_) {
    const bit = await fromQu.get(p);
    if (bit) await toQu.putSealed(p, bit);
  }
}

/** Same idea as mirrorPaths(), for a DERIVED list's children (unknown/random ids, e.g. thread messages) - enumerates via ListService.listDerived() instead of a fixed path list. */
async function mirrorChildren(fromQu, toQu, parentPath) {
  const entries = await new ListService(fromQu).listDerived(parentPath);
  for (const { path, quBit } of entries) await toQu.putSealed(path, quBit);
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

test('creating a calendar via the sidebar form shows it under "My calendars" and switches to month view', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  try {
    await createCalendarViaForm(container);
    assert.equal(container.querySelector('.qu-cal-row-title').textContent, 'Team calendar');
    assert.equal(container.querySelector('.qu-cal-month-grid') !== null, true);
    // No FAB/inline "+ New event" link anymore - that's the global header's
    // App Navigation Points Slot now (renderHeaderNavPoints, tested in
    // isolation below), reachable at every width instead of only on mobile.
    assert.equal(container.querySelector('.qu-cal-fab'), null);
    assert.equal(container.querySelector('.qu-cal-new-event-inline'), null);
  } finally {
    stop();
  }
});

test('the main view has exactly one back/switch affordance (mountContextSwitcher\'s titlebar link) - no bespoke hamburger/off-canvas drawer', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-ctxswitch-root') !== null);
    assert.equal(container.querySelector('.qu-cal-menu-btn'), null);
    assert.equal(container.querySelector('.qu-cal-scrim'), null);
    const titleLink = container.querySelector('.qu-ctxswitch-title-link');
    assert.ok(titleLink);
    assert.equal(titleLink.getAttribute('href'), '#/calendar/manage');
  } finally {
    stop();
  }
});

test('#/calendar/manage renders the same calendars list full-page, with no back link of its own (the shell header\'s Back already covers it)', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(container);
  stop();

  const container2 = makeContainer();
  const stop2 = mount(container2, { qu, services, segments: ['calendar', 'manage'], subscribe: noopSubscribe });
  try {
    await waitFor(() => container2.querySelector('.qu-cal-row-title') !== null);
    assert.equal(container2.querySelector('.qu-cal-row-title').textContent, 'Team calendar');
    assert.equal(container2.querySelector('a.qu-subpage-back'), null);
  } finally {
    stop2();
  }
});

test('every subpage (new event, event detail, share) has no bespoke back link - only the shell header\'s Back/Forward', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(container);
  const [{ id: calId }] = await services.flags.listPrivate('calendar', 'calendar');
  stop();

  for (const segments of [['calendar', calId, 'new'], ['calendar', calId, 'share']]) {
    const c = makeContainer();
    const s = mount(c, { qu, services, segments, subscribe: noopSubscribe });
    try {
      await waitFor(() => c.querySelector('.qu-cal-page') !== null || c.querySelector('.qu-cal-form') !== null);
      assert.equal(c.querySelector('a.qu-subpage-back'), null, `no back link for segments ${segments.join('/')}`);
      assert.equal(c.querySelector('.qu-cal-back-link'), null);
    } finally {
      s();
    }
  }
});

// ===== renderHeaderNavPoints() - the shell.headerNavPoints contributor (see docs/app-navigation-standard.md Rule 2) =====

test('renderHeaderNavPoints(): hidden while another app is active, shown with a "+" link once Calendar becomes active and an editable calendar resolves', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(makeContainer(), { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(document.body.lastElementChild);
  const [{ id: calId }] = await services.flags.listPrivate('calendar', 'calendar');
  stop();

  let appId = 'chat';
  const listeners = [];
  renderHeaderNavPoints(container, {
    getContext: () => ({ appId, segments: [appId] }),
    onContextChange: (cb) => listeners.push(cb),
    services, qu,
  });
  const wrap = container.querySelector('.qu-app-header-action');
  assert.equal(wrap.hidden, true);

  appId = 'calendar';
  listeners.forEach((cb) => cb());
  assert.equal(wrap.hidden, false);
  await waitFor(() => wrap.querySelector('a')?.getAttribute('href') === `#/calendar/${calId}/new`);
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
  await waitFor(() => container.querySelector('.qu-actor-picker input') !== null);
  const picker = container.querySelector('.qu-actor-picker input');
  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => container.querySelector('.qu-actor-picker-option') !== null);
  container.querySelector('.qu-actor-picker-option').click();

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

test('an invited member sees the shared calendar (correctly labeled "Shared with me") and its existing events the next time they open #/calendar - regression for the "notification arrives but nothing shows up" bug', async () => {
  const CAL_SPACE = 'ff73365b-144a-4285-8e98-ac7f9928a95f';
  const { qu: ownerQu, services: ownerServices } = await freshEnv();
  const { qu: guestQu, services: guestServices, myPub: guestPub } = await createPeer(ownerQu, { alias: 'Ada' });
  await ownerServices.contacts.addContact(guestPub, {});

  // Owner creates a calendar, adds an event, then shares it.
  const ownerContainer = makeContainer();
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(ownerContainer);
  const [{ id: calId }] = await ownerServices.flags.listPrivate('calendar', 'calendar');
  stop();

  stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: segmentsFor(`#/calendar/${calId}/new`), subscribe: noopSubscribe });
  await waitFor(() => ownerContainer.querySelector('.qu-cal-form') !== null);
  ownerContainer.querySelector('.qu-cal-form input[placeholder]').value = 'Kickoff';
  // Leaves the start datetime at its own default (now) - the guest's Month
  // view below defaults its cursor to today too, so the event lands in the
  // same visible month without hardcoding (and potentially drifting out of
  // "the current month") a fixed date.
  ownerContainer.querySelector('.qu-cal-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => window.location.hash === '#/calendar');
  stop();

  stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: segmentsFor(`#/calendar/${calId}/share`), subscribe: noopSubscribe });
  await waitFor(() => ownerContainer.querySelector('.qu-actor-picker input') !== null);
  const picker = ownerContainer.querySelector('.qu-actor-picker input');
  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => ownerContainer.querySelector('.qu-actor-picker-option') !== null);
  ownerContainer.querySelector('.qu-actor-picker-option').click();
  await waitForAsync(async () => (await ownerServices.access.getAcl(CAL_SPACE, 'docs', `cal-${calId}-events`)).writers.length === 2);
  stop();

  // Simulates the guest's OWN client having synced in exactly what a real
  // relay connection would deliver: the calendar's meta/events documents,
  // their own private invite-mailbox thread (config + the one message in
  // it), and the OWNER's own profile - decrypting that invite message needs
  // the SENDER's published X25519 key too (ECDH), same reasoning
  // MessageService's own `#getProfile()`/`resolveReaderXKeys()` already
  // document - see mirrorPaths()/mirrorChildren()'s own doc comments.
  const ownerPub = await ownerServices.actors.whoAmI();
  await mirrorPaths(ownerQu, guestQu, [
    actorPath(ownerPub, 'profile'),
    paths.documentPath(CAL_SPACE, `cal-${calId}-meta`),
    paths.documentPath(CAL_SPACE, `cal-${calId}-events`),
    paths.threadMetaPath(CAL_SPACE, `invite-${guestPub}`),
  ]);
  await mirrorChildren(ownerQu, guestQu, paths.threadMessagesParentPath(CAL_SPACE, `invite-${guestPub}`));

  // Before the fix, NOTHING besides directly visiting `#/calendar/<calId>`
  // (a link the invitee is never actually given - notification URLs are
  // always the generic `#/calendar`) starred this calendar for the guest -
  // simply opening `#/calendar` is exactly what a real invitee does after
  // seeing a notification arrive.
  const guestContainer = makeContainer();
  stop = mount(guestContainer, { qu: guestQu, services: guestServices, segments: ['calendar'], subscribe: noopSubscribe });
  await waitFor(() => guestContainer.querySelector('.qu-cal-section-heading') !== null);

  const mine = await guestServices.flags.listPrivate('calendar', 'calendar');
  assert.deepEqual(mine.map((c) => c.id), [calId]);

  // "My calendars" always renders (even empty, so a pure guest can still
  // create their own) - "Shared with me" only appears once there's
  // something in it, and must be the one actually containing the invite.
  const headings = [...guestContainer.querySelectorAll('.qu-cal-section-heading')].map((el) => el.textContent);
  assert.deepEqual(headings, ['My calendars', 'Shared with me']);
  const sharedSection = headings.indexOf('Shared with me');
  const sharedRow = guestContainer.querySelectorAll('.qu-cal-section-heading')[sharedSection].nextElementSibling;
  assert.equal(sharedRow.querySelector('.qu-cal-row-title').textContent, 'Team calendar');

  await waitFor(() => guestContainer.querySelector('.qu-cal-month-grid') !== null);
  await waitFor(() => guestContainer.querySelector('.qu-cal-chip') !== null);
  assert.equal(guestContainer.querySelector('.qu-cal-chip').textContent, 'Kickoff');
  stop();
});

/**
 * Shared setup for the two tests below: an owner creates+shares one
 * calendar with a guest, and the guest's OWN client has synced in exactly
 * what a real relay connection would deliver (same technique/reasoning as
 * the "an invited member sees the shared calendar" test above - see its
 * own comments for why each specific path is mirrored).
 */
async function ownerSharesCalendarWithGuest() {
  const CAL_SPACE = 'ff73365b-144a-4285-8e98-ac7f9928a95f';
  const { qu: ownerQu, services: ownerServices, myPub: ownerPub } = await freshEnv();
  const { qu: guestQu, services: guestServices, myPub: guestPub } = await createPeer(ownerQu, { alias: 'Ada' });
  await ownerServices.contacts.addContact(guestPub, {});

  const ownerContainer = makeContainer();
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: ['calendar'], subscribe: noopSubscribe });
  await createCalendarViaForm(ownerContainer);
  const [{ id: calId }] = await ownerServices.flags.listPrivate('calendar', 'calendar');
  stop();

  stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: segmentsFor(`#/calendar/${calId}/share`), subscribe: noopSubscribe });
  await waitFor(() => ownerContainer.querySelector('.qu-actor-picker input') !== null);
  const picker = ownerContainer.querySelector('.qu-actor-picker input');
  picker.value = 'Ada';
  picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => ownerContainer.querySelector('.qu-actor-picker-option') !== null);
  ownerContainer.querySelector('.qu-actor-picker-option').click();
  await waitForAsync(async () => (await ownerServices.access.getAcl(CAL_SPACE, 'docs', `cal-${calId}-events`)).writers.length === 2);
  stop();

  await mirrorPaths(ownerQu, guestQu, [
    actorPath(ownerPub, 'profile'),
    paths.documentPath(CAL_SPACE, `cal-${calId}-meta`),
    paths.documentPath(CAL_SPACE, `cal-${calId}-events`),
    paths.threadMetaPath(CAL_SPACE, `invite-${guestPub}`),
    paths.threadMetaPath(CAL_SPACE, `activity-${calId}`),
  ]);
  await mirrorChildren(ownerQu, guestQu, paths.threadMessagesParentPath(CAL_SPACE, `invite-${guestPub}`));

  return { CAL_SPACE, ownerQu, ownerServices, ownerPub, guestQu, guestServices, guestPub, calId };
}

test('a shared calendar is marked as such (a real per-row badge, not just the section heading), and clicking its title reveals the owner - previously nowhere in the app showed WHO shared it', async () => {
  const { ownerQu, ownerServices, guestQu, guestServices, calId } = await ownerSharesCalendarWithGuest();

  // The OWNER's own list: their own calendar carries no "shared" badge.
  const ownerContainer = makeContainer();
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, segments: ['calendar'], subscribe: noopSubscribe });
  await waitFor(() => ownerContainer.querySelector('.qu-cal-row-title') !== null);
  assert.equal(ownerContainer.querySelector('.qu-cal-shared-badge'), null);
  stop();

  // The GUEST's own list: the shared calendar IS badged, and its title is
  // a clickable button that reveals the owner's alias on click.
  const guestContainer = makeContainer();
  stop = mount(guestContainer, { qu: guestQu, services: guestServices, segments: ['calendar'], subscribe: noopSubscribe });
  await waitFor(() => guestContainer.querySelector('.qu-cal-row-title') !== null);

  assert.ok(guestContainer.querySelector('.qu-cal-shared-badge'), 'expected a per-row "shared" badge');
  const titleBtn = guestContainer.querySelector('.qu-cal-row-title-btn');
  assert.ok(titleBtn, 'expected the shared calendar\'s title to be a real button, not plain text');
  assert.equal(titleBtn.textContent, 'Team calendar');

  const ownerLine = guestContainer.querySelector('.qu-cal-owner-line');
  assert.equal(ownerLine.hidden, true, 'hidden until clicked');
  titleBtn.click();
  await waitFor(() => !ownerLine.hidden && /Me/.test(ownerLine.textContent));
  assert.match(ownerLine.textContent, /Owned by Me/);

  // Clicking again hides it.
  titleBtn.click();
  assert.equal(ownerLine.hidden, true);
  stop();
});

test('leaving a shared calendar hides it AND notifies the owner (via the same activity-thread mechanism every real create/update/delete already uses) - it must never delete/edit the calendar itself, only end this identity\'s own subscription to it', async () => {
  const { CAL_SPACE, ownerQu, ownerServices, guestQu, guestServices, guestPub, calId } = await ownerSharesCalendarWithGuest();

  const guestContainer = makeContainer();
  window.confirm = () => true;
  const stop = mount(guestContainer, { qu: guestQu, services: guestServices, segments: ['calendar'], subscribe: noopSubscribe });
  await waitFor(() => guestContainer.querySelector('.qu-cal-row button[title="Leave"]') !== null);
  guestContainer.querySelector('.qu-cal-row button[title="Leave"]').click();

  // Hidden from the guest's own list.
  await waitForAsync(async () => (await guestServices.flags.listPrivate('calendar', 'calendar')).length === 0);

  // The calendar itself is untouched - still exists, guest is still
  // formally a member (leaving only un-stars; a plain member has no write
  // access to the owner-only meta document to revoke their own ACL entry
  // even in principle - see calendarsSection()'s own doc comment).
  const metaBit = await ownerQu.get(paths.documentPath(CAL_SPACE, `cal-${calId}-meta`));
  assert.ok(metaBit.val, 'the calendar itself must still exist');
  assert.ok(metaBit.val.members.some((m) => m.actorPub === guestPub));

  // The owner is notified: a "left" message landed in the calendar's own
  // activity thread (the SAME thread/mechanism a real event create/update/
  // delete already notifies through - see notifyActivity()'s own doc
  // comment). Written into the GUEST's own store here (these two identities
  // are two independent in-memory QuStores with no real sync layer in this
  // test - propagating it on to the owner's own store is an already-proven,
  // separate relay/sync concern, not something this test re-verifies); the
  // owner reads it once it arrives via the exact same mirrorChildren()
  // technique every other cross-identity test in this file already uses.
  await waitForAsync(async () => {
    const { messages } = await guestServices.messages.listMessages(CAL_SPACE, `activity-${calId}`);
    return messages.some((m) => m.body === 'left');
  });
  await mirrorPaths(guestQu, ownerQu, [paths.threadMetaPath(CAL_SPACE, `activity-${calId}`)]);
  await mirrorChildren(guestQu, ownerQu, paths.threadMessagesParentPath(CAL_SPACE, `activity-${calId}`));
  const { messages: ownerSeen } = await ownerServices.messages.listMessages(CAL_SPACE, `activity-${calId}`);
  assert.ok(ownerSeen.some((m) => m.body === 'left'), 'the owner\'s own client can read the "left" notice');
  stop();
});

test('a shared calendar can never be deleted or renamed by a non-owner, not just hidden from their own UI - the meta document is owner-only writer, enforced by AccessEngine itself (not merely canManage()\'s own UI gate)', async () => {
  const { CAL_SPACE, ownerQu, guestQu, guestServices, calId } = await ownerSharesCalendarWithGuest();

  // AccessEngine only enforces a write ACL it can actually SEE locally
  // (§"No explicit ACL doc" in access-engine.js's own #handlePut() - an
  // unmirrored ACL document reads as "nothing protected here yet", not
  // "denied"). A real relay round-trip would have delivered this already;
  // mirrored explicitly here for the same reason every other cross-store
  // path in this file is.
  await mirrorPaths(ownerQu, guestQu, [paths.aclPath(CAL_SPACE, 'docs', `cal-${calId}-meta`)]);

  // The guest was invited as an editor (this app's own default role for a
  // picker-driven invite - see inviteMember()) - real write access to
  // EVENTS, but the calendar's own meta document (title/color/members/
  // delete) stays owner-only regardless of role, per this file's own top
  // doc comment ("OWNER-ONLY writer").
  const metaPath = paths.documentPath(CAL_SPACE, `cal-${calId}-meta`);
  const writeOptions = await guestServices.access.writeOptionsFor(CAL_SPACE, 'docs', `cal-${calId}-meta`);
  // A delete (tombstone) attempt.
  await assert.rejects(() => guestQu.put(metaPath, null, writeOptions), /not authorized/i);
  // A rename attempt.
  const meta = (await guestQu.get(metaPath)).val;
  await assert.rejects(() => guestQu.put(metaPath, { ...meta, title: 'Hijacked' }, writeOptions), /not authorized/i);

  // The calendar is genuinely untouched either way.
  const stillThere = await guestQu.get(metaPath);
  assert.equal(stillThere.val.title, 'Team calendar');
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

test('typing into the Agenda filter never recreates the input element (focus/cursor survive every keystroke) - regression: it used to call the full renderMain() rebuild on every "input" event', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  try {
    await createCalendarViaForm(container);
    const [{ id: calId }] = await services.flags.listPrivate('calendar', 'calendar');
    await upsertEventDirectly(qu, services, calId, { title: 'Standup' });
    await upsertEventDirectly(qu, services, calId, { title: 'Retro' });
    await waitFor(() => container.querySelector('.qu-cal-viewswitch button')?.textContent === 'Day');

    const agendaBtn = [...container.querySelectorAll('.qu-cal-viewswitch button')].find((b) => b.textContent === 'Agenda');
    agendaBtn.click();
    await waitFor(() => container.querySelector('.qu-cal-filter') !== null);

    const filterInput = container.querySelector('.qu-cal-filter');
    for (const ch of 'Standup') {
      filterInput.value += ch;
      filterInput.dispatchEvent(new window.Event('input', { bubbles: true }));
      // Still the EXACT same DOM node after every single keystroke - a
      // recreated <input> (the old, full-rebuild bug) would fail this on
      // the very first character.
      assert.equal(container.querySelector('.qu-cal-filter'), filterInput);
    }
    await waitFor(() => container.querySelectorAll('.qu-cal-event-row, .qu-cal-chip').length === 1);
    assert.match(container.querySelector('.qu-cal-event-row, .qu-cal-chip').textContent, /Standup/);
  } finally {
    stop();
  }
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['calendar'], subscribe: noopSubscribe });
  await waitFor(() => container.querySelector('.qu-cal-empty') !== null);
  assert.doesNotThrow(() => stop());
});
