import { appCatalogEntryPath } from '@qu/services/paths';
import { buildAppsCatalog } from './apps-catalog.js';

/**
 * APPS CATALOG STORE — publishes the same data `buildAppsCatalog()` builds
 * for `/apps.json` into the Qu store itself, so a client can `<qu-list
 * parent="/store/apps/catalog">` it directly (see `@qu/ui`'s
 * `components.js`) instead of a one-shot HTTP fetch with no live-update
 * story. `/apps.json` stays as a lightweight compat/debug endpoint fed by
 * the exact same `buildAppsCatalog()` call - no second source of truth,
 * just two readers of one function's output.
 *
 * SECURITY MODEL: no new `AccessEngine` ACL. Every other relay-authored
 * derived list in this codebase (Directory entries, public Flags,
 * Reactions, Pins, Presence) is trusted the SAME way - the reader verifies
 * the QuBit's own signer, never the path segment. This follows that
 * established convention rather than special-casing the app catalog with
 * write-locking machinery nothing else here has: the relay signs every
 * catalog entry with its OWN identity key, and exposes that pubkey
 * publicly via `/config.json` (`relayPub` - see `http-router.js`) for a
 * reader (`apps/app-list`) to check each entry against before trusting it.
 *
 * Called once after `boot()` finishes loading apps, and again whenever an
 * admin's settings change affects `disabledApps` (see `admin-http.js`'s
 * `handleSettings()`) - so an enable/disable takes effect for every
 * connected client immediately, no relay restart needed.
 */

/**
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identity - This relay's OWN identity (never an end user's - see `relay.js`'s own doc comment on that distinction).
 * @param {import('@qu/loader').QuLoader} loader
 * @param {{disabledApps: string[], hiddenFromAppList?: string[]}} settings
 * @returns {Promise<Array<object>>} The catalog entries just published (same shape `buildAppsCatalog()` returns).
 */
export async function publishAppsCatalog(qu, identity, loader, settings) {
  const mainKey = await identity.getMainKey();
  const catalog = buildAppsCatalog(loader, settings.disabledApps, settings.hiddenFromAppList);
  for (const entry of catalog) {
    await qu.put(appCatalogEntryPath(entry.name), entry, {
      signWith: mainKey.privateKeyPkcs8,
      writerPub: mainKey.publicKey,
    });
  }
  return catalog;
}
