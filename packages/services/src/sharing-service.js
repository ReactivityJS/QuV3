import { QuCrypto } from '@qu/core';
import { documentPath, threadMessagesParentPath } from './paths.js';

/**
 * SHARING SERVICE — the generic "shared resource with owner/editor/viewer
 * members, invite-by-alias-or-pub, ACL kept in sync as roles change" Entity
 * API, extracted from `apps/calendar/client.js`'s own (previously inline)
 * `mountActorPicker()`/`roleOf()`/`createCalendar()`/`syncEventsAcl()`/
 * `ensureCalendarMembership()`/`inviteMember()`/`changeMemberRole()`/
 * `removeMember()`/`discoverPendingInvites()` - Calendar's first real caller,
 * a second app (ToDo lists) needing the identical shape is what actually
 * forced the extraction (see this package's own `FlagService` doc comment
 * for why "wait for a second real caller" is this codebase's own bar for
 * generalizing, not speculative ahead of one).
 *
 * A "resource" here is always a single Document (`kind: 'docs'`) shaped
 * `{..caller-owned fields.., ownerPub, members: [{actorPub, role, addedAt}],
 * createdAt}`, ACL-protected via `AccessService` at its own `metaResourceId`.
 * This Service only ever touches that ONE meta document plus the generic
 * ACL/invite-mailbox/private-star primitives - it knows nothing about a
 * calendar's `events` document or a todo list's `items` document; syncing
 * THEIR writer ACL as membership changes is what `syncWriterAcl()` is for,
 * called by the caller against whichever sibling resource(s) it owns.
 *
 * Every method takes `flagType`/`entityKind` (or a resource id / meta
 * shape) as plain arguments rather than being constructed once per app -
 * one shared instance (wired in `apps/shell/src/services.js` as
 * `services.sharing`) serves every app that has shareable resources.
 */
