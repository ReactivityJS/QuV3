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

/** The small shared vocabulary a `contributes` entry's optional `kind` may use - see that field's own doc comment below for why. */
export const CONTRIBUTION_KINDS = Object.freeze(['ui', 'hook', 'menu']);

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
 * @property {Array<{point: string, export: string, kind?: 'ui'|'menu', order?: number}>} [contributes] -
 *   Drupal-hooks-inspired extension points THIS app contributes CODE to,
 *   resolved by `@qu/foundation`'s `ExtensionPointHost` (see
 *   extension-points.js's own doc comment for the runtime mechanism and for
 *   why a THIRD, storage-triggered "hook" kind deliberately does NOT belong
 *   here - `qu.onStorageChange()`/`watch()`/`watchChildren()`, Qu Core's own
 *   already-existing listener mechanism, cover that case directly, with no
 *   `contributes` entry needed at all). Unlike `actions` above (pure DATA - a
 *   label/href template, because a slot consumer never runs the contributing
 *   app's code), a `contributes` entry names a real, LIVE function: `export`
 *   is the name of a function this app's OWN `clientMain` module exports
 *   (alongside `mount`), and `ExtensionPointHost` dynamically `import()`s
 *   that already-integrity/signature-pinned module URL (the SAME one the
 *   shell would import to mount this app - no new trust surface) and calls
 *   the named export - this is what makes cross-app UI plugins possible at
 *   all despite only ONE app's `clientMain` ever being mounted in-place at a
 *   time (see actions.js's doc comment on that constraint - `contributes` is
 *   the mechanism that actually crosses it, `actions` deliberately doesn't
 *   try to). `point` is a dot-namespaced id a HOST app defines and reads
 *   contributors for (e.g. `"content.messageActions"`,
 *   `"contextMenu.forumMessage"`) - two usage shapes share this one
 *   mechanism, distinguished purely by which `ExtensionPointHost` method the
 *   host calls for its own point id (`kind` below is an optional, purely
 *   descriptive label for tooling - never enforced, exactly like
 *   `pushActions[].type`):
 *     - UI slot / content plugin (`kind: 'ui'`, `ExtensionPointHost.
 *       renderSlot(point, container, payload)`): `export`'s function is
 *       `(container, payload) -> void|Promise<void>`, expected to mount its
 *       own DOM into `container` - e.g. a future Likes/Bookmarks/Share app
 *       contributing a render function to a `"content.messageActions"` point
 *       Forum defines, so those buttons appear next to Forum's own reactions
 *       without Forum ever importing Likes/Bookmarks/Share.
 *     - Context menu extension (`kind: 'menu'`, `ExtensionPointHost.
 *       collect(point, payload)`): `export`'s function is `(payload) ->
 *       Array<{id, label, icon?, onClick}> | Promise<...>`, results from every
 *       contributor concatenated and returned - e.g. a host app's "..." menu
 *       on one of its own items, extended with entries other apps
 *       contribute (Reply/Forward/Share).
 *   `order` sorts contributors within one `point` (lower first, default 0),
 *   same convention as `actions[].order`. An app with nothing to contribute
 *   simply omits this field - additive, non-breaking, exactly like `actions`.
 *
 * @property {Array<{point: string, kind?: 'ui'|'hook'|'menu', description?: string}>} [definesExtensionPoints] -
 *   The other half of the `contributes` picture: where `contributes` says
 *   "I implement point X", this says "point X exists, and here's what it
 *   means" - PURE, non-executable documentation (exactly like `pushActions`/
 *   `actions`: additive, never enforced, a package with nothing to declare
 *   simply omits it), letting anyone reading the manifest catalog discover
 *   every extension point the system currently has WITHOUT grepping source
 *   for every `renderSlot()`/`collect()`/`qu.onStorageChange()` call site.
 *   Available to ANY manifest `kind` (`engine`/`service`/`app`), not just
 *   apps. `kind` here allows a THIRD value `'hook'`, deliberately absent from
 *   `contributes` above: a `'hook'` point is one that fires via Qu Core's OWN
 *   `qu.onStorageChange()` (typically filtered to one path prefix, exactly
 *   like `watch()`/`watchChildren()`/`@qu/sync` already do) - e.g. ThreadEngine
 *   declaring `{point: "thread.messagePosted", kind: "hook", description:
 *   "fires via qu.onStorageChange() on writes under a thread's messages path
 *   - see paths.threadMessagesParentPath()"}`. There is deliberately NO
 *   `export`/`contributes` entry for a `'hook'`-kind point and no
 *   `ExtensionPointHost` method backs it - a contributor just calls
 *   `qu.onStorageChange()` directly wherever its own code already runs, the
 *   same established mechanism `@qu/reactive`/`@qu/sync`/`@qu/relay` all
 *   already use, needing no cross-app dynamic-import at all (unlike `'ui'`/
 *   `'menu'` points, a storage write needs no help finding code that isn't
 *   there - the listener registers itself, wherever it happens to run).
 *   `'ui'`/`'menu'`-kind points, by contrast, DO get real `contributes`
 *   entries elsewhere in the catalog, resolved through `ExtensionPointHost` -
 *   e.g. Forum's own manifest declares `{point: "content.messageActions",
 *   kind: "ui", description: "extra action buttons per forum message"}`, and
 *   a future Likes app's manifest declares `{point: "content.messageActions",
 *   export: "renderLikeButton"}` under ITS `contributes` - Forum never
 *   imports Likes, Likes never imports Forum, both merely agree on the same
 *   `point` string, discoverable by anyone reading the catalog.
 *
 * @property {string} [spaceId] - This app's OWN permanent storage space id
 *   (see @qu/services' `paths.js`'s `spacePath()`/`documentPath()`/
 *   `threadMetaPath()` etc. - every one of them takes a `spaceId` as their
 *   first segment). A UUID, generated ONCE per app and committed here
 *   alongside `name`/`label` - deliberately NOT auto-generated per relay
 *   deployment (that would give every independent relay running "the same"
 *   app its OWN isolated space, defeating the actual point): any relay that
 *   deploys this exact app source shares the SAME `spaceId`, so its data is
 *   addressable/mergeable the same way regardless of which relay it landed
 *   on first - `name`/`label` stay human-friendly display metadata only,
 *   never used as a storage key (see `apps/forum`'s own history: it used to
 *   pass the literal string `'forum'` as its spaceId, which is exactly the
 *   collision risk a human-readable name creates once more than one
 *   independent deployment/app could plausibly pick the same word).
 *   Optional: an app with no `ThreadService`/space-scoped storage of its own
 *   (e.g. `app-list`, which only ever reads shared catalog/directory paths
 *   that aren't "a space" in this sense) simply omits it.
 *
 * DEFERRED: an optional, analogous `spaceId`-style UUID for a RELAY itself
 * (as opposed to a single app's space) - for a future "this relay is part of
 * a named, globally-shared network" concept - is anticipated but
 * deliberately NOT designed or built here; nothing in this field's shape
 * blocks adding it later as its own separate, relay-level concept alongside
 * (not replacing) an app's own `spaceId`.
 *
 * NOTE: QuV2's prototype had a separate, never-wired `capabilities` field +
 * `Registry.registerCapability()` API for "what actions exist for this
 * entity kind" runtime dispatch (see registry.js's doc comment) - `contributes`
 * above is that idea's real, actually-wired successor (the `kind: 'menu'`
 * usage shape covers the same "context menu for an entity" case), so the old
 * field name is retired rather than resurrected.
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
  if (manifest.spaceId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manifest.spaceId)) {
    throw new Error('Invalid manifest: "spaceId" must be a UUID');
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
  if (manifest.contributes !== undefined) {
    const valid = Array.isArray(manifest.contributes) && manifest.contributes.every(
      (c) => c && typeof c === 'object'
        && typeof c.point === 'string' && typeof c.export === 'string'
        && (c.kind === undefined || CONTRIBUTION_KINDS.includes(c.kind))
        && (c.order === undefined || typeof c.order === 'number')
    );
    if (!valid) throw new Error(`Invalid manifest: "contributes" must be an array of {point, export, kind?, order?} where kind is one of ${CONTRIBUTION_KINDS.join(', ')}`);
  }
  if (manifest.definesExtensionPoints !== undefined) {
    const valid = Array.isArray(manifest.definesExtensionPoints) && manifest.definesExtensionPoints.every(
      (d) => d && typeof d === 'object'
        && typeof d.point === 'string'
        && (d.kind === undefined || CONTRIBUTION_KINDS.includes(d.kind))
        && (d.description === undefined || typeof d.description === 'string')
    );
    if (!valid) throw new Error(`Invalid manifest: "definesExtensionPoints" must be an array of {point, kind?, description?} where kind is one of ${CONTRIBUTION_KINDS.join(', ')}`);
  }
  return manifest;
}
