/**
 * PRIVATE STORAGE — read/write data only the owning identity can decrypt.
 *
 * `QuStore.put()` can encrypt for a recipient (`options.encryptWith`), but
 * there's no matching "decrypt on read" - `get()` just hands back whatever
 * the adapter stored, encrypted or not (by design: QuStore stays dumb, see
 * `@qu/core`). Several Services need "store this so only I can read it
 * back" (`FlagService`'s private mode - Favorites/Contacts - today, more
 * later) - this module is the one place that pattern is implemented, rather
 * than each Service re-deriving its own encrypt/decrypt dance.
 *
 * The identity SELF-encrypts: sender and recipient are the same X25519
 * keypair. That's not a workaround, it's exactly what "only I can read
 * this" means cryptographically - `QuCrypto.encrypt()`'s envelope-encryption
 * scheme (see `@qu/core`) supports any recipient list, and a single-element
 * list containing your own key is a completely ordinary use of it.
 *
 * Three shapes, one crypto primitive each way:
 *   - `putPrivate()`/`getPrivate()` - a SINGLE private document at its own
 *     path (e.g. `ProfileService`'s private extra-fields document).
 *   - `getPrivateChildren()` - the DERIVED-LIST counterpart
 *     (`ListService.listDerived()`'s shape, with a decrypt step per child) -
 *     for a parent under which each item already lives at its own
 *     self-encrypted path (`FlagService`'s private mode - see
 *     `privateFlagPath()`/`privateFlagParentPath()` in `paths.js`).
 *   - `createPrivateStore()` - a Qu-shaped FACADE (`{get, put, getChildren,
 *     onStorageChange}`) wrapping the above, so `@qu/reactive`'s `watch()`/
 *     `watchChildren()` and every `@qu/ui` Custom Element (all duck-typed
 *     against exactly this interface - see `components.js`'s `findQu()`)
 *     work UNCHANGED against self-encrypted data. A container element with
 *     `.qu = createPrivateStore(qu, identity)` gives every `<qu-view>`/
 *     `<qu-bind>`/`<qu-list>` underneath it transparent encryption, with
 *     ZERO new UI-layer code - this is what makes a reactive "is this
 *     already my favorite/contact" star possible without a bespoke
 *     decrypting component.
 */
import { QuCrypto } from '@qu/core';

function isEncryptedEnvelope(value) {
  return !!value && typeof value === 'object' && typeof value.iv === 'string' && typeof value.ct === 'string' && Array.isArray(value.to);
}

