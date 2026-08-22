import { tagPath, tagParentPath, entityTagPath, entityTagsParentPath } from './paths.js';

/**
 * TAG SERVICE — the "Taggable" Capability (Quniverse V4, see
 * docs/v4-concept.md §4/§20's brainstorming: *"TagEngine zunächst wirklich
 * nur simpel: Tagging + Queries. Keine Hierarchie/Aliase."*). Deliberately
 * minimal: no tag hierarchy, no aliases, no cross-`entityKind` search - just
 * two derived-list indexes, both O(1) writes, no read-modify-write of a
 * shared document:
 *
 *   - `tagPath()`/`tagParentPath()` - the FORWARD direction, "what has tag
 *     X" (`getTaggedEntities()`), scoped to one `entityKind` at a time.
 *   - `entityTagPath()`/`entityTagsParentPath()` - the REVERSE direction,
 *     "what tags does entity Y have" (`getTags()`).
 *
 * `addTag()`/`removeTag()` write/tombstone BOTH pointers - there is no
 * single source of truth one derives the other from (same reasoning
 * `FlagService`'s public mode already documents: two independent QuBits,
 * not an index document to race on).
 *
 * Tag queries are scoped to one `entityKind` at a time, not cross-kind -
 * `flagPath()`'s own per-`entityKind` scoping is the direct precedent, and
 * nothing has asked for a "everything tagged X regardless of kind" fan-out
 * query yet.
 */
export class TagService {
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
   * @param {string|number} spaceId @param {string} entityKind @param {string} entityId @param {string} tag
   * @param {{asSpaceId?: string|number}} [options]
   */
  async addTag(spaceId, entityKind, entityId, tag, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const writeOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    const taggedAt = Date.now();
    await Promise.all([
      this.qu.put(tagPath(spaceId, tag, entityKind, entityId), { taggedAt }, writeOptions),
      this.qu.put(entityTagPath(spaceId, entityKind, entityId, tag), { taggedAt }, writeOptions),
    ]);
  }

  /**
   * Tombstones BOTH pointers (`QuStore` has no `delete()`) - a no-op if the
   * tag wasn't present.
   * @param {string|number} spaceId @param {string} entityKind @param {string} entityId @param {string} tag
   * @param {{asSpaceId?: string|number}} [options]
   */
  async removeTag(spaceId, entityKind, entityId, tag, { asSpaceId = null } = {}) {
    const signKey = await this.#signingKey(asSpaceId);
    const writeOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    await Promise.all([
      this.qu.put(tagPath(spaceId, tag, entityKind, entityId), null, writeOptions),
      this.qu.put(entityTagPath(spaceId, entityKind, entityId, tag), null, writeOptions),
    ]);
  }

  /**
   * @param {string|number} spaceId @param {string} entityKind @param {string} entityId
   * @returns {Promise<string[]>} Every tag currently on this entity.
   */
  async getTags(spaceId, entityKind, entityId) {
    const entries = await this.list.listDerived(entityTagsParentPath(spaceId, entityKind, entityId));
    return entries.filter((e) => e.quBit.val).map((e) => e.path.slice(e.path.lastIndexOf('/') + 1));
  }

  /**
   * @param {string|number} spaceId @param {string} tag @param {string} entityKind
   * @returns {Promise<string[]>} Every entity id (of `entityKind`) currently tagged `tag`.
   */
  async getTaggedEntities(spaceId, tag, entityKind) {
    const entries = await this.list.listDerived(tagParentPath(spaceId, tag, entityKind));
    return entries.filter((e) => e.quBit.val).map((e) => e.path.slice(e.path.lastIndexOf('/') + 1));
  }
}
