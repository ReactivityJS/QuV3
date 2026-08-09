/**
 * APPS CATALOG — builds the JSON `/apps.json` serves: every loaded app's
 * nav-relevant manifest fields, plus a resolved, ready-to-fetch
 * `clientMainUrl` (see `@qu/foundation`'s manifest schema for why
 * `clientMain` needs resolving at all - it's a path relative to wherever
 * the app was loaded FROM, local directory or remote manifest URL, and a
 * browser shell has no way to know which on its own).
 *
 * This is the self-generating menu's data source, once a shell exists to
 * read it - directly analogous to the real Qu's `/relay/services` endpoint,
 * just backed by `@qu/loader`'s manifests instead of a hand-maintained
 * service registry.
 */

/**
 * @param {import('@qu/loader').QuLoader} loader
 * @param {string[]} [disabledAppNames] - Names an admin has turned off (see
 *   `admin-http.js`'s `handleSettings()`) - still LISTED (a future
 *   Relay Admin needs to see and re-enable them), just marked
 *   `enabled: false`. A consumer of this catalog is expected to filter on
 *   that flag itself, same as it would for any other app-specific override.
 * @returns {Array<object>} One entry per loaded app with a `clientMain`
 *   (apps without one - pure server-side Engines/Services/apps, e.g. a
 *   thread-auto-provisioning app with no UI of its own - are omitted;
 *   there's nothing for a shell to mount for them).
 */
export function buildAppsCatalog(loader, disabledAppNames = []) {
  const out = [];
  for (const { manifest, originUrl } of loader.listManifests()) {
    if (!manifest.clientMain) continue;
    out.push({
      name: manifest.name,
      label: manifest.label ?? manifest.name,
      icon: manifest.icon,
      navOrder: manifest.navOrder,
      // See `@qu/foundation`'s manifest schema doc comment on `spaceId` - an
      // app's own fixed storage-space UUID, `undefined` for apps with no
      // space-scoped storage of their own.
      spaceId: manifest.spaceId,
      clientMainUrl: resolveClientMainUrl(manifest, originUrl),
      clientIntegrity: manifest.clientIntegrity,
      clientSignature: manifest.clientSignature,
      enabled: !disabledAppNames.includes(manifest.name),
      pushActions: manifest.pushActions ?? [],
      // See `@qu/foundation/actions.js`'s `actionsForSlot()` - this is the
      // catalog entries it reads `.actions` off of.
      actions: manifest.actions ?? [],
      // See `@qu/foundation/extension-points.js`'s `ExtensionPointHost` -
      // `contributes` is what it dynamically imports/calls; `definesExtensionPoints`
      // is pure discovery metadata (its own `listDefinedPoints()` reads this).
      // A server-only Engine/Service (no `clientMain`, filtered out above)
      // can ALSO declare `definesExtensionPoints` - that's discoverable
      // directly off `loader.listManifests()` server-side, this catalog
      // being client-facing only doesn't need to carry it.
      contributes: manifest.contributes ?? [],
      definesExtensionPoints: manifest.definesExtensionPoints ?? [],
    });
  }
  return out;
}

function resolveClientMainUrl(manifest, originUrl) {
  if (originUrl) {
    // Loaded from a remote manifest URL - resolve clientMain the same way
    // RemoteLoader.loadRemote() resolves `main`, relative to that URL.
    return new URL(manifest.clientMain, originUrl).href;
  }
  // Local - this relay serves it itself under /apps/<name>/ (see static-apps.js).
  return `/apps/${manifest.name}/${manifest.clientMain.replace(/^\.\//, '')}`;
}
