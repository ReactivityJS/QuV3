import { QuCrypto } from '@qu/core';
import { presencePath, presenceSettingsPath, threadReadReceiptPath } from './paths.js';
import { putPrivate, getPrivate } from './private-storage.js';
import { isEncryptedEnvelope, decryptEnvelope } from './crypto-envelope.js';

/**
 * PRESENCE SERVICE — one of four focused services `ThreadService` (QuV2's
 * 778-line, five-concern monolith) split into, per
 * docs/v3-technical-concept.md §4.3. Bundles presence (online/offline) AND
 * PUBLIC read receipts, deliberately, though the concept doc names only
 * `PresenceService` (four services for five concerns) - compare
 * `MessageService.markRead()`/`getLastReadAt()` - the PRIVATE counterpart to
 * `publishReadReceipt()`/`getReadReceipts()` below, which stayed with
 * `MessageService` instead because it's about THIS identity's own read
 * position, not a signal published for others.
 *
 * PRESENCE IS USER-CENTRIC, NOT ROOM-CENTRIC (redesigned from an earlier,
 * per-(space,thread) shape): one signed QuBit per actor, GLOBALLY, at
 * `presencePath()` - not one per open room. The earlier shape meant a
 * heartbeat write PER OPEN ROOM PER PARTICIPANT every `intervalMs` -
 * O(N) relay traffic in a busy multi-room session, one signal per room even
 * though "is this person online" is exactly the same answer in every one of
 * them. `startHeartbeat()` now runs ONCE PER SESSION (see
 * `apps/shell/client.js`'s own top-level boot, not `apps/chat/client.js`'s
 * per-room-view mount anymore), independent of how many rooms happen to be
 * open. A room/space simply READS this same global signal for its own
 * already-known member list (`getUserPresences()`), same "no derived-list
 * enumeration needed" reasoning the old per-thread version already had -
 * only WHERE the write happens changed, not the "known member list, known
 * paths" read shape.
 *
 * VISIBILITY - two real levels plus an explicit off-switch, all governed by
 * a PRIVATE per-identity preference (`presenceSettingsPath()` -
 * `getVisibility()`/`setVisibility()`, defaults to 'public' for v1 - a
 * dedicated settings UI for switching it is a follow-up, not built in this
 * round):
 *   - `'public'` (default) - unencrypted, signed - exactly
 *     `DirectoryService.setVisible()`'s own shape. Anyone who knows the
 *     actor's pub can read it.
 *   - `'contacts'` - encrypted for this identity's OWN current
 *     `ContactsService.listContacts()` (reader keys resolved to X25519 the
 *     same way `MessageService`'s own `#resolveReaderXKeys()` does it) -
 *     ONLY those contacts can decrypt it. The reader list is private and
 *     one-sided (only the owner can ever see their own contacts), so the
 *     encryption necessarily happens from the WRITER's side, at publish
 *     time - a contact-list change takes effect from the NEXT heartbeat
 *     tick on, same "no retroactive re-key" limitation
 *     `MessageService`/thread-reader changes already carry elsewhere in
 *     this codebase.
 *   - `'off'` - `setUserPresence()` simply skips writing. Any previously
 *     published status is left exactly as it was - readers still treat
 *     staleness (`getUserPresence()`'s own `online` computation) as the
 *     real source of truth, so it silently reads as offline within
 *     `staleAfterMs` once the heartbeat stops refreshing it, with no
 *     separate tombstone write needed.
 *
 * A contact who fails to resolve (no published profile/X key yet) is
 * SKIPPED, not fail-closed the way `MessageService.postMessage()`
 * deliberately fails an entire private message rather than dropping one
 * reader - a heartbeat is best-effort, low-stakes, broadcast-shaped data;
 * one perpetually-unresolvable contact should never be able to silently
 * block every OTHER contact from ever seeing this identity's presence.
 *
 * NOT a `ListService` shape at all (neither derived nor curated): presence
 * is always read for an already-known set of actor pubs (room members,
 * contacts), never discovered by enumeration.
 *
 * SECURITY NOTE (same one `ReactionService`/`PinService` state): neither a
 * presence nor a read-receipt write is ACL-checked by `AccessEngine` beyond
 * ordinary thread membership - a caller must always key off the QuBit's own
 * verified `pub`, never trust a path segment as proof of who wrote it.
 */
