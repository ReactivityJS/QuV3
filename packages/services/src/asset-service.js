import { assetPath } from './paths.js';
import { resolveReaderXKeys, decryptEnvelope } from './crypto-envelope.js';

/**
 * ASSET SERVICE — the Entity API for file/image/video/audio attachments,
 * wrapping `@qu/engines`' `AssetEngine` (chunked local storage, hashing,
 * dedup/resume, reassembly - see that file's own doc comment) the same way
 * `MessageService` wraps `ThreadEngine`/`AccessEngine`: this layer resolves
 * WHO can read an attachment and WHICH signing/encryption keys apply,
 * `AssetEngine` stays entirely ignorant of readers/identities and only
 * knows "chunk this, store it, verify it, sync it" - the chunking/hashing/
 * dedup/retry LOGIC lives centrally in the Engine, on purpose; this Service
 * never re-implements any of it, it only resolves keys and calls through.
 *
 * ENCRYPTION mirrors `MessageService.postMessage()`'s own "encrypt for a
 * reader list" pattern exactly (`resolveReaderXKeys()`/`decryptEnvelope()`,
 * shared via `crypto-envelope.js`) - an attachment sitting next to an
 * encrypted message body would otherwise be the one part of an
 * end-to-end-encrypted thread a relay operator could still read in the
 * clear. `readerPubs: []` (the default) means public/unencrypted - the
 * caller decides per-call, same as `MessageService` decides per-thread via
 * `config.readers`; `AssetService` has no thread/config concept of its own
 * to derive this from automatically (an attachment isn't inherently
 * thread-scoped - a profile avatar has no thread at all).
 *
 * SYNC verification/retry (`verifySyncOut()`) needs the EXACT SAME
 * `readerPubs`/`asSpaceId` the original `upload()` call used, to re-derive
 * the same signing/encryption options for any piece that needs re-sending -
 * see `AssetEngine.verifySyncOut()`'s own doc comment for why a retry can't
 * just re-announce the already-sealed local copy directly.
 */
export class AssetService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/engines').AssetEngine} assetEngine
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   backfills a local miss on `download()`, and is REQUIRED for
   *   `verifySyncOut()` (there is nothing to verify against without it).
   */
  constructor(qu, assetEngine, identityEngine, syncFetch = null) {
    this.qu = qu;
    this.engine = assetEngine;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
  }

  /**
   * Uploads a file, chunked/hashed/stored locally by `AssetEngine` - see
   * that file's own doc comment for what "uploaded" means here: this
   * resolves once the LOCAL write is durable, matching this codebase's
   * established "saved locally is done, relay confirmation is a separate,
   * trackable step" convention (see `verifySyncOut()`).
   *
   * @param {string|number} spaceId
   * @param {string} assetId - Caller-generated (e.g. `crypto.randomUUID()`),
   *   same convention as `MessageService.postMessage()`'s own `messageId`.
   * @param {Blob|Uint8Array|ArrayBuffer|{name: string, mime: string, data: *}} file
   * @param {{readerPubs?: string[], asSpaceId?: string|number, onProgress?: (fraction: number) => void}} [options]
   * @returns {Promise<{name: string, mime: string, size: number}>}
   */
  async upload(spaceId, assetId, file, { readerPubs = [], asSpaceId = null, onProgress = null } = {}) {
    const described = await describeFile(file);
    const putOptions = await this.#resolvePutOptions(readerPubs, asSpaceId);
    if (onProgress) putOptions.onProgress = onProgress;
    await this.qu.put(assetPath(spaceId, assetId), file, putOptions);
    return described;
  }

  /**
   * Verifies (and retries) that an already-`upload()`-ed asset actually
   * reached the relay - see `AssetEngine.verifySyncOut()`'s own doc comment
   * for the full mechanism. Pass the SAME `readerPubs`/`asSpaceId` the
   * original `upload()` call used.
   *
   * @param {string|number} spaceId @param {string} assetId
   * @param {{readerPubs?: string[], asSpaceId?: string|number, maxRetries?: number, retryDelayMs?: number, onSyncProgress?: Function}} [options]
   * @returns {Promise<{synced: boolean, missing: string[], attempts: number}>}
   */
  async verifySyncOut(spaceId, assetId, { readerPubs = [], asSpaceId = null, maxRetries, retryDelayMs, onSyncProgress } = {}) {
    if (!this.syncFetch) throw new Error('AssetService.verifySyncOut: no syncFetch configured - nothing to verify against');
    const putOptions = await this.#resolvePutOptions(readerPubs, asSpaceId);
    return this.engine.verifySyncOut(assetPath(spaceId, assetId), this.syncFetch, {
      decrypt: this.#decrypt,
      putOptions,
      maxRetries,
      retryDelayMs,
      onSyncProgress,
    });
  }

  /**
   * @param {string|number} spaceId @param {string} assetId
   * @param {{maxRetries?: number, retryDelayMs?: number}} [options] - See
   *   `AssetEngine.getAsset()`'s own doc comment for the sync-in retry these
   *   forward to.
   * @returns {Promise<{meta: object, data: Uint8Array}|null>}
   */
  async download(spaceId, assetId, options = {}) {
    return this.engine.getAsset(assetPath(spaceId, assetId), this.syncFetch, this.#decrypt, options);
  }

  #decrypt = (quBit) => decryptEnvelope(quBit, this.identity, (pub) => this.#getProfile(pub));

  async #resolvePutOptions(readerPubs, asSpaceId) {
    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    if (readerPubs.length) {
      const xKey = asSpaceId ? await this.identity.getSpaceXKey(asSpaceId) : await this.identity.getMainXKey();
      putOptions.encryptWith = await resolveReaderXKeys(readerPubs, (pub) => this.#getProfile(pub));
      putOptions.senderXPrivateKey = xKey.privateKeyPkcs8;
    }
    return putOptions;
  }

  /**
   * @param {string} actorPub
   * @returns {Promise<object|null>} Same as `identity.getProfile()`, but
   *   backfills via `syncFetch` (if provided) on a local miss - same
   *   pattern as `MessageService`'s own `#getProfile()`.
   */
  async #getProfile(actorPub) {
    const local = await this.identity.getProfile(actorPub);
    if (local) return local;
    if (!this.syncFetch) return null;
    try {
      await this.syncFetch(`/store/actors/~${actorPub}/profile`);
    } catch {
      return null;
    }
    return this.identity.getProfile(actorPub);
  }
}

/**
 * Extracts just `{name, mime, size}` without materializing bytes twice -
 * `qu.put()`'s own return value for an ENCRYPTED upload is the sealed
 * ciphertext envelope, not the plaintext description, so `upload()` needs
 * this computed separately beforehand rather than reading it back out.
 * @param {Blob|Uint8Array|ArrayBuffer|{name, mime, data}} file
 * @returns {Promise<{name: string, mime: string, size: number}>}
 */
async function describeFile(file) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    return { name: file.name ?? 'unnamed', mime: file.type || 'application/octet-stream', size: file.size };
  }
  if (file instanceof Uint8Array) return { name: 'unnamed', mime: 'application/octet-stream', size: file.length };
  if (file instanceof ArrayBuffer) return { name: 'unnamed', mime: 'application/octet-stream', size: file.byteLength };
  if (file && typeof file === 'object' && file.name && file.mime) {
    const size = file.size ?? (file.data?.byteLength ?? file.data?.length ?? 0);
    return { name: file.name, mime: file.mime, size };
  }
  throw new Error('AssetService.upload: unrecognised file input - expected Blob, Uint8Array, ArrayBuffer or {name, mime, data}');
}
