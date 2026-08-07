import { QuCrypto } from '@qu/core';
import { threadReactionPath, threadReactionsParentPath } from './paths.js';

/**
 * REACTION SERVICE — one of four focused services `ThreadService` (QuV2's
 * 778-line, five-concern monolith) split into, per
 * docs/v3-technical-concept.md §4.3. Deliberately its own Service, not
 * routed through `FlagService` (§4.4, kept as-is): a reaction is one emoji
 * *value* per (message, actor) - changing it REPLACES the previous one,
 * there's no separate "on/off" boolean the way a Flag has - a genuinely
 * different domain shape even though the storage MECHANICS below are
 * nearly identical to `FlagService`'s public mode.
 *
 * A DERIVED list (docs/v3-technical-concept.md §4.2): each reactor's own
 * signed slot lives at `threadReactionPath()`, enumerated via
 * `ListService.listDerived()` at the shared parent
 * (`threadReactionsParentPath()`) - no index document, `setReaction()` is a
 * single `qu.put()`.
 *
 * SECURITY NOTE (same one QuV2's own source stated plainly): unlike a
 * thread MESSAGE, a reaction write is NOT ACL-checked by `AccessEngine`
 * (its thread-path regex only recognizes `meta`/`msgs/...` - see
 * `access-engine.js`) - any current writer of the thread can technically
 * write to any OTHER member's reaction slot by path. The path is
 * addressing, not trust: a caller must always key off the QuBit's own
 * verified `pub` (see `#actorPubOf()` below), never trust a path segment as
 * proof of who wrote it.
 */
export class ReactionService {
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

  /** @param {object} quBit @returns {string|null} base64url actor pubkey, or null if unsigned. */
  #actorPubOf(quBit) {
    return quBit?.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
  }

  /**
   * Sets (or clears) this identity's OWN reaction on a message - a second
   * call with a different emoji simply replaces the first (one reaction per
   * person per message, same rule WhatsApp/Matrix/Slack all use), a `null`
   * emoji clears it (a tombstone QuBit - `QuStore` has no `delete()`).
   * @param {string|number} spaceId @param {string} threadId @param {string} messageId
   * @param {string|null} emoji
   * @param {{asSpaceId?: string|number}} [options]
   */
  async setReaction(spaceId, threadId, messageId, emoji, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const actorPub = QuCrypto.toBase64Url(signKey.publicKey);
    const path = threadReactionPath(spaceId, threadId, messageId, actorPub);
    await this.qu.put(path, emoji, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId @param {string} messageId
   * @returns {Promise<Record<string, string[]>>} `{ emoji: [reactorActorPub, ...] }` -
   *   the TRUE set, `listDerived()` is called with no `limit` (same
   *   correctness reasoning as `FlagService.getPublicFlags()`).
   */
  async getReactions(spaceId, threadId, messageId) {
    const entries = await this.list.listDerived(threadReactionsParentPath(spaceId, threadId, messageId));
    const byEmoji = {};
    for (const { quBit } of entries) {
      const reactorPub = this.#actorPubOf(quBit);
      if (!reactorPub || !quBit.val) continue; // unsigned, or a cleared (tombstone) reaction
      (byEmoji[quBit.val] ??= []).push(reactorPub);
    }
    return byEmoji;
  }
}
