import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { AccessService } from '../src/access-service.js';
import { MessageService } from '../src/message-service.js';
import { FlagService } from '../src/flag-service.js';
import { SharingService } from '../src/sharing-service.js';
import { documentPath, threadMetaPath, threadMessagesParentPath } from '../src/paths.js';

const SPACE_ID = 'test-space';
const KIND = 'docs';

async function freshActor() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias: 'Someone' }); // so mirrorProfile() below has something to copy - notify()/writeOptionsFor() need a resolvable X25519 key
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const flags = new FlagService(qu, identity, list);
  const sharing = new SharingService(qu, identity, access, messages, flags);
  const pub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  return { qu, identity, list, access, messages, flags, sharing, pub };
}

/** Publishes `actor`'s own profile onto `intoQu` too - needed before `intoQu`'s owner can notify()/resolve `actor`'s X25519 key, mirroring apps/calendar/test's own publishOtherUser(). */
async function mirrorProfile(actor, intoQu) {
  const bit = await actor.qu.get(actorPath(actor.pub, 'profile'));
  if (bit) await intoQu.putSealed(actorPath(actor.pub, 'profile'), bit);
}

async function mirrorPath(fromQu, toQu, path) {
  const bit = await fromQu.get(path);
  if (bit) await toQu.putSealed(path, bit);
}

async function mirrorChildren(fromQu, toQu, parentPath) {
  const entries = await new ListService(fromQu).listDerived(parentPath);
  for (const { path, quBit } of entries) await toQu.putSealed(path, quBit);
}

test('createOwned() protects the meta doc, writes a single-owner member list, and stars it into listMine()', async () => {
  const owner = await freshActor();
  const meta = await owner.sharing.createOwned(
    SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' },
  );
  assert.equal(meta.title, 'Groceries');
  assert.equal(meta.ownerPub, owner.pub);
  assert.deepEqual(meta.members.map((m) => ({ actorPub: m.actorPub, role: m.role })), [{ actorPub: owner.pub, role: 'owner' }]);

  const acl = await owner.access.getAcl(SPACE_ID, KIND, 'list-1-meta');
  assert.deepEqual(acl.writers, [owner.pub]);

  const mine = await owner.sharing.listMine('todo', 'list');
  assert.deepEqual(mine.map((l) => l.id), ['list-1']);
});

test('roleOf()/canEdit()/canManage() read the members array, tolerating a null meta', async () => {
  const owner = await freshActor();
  const meta = { members: [{ actorPub: 'a', role: 'owner' }, { actorPub: 'b', role: 'editor' }, { actorPub: 'c', role: 'viewer' }] };
  assert.equal(owner.sharing.roleOf(meta, 'a'), 'owner');
  assert.equal(owner.sharing.roleOf(meta, 'nobody'), null);
  assert.equal(owner.sharing.roleOf(null, 'a'), null);
  assert.equal(owner.sharing.canEdit('owner'), true);
  assert.equal(owner.sharing.canEdit('editor'), true);
  assert.equal(owner.sharing.canEdit('viewer'), false);
  assert.equal(owner.sharing.canManage('owner'), true);
  assert.equal(owner.sharing.canManage('editor'), false);
});

test('inviteMember() notifies FIRST - a resolvable-key failure grants no membership at all', async () => {
  const owner = await freshActor();
  await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });

  await assert.rejects(() => owner.sharing.inviteMember(
    SPACE_ID, KIND, 'list-1-meta', 'nobody-ever-published', 'editor', { notifyBody: 'invited' },
  ));

  const meta = await owner.sharing.getMeta(SPACE_ID, 'list-1-meta');
  assert.equal(meta.members.length, 1); // still just the owner
});

