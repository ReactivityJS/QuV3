import { QuCrypto } from '@qu/core';
import { directoryEntryPath, directoryEntriesParentPath } from './paths.js';

/**
 * DIRECTORY SERVICE — an opt-in, public "who's browsable" list, the thing
 * a people-search/user-list UI needs beyond direct Contacts (which only
 * covers people you've already starred). Publishing here is a deliberate,
 * reversible choice ("listed"), completely independent of
 * `ContactsService`'s private starred list ("known to me").
 *
 * REDESIGNED from QuV2's version, not a straight port: QuV2 built this on
 * `DocumentService` (a signed-entry-document primitive) plus
 * `CollectionService` (a separate curated `{$list}` index of which entries
 * are currently visible) - neither exists in V3 (superseded by §4.2's
 * `ListService`). The V3 shape needs neither: each identity's directory
 * entry already lives at its own path (`directoryEntryPath()`), so
 * `listVisible()` is exactly `ListService.listDerived()` over the shared
 * parent - no separate index document to keep in sync with the entries it
 * references. Going invisible again is a tombstone write (`null`, see
 * `setVisible()`), the same convention `PinService`/`FlagService.setPublic()`
 * already use, since `QuStore` has no `delete()` - simpler than QuV2's
 * "leave the entry document in place, just remove it from a separate
 * membership list" split, and with nothing left that can drift out of sync
 * between the two.
 *
 * A DERIVED list per docs/v3-technical-concept.md §4.2/§4.3: no `syncFetch`
 * backfill-on-miss needed here (unlike QuV2's version, which needed one for
 * both the entry document AND the membership collection) - a caller
 * `subscribe()`-ing `/store/directory` (see @qu/sync) already catches this
 * list up on reconnect, the same reasoning `MessageService`/`ReactionService`/
 * `PinService` already rely on for their own derived lists.
 *
 * SECURITY NOTE (same one `ReactionService`/`PinService` state): a
 * directory entry is addressed by the actor's own pub in its path, but
 * that's addressing, not proof - `listVisible()` always keys off the
 * QuBit's own verified signer (`#actorPubOf()`), never the path segment.
 */
export class DirectoryService {
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

  /** @param {object} quBit @returns {string|null} base64url actor pubkey, or null if unsigned. */
  #actorPubOf(quBit) {
    return quBit?.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
  }

  /**
   * Publishes (or updates) this identity's directory entry, or tombstones
   * it (`visible: false`) so it stops being enumerable - the entry this
   * identity itself last published is simply replaced, not layered on top
   * of, matching `saveProfile()`'s own "replace wholesale" convention.
   * @param {boolean} visible
   * @param {object} [extra] - Public fields to show (name, bio, ...) - only meaningful when `visible` is true.
   * @returns {Promise<string>} This identity's actor pubkey (base64url).
   */
  async setVisible(visible, extra = {}) {
    const mainKey = await this.identity.getMainKey();
    const actorPub = QuCrypto.toBase64Url(mainKey.publicKey);
    const path = directoryEntryPath(actorPub);
    const value = visible ? { actorPub, ...extra } : null;
    await this.qu.put(path, value, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });
    return actorPub;
  }

  /**
   * @returns {Promise<Array<{actorPub: string, [key: string]: string}>>}
   *   Every currently visible directory entry - `listDerived()` is called
   *   with no `limit` (same correctness reasoning as
   *   `FlagService.getPublicFlags()`/`ReactionService.getReactions()`: a
   *   people-search list silently capped at some default would just be
   *   wrong).
   */
  async listVisible() {
    const entries = await this.list.listDerived(directoryEntriesParentPath());
    const result = [];
    for (const { quBit } of entries) {
      const actorPub = this.#actorPubOf(quBit);
      if (!actorPub || !quBit.val) continue; // unsigned, or a tombstoned (no-longer-visible) entry
      // `actorPub` LAST: `quBit.val` may itself contain an `actorPub` field
      // (see setVisible()) - it must never be able to override the verified
      // signer computed above. A spread ordered the other way around would
      // let a forged/mismatched entry's own claimed `actorPub` win.
      result.push({ ...quBit.val, actorPub });
    }
    return result;
  }

  /** @param {string} actorPub @returns {Promise<boolean>} */
  async isVisible(actorPub) {
    return (await this.listVisible()).some((entry) => entry.actorPub === actorPub);
  }
}
