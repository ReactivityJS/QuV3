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
   * @param {{asSpaceId?: string|number, id?: string, writeOptions?: object}} [options]
   *   `id` - explicit id override (default: a fresh `crypto.randomUUID()`) -
   *   only ever passed by a caller that must know the final id BEFORE the
   *   write lands, e.g. `ChannelService.createTopic()` protecting a
   *   restricted topic's own ACL first (see that file's own doc comment).
   *   `writeOptions` - merged into (and taking precedence over) the default
   *   `{signWith, writerPub}` - lets a caller pass `AccessService.
   *   writeOptionsFor()`'s own `{encryptWith, senderXPrivateKey}` shape for
   *   a reader-restricted Entity, the same real-encryption path `protect()`'s
   *   own doc comment describes for `docs`/`lists` - the caller stays
   *   responsible for decrypting its own reads back (see that doc comment's
   *   "GOTCHA" - `EntityService` itself is no more decrypt-aware than a
   *   plain Document read is).
   * @returns {Promise<object>} The stored entity (including `_id`/`_type`/`_created`) -
   *   ALWAYS the plaintext this method built, even when `writeOptions`
   *   encrypted the actual write: `qu.put()`'s own returned QuBit's `val` is
   *   the post-encryption ciphertext envelope in that case (confirmed live -
   *   a restricted-channel topic came back with `{iv, ct, to}` instead of
   *   its real fields, the first real caller to ever pass `encryptWith`
   *   here), so this method never reads `quBit.val` back at all - the same
   *   "return what we already built, don't re-read the ciphertext" pattern
   *   `MessageService.postMessage()` already uses. `_created` is stamped
   *   HERE too (not left to `EntityEngine`'s own fallback stamping) so the
   *   returned object is always complete and correct regardless of encryption.
   */
  async createEntity(spaceId, type, fields = {}, options = {}) {
    const signKey = options.asSpaceId ? await this.identity.getSpaceKey(options.asSpaceId) : await this.identity.getMainKey();
    // _id is set explicitly to the SAME id the path uses - EntityEngine only
    // generates its own _id when one isn't already present (see that file's
    // doc comment), and it has no way to know the path's id on its own.
    const id = options.id ?? globalThis.crypto.randomUUID();
    const entity = { _id: id, _type: type, _created: Date.now(), ...this.#normalizeFields(type, fields) };
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey, ...options.writeOptions };
    await this.qu.put(entityPath(spaceId, id), entity, putOptions);
    return entity;
  }

  /**
   * @param {string|number} spaceId @param {string} entityId
   * @param {{decrypt?: (quBit: object) => Promise<object|null>}} [options] -
   *   `decrypt` - an optional caller-supplied hook, called with the raw
   *   QuBit instead of returning `quBit.val` verbatim. `EntityService`
   *   itself stays no more decrypt-aware than a plain Document read is (see
   *   `createEntity()`'s own doc comment "GOTCHA" reference) - a caller that
   *   protected this Entity with restricted `readers` (e.g. `ChannelService`,
   *   for a restricted channel's topic) supplies its OWN
   *   `isEncryptedEnvelope()`/`decryptEnvelope()` pair here, the same scoped,
   *   per-Service fix `AccessService.writeOptionsFor()`'s own doc comment
   *   already establishes as the pattern, rather than this generic Service
   *   growing crypto knowledge of its own.
   * @returns {Promise<object|null>}
   */
  async getEntity(spaceId, entityId, { decrypt = null } = {}) {
    const quBit = await this.qu.get(entityPath(spaceId, entityId));
    if (!quBit?.val) return null;
    return decrypt ? decrypt(quBit) : quBit.val;
  }

  /**
   * Merge-writes `patch` onto an existing entity, keeping `_id`/`_created`/
   * `_type` (via `EntityEngine`'s own re-attachment - see that file's doc
   * comment - `patch` doesn't need to repeat them).
   * @param {string|number} spaceId @param {string} entityId
   * @param {object} patch
   * @param {{asSpaceId?: string|number, writeOptions?: object, decrypt?: (quBit: object) => Promise<object|null>}} [options] -
   *   `writeOptions` - see `createEntity()`'s own doc comment; the same
   *   reader-restricted-encryption escape hatch, for updating a protected
   *   Entity's content in place. `decrypt` - see `getEntity()`'s own doc
   *   comment; required for a correct merge against a protected Entity's
   *   PLAINTEXT fields, not its still-encrypted envelope.
   * @returns {Promise<object>} The updated entity - ALWAYS the plaintext
   *   `merged` object this method already built, never `qu.put()`'s own
   *   returned QuBit - see `createEntity()`'s own doc comment for exactly
   *   why (identical reasoning, same fix).
   * @throws {Error} If no entity exists at this id yet.
   */
  async updateEntity(spaceId, entityId, patch, options = {}) {
    const existing = await this.getEntity(spaceId, entityId, { decrypt: options.decrypt });
    if (!existing) throw new Error(`EntityService.updateEntity: no entity "${entityId}" in space "${spaceId}"`);

    const signKey = options.asSpaceId ? await this.identity.getSpaceKey(options.asSpaceId) : await this.identity.getMainKey();
    const merged = { ...existing, ...this.#normalizeFields(existing._type, patch) };
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey, ...options.writeOptions };
    await this.qu.put(entityPath(spaceId, entityId), merged, putOptions);
    return merged;
  }
}
