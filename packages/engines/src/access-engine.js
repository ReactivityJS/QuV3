/**
 * ACCESS ENGINE — the ONE place write-ACL enforcement lives, for every
 * entity kind (Document, Collection, Asset, Thread alike), not duplicated
 * per Engine. Registered `{segment: null, order: 0}` (see @qu/core's
 * `QuStore.registerEngine()`) so it runs on literally every `put()`, before
 * DocumentEngine/ThreadEngine (order 5) and AssetEngine (order 10) - a
 * resource protected this way is gated regardless of which higher-level
 * Engine/Service also happens to touch its path.
 *
 * CONVENTION: a resource's ACL descriptor lives at a SIBLING path,
 * `/store/<space>/acl/<kind>/<resourceId>` (see @qu/services' `aclPath()`),
 * never nested inside the resource's own path - this Engine never needs to
 * understand a Document's/Collection's/Thread's own shape, only its own
 * `{writers, readers}` convention. No ACL doc for a resource means fully
 * open - a purely ADDITIVE capability, a Document/Collection/Asset/Thread
 * with no ACL doc simply stays unrestricted. `ThreadEngine`'s own
 * `createThread()`-equivalent Service call is responsible for writing this
 * doc BEFORE any message is expected to be gated - the exact same
 * responsibility Document/Collection/Asset creation already has, not a
 * Thread-specific concern.
 *
 * Unlike the QuV2 prototype this is rebuilt from, Threads use this SAME
 * convention from the start, with no separate `meta`-document fallback -
 * that fallback existed only to avoid re-migrating already-deployed data,
 * which doesn't apply to a fresh build (see thread-engine.js's own doc
 * comment for the corresponding simplification on the write side).
 *
 * `readers` is intentionally NOT enforced here - restricting who can
 * DECRYPT content is a content-layer (encryption) concern, already fully
 * generic at @qu/core's `QuStore.#seal()` level (`options.encryptWith`),
 * not a pipeline-gate concern. This Engine only ever answers "is this
 * signer allowed to WRITE here."
 *
 * HONEST LIMITATION: this only protects LOCAL writes through
 * `QuStore.put()`. A QuBit arriving via sync's replication is written
 * directly to the adapter (`QuStore.putSealed()`), bypassing the whole
 * Engine pipeline. Per docs/v3-technical-concept.md §3.3 - this is V3
 * milestone #1, not deferred future work - `assertWriteAuthorized()` below
 * is exported specifically so `@qu/sync`'s `SyncEngine` can apply the
 * IDENTICAL check to an incoming synced write before persisting it, using
 * the same decision this Engine's own pipeline hook makes, not a second,
 * divergent copy of it.
 */
import { QuCrypto } from '@qu/core';

const DOC_RE = /^\/store\/([^/]+)\/docs\/([^/]+)$/;
const COLLECTION_RE = /^\/store\/([^/]+)\/collections\/([^/]+)$/;
const ASSET_RE = /^\/store\/([^/]+)\/assets\/([^/]+)(?:\/meta)?$/;
const THREAD_RE = /^\/store\/([^/]+)\/threads\/([^/]+)\/(?:meta|msgs\/[^/]+)$/;
const ACL_RE = /^\/store\/([^/]+)\/acl\/([^/]+)\/([^/]+)$/;

/** @param {string} path @returns {{spaceId: string, kind: 'docs'|'collections'|'assets'|'threads', resourceId: string}|null} */
function resolveResource(path) {
  let match = path.match(DOC_RE);
  if (match) return { spaceId: match[1], kind: 'docs', resourceId: match[2] };
  match = path.match(COLLECTION_RE);
  if (match) return { spaceId: match[1], kind: 'collections', resourceId: match[2] };
  match = path.match(ASSET_RE);
  if (match) return { spaceId: match[1], kind: 'assets', resourceId: match[2] };
  match = path.match(THREAD_RE);
  if (match) return { spaceId: match[1], kind: 'threads', resourceId: match[2] };
  return null;
}

/** @param {object|null} acl @param {Uint8Array|null} writerPub @returns {boolean} */
function writerAllowed(acl, writerPub) {
  if (!acl || acl.writers === '*') return true;
  const writerPubB64Url = writerPub ? QuCrypto.toBase64Url(writerPub) : null;
  return !!writerPubB64Url && Array.isArray(acl.writers) && acl.writers.includes(writerPubB64Url);
}

/**
 * The pure write-authorization decision, usable outside the Engine pipeline
 * (see class doc comment above - this is what closes the sync-bypass gap).
 * Throws a descriptive error when NOT authorized (so `AccessEngine` itself
 * can just `await` this and let the throw propagate, exactly like every
 * other Engine's own inline check does) rather than returning a boolean -
 * the caller that needs a non-throwing check (`SyncEngine`, which wants to
 * silently drop an unauthorized synced write, not crash) wraps this in its
 * own `try/catch`.
 *
 * @param {import('@qu/core').QuStore} qu
 * @param {string} path
 * @param {Uint8Array|null} writerPub - Raw Ed25519 public key bytes of the
 *   signer, or `null` for an unsigned write. Callers normalize their own
 *   representation to this shape first: `AccessEngine` already has raw
 *   bytes (`ctx.options.writerPub`, read before sealing); `SyncEngine` has a
 *   verified QuBit's `pub` as a base64 STRING and must
 *   `QuCrypto.fromBase64()` it first.
 * @returns {Promise<void>}
 * @throws {Error} If the write is not authorized.
 */
export async function assertWriteAuthorized(qu, path, writerPub) {
  // A write to an ACL descriptor itself: only an already-listed writer (or
  // nobody yet, i.e. first-write-wins, same bootstrap rule every other
  // resource already has) may change it - otherwise anyone could hijack a
  // protected resource by simply overwriting its own ACL.
  const aclMatch = path.match(ACL_RE);
  if (aclMatch) {
    const existingBit = await qu.get(path);
    if (!existingBit) return; // nothing protected yet - first writer establishes it
    if (!writerAllowed(existingBit.val, writerPub)) {
      const [, , kind, resourceId] = aclMatch;
      throw new Error(`AccessEngine: not authorized to change access for ${kind} "${resourceId}"`);
    }
    return;
  }

  const resource = resolveResource(path);
  if (!resource) return; // not a recognized protectable path - leave it to the default pipeline

  const { spaceId, kind, resourceId } = resource;
  const aclBit = await qu.get(`/store/${spaceId}/acl/${kind}/${resourceId}`);
  if (!writerAllowed(aclBit?.val ?? null, writerPub)) {
    throw new Error(`AccessEngine: writer not authorized to write to ${kind} "${resourceId}"`);
  }
}

export class AccessEngine {
  /** @param {import('@qu/core').QuStore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: null,
      order: 0,
      put: (ctx) => this.#handlePut(ctx),
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }

  async #handlePut(ctx) {
    const writerPub = ctx.options.writerPub ? QuCrypto.toBytes(ctx.options.writerPub, 'writerPub') : null;
    await assertWriteAuthorized(this.qu, ctx.path, writerPub);
  }
}