test('inviteMember() end-to-end: invitee becomes a member at the given role, and onMembersChanged fires so a sibling resource\'s writer ACL can grow with them', async () => {
  const owner = await freshActor();
  const guest = await freshActor();
  await mirrorProfile(guest, owner.qu); // owner needs the invitee's X key to notify() them

  await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });
  await owner.access.protect(SPACE_ID, KIND, 'list-1-items', { writers: [owner.pub] });

  let syncedMembers = null;
  await owner.sharing.inviteMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'editor', {
    notifyBody: 'invited',
    notifyExtra: { listId: 'list-1' },
    onMembersChanged: async (members) => {
      syncedMembers = members;
      await owner.sharing.syncWriterAcl(SPACE_ID, KIND, 'list-1-items', members);
    },
  });

  const meta = await owner.sharing.getMeta(SPACE_ID, 'list-1-meta');
  assert.deepEqual(meta.members.map((m) => m.actorPub).sort(), [owner.pub, guest.pub].sort());
  assert.equal(owner.sharing.roleOf(meta, guest.pub), 'editor');
  assert.deepEqual(syncedMembers.map((m) => m.actorPub).sort(), [owner.pub, guest.pub].sort());

  const acl = await owner.access.getAcl(SPACE_ID, KIND, 'list-1-items');
  assert.deepEqual([...acl.writers].sort(), [owner.pub, guest.pub].sort());
});

test('ensureMembership() is a no-op if already a member - existing role untouched, onMembersChanged not called again', async () => {
  const owner = await freshActor();
  const guest = await freshActor();
  await mirrorProfile(guest, owner.qu);
  await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });
  await owner.sharing.inviteMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'editor', { notifyBody: 'invited' });

  let called = false;
  await owner.sharing.ensureMembership(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'viewer', { onMembersChanged: () => { called = true; } });
  assert.equal(called, false);

  const meta = await owner.sharing.getMeta(SPACE_ID, 'list-1-meta');
  assert.equal(owner.sharing.roleOf(meta, guest.pub), 'editor'); // NOT downgraded to viewer
});

test('changeMemberRole() updates the role and fires onMembersChanged', async () => {
  const owner = await freshActor();
  const guest = await freshActor();
  await mirrorProfile(guest, owner.qu);
  await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });
  await owner.access.protect(SPACE_ID, KIND, 'list-1-items', { writers: [owner.pub] });
  await owner.sharing.inviteMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'viewer', { notifyBody: 'invited' });

  await owner.sharing.changeMemberRole(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'editor', {
    onMembersChanged: (members) => owner.sharing.syncWriterAcl(SPACE_ID, KIND, 'list-1-items', members),
  });

  const meta = await owner.sharing.getMeta(SPACE_ID, 'list-1-meta');
  assert.equal(owner.sharing.roleOf(meta, guest.pub), 'editor');
  const acl = await owner.access.getAcl(SPACE_ID, KIND, 'list-1-items');
  assert.deepEqual([...acl.writers].sort(), [owner.pub, guest.pub].sort());
});

test('removeMember() revokes membership, shrinks a synced sibling ACL, and AccessEngine actually rejects a further write from the removed writer', async () => {
  const owner = await freshActor();
  const guest = await freshActor();
  await mirrorProfile(guest, owner.qu);
  await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });
  await owner.access.protect(SPACE_ID, KIND, 'list-1-items', { writers: [owner.pub] });
  await owner.sharing.inviteMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'editor', {
    notifyBody: 'invited',
    onMembersChanged: (members) => owner.sharing.syncWriterAcl(SPACE_ID, KIND, 'list-1-items', members),
  });

  const guestKey = await guest.identity.getMainKey();
  const itemsPath = documentPath(SPACE_ID, 'list-1-items');
  // The guest CAN write to the synced sibling resource while still an editor.
  await owner.qu.put(itemsPath, { items: [{ id: 't1' }] }, { signWith: guestKey.privateKeyPkcs8, writerPub: guestKey.publicKey });

  await owner.sharing.removeMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, {
    activityThreadId: 'activity-list-1',
    onMembersChanged: (members) => owner.sharing.syncWriterAcl(SPACE_ID, KIND, 'list-1-items', members),
  });

  const meta = await owner.sharing.getMeta(SPACE_ID, 'list-1-meta');
  assert.equal(owner.sharing.roleOf(meta, guest.pub), null);

  await assert.rejects(() => owner.qu.put(itemsPath, { items: [] }, { signWith: guestKey.privateKeyPkcs8, writerPub: guestKey.publicKey }));
});

