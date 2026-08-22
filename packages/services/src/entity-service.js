import { entityPath } from './paths.js';
import { createContent } from './content.js';
import { defaultEntityTypes } from './entity-types.js';

/**
 * ENTITY SERVICE — the friendly API over `@qu/engines`' `EntityEngine` and
 * `entityPath()` (Quniverse V4, see docs/v4-concept.md §3.1), the same
 * relationship `ChannelService`/`MessageService` already have to
 * `ThreadEngine`: this Service composes reads/writes/normalization around
 * the Engine's pipeline behaviour; the Engine itself only owns the
 * trust-boundary stamping/`_type`-requirement (see entity-engine.js).
 *
 * Validation is deliberately light: `createEntity()` consults the
 * `EntityTypeRegistry` only to decide whether to run `createContent()` on a
 * supplied `content` field. An unregistered `type` is still allowed (not
 * thrown) - matching this codebase's general open-by-default posture
 * (`@qu/engines`' `AccessEngine`) rather than making this the first hard
 * schema-validation gate in the Entity layer (see entity-types.js's own doc
 * comment).
 */
export class EntityService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./entity-types.js').EntityTypeRegistry} [entityTypeRegistry]
   */
  constructor(qu, identityEngine, entityTypeRegistry = defaultEntityTypes) {
    this.qu = qu;
    this.identity = identityEngine;
    this.types = entityTypeRegistry;
  }

  /** @param {{content?: object}} fields @param {string} type @returns {object} `fields`, with `content` normalized via `createContent()` if present and `type` declares a content field (or is unregistered - see class doc comment). */
  #normalizeFields(type, fields) {
    if (!fields.content) return fields;
    const definition = this.types.get(type);
    if (definition && !definition.content) return fields; // this type explicitly declares no content field - leave it untouched, not our call to strip it
    return { ...fields, content: createContent(fields.content) };
  }

  /**
   * @param {string|number} spaceId
   * @param {string} type - e.g. `"article"` - looked up in the registry
   *   this Service was constructed with, but not required to be registered.
   * @param {object} [fields] - Type-specific fields, e.g. `{title, content}`.
   * @param {{asSpaceId?: string|number}} [options]
   * @returns {Promise<object>} The stored entity (including `_id`/`_type`/`_created`).
   */
  async createEntity(spaceId, type, fields = {}, options = {}) {
    const signKey = options.asSpaceId ? await this.identity.getSpaceKey(options.asSpaceId) : await this.identity.getMainKey();
    const id = globalThis.crypto.randomUUID();
    // _id is set explicitly to the SAME id the path uses - EntityEngine only
    // generates its own _id when one isn't already present (see that file's
    // doc comment), and it has no way to know the path's id on its own.
    const entity = { _id: id, _type: type, ...this.#normalizeFields(type, fields) };
    const quBit = await this.qu.put(entityPath(spaceId, id), entity, {
      signWith: signKey.privateKeyPkcs8,
      writerPub: signKey.publicKey,
    });
    return quBit.val;
  }

  /**
   * @param {string|number} spaceId @param {string} entityId
   * @returns {Promise<object|null>}
   */
  async getEntity(spaceId, entityId) {
    const quBit = await this.qu.get(entityPath(spaceId, entityId));
    return quBit?.val ?? null;
  }

  /**
   * Merge-writes `patch` onto an existing entity, keeping `_id`/`_created`/
   * `_type` (via `EntityEngine`'s own re-attachment - see that file's doc
   * comment - `patch` doesn't need to repeat them).
   * @param {string|number} spaceId @param {string} entityId
   * @param {object} patch
   * @param {{asSpaceId?: string|number}} [options]
   * @returns {Promise<object>} The updated entity.
   * @throws {Error} If no entity exists at this id yet.
   */
  async updateEntity(spaceId, entityId, patch, options = {}) {
    const existing = await this.getEntity(spaceId, entityId);
    if (!existing) throw new Error(`EntityService.updateEntity: no entity "${entityId}" in space "${spaceId}"`);

    const signKey = options.asSpaceId ? await this.identity.getSpaceKey(options.asSpaceId) : await this.identity.getMainKey();
    const merged = { ...existing, ...this.#normalizeFields(existing._type, patch) };
    const quBit = await this.qu.put(entityPath(spaceId, entityId), merged, {
      signWith: signKey.privateKeyPkcs8,
      writerPub: signKey.publicKey,
    });
    return quBit.val;
  }
}