export class SharingService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./access-service.js').AccessService} accessService
   * @param {import('./message-service.js').MessageService} messageService
   * @param {import('./flag-service.js').FlagService} flagService
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Same
   *   backfill-on-local-miss purpose as every other Service's own syncFetch -
   *   `discoverPendingInvites()` needs it explicitly: `ListService.
   *   listDerived()` (which `MessageService.listMessages()` reads through)
   *   does no backfill of its own (unlike `listCurated()`'s
   *   `#backgroundRefresh`), so without this, a peer's own invite mailbox
   *   would only ever show invites this session already happened to sync.
   */
  constructor(qu, identityEngine, accessService, messageService, flagService, syncFetch = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.access = accessService;
    this.messages = messageService;
    this.flags = flagService;
    this.syncFetch = syncFetch;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /** @param {object|null} meta @param {string} actorPub @returns {string|null} */
  roleOf(meta, actorPub) {
    return meta?.members?.find((m) => m.actorPub === actorPub)?.role ?? null;
  }
  /** @param {string|null} role */
  canEdit(role) { return role === 'owner' || role === 'editor'; }
  /** @param {string|null} role */
  canManage(role) { return role === 'owner'; }

  /**
   * @param {string} flagType @param {string} entityKind
   * @returns {Promise<Array<{id: string, starredAt: number}>>} This
   *   identity's own private "my resources of this kind" list - the same
   *   shape Calendar's "My Calendars" reads via `listPrivate('calendar',
   *   'calendar')`.
   */
  async listMine(flagType, entityKind) {
    return this.flags.listPrivate(flagType, entityKind);
  }

  /**
   * @param {string|number} spaceId @param {string} metaResourceId
   * @returns {Promise<object|null>} Same local-then-backfill shape as every
   *   other Service's own `fetchDoc`-style helper (e.g. Calendar's own,
   *   before this method existed) - without the `syncFetch` retry, a peer
   *   who hasn't yet synced this resource this session would see it as
   *   nonexistent instead of just "not synced yet".
   */
  async getMeta(spaceId, metaResourceId) {
    const path = documentPath(spaceId, metaResourceId);
    let quBit = await this.qu.get(path);
    if (!quBit?.val && this.syncFetch) {
      try { await this.syncFetch(path); } catch { /* unreachable, or genuinely absent */ }
      quBit = await this.qu.get(path);
    }
    return quBit?.val ?? null;
  }

  /**
   * Creates a new owned+shareable resource: protects `metaResourceId`
   * (writers = [caller]), writes the meta document with a single `owner`
   * member, and privately stars it (so it shows up in `listMine()`).
   * @param {string|number} spaceId @param {'docs'|'lists'|'assets'|'threads'} kind
   * @param {string} metaResourceId
   * @param {object} metaFields - Caller-owned fields (e.g. `{id, title}`) -
   *   `ownerPub`/`members`/`createdAt` are added here, not by the caller.
   * @param {{flagType: string, entityKind: string}} star - Which private
   *   "my resources" list to star this into.
   * @returns {Promise<object>} The written meta document.
   */
  async createOwned(spaceId, kind, metaResourceId, metaFields, { flagType, entityKind }) {
    const ownerPub = await this.#myActorPub();
    const members = [{ actorPub: ownerPub, role: 'owner', addedAt: Date.now() }];
    await this.access.protect(spaceId, kind, metaResourceId, { writers: [ownerPub] });
    const writeOptions = await this.access.writeOptionsFor(spaceId, kind, metaResourceId);
    const meta = { ...metaFields, ownerPub, members, createdAt: Date.now() };
    await this.qu.put(documentPath(spaceId, metaResourceId), meta, writeOptions);
    await this.flags.setPrivate(flagType, entityKind, metaFields.id, true, {});
    return meta;
  }

  /**
   * Grows/shrinks a SIBLING resource's (e.g. a calendar's `events` document,
   * a todo list's `items` document) writer ACL to exactly the members whose
   * role is in `writerRoles` - call after any membership/role change on the
   * meta document. Mirrors Calendar's own `syncEventsAcl()`, generalized to
   * any sibling resourceId.
   * @param {string|number} spaceId @param {'docs'|'lists'|'assets'|'threads'} kind
   * @param {string} resourceId @param {Array<{actorPub: string, role: string}>} members
   * @param {{writerRoles?: string[]}} [options]
   */
  async syncWriterAcl(spaceId, kind, resourceId, members, { writerRoles = ['owner', 'editor'] } = {}) {
    const writers = members.filter((m) => writerRoles.includes(m.role)).map((m) => m.actorPub);
    await this.access.protect(spaceId, kind, resourceId, { writers }, { includeSelfAsWriter: false });
  }

  /**
   * Adds `actorPub` to a resource's member list at `role` - a no-op if
   * already a member (existing role untouched). `onMembersChanged(members)`
   * is the caller's hook to re-run its own `syncWriterAcl()`/thread-reader
   * updates against whichever sibling resources it owns.
   * @param {string|number} spaceId @param {'docs'|'lists'|'assets'|'threads'} kind
   * @param {string} metaResourceId @param {string} actorPub @param {string} role
   * @param {{onMembersChanged?: (members: Array) => Promise<void>|void}} [options]
   * @returns {Promise<object>} The updated meta document.
   */
  async ensureMembership(spaceId, kind, metaResourceId, actorPub, role, { onMembersChanged } = {}) {
    const meta = await this.getMeta(spaceId, metaResourceId);
    if (!meta) throw new Error(`SharingService.ensureMembership: no meta "${metaResourceId}" in space "${spaceId}"`);
    if (meta.members.some((m) => m.actorPub === actorPub)) return meta;
    const members = [...meta.members, { actorPub, role, addedAt: Date.now() }];
    const writeOptions = await this.access.writeOptionsFor(spaceId, kind, metaResourceId);
    const next = { ...meta, members };
    await this.qu.put(documentPath(spaceId, metaResourceId), next, writeOptions);
    await onMembersChanged?.(members);
    return next;
  }

  /**
   * Invites `actorPub` at `role` - notifies them FIRST (into their own
   * `invite-<actorPub>` mailbox via `MessageService.notify()`), then grants
   * membership; a resolvable-key failure aborts before any access is
   * written, so nobody ever silently gains access nobody was notified about.
   * @param {string|number} spaceId @param {'docs'|'lists'|'assets'|'threads'} kind
   * @param {string} metaResourceId @param {string} actorPub @param {string} role
   * @param {{notifyBody: string, notifyExtra?: object, onMembersChanged?: Function}} options
   * @returns {Promise<object>} The updated meta document.
   * @throws {Error} If the invitee's profile/keys haven't synced yet.
   */
  async inviteMember(spaceId, kind, metaResourceId, actorPub, role, { notifyBody, notifyExtra = {}, onMembersChanged } = {}) {
    try {
      await this.messages.notify(spaceId, actorPub, notifyBody, notifyExtra);
    } catch {
      throw new Error('their profile hasn’t synced yet - try again shortly');
    }
    return this.ensureMembership(spaceId, kind, metaResourceId, actorPub, role, { onMembersChanged });
  }

  /**
   * @param {string|number} spaceId @param {'docs'|'lists'|'assets'|'threads'} kind
   * @param {string} metaResourceId @param {string} actorPub @param {string} role
   * @param {{onMembersChanged?: Function}} [options]
   * @returns {Promise<object>} The updated meta document.
   */
  async changeMemberRole(spaceId, kind, metaResourceId, actorPub, role, { onMembersChanged } = {}) {
    const meta = await this.getMeta(spaceId, metaResourceId);
    if (!meta) throw new Error(`SharingService.changeMemberRole: no meta "${metaResourceId}" in space "${spaceId}"`);
    const members = meta.members.map((m) => (m.actorPub === actorPub ? { ...m, role } : m));
    const writeOptions = await this.access.writeOptionsFor(spaceId, kind, metaResourceId);
    const next = { ...meta, members };
    await this.qu.put(documentPath(spaceId, metaResourceId), next, writeOptions);
    await onMembersChanged?.(members);
    return next;
  }

  /**
   * @param {string|number} spaceId @param {'docs'|'lists'|'assets'|'threads'} kind
   * @param {string} metaResourceId @param {string} actorPub
   * @param {{activityThreadId?: string, onMembersChanged?: Function}} [options] -
   *   `activityThreadId`, if given, also revokes the removed member as a
   *   reader of that thread (best-effort - a thread that was never created
   *   yet is not an error).
   * @returns {Promise<object>} The updated meta document.
   */
  async removeMember(spaceId, kind, metaResourceId, actorPub, { activityThreadId, onMembersChanged } = {}) {
    const meta = await this.getMeta(spaceId, metaResourceId);
    if (!meta) throw new Error(`SharingService.removeMember: no meta "${metaResourceId}" in space "${spaceId}"`);
    const members = meta.members.filter((m) => m.actorPub !== actorPub);
    const writeOptions = await this.access.writeOptionsFor(spaceId, kind, metaResourceId);
    const next = { ...meta, members };
    await this.qu.put(documentPath(spaceId, metaResourceId), next, writeOptions);
    await onMembersChanged?.(members);
    if (activityThreadId) {
      try { await this.messages.removeReader(spaceId, activityThreadId, actorPub); } catch { /* no activity thread yet - nothing to revoke */ }
    }
    return next;
  }

  /**
   * Stars `resourceId` into this identity's own private `listMine()` list,
   * IF this identity is actually a current member of `meta` - never trusts
   * an invite/notification alone as proof of standing access. A no-op if
   * already starred.
   * @param {string} flagType @param {string} entityKind @param {string} resourceId @param {object|null} meta
   * @returns {Promise<boolean>} Whether it was newly starred.
   */
  async starIfMember(flagType, entityKind, resourceId, meta) {
    const myActorPub = await this.#myActorPub();
    if (!this.roleOf(meta, myActorPub)) return false;
    if (await this.flags.hasPrivate(flagType, entityKind, resourceId)) return false;
    await this.flags.setPrivate(flagType, entityKind, resourceId, true, {});
    return true;
  }

  /** @param {string} flagType @param {string} entityKind @param {string} resourceId */
  async unstar(flagType, entityKind, resourceId) {
    await this.flags.setPrivate(flagType, entityKind, resourceId, false);
  }

  /**
   * Re-reads this identity's own `invite-<myActorPub>` mailbox and stars
   * every resource mentioned there that this identity is CURRENTLY a member
   * of (an invite message is just a notification trace, not proof of
   * standing access - the owner may have since removed them). Already-
   * starred resources are skipped (`starIfMember()`'s own `hasPrivate`
   * check) - O(1) per invite on every later call, not a growing re-scan
   * cost. Meant to be called once per app mount, mirroring Calendar's own
   * `pendingInvitesChecked` guard (the caller's responsibility, not this
   * Service's - it has no mount lifecycle of its own).
   * @param {string|number} spaceId
   * @param {{flagType: string, entityKind: string, resourceKey: string,
   *   fetchMeta: (resourceId: string) => Promise<object|null>}} options -
   *   `resourceKey` is the field name `notifyExtra` used for the resource id
   *   (e.g. `'calendarId'` vs `'listId'`) - apps notify with different keys,
   *   this just tells `discoverPendingInvites()` which one to read back out.
   */
  async discoverPendingInvites(spaceId, { flagType, entityKind, resourceKey, fetchMeta }) {
    const myActorPub = await this.#myActorPub();
    const threadId = `invite-${myActorPub}`;
    if (this.syncFetch) await this.syncFetch(threadMessagesParentPath(spaceId, threadId)).catch(() => {});
    const { messages } = await this.messages.listMessages(spaceId, threadId).catch(() => ({ messages: [] }));
    const ids = [...new Set(messages.map((m) => m[resourceKey]).filter(Boolean))];
    for (const id of ids) {
      const meta = await fetchMeta(id);
      if (meta) await this.starIfMember(flagType, entityKind, id, meta);
    }
  }
}
