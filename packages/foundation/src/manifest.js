/**
 * MANIFEST — the declarative description every loadable Qu package
 * (Engine, Service or App) ships as `manifest.quapp` (a plain JSON file).
 *
 * Packages declare what they need and what they provide, so the Loader can
 * resolve dependencies and third parties can write Engines/Services/Apps
 * without ever touching Qu Core directly.
 *
 * Example (an app):
 *   {
 *     "name": "forum",
 *     "version": "1.0.0",
 *     "kind": "app",
 *     "main": "./index.js",
 *     "requires": ["thread-engine", "document-service", "notification-service"]
 *   }
 *
 * Example (an engine that registers itself):
 *   {
 *     "name": "thread-engine",
 *     "version": "1.0.0",
 *     "kind": "engine",
 *     "main": "./index.js",
 *     "requires": ["document-service"],
 *     "provides": ["thread-engine"]
 *   }
 *
 * Example (a UI app a shell mounts in-place):
 *   {
 *     "name": "notes",
 *     "version": "1.0.0",
 *     "kind": "app",
 *     "main": "./index.js",
 *     "clientMain": "./client.js",
 *     "label": "Notes",
 *     "icon": "📝",
 *     "navOrder": 20,
 *     "requires": ["document-service", "collection-service"]
 *   }
 */

/** Fields every manifest must have. */
export const REQUIRED_FIELDS = Object.freeze(['name', 'version', 'main']);

/** The three kinds of package the Loader understands. Apps are UI-only by convention. */
export const MANIFEST_KINDS = Object.freeze(['engine', 'service', 'app']);

/** The small shared vocabulary a `pushActions` entry's optional `type` may use - see that field's own doc comment below for why. */
export const PUSH_ACTION_TYPES = Object.freeze(['create', 'update', 'delete', 'mention', 'custom']);

/**
 * @typedef {Object} Manifest
 * @property {string} name - Unique registry name, e.g. "thread-engine".
 * @property {string} version - Semver string. Only used for display today;
 *   the DependencyResolver checks *presence*, not version ranges (see there
 *   for why we deliberately don't do semver resolution yet).
 * @property {string} main - Path (relative to the manifest) to the ES module
 *   to `import()`.
 * @property {'engine'|'service'|'app'} [kind='app']
 * @property {string[]} [requires] - Names that must already be registered
 *   (or become registered as a side effect of loading) before this package
 *   loads.
 * @property {string[]} [provides] - Names this package registers into the
 *   Registry once loaded. Used to verify the package kept its promise.
 * @property {string} [integrity] - "sha256-<base64>" of the main module's
 *   source, required for remote loading (see @qu/loader).
 * @property {string} [signature] - base64url Ed25519 signature over the main
 *   module's bytes, checked against loadRemote()'s trustedPublisherPubs.
 *
 * Nav/UI fields - all optional, purely descriptive metadata a shell reads to
 * build a self-generating menu. None of these are enforced by the Loader or
 * Registry; a consumer that doesn't know about one simply never reads it -
 * additive, non-breaking.
 * @property {string} [label] - Display name for nav/menus (defaults to `name`).
 * @property {string} [icon] - An emoji or icon identifier for nav rendering.
 * @property {number} [navOrder] - Sort hint within a nav listing (lower first).
 * @property {string} [clientMain] - Path (relative to the manifest) OR an
 *   absolute URL to a browser ES module exporting
 *   `mount(container, ctx) -> stopFn|void`, for a shell to mount this app's
 *   UI in-place. Separate from `main`, which the Loader imports SERVER-SIDE
 *   (Node) to register Engines/Services - an app can have either, both, or
 *   (if it's UI-only) a trivial no-op `main`.
 * @property {string} [clientIntegrity] - "sha256-<base64>" of `clientMain`'s
 *   source. `integrity`/`signature` above cover `main`; `clientMain` is a
 *   DIFFERENT file a BROWSER fetches, so it gets its own pinning fields.
 * @property {string} [clientSignature] - base64url Ed25519 signature over
 *   `clientMain`'s bytes, the `clientMain` counterpart to `signature`.
 * @property {Array<{id: string, label: string, type?: 'create'|'update'|'delete'|'mention'|'custom'}>} [pushActions] - Push-
 *   notification categories THIS app can trigger (e.g. `{id: "mention",
 *   label: "Mentions", type: "mention"}`, `{id: "newMessage", label: "New
 *   messages", type: "create"}`) - `id` is what push delivery passes as
 *   `functionName` to a notification-preferences check, `label` is what a
 *   Notifications app's settings screen shows next to this app's name/icon
 *   for the toggle - built from every loaded app's declared `pushActions`
 *   instead of a hard-coded list. An app with no push-worthy events of its
 *   own (most apps) simply omits this field. `type` is an OPTIONAL, purely
 *   descriptive taxonomy hint (treated as `'custom'` when omitted) - ready
 *   for a future notifications UI/dedup pass to group or icon-badge actions
 *   by type, without every existing manifest needing to change.
 * @property {Array<{slot: string, id: string, label: string, icon?: string, hrefTemplate: string, order?: number}>} [actions] -
 *   UI actions THIS app contributes to a named "slot" (an extension point
 *   some OTHER app renders, e.g. `"contact-row"`) - see actions.js's own doc
 *   comment for why this is "slot", never "mount". A slot-rendering app
 *   never imports the contributing app; it reads every loaded app's
 *   `actions` off the SAME manifest catalog it already fetched, filters to
 *   its own slot id via `actionsForSlot()`, and builds one link per action
 *   with `hrefTemplate`'s `{param}` tokens filled in via
 *   `resolveActionHref()` (see @qu/foundation/actions.js) - e.g. Chat
 *   declares `{slot: "contact-row", id: "chat", hrefTemplate: "#/chat/{pub}",
 *   ...}`, and Contact List (which has never heard of Chat) renders it by
 *   resolving `{pub}` to each contact's actorPub. `order` is a sort hint,
 *   lower first (defaults to 0). An app with nothing to contribute to any
 *   slot simply omits this field.
 *
 * DEFERRED: a `capabilities` field (action names a package contributes for
 * runtime dispatch, e.g. building a context menu from "what actions exist
 * for this entity kind") existed in the QuV2 prototype alongside a
 * `Registry.registerCapability()` API, but was never wired to a real
 * caller - see registry.js's doc comment. Neither is part of this schema
 * yet; both return together, paired with their first real consumer.
 */