/** @param {{iv: string, ct: string, to: Array<{pub: string, key: string}>}} envelope @param {{publicKey: Uint8Array, privateKeyPkcs8: Uint8Array}} xKey @returns {Promise<*|null>} `null` if `xKey` isn't among the envelope's recipients. */
async function decryptForSelf(envelope, xKey) {
  const myXPubB64 = QuCrypto.toBase64(xKey.publicKey);
  const entry = envelope.to.find((e) => e.pub === myXPubB64);
  if (!entry) return null;
  const plaintext = await QuCrypto.decrypt(
    QuCrypto.fromBase64(envelope.iv),
    QuCrypto.fromBase64(envelope.ct),
    QuCrypto.fromBase64(entry.key),
    xKey.publicKey,
    xKey.privateKeyPkcs8
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/**
 * Writes `value` at `path`, signed and self-encrypted with the identity's
 * main keys.
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identityEngine
 * @param {string} path
 * @param {*} value - Must be JSON-serialisable.
 * @returns {Promise<object>} The stored QuBit (still encrypted - use getPrivate() to read it back).
 */
export async function putPrivate(qu, identityEngine, path, value) {
  const mainKey = await identityEngine.getMainKey();
  const xKey = await identityEngine.getMainXKey();
  return qu.put(path, value, {
    signWith: mainKey.privateKeyPkcs8,
    writerPub: mainKey.publicKey,
    encryptWith: xKey.publicKey,
    senderXPrivateKey: xKey.privateKeyPkcs8,
  });
}

/**
 * Reads and decrypts a value written by putPrivate(). Returns `null` if
 * nothing is stored, or if the stored value isn't decryptable by this
 * identity (wrong owner, or genuinely not encrypted for us).
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identityEngine
 * @param {string} path
 * @returns {Promise<*|null>}
 */
export async function getPrivate(qu, identityEngine, path) {
  const quBit = await qu.get(path);
  if (!quBit) return null;
  if (!isEncryptedEnvelope(quBit.val)) return quBit.val; // tolerate plaintext (e.g. a tombstone `null`, or local dev without keys)

  const xKey = await identityEngine.getMainXKey();
  return decryptForSelf(quBit.val, xKey);
}

/**
 * The derived-list counterpart to `getPrivate()`: every direct child of
 * `parentPath`, decrypted for this identity. Mirrors
 * `ListService.listDerived()` exactly (same `qu.getChildren()` call, same
 * "no default `limit`" reasoning - see that method's own doc comment), with
 * one extra step: each surviving entry's value is decrypted. Tombstones
 * (`!quBit.val` - see `FlagService.setPrivate(..., false)`, a PLAIN,
 * unencrypted `null` write, same convention every other derived list's
 * clear-write already uses) are skipped BEFORE attempting to decrypt them -
 * cheaper, and there's nothing to decrypt in a `null`.
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identityEngine
 * @param {string} parentPath
 * @param {{limit?: number, order?: 'asc'|'desc', cursor?: string}} [options]
 * @returns {Promise<Array<{path: string, value: *, ts: number, pub: string|null}>>}
 *   `pub` (base64, `QuBit`'s own on-wire shape) is passed through even
 *   though this function's OWN job is decryption, not signature checking -
 *   a signer was never secret (it's on every QuBit, encrypted payload or
 *   not), so hiding it here would just force a caller that separately
 *   needs it (e.g. `apps/app-list` verifying a catalog entry's signer -
 *   see `createPrivateStore()` below) to bypass this function entirely.
 */
export async function getPrivateChildren(qu, identityEngine, parentPath, options = {}) {
  const entries = await qu.getChildren(parentPath, { sort: 'ts', order: options.order ?? 'desc', limit: options.limit, cursor: options.cursor ?? null });
  const xKey = await identityEngine.getMainXKey(); // fetched once, reused for every entry - avoids N redundant key derivations
  const results = [];
  for (const { path, quBit } of entries) {
    if (!quBit.val) continue;
    const value = isEncryptedEnvelope(quBit.val) ? await decryptForSelf(quBit.val, xKey) : quBit.val;
    if (value === null) continue; // not decryptable by this identity - shouldn't normally happen for OUR OWN data, but stay consistent with getPrivate()'s own tolerance
    results.push({ path, value, ts: quBit.ts, pub: quBit.pub ?? null });
  }
  return results;
}

/**
 * A Qu-shaped facade over self-encrypted storage - see this module's own
 * doc comment for why this is the mechanism that makes private data
 * reactive without any new UI-layer code. `get()`/`getChildren()` decrypt
 * transparently; `put(path, null)` writes a plain (unencrypted) tombstone,
 * matching `FlagService.setPrivate(..., false)`'s own convention, so a
 * `<qu-bind>` clearing a value produces exactly the same on-wire shape a
 * Service method would.
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identityEngine
 * @returns {{get: Function, put: Function, getChildren: Function, onStorageChange: Function}}
 */
export function createPrivateStore(qu, identityEngine) {
  return {
    async get(path) {
      const quBit = await qu.get(path);
      if (!quBit) return null;
      if (!quBit.val) return { val: null, ts: quBit.ts, pub: quBit.pub ?? null };
      const xKey = await identityEngine.getMainXKey();
      const val = isEncryptedEnvelope(quBit.val) ? await decryptForSelf(quBit.val, xKey) : quBit.val;
      return { val, ts: quBit.ts, pub: quBit.pub ?? null };
    },
    async put(path, value) {
      if (value === null || value === undefined) {
        const mainKey = await identityEngine.getMainKey();
        return qu.put(path, null, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });
      }
      return putPrivate(qu, identityEngine, path, value);
    },
    async getChildren(parentPath, options) {
      const entries = await getPrivateChildren(qu, identityEngine, parentPath, options);
      return entries.map(({ path, value, ts, pub }) => ({ path, quBit: { val: value, ts, pub } }));
    },
    onStorageChange(handler) {
      return qu.onStorageChange(handler);
    },
  };
}
