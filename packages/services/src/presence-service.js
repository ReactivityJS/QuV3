import { QuCrypto } from '@qu/core';
import { threadPresencePath, threadReadReceiptPath } from './paths.js';

/**
 * PRESENCE SERVICE — one of four focused services `ThreadService` (QuV2's
 * 778-line, five-concern monolith) split into, per
 * docs/v3-technical-concept.md §4.3. Bundles presence (online/offline) AND
 * PUBLIC read receipts, deliberately, though the concept doc names only
 * `PresenceService` (four services for five concerns) - they share the
 * exact same technical shape: one signed QuBit per actor at a path a caller
 * reads by already-known `memberPubs`, no derived-list enumeration needed
 * (a thread's membership is already known - see `THREAD_PRESETS.chat`),
 * and both are "a member publishing a status signal about themselves that
 * other members read," not a `messages`/`reactions`/`pins` concern. Compare
 * `MessageService.markRead()`/`getLastReadAt()` - the PRIVATE counterpart to
 * `publishReadReceipt()`/`getReadReceipts()` below, which stayed with
 * `MessageService` instead because it's about THIS identity's own read
 * position, not a signal published for others.
 *
 * NOT a `ListService` shape at all (neither derived nor curated): there is
 * nothing to DISCOVER here, only known members' already-known paths to read.
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
   */
  constructor(qu, identityEngine) {
    this.qu = qu;
    this.identity = identityEngine;
  }

  /** @returns {Promise<{privateKeyPkcs8: ArrayBuffer, publicKey: Uint8Array}>} */
  async #signingKey(asSpaceId) {
    return asSpaceId ? this.identity.getSpaceKey(asSpaceId) : this.identity.getMainKey();
  }

  // ===== presence ==========================================================

  /**
   * Publishes this identity's own presence in a thread. Call again every
   * `intervalMs` (see `startHeartbeat()` below) - staleness, not an
   * explicit "offline", is what `getPresence()` actually trusts, since an
   * ungraceful disconnect (closing a tab) never gets a chance to publish
   * 'offline'.
   * @param {string|number} spaceId @param {string} threadId @param {'online'|'offline'} status
   * @param {{asSpaceId?: string|number}} [options]
   */
  async setPresence(spaceId, threadId, status, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const path = threadPresencePath(spaceId, threadId, QuCrypto.toBase64Url(signKey.publicKey));
    await this.qu.put(path, { status, lastSeen: Date.now() }, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @param {string[]} memberPubs - Whose presence to check.
   * @param {{staleAfterMs?: number}} [options] - Default 15s = 3x the
   *   default heartbeat (5s, see `startHeartbeat()`) - tight enough that
   *   "online" flips to "offline" within a few seconds of really going
   *   away, loose enough not to falsely flash offline on one missed beat.
   * @returns {Promise<Record<string, {status: string, lastSeen: number, online: boolean}>>}
   */
  async getPresence(spaceId, threadId, memberPubs, { staleAfterMs = 15_000 } = {}) {
    const now = Date.now();
    const result = {};
    await Promise.all(memberPubs.map(async (pub) => {
      const quBit = await this.qu.get(threadPresencePath(spaceId, threadId, pub));
      if (!quBit?.val) return;
      const { status, lastSeen } = quBit.val;
      result[pub] = { status, lastSeen, online: status === 'online' && now - lastSeen < staleAfterMs };
    }));
    return result;
  }

  /**
   * Publishes 'online' every `intervalMs`, and 'offline' once when stopped
   * (best-effort - an ungraceful disconnect skips this; readers must still
   * treat staleness, not just the last published status, as the source of
   * truth - see `getPresence()`).
   * @param {string|number} spaceId @param {string} threadId
   * @param {{intervalMs?: number, asSpaceId?: string|number}} [options]
   * @returns {() => Promise<void>} Stop function.
   */
  startHeartbeat(spaceId, threadId, { intervalMs = 5_000, asSpaceId = null } = {}) {
    this.setPresence(spaceId, threadId, 'online', { asSpaceId }).catch(() => {});
    const timer = setInterval(() => {
      this.setPresence(spaceId, threadId, 'online', { asSpaceId }).catch(() => {});
    }, intervalMs);
    return async () => {
      clearInterval(timer);
      await this.setPresence(spaceId, threadId, 'offline', { asSpaceId }).catch(() => {});
    };
  }

  // ===== public read receipts =============================================

  /**
   * Publishes "I've read everything up to this timestamp" - VISIBLE TO
   * OTHER MEMBERS (unlike `MessageService.markRead()`/`getLastReadAt()`,
   * which are PRIVATE per-identity markers for this identity's own unread
   * badge). This is what lets a sender show a "read" tick on their own
   * messages - the reader publishing this is a deliberate, visible signal,
   * same as WhatsApp/Signal read receipts, not something inferable from
   * encrypted message traffic alone.
   * @param {string|number} spaceId @param {string} threadId
   * @param {number} uptoTs - Epoch ms; typically the newest message's `ts`.
   * @param {{asSpaceId?: string|number}} [options]
   */
  async publishReadReceipt(spaceId, threadId, uptoTs, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const path = threadReadReceiptPath(spaceId, threadId, QuCrypto.toBase64Url(signKey.publicKey));
    await this.qu.put(path, { upto: uptoTs }, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @param {string[]} memberPubs - Same fixed-member-list reasoning as `getPresence()`.
   * @returns {Promise<Record<string, number>>} `{ actorPub: uptoTs }` - a
   *   member absent from the result has never published a read receipt here.
   */
  async getReadReceipts(spaceId, threadId, memberPubs) {
    const result = {};
    await Promise.all(memberPubs.map(async (pub) => {
      const quBit = await this.qu.get(threadReadReceiptPath(spaceId, threadId, pub));
      if (typeof quBit?.val?.upto === 'number') result[pub] = quBit.val.upto;
    }));
    return result;
  }
}
