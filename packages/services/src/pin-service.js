import { QuCrypto } from '@qu/core';
import { threadPinPath, threadPinsParentPath } from './paths.js';

/**
 * PIN SERVICE — one of four focused services `ThreadService` (QuV2's
 * 778-line, five-concern monolith) split into, per
 * docs/v3-technical-concept.md §4.3.
 *
 * Unlike `ReactionService`, pins are NOT per-actor: any current writer of
 * the thread may pin or unpin any message (the same rule QuV2's own pins
 * carried), so there is exactly ONE QuBit per PINNED message, not one per
 * (message, actor) pair. Still a DERIVED list (docs/v3-technical-concept.md
 * §4.2): each pinned message's own marker lives at `threadPinPath()`,
 * enumerated via `ListService.listDerived()` at the shared parent
 * (`threadPinsParentPath()`) - `setPinned()` is a single `qu.put()`, `null`
 * clears a pin (a tombstone - `QuStore` has no `delete()`).
 *
 * SECURITY NOTE (same one `ReactionService` states): a pin write is NOT
 * ACL-checked by `AccessEngine` beyond ordinary thread membership - see
 * that file's own doc comment for the identical reasoning, which applies
 * here unchanged since "any writer may pin any message" is the intended
 * rule anyway, not a gap.
 */
export class PinService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./list-service.js').ListService} listService
   */
  constructor(qu, identityEngine, listService) {
    this.qu = qu;
    this.identity = identityEngine;
    this.list = listService;
  }

  /** @returns {Promise<{privateKeyPkcs8: ArrayBuffer, publicKey: Uint8Array}>} */
  async #signingKey(asSpaceId) {
    return asSpaceId ? this.identity.getSpaceKey(asSpaceId) : this.identity.getMainKey();
  }

  /**
   * Pins (or unpins) a message.
   * @param {string|number} spaceId @param {string} threadId @param {string} messageId
   * @param {boolean} pinned
   * @param {{asSpaceId?: string|number}} [options]
   */
  async setPinned(spaceId, threadId, messageId, pinned, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const path = threadPinPath(spaceId, threadId, messageId);
    const value = pinned ? { pinnedAt: Date.now(), pinnedBy: QuCrypto.toBase64Url(signKey.publicKey) } : null;
    await this.qu.put(path, value, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @returns {Promise<string[]>} Currently pinned message ids, newest-pinned-first.
   */
  async listPinned(spaceId, threadId) {
    const entries = await this.list.listDerived(threadPinsParentPath(spaceId, threadId));
    return entries.filter((e) => e.quBit.val).map((e) => e.path.slice(e.path.lastIndexOf('/') + 1));
  }
}
