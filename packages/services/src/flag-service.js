import { QuCrypto } from '@qu/core';
import { flagPath, flagParentPath } from './paths.js';

/**
 * FLAG SERVICE — the universal "mark this thing" mechanism (Drupal calls
 * this a "Flag": Like, Bookmark, Favorite, ... each a configurable TYPE
 * that can apply to more than one kind of entity). Two independent modes,
 * chosen per call rather than per flagType, since the same conceptual
 * "flag" can legitimately want either shape depending on what's flagging
 * what:
 *
 *   - PRIVATE (`setPrivate`/`listPrivate`/`hasPrivate`): "my own list of
 *     things I've flagged" - self-encrypted, only I can read it. Thin
 *     wrapper over the already-fully-generic `StarredService`
 *     (`namespace = flagType + ':' + entityKind`, `itemId = entityRef`).
 *     This is what `FavoritesService` (apps) and `ContactsService` (users)
 *     both are.
 *   - PUBLIC (`setPublic`/`getPublicFlags`/`hasPublicFlag`): a visible,
 *     shared count (Like) - each actor writes their OWN signed slot under
 *     `paths.flagPath()`, enumerable by anyone via
 *     `ListService.listDerived()` - no index document, exactly the same
 *     derived-list shape a future `ThreadService`'s reactions/pins will
 *     use (see docs/v3-technical-concept.md §4.2's migration table - public
 *     flags and reactions are the same storage shape). Trust comes ONLY
 *     from each QuBit's own verified `pub` (never from the path segment).
 *
 * `entityRef` is always a flat, caller-defined string id (no structure
 * assumed) - same convention `StarredService`'s `itemId` already uses.
 *
 * No legacy namespace mapping (QuV2's `LEGACY_NAMESPACES`, routing
 * `favorite:app`/`favorite:user` onto `StarredService`'s pre-existing
 * `'apps'`/`'contacts'` namespaces to avoid stranding already-deployed
 * users' data): a fresh build has no deployed data predating this
 * convention to stay compatible with - same reasoning already applied to
 * `AccessEngine`/`ThreadEngine` (docs/v3-technical-concept.md §3.3,
 * principle 5: no migration-era complexity carried into a build that has
 * nothing to migrate from).
 */
export class FlagService {
  static PUBLIC_SPACE = 'public';

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./starred-service.js').StarredService} starredService
   * @param {import('./list-service.js').ListService} listService
   */
  constructor(qu, identityEngine, starredService, listService) {
    this.qu = qu;
    this.identity = identityEngine;
    this.starred = starredService;
    this.list = listService;
  }

  // ===== private mode ======================================================

  /**
   * @param {string} flagType @param {string} entityKind @param {string} entityRef
   * @param {boolean} on @param {object} [data] - Extra fields to store alongside (e.g. a nickname).
   * @returns {Promise<Array<object>>} The updated list.
   */
  async setPrivate(flagType, entityKind, entityRef, on, data = {}) {
    const namespace = `${flagType}:${entityKind}`;
    return on ? this.starred.star(namespace, entityRef, data) : this.starred.unstar(namespace, entityRef);
  }

  /** @param {string} flagType @param {string} entityKind @returns {Promise<Array<object>>} */
  async listPrivate(flagType, entityKind) {
    return this.starred.list(`${flagType}:${entityKind}`);
  }

  /** @param {string} flagType @param {string} entityKind @param {string} entityRef @returns {Promise<boolean>} */
  async hasPrivate(flagType, entityKind, entityRef) {
    return this.starred.isStarred(`${flagType}:${entityKind}`, entityRef);
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