export class PresenceService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./contacts-service.js').ContactsService} [contactsService] -
   *   Required only for `'contacts'`-visibility publishing (`setVisibility('contacts')`
   *   + a `setUserPresence()` call) - every other method works without it.
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   backfills a reader's/sender's profile this identity doesn't have
   *   LOCALLY yet, same "backfill on local miss" role `MessageService`'s own
   *   `syncFetch` constructor param already documents.
   */
  constructor(qu, identityEngine, contactsService = null, syncFetch = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.contacts = contactsService;
    this.syncFetch = syncFetch;
  }

  /** @returns {Promise<string>} base64url pubkey of this identity's main key. */
  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * @param {string} actorPub
   * @returns {Promise<object|null>} Same backfill-via-syncFetch shape
   *   `MessageService`'s own private `#getProfile()` uses.
   */
  async #getProfile(actorPub) {
    const local = await this.identity.getProfile(actorPub);
    if (local) return local;
    if (!this.syncFetch) return null;
    try {
      await this.syncFetch(`/store/actors/~${actorPub}/profile`);
    } catch {
      return null;
    }
    return this.identity.getProfile(actorPub);
  }

  // ===== visibility preference (private, identity-bound) ==================

  /** @returns {Promise<'public'|'contacts'|'off'>} */
  async getVisibility() {
    const settings = await getPrivate(this.qu, this.identity, presenceSettingsPath(await this.#myActorPub()));
    return settings?.visibility ?? 'public';
  }

  /** @param {'public'|'contacts'|'off'} visibility */
  async setVisibility(visibility) {
    await putPrivate(this.qu, this.identity, presenceSettingsPath(await this.#myActorPub()), { visibility });
  }

  // ===== presence ==========================================================

  /**
   * Publishes this identity's own GLOBAL presence, encrypted (or not) per
   * the current `getVisibility()` preference - see this class's own doc
   * comment for what each level means. A no-op write when visibility is
   * `'off'`, or when it's `'contacts'` but none of this identity's current
   * contacts have a resolvable X key yet (nothing meaningful to publish).
   * @param {'online'|'offline'} status
   */
  async setUserPresence(status) {
    const visibility = await this.getVisibility();
    if (visibility === 'off') return;

    const mainKey = await this.identity.getMainKey();
    const putOptions = { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey };

    if (visibility === 'contacts') {
      if (!this.contacts) return; // no ContactsService wired - nothing this call can do
      const contacts = await this.contacts.listContacts();
      const xKeys = [];
      for (const { actorPub } of contacts) {
        const profile = await this.#getProfile(actorPub);
        if (profile?.xPublicKey) xKeys.push(QuCrypto.fromBase64Url(profile.xPublicKey)); // unresolvable contacts are skipped, not fail-closed - see class doc comment
      }
      if (xKeys.length === 0) return;
      putOptions.encryptWith = xKeys;
      putOptions.senderXPrivateKey = (await this.identity.getMainXKey()).privateKeyPkcs8;
    }

    const myPub = QuCrypto.toBase64Url(mainKey.publicKey);
    await this.qu.put(presencePath(myPub), { status, lastSeen: Date.now() }, putOptions);
  }

  /**
   * @param {string} actorPub
   * @param {{staleAfterMs?: number}} [options] - Same 15s default (3x the
   *   default heartbeat) as the old per-thread version.
   * @returns {Promise<{status: string, lastSeen: number, online: boolean}|null>}
   *   `null` if this actor has never published presence, or published it
   *   `'contacts'`-encrypted for a list this identity isn't (or isn't
   *   anymore) part of.
   */
  async getUserPresence(actorPub, { staleAfterMs = 15_000 } = {}) {
    const quBit = await this.qu.get(presencePath(actorPub));
    if (!quBit?.val) return null;
    const val = isEncryptedEnvelope(quBit.val) ? await decryptEnvelope(quBit, this.identity, (pub) => this.#getProfile(pub)) : quBit.val;
    if (!val) return null;
    const { status, lastSeen } = val;
    return { status, lastSeen, online: status === 'online' && Date.now() - lastSeen < staleAfterMs };
  }

  /**
   * The multi-actor convenience `apps/chat`'s room view needs - same
   * "known member list, known paths, no derived-list enumeration" shape
   * `getUserPresence()` above documents, just batched.
   * @param {string[]} actorPubs
   * @param {{staleAfterMs?: number}} [options]
   * @returns {Promise<Record<string, {status: string, lastSeen: number, online: boolean}>>}
   */
  async getUserPresences(actorPubs, options) {
    const result = {};
    await Promise.all(actorPubs.map(async (pub) => {
      const presence = await this.getUserPresence(pub, options);
      if (presence) result[pub] = presence;
    }));
    return result;
  }

  /**
   * Publishes 'online' every `intervalMs`, and 'offline' once when stopped
   * (best-effort - an ungraceful disconnect skips this; readers must still
   * treat staleness, not just the last published status, as the source of
   * truth - see `getUserPresence()`). Meant to be started ONCE PER SESSION
   * (see this class's own top doc comment), not per open room.
   * @param {{intervalMs?: number}} [options]
   * @returns {() => Promise<void>} Stop function.
   */
  startHeartbeat({ intervalMs = 5_000 } = {}) {
    this.setUserPresence('online').catch(() => {});
    const timer = setInterval(() => {
      this.setUserPresence('online').catch(() => {});
    }, intervalMs);
    return async () => {
      clearInterval(timer);
      await this.setUserPresence('offline').catch(() => {});
    };
  }

  // ===== public read receipts (unchanged - still per-thread) ==============

  /**
   * Publishes "I've read everything up to this timestamp" - VISIBLE TO
   * OTHER MEMBERS (unlike `MessageService.markRead()`/`getLastReadAt()`,
   * which are PRIVATE per-identity markers for this identity's own unread
   * badge). This is what lets a sender show a "read" tick on their own
   * messages - the reader publishing this is a deliberate, visible signal,
   * same as WhatsApp/Signal read receipts, not something inferable from
   * encrypted message traffic alone. UNLIKE presence above, this stays
   * thread-scoped - "read up to X" is inherently a fact about one thread's
   * own message history, not something a global-per-actor path could mean.
   * @param {string|number} spaceId @param {string} threadId
   * @param {number} uptoTs - Epoch ms; typically the newest message's `ts`.
   * @param {{asSpaceId?: string|number}} [options]
   */
  async publishReadReceipt(spaceId, threadId, uptoTs, { asSpaceId = null } = {}) {
    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const path = threadReadReceiptPath(spaceId, threadId, QuCrypto.toBase64Url(signKey.publicKey));
    await this.qu.put(path, { upto: uptoTs }, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @param {string[]} memberPubs - Same fixed-member-list reasoning as `getUserPresences()`.
   * @returns {Promise<Record<string, {upto: number, readAt: number}>>}
   *   `upto` is the newest message ts the member had read as of that publish;
   *   `readAt` is the wall-clock moment they actually published it - the
   *   QuBit's own signed write `ts` (see `packages/core/src/qubit.js`), not
   *   a second field this service has to maintain itself. A member absent
   *   from the result has never published a read receipt here.
   */
  async getReadReceipts(spaceId, threadId, memberPubs) {
    const result = {};
    await Promise.all(memberPubs.map(async (pub) => {
      const quBit = await this.qu.get(threadReadReceiptPath(spaceId, threadId, pub));
      if (typeof quBit?.val?.upto === 'number') result[pub] = { upto: quBit.val.upto, readAt: quBit.ts };
    }));
    return result;
  }
}
