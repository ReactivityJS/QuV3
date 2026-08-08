import { QuCrypto } from '@qu/core';

/**
 * TRUSTED APPS CATALOG STORE — wraps a real `qu` so any reactive primitive
 * built on top of it (`watchChildren()`, `<qu-list parent="...">`) only
 * ever sees `/store/apps/catalog/*` entries actually signed by a given
 * relay's own `relayPub` (`/config.json`), with admin-disabled entries
 * (`enabled: false`) filtered out too - one filtering pass, not two.
 *
 * The catalog isn't `AccessEngine`-ACL-protected (see `@qu/relay`'s
 * `apps-catalog-store.js` for why - "path is addressing, signer is truth",
 * the same convention every derived list in this codebase relies on), so a
 * reader MUST do this check itself rather than trusting whoever wrote to a
 * given path.
 *
 * Extracted from `apps/app-list/client.js` (this exact logic, private and
 * un-reusable there) once `apps/shell` needed the SAME filtered catalog for
 * its own top nav - a second real caller, not a speculative extraction.
 *
 * @param {import('@qu/core').QuStore} qu
 * @param {string} relayPub - base64url, from `/config.json`.
 * @returns {{get: Function, put: Function, getChildren: Function, onStorageChange: Function}}
 */
export function createTrustedCatalogStore(qu, relayPub) {
  return {
    get: (path) => qu.get(path),
    put: (path, value, options) => qu.put(path, value, options),
    async getChildren(parentPath, options) {
      const entries = await qu.getChildren(parentPath, options);
      return entries.filter((e) => {
        const pub = e.quBit?.pub;
        const signer = pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(pub)) : null;
        return signer === relayPub && e.quBit.val?.enabled !== false;
      });
    },
    onStorageChange: (handler) => qu.onStorageChange(handler),
  };
}
