import { QuCrypto } from '@qu/core';
import { flagPath, flagParentPath, privateFlagPath, privateFlagParentPath } from './paths.js';
import { getPrivate, putPrivate, getPrivateChildren } from './private-storage.js';

/**
 * FLAG SERVICE — the universal "mark this thing" mechanism (Drupal calls
 * this a "Flag": Like, Bookmark, Favorite, ... each a configurable TYPE
 * that can apply to more than one kind of entity). Two independent modes,
 * chosen per call rather than per flagType, since the same conceptual
 * "flag" can legitimately want either shape depending on what's flagging
 * what:
 *
 *   - PRIVATE (`setPrivate`/`listPrivate`/`hasPrivate`): "my own list of
 *     things I've flagged" - self-encrypted, only I can read it. This is
 *     what `FavoritesService` (apps) and `ContactsService` (users) both are.
 *   - PUBLIC (`setPublic`/`getPublicFlags`/`hasPublicFlag`): a visible,
 *     shared count (Like) - each actor writes their OWN signed slot under
 *     `paths.flagPath()`, enumerable by anyone via
 *     `ListService.listDerived()`. Trust comes ONLY from each QuBit's own
 *     verified `pub` (never from the path segment).
 *
 * Both modes now share the SAME underlying shape (docs/v3-technical-concept.md
 * §4.2's derived-list pattern) - one QuBit per (flag, entity) at its own
 * path, enumerated via a shared parent, no index document either way. The
 * only real difference is the crypto: PUBLIC signs-and-leaves-plaintext,
 * PRIVATE additionally self-encrypts (`private-storage.js`'s
 * `putPrivate()`/`getPrivate()`/`getPrivateChildren()`).
 *
 * REDESIGNED from an earlier V3 draft that routed private mode through a
 * separate `StarredService` (one self-encrypted BLOB per namespace,
 * containing the whole list as an inline array): that shape meant every
 * add/remove had to read-modify-write-and-re-encrypt the ENTIRE list -
 * O(n) per mutation, plus lock/retry contention, for data (Favorites/
 * Contacts) that has no reason to share a single document at all. Verified
 * before removing it: `StarredService` had zero callers besides this
 * file's own private mode. Deleted, not deprecated - a fresh build has
 * nothing depending on its shape.
 *
 * `entityRef` is always a flat, caller-defined string id (no structure
 * assumed).
 */
export class FlagService {
  static PUBLIC_SPACE = 'public';

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./list-service.js').ListService} listService - Used by PUBLIC mode only (`getPublicFlags()`'s `listDerived()` call) - PRIVATE mode enumerates directly via `getPrivateChildren()`, which has no `@qu/services`-internal dependency of its own beyond `private-storage.js`.
   */
  constructor(qu, identityEngine, listService) {
    this.qu = qu;
    this.identity = identityEngine;
    this.list = listService;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  // ===== private mode ======================================================

  /**
   * Sets (or clears) this identity's own private flag on an entity - a
   * single write, O(1) regardless of how many other entities this identity
   * has flagged. Clearing writes a PLAIN (unencrypted) `null` tombstone -
   * same convention every other derived list's clear-write already uses
   * (`QuStore` has no `delete()`) - there's nothing sensitive in "absent",
   * so encrypting a tombstone would cost cycles for no privacy benefit.
   * @param {string} flagType @param {string} entityKind @param {string} entityRef
   * @param {boolean} on @param {object} [data] - Extra fields to store alongside (e.g. a nickname).
   * @returns {Promise<void>}
   */
  async setPrivate(flagType, entityKind, entityRef, on, data = {}) {
    const actorPub = await this.#myActorPub();
    const path = privateFlagPath(actorPub, flagType, entityKind, entityRef);
    if (!on) {
      const mainKey = await this.identity.getMainKey();
      await this.qu.put(path, null, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });
      return;
    }
    await putPrivate(this.qu, this.identity, path, { starredAt: Date.now(), ...data });
  }

  /**
   * @param {string} flagType @param {string} entityKind
   * @returns {Promise<Array<{id: string, starredAt: number, [key: string]: *}>>}
   *   `id` is reconstructed from each entry's own path (its last segment) -
   *   not stored redundantly inside the value.
   */
  async listPrivate(flagType, entityKind) {
    const actorPub = await this.#myActorPub();
    const entries = await getPrivateChildren(this.qu, this.identity, privateFlagParentPath(actorPub, flagType, entityKind));
    return entries.map(({ path, value }) => ({ id: path.slice(path.lastIndexOf('/') + 1), ...value }));
  }

  /** @param {string} flagType @param {string} entityKind @param {string} entityRef @returns {Promise<boolean>} */
  async hasPrivate(flagType, entityKind, entityRef) {
    const actorPub = await this.#myActorPub();
    const path = privateFlagPath(actorPub, flagType, entityKind, entityRef);
    return !!(await getPrivate(this.qu, this.identity, path));
  }

  // ===== public mode ========================================================

  /** @param {object} quBit @returns {string|null} base64url actor pubkey, or null if unsigned. */
  #actorPubOf(quBit) {
    return quBit?.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
  }

  /**
   * Sets (or clears) THIS identity's own public flag on an entity. Clearing
   * writes a `null`-valued tombstone QuBit (QuStore has no `delete()`) -
   * `getPublicFlags()`/`hasPublicFlag()` both filter these out.
   * @param {string|number} spaceId - The entity's own space if it has one
   *   (e.g. a forum thread's space), or `FlagService.PUBLIC_SPACE` for
   *   entity kinds with no natural space of their own (e.g. `user`, `app`).
   * @param {string} flagType @param {string} entityKind @param {string} entityRef
   * @param {boolean} on
   */
  async setPublic(spaceId, flagType, entityKind, entityRef, on) {
    const mainKey = await this.identity.getMainKey();
    const path = flagPath(spaceId, flagType, entityKind, entityRef, QuCrypto.toBase64Url(mainKey.publicKey));
    await this.qu.put(path, on ? { flaggedAt: Date.now() } : null, {
      signWith: mainKey.privateKeyPkcs8,
      writerPub: mainKey.publicKey,
    });
  }

  /**
   * @param {string|number} spaceId @param {string} flagType @param {string} entityKind @param {string} entityRef
   * @returns {Promise<{count: number, actorPubs: string[]}>} The TRUE count -
   *   `listDerived()` is called with no `limit`, see its own doc comment for why.
   */
  async getPublicFlags(spaceId, flagType, entityKind, entityRef) {
    const entries = await this.list.listDerived(flagParentPath(spaceId, flagType, entityKind, entityRef));
    const actorPubs = [];
    for (const entry of entries) {
      const actorPub = this.#actorPubOf(entry.quBit);
      if (actorPub && entry.quBit.val) actorPubs.push(actorPub); // skip unsigned or cleared (tombstone) entries
    }
    return { count: actorPubs.length, actorPubs };
  }

  /**
   * @param {string|number} spaceId @param {string} flagType @param {string} entityKind
   * @param {string} entityRef @param {string} actorPub
   * @returns {Promise<boolean>}
   */
  async hasPublicFlag(spaceId, flagType, entityKind, entityRef, actorPub) {
    const path = flagPath(spaceId, flagType, entityKind, entityRef, actorPub);
    const quBit = await this.qu.get(path);
    return !!(quBit && this.#actorPubOf(quBit) === actorPub && quBit.val);
  }
}