/**
 * Validates a parsed manifest object. Throws a descriptive error on the
 * first problem found rather than collecting all of them - manifests are
 * small and meant to be fixed one mistake at a time during development.
 *
 * @param {*} manifest
 * @returns {Manifest} the same object, for chaining.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: expected a JSON object');
  }
  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      throw new Error(`Invalid manifest: missing or non-string required field "${field}"`);
    }
  }
  if (manifest.kind !== undefined && !MANIFEST_KINDS.includes(manifest.kind)) {
    throw new Error(`Invalid manifest: "kind" must be one of ${MANIFEST_KINDS.join(', ')}, got "${manifest.kind}"`);
  }
  for (const field of ['requires', 'provides']) {
    if (manifest[field] !== undefined) {
      if (!Array.isArray(manifest[field]) || !manifest[field].every((x) => typeof x === 'string')) {
        throw new Error(`Invalid manifest: "${field}" must be an array of strings`);
      }
    }
  }
  if (manifest.integrity !== undefined && !/^sha256-[A-Za-z0-9+/]+=*$/.test(manifest.integrity)) {
    throw new Error('Invalid manifest: "integrity" must look like "sha256-<base64>"');
  }
  for (const field of ['label', 'icon', 'clientMain', 'signature', 'clientSignature']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') {
      throw new Error(`Invalid manifest: "${field}" must be a string`);
    }
  }
  if (manifest.navOrder !== undefined && typeof manifest.navOrder !== 'number') {
    throw new Error('Invalid manifest: "navOrder" must be a number');
  }
  if (manifest.clientIntegrity !== undefined && !/^sha256-[A-Za-z0-9+/]+=*$/.test(manifest.clientIntegrity)) {
    throw new Error('Invalid manifest: "clientIntegrity" must look like "sha256-<base64>"');
  }
  if (manifest.pushActions !== undefined) {
    const valid = Array.isArray(manifest.pushActions) && manifest.pushActions.every(
      (a) => a && typeof a === 'object' && typeof a.id === 'string' && typeof a.label === 'string'
        && (a.type === undefined || PUSH_ACTION_TYPES.includes(a.type))
    );
    if (!valid) throw new Error(`Invalid manifest: "pushActions" must be an array of {id, label, type?} where type is one of ${PUSH_ACTION_TYPES.join(', ')}`);
  }
  if (manifest.actions !== undefined) {
    const valid = Array.isArray(manifest.actions) && manifest.actions.every(
      (a) => a && typeof a === 'object'
        && typeof a.slot === 'string' && typeof a.id === 'string' && typeof a.label === 'string' && typeof a.hrefTemplate === 'string'
        && (a.icon === undefined || typeof a.icon === 'string')
        && (a.order === undefined || typeof a.order === 'number')
    );
    if (!valid) throw new Error('Invalid manifest: "actions" must be an array of {slot, id, label, hrefTemplate, icon?, order?}');
  }
  return manifest;
}