test('starIfMember() only stars a resource this identity is CURRENTLY a member of, is idempotent, and unstar() removes it from listMine()', async () => {
  const owner = await freshActor();
  const outsider = await freshActor();
  const meta = await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });

  assert.equal(await outsider.sharing.starIfMember('todo', 'list', 'list-1', meta), false);
  assert.deepEqual(await outsider.sharing.listMine('todo', 'list'), []);

  // owner IS a member, but createOwned() already starred it - a second call is a no-op, not a double-star.
  assert.equal(await owner.sharing.starIfMember('todo', 'list', 'list-1', meta), false);

  await owner.sharing.unstar('todo', 'list', 'list-1');
  assert.deepEqual(await owner.sharing.listMine('todo', 'list'), []);
});

test('discoverPendingInvites() stars every resource this identity is CURRENTLY a member of, mentioned in its own invite mailbox', async () => {
  const owner = await freshActor();
  const guest = await freshActor();
  await mirrorProfile(guest, owner.qu);
  await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });
  await owner.sharing.inviteMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'editor', {
    notifyBody: 'invited', notifyExtra: { listId: 'list-1' },
  });

  // Simulate sync: mirror the invitee's own invite mailbox + the list's meta doc onto their store.
  await mirrorProfile(owner, guest.qu);
  const inviteThreadId = `invite-${guest.pub}`;
  await mirrorPath(owner.qu, guest.qu, threadMetaPath(SPACE_ID, inviteThreadId));
  await mirrorChildren(owner.qu, guest.qu, threadMessagesParentPath(SPACE_ID, inviteThreadId));
  await mirrorPath(owner.qu, guest.qu, documentPath(SPACE_ID, 'list-1-meta'));

  const fetchMeta = (id) => guest.sharing.getMeta(SPACE_ID, `${id}-meta`);
  await guest.sharing.discoverPendingInvites(SPACE_ID, { flagType: 'todo', entityKind: 'list', resourceKey: 'listId', fetchMeta });

  const mine = await guest.sharing.listMine('todo', 'list');
  assert.deepEqual(mine.map((l) => l.id), ['list-1']);
});

test('discoverPendingInvites() does NOT star a resource the invite mentions if this identity is no longer actually a member of it', async () => {
  const owner = await freshActor();
  const guest = await freshActor();
  await mirrorProfile(guest, owner.qu);
  await owner.sharing.createOwned(SPACE_ID, KIND, 'list-1-meta', { id: 'list-1', title: 'Groceries' }, { flagType: 'todo', entityKind: 'list' });
  await owner.sharing.inviteMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, 'editor', {
    notifyBody: 'invited', notifyExtra: { listId: 'list-1' },
  });
  await owner.sharing.removeMember(SPACE_ID, KIND, 'list-1-meta', guest.pub, {});

  await mirrorProfile(owner, guest.qu);
  const inviteThreadId = `invite-${guest.pub}`;
  await mirrorPath(owner.qu, guest.qu, threadMetaPath(SPACE_ID, inviteThreadId));
  await mirrorChildren(owner.qu, guest.qu, threadMessagesParentPath(SPACE_ID, inviteThreadId));
  await mirrorPath(owner.qu, guest.qu, documentPath(SPACE_ID, 'list-1-meta')); // now reflects the removal

  const fetchMeta = (id) => guest.sharing.getMeta(SPACE_ID, `${id}-meta`);
  await guest.sharing.discoverPendingInvites(SPACE_ID, { flagType: 'todo', entityKind: 'list', resourceKey: 'listId', fetchMeta });

  assert.deepEqual(await guest.sharing.listMine('todo', 'list'), []);
});
