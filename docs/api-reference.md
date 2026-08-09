# Quniverse API reference

The complete, callable surface of every `@qu/*` package, plus theming,
styling, and templating. Everything here is either a verbatim export
signature read directly from source, or explicitly marked as simplified.
For *shape and wiring* (how these pieces fit into a mounted app), see
[`docs/building-an-app.md`](./building-an-app.md) — that guide links back
into specific sections here by name.

Package source lives under `packages/<name>/src/`; every package re-exports
its full public surface from `packages/<name>/src/index.js` — that file is
always the authoritative list of what `import { ... } from '@qu/<name>'`
gives you.

## Contents

1. [`@qu/core`](#1-qucore) — `QuStore`, `QuBit`, `QuCrypto`, `QuEvents`
2. [`@qu/identity`](#2-quidentity) — `QuIdentityEngine`, mnemonic/key derivation
3. [`@qu/reactive`](#3-qureactive) — `watch()`, `watchChildren()`
4. [`@qu/foundation`](#4-qufoundation) — manifests, extension points, actions
5. [`@qu/services`](#5-quservices) — every Service class, `paths`
6. [`@qu/ui`](#6-quui) — Custom Elements, avatars, flags, assets
7. [`@qu/i18n`](#7-qui18n) — `createI18n()`
8. [Theming](#8-theming) — `ensureTheme()`, `THEME_PRESETS`
9. [Styling](#9-styling) — `injectStyle()` convention
10. [Templating](#10-templating) — `apps/profile`'s `template`/`style` system, worked example
11. [`@qu/thread-ui`](#11-quthread-ui) — `insertAtCursor()`, `renderEmojiPicker()`, `mountMentionAutocomplete()`

---

## 1. `@qu/core`

`packages/core/src/index.js` exports: `QUBIT_FIELDS, isQuBit, isEncryptedEnvelope,
createQuBit, QuCrypto, QuEvents, QuMount, QuStore, VolatileAdapter,
MemoryStoreAdapter, encodeChildCursor, sortAndPaginateChildren`.

### `QuBit`

Every value in Quniverse is stored as one `QuBit` — exactly 5 fields, no more:

```js
{ path, val, ts, pub, sig }
```

`path` — the storage address. `val` — the value (plain, or an encrypted
envelope). `ts` — write timestamp (monotonic per path, used for ordering and
freshness checks). `pub` — the signer's public key. `sig` — the signature
over `(path, val, ts)`.

### `QuStore`

The one store instance a whole page load shares — passed as `ctx.qu` to
every mounted app.

- **`qu.mount(name, adapter)`** — attaches a storage adapter (`MemoryStoreAdapter`
  for tests, a real persistent adapter in production/relay contexts).
- **`qu.put(path, val, options)`** — the write pipeline: **TRANSFORM** (runs
  every registered Engine indexed by path segment — e.g. `AccessEngine`,
  `ThreadEngine`) → **SEAL** (sign/encrypt per `options`) → **PERSIST** →
  **NOTIFY** (fires `storage:put` on the internal `QuEvents` bus). `options`:
  - `signWith` — an Ed25519 PKCS8 private key; signs the write.
  - `writerPub` — the corresponding public key, checked against ACLs.
  - `encryptWith` — an X25519 public key (or array of them) to encrypt `val` for.
  - `senderXPrivateKey` — the sender's own X25519 private key, needed to encrypt.
- **`qu.get(path)`** — **FETCH** → **TRANSFORM**; returns a `QuBit` or `null`.
- **`qu.getChildren(parentPath, { sort = 'ts', order, limit, cursor })`** —
  one level deep under `parentPath`, cursor-paginated. **Bypasses the Engine
  transform** — raw `QuBit`s, not decoded/decrypted values. This is what
  `ListService.listDerived()` and `watchChildren()` build on.
  `encodeChildCursor()`/`sortAndPaginateChildren()` are the two helpers this
  method is implemented in terms of.
- **`qu.putSealed(path, quBit)`** — **PERSIST + NOTIFY only**, no re-signing.
  Used exclusively by `@qu/sync` for writes arriving from a peer that are
  already signed; sets an `origin: 'sync'` marker on the notify event so a
  listener can tell a synced-in write apart from a local one.
- **`qu.onStorageChange(handler)`** — subscribes `handler({path, quBit, origin?})`
  to every `put`/`putSealed` on this store. The primitive `@qu/reactive`'s
  `watch()`/`watchChildren()` and `@qu/sync` are both built on — a
  `definesExtensionPoints` entry with `kind: 'hook'` (see §4) documents a
  reaction point built this way instead of via `ExtensionPointHost`.

### `QuCrypto`

Static crypto helpers used throughout `@qu/services`: `sign()`, `verify()`,
`toBase64Url()`/`fromBase64Url()`, key generation. Every Service that signs
its own writes (`NotificationPrefsService.savePrefs()`, `MessageService.postMessage()`,
...) calls through this, never `crypto.subtle` directly.

### `QuEvents`

A small, generic pub/sub bus — `on(event, fn)`, `off(event, fn)`, `emit(event, ...args)`.
Used internally by `QuStore` (its notify bus) and by `ExtensionPointHost`
(§4) for `renderSlot()`'s fire-and-forget dispatch.

---

## 2. `@qu/identity`

`packages/identity/src/index.js` exports: `QuIdentityEngine, actorPath,
generateMnemonicPhrase, isValidMnemonic, mnemonicToSeedBytes, deriveMasterNode,
deriveChildNode, deriveNodeFromPath, paths`.

### `QuIdentityEngine`

The one identity object per page load — passed as `ctx.identity`. Almost
everything you need from it is already wrapped by a Service in `ctx.services`
(see §5); reach for it directly only when you need a raw key.

Key methods: `generateMnemonic()`, `importMnemonic(phrase)`, `exportSeedCode()`,
`importSeedCode(code)`, `hasIdentity()`, `getMainKey()` / `getMainXKey()`
(Ed25519 signing / X25519 encryption keypairs for your main identity),
`getSpaceKey(spaceId)` / `getSpaceXKey(spaceId)` (per-space derived keypairs,
what `asSpaceId` options throughout `@qu/services` sign with), `getEphemeralKey()`,
`publishMainProfile(fields)`, `publishProfile(spaceId, fields)`, `getProfile(pub)`,
`createAttestation(...)`, `resolveMainUser(...)`.

Every key is deterministically derived from one mnemonic seed
(`deriveMasterNode()` → `deriveChildNode()`/`deriveNodeFromPath()`) — nothing
is generated and stored independently per key.

---

## 3. `@qu/reactive`

`packages/reactive/src/watch.js`. Both functions are **race-guarded**: an
older, slower callback invocation can never overwrite a newer one's result,
even though the callback itself does no guarding.

### `watch(qu, path, callback, { initial = true, syncFetch } = {})`

Calls `callback(quBit | null)` once immediately (if `initial`), then again
every time `path` changes via `qu.onStorageChange()`. Internally
timestamp-guarded against out-of-order delivery (a `syncFetch` backfill
arriving after a live write must never re-render the stale value over it).
Returns an unsubscribe function.

### `watchChildren(qu, parentPath, callback, { initial = true, syncFetch, limit, order, cursor } = {})`

Same contract, but for `qu.getChildren(parentPath, ...)` — fires whenever
**any** child under `parentPath` changes. Call-counter-guarded (not
timestamp-guarded, since there's no single timestamp for "the children
changed") against the identical out-of-order race. **The callback receives no
useful payload** — every real app in this repo re-fetches via the relevant
Service (`services.messages.listMessages(...)`, etc.) inside the callback,
rather than trying to reconstruct state from raw `QuBit`s. Returns an
unsubscribe function.

Both are the primitive every `<qu-view>`/`<qu-list>` Custom Element (§6) is
built on internally, and what every app's own `mount()` calls directly for
anything not expressible as a declarative element.

---

## 4. `@qu/foundation`

`packages/foundation/src/index.js` exports: `Registry, HookBus, DependencyResolver,
validateManifest, REQUIRED_FIELDS, MANIFEST_KINDS, PUSH_ACTION_TYPES,
CONTRIBUTION_KINDS, actionsForSlot, resolveActionHref, RuntimeContainer,
ExtensionPointHost, listDefinedPoints`.

### Manifests

- **`REQUIRED_FIELDS`** = `['name', 'version', 'main']`.
- **`MANIFEST_KINDS`** = `['engine', 'service', 'app']`.
- **`PUSH_ACTION_TYPES`** = `['create', 'update', 'delete', 'mention', 'custom']`.
- **`CONTRIBUTION_KINDS`** = `['ui', 'hook', 'menu']`.
- **`validateManifest(manifest)`** — throws a descriptive error naming the
  first invalid field; the full field reference (with every field's meaning)
  lives in `docs/building-an-app.md` §2, since that's a manifest-*authoring*
  concern more than an API one.

### `ExtensionPointHost` (`packages/foundation/src/extension-points.js`)

Built once per route dispatch, from the live `apps` catalog
(`new ExtensionPointHost(apps)` — `apps/shell/client.js`'s `renderRoute()`
does this on every hash change, so it's always current).

- **`.renderSlot(point, container, payload)`** — for `kind: 'ui'` points.
  Registers every manifest-declared contributor to `point` onto an internal
  `QuEvents` instance (lazily, once per point, via a private
  `#ensureRegistered`), then emits. Each contributor's exported function
  receives a **fresh** `<div class="qu-ext-slot-item" data-contributor-app="...">`
  appended to `container` — never `container` itself — so contributors can
  never see or clobber each other's DOM. Contributed modules are cached by
  `clientMainUrl` in an internal `Map`, so a slot rendered once per row in a
  long list (e.g. one call per forum message) doesn't re-`import()`/re-eval
  the same contributor module per row.
- **`.collect(point, payload)`** — for `kind: 'menu'` points. Not built on
  `QuEvents` (fire-and-forget doesn't fit "gather every answer") — loops
  contributors, calls each, concatenates the results, each tagged with its
  contributing `appId`.
- **`listDefinedPoints(apps)`** — a pure query over every loaded app's
  `definesExtensionPoints`, independent of any host instance. Useful for a
  "what extension points exist" debug/discovery view.

The full worked example (a real host + a real contributor, quoted from
`apps/forum`/`apps/bookmarks`) is in `docs/building-an-app.md` §6.2 — this
section is the method reference, that one is the "how do I actually use this."

### Actions (`packages/foundation/src/actions.js`)

- **`actionsForSlot(apps, slotId)`** — pure filter + sort over every loaded
  app's `actions` array; returns `{appId, id, label, icon, hrefTemplate, order}[]`.
- **`resolveActionHref(action, params)`** — fills `{param}` tokens in
  `action.hrefTemplate` from `params`, URL-encoding each value; **throws** if
  a token in the template has no matching key in `params`.

Deliberately not the same mechanism as `contributes`/`ExtensionPointHost`:
`actions` is pure data (a link), no code execution, no dynamic import — see
`docs/building-an-app.md` §6.1 for the worked example.

---

## 5. `@qu/services`

`packages/services/src/index.js` is the authoritative export list. Every
Service takes `qu` (and usually `identityEngine`) as its first constructor
argument(s) — none of them are singletons, `apps/shell/src/services.js`
constructs the full set once per page load and hands the whole object as
`ctx.services` to every mounted app.

### `paths` (`packages/services/src/paths.js`)

Exported as a namespace: `import { paths } from '@qu/services'`. Every
function here is a pure string-builder — no I/O. The Entity-API surface:

| Function | Builds the path for |
|---|---|
| `spacePath(spaceId)` | Everything under one space — what a `subscribe()` call needs to cover it all. |
| `documentPath(spaceId, docId)` | A single arbitrary document. |
| `assetPath(spaceId, assetId)` | An uploaded asset's root (chunks live under it). |
| `aclPath(spaceId, kind, resourceId)` | A resource's ACL document (what `AccessService` reads/writes). |
| `listPath(spaceId, listId)` | A curated list document (`ListService.createCurated()`/`.listCurated()`). |
| `threadMetaPath(spaceId, threadId)` | A Thread's config (`{writers, readers, replyMode, formatting, ...}`). |
| `threadMessagePath(spaceId, threadId, messageId)` | One message. |
| `threadMessagesParentPath(spaceId, threadId)` | The derived-list parent `watchChildren()`/`listMessages()` watch. |
| `privateFlagPath`/`privateFlagParentPath(actorPub, flagType, entityKind[, entityRef])` | Your own private flags (favorites/bookmarks/contacts) — see `FlagService`. |
| `flagPath`/`flagParentPath(spaceId, flagType, entityKind, entityRef[, actorPub])` | Public flags (e.g. a public "like"). |
| `threadReadMarkerPath(spaceId, threadId, actorPub)` | One actor's private last-read marker for a thread. |
| `threadReactionPath`/`threadReactionsParentPath(spaceId, threadId, messageId[, actorPub])` | One message's reactions. |
| `threadPinPath`/`threadPinsParentPath(spaceId, threadId[, messageId])` | A thread's pinned messages. |
| `threadPresencePath(spaceId, threadId, actorPub)` | Presence heartbeat. |
| `threadReadReceiptPath(spaceId, threadId, actorPub)` | Read receipts (distinct from the private read *marker* above — a receipt is public, "X has seen up to ts Y"). |
| `directoryEntryPath`/`directoryEntriesParentPath(actorPub)` | The public directory (`DirectoryService`). |
| `notificationPrefsPath(actorPub)` | `NotificationPrefsService`'s public, signed prefs document. |
| `notificationsSpaceId(actorPub)` | `` `notifications-${actorPub}` `` — the fixed per-identity notifications space id. |
| `NOTIFICATIONS_SPACE_PREFIX` | `'notifications-'` (the constant the above is built from). |
| `NOTIFICATIONS_THREAD_ID` | `'notifications'` — the fixed thread id inside that space. |
| `pushSubscriptionPath`/`pushSubscriptionsParentPath(actorPub[, subscriptionId])` | Web Push subscription records. |
| `appCatalogEntryPath`/`appCatalogParentPath([name])` | The mirrored app catalog under `/store/apps/catalog/...`. |

### `ListService`

`new ListService(qu, syncFetch = null, getGeneration = null)`.

- `listDerived(parentPath, { limit, order = 'desc', cursor } = {})` — thin
  wrapper over `qu.getChildren()`, what every "list of X" reads through.
- `createCurated(listPath, itemPaths, options)` / `listCurated(listPath)` /
  `addCurated(listPath, itemPath, options)` / `removeCurated(listPath, itemPath, options)` /
  `listCuratedRawPaths(listPath)` — a **curated** list: one document holding
  an explicit array of item paths (vs. derived: many sibling documents, no
  index). `addCurated()`/`removeCurated()` retry internally
  (`#mutateOnce(..., attempt)`) against concurrent-write races on the shared
  index document.

### `AccessService`

`new AccessService(qu, identityEngine, syncFetch = null, getGeneration = null)`.

`getAcl(spaceId, kind, resourceId)`, `protect(spaceId, kind, resourceId, acl = {}, { asSpaceId, includeSelfAsWriter = true })`,
`unprotect(...)`, `addWriter`/`removeWriter`/`addReader`/`removeReader(spaceId, kind, resourceId, actorPub, options)`,
`writeOptionsFor(spaceId, kind, resourceId, { asSpaceId })` — resolves the
`{signWith, writerPub, encryptWith, senderXPrivateKey}` options another
Service's `qu.put()` call needs, given a resource's current ACL.

### `FlagService`

`new FlagService(qu, identityEngine, listService)`. The shared primitive
behind favorites/contacts/bookmarks (all **private**, encrypted to yourself)
and a generic public-flag mode:

- **Private:** `setPrivate(flagType, entityKind, entityRef, on, data = {})`,
  `listPrivate(flagType, entityKind)`, `hasPrivate(flagType, entityKind, entityRef)`.
- **Public:** `setPublic(spaceId, flagType, entityKind, entityRef, on)`,
  `getPublicFlags(spaceId, flagType, entityKind, entityRef)`,
  `hasPublicFlag(spaceId, flagType, entityKind, entityRef, actorPub)`.

`@qu/ui`'s `renderFlagToggle()` (§6) is the generic UI over this — it takes
a `flags` adapter object exposing exactly `hasPrivate()`/`setPrivate()` (or a
hand-rolled adapter with the same two methods, as `BookmarksService`'s own
consumer in `apps/bookmarks/client.js` does — see `docs/building-an-app.md` §6.2).

### `FavoritesService` / `ContactsService` / `BookmarksService`

Three thin, purpose-named facades over one shared `FlagService` instance —
each hides its own `flagType`/`entityKind` string pair behind a narrower API:

- **`FavoritesService(flagService)`**: `add(appId)`, `remove(appId)`,
  `list()`, `isFavorite(appId)`.
- **`ContactsService(flagService, identityEngine)`**: `addContact(actorPub, data = {})`,
  `removeContact(actorPub)`, `listContacts()`, `isContact(actorPub)`.
- **`BookmarksService(flagService)`**: `add(messageId, snapshot = {})`,
  `remove(messageId)`, `isBookmarked(messageId)`, `list()`.

### `MessageService`

`new MessageService(qu, identityEngine, listService, accessService, syncFetch = null, getGeneration = null)`.
The Entity API over a Thread's messages (see `@qu/engines`' `ThreadEngine`
for the pipeline half). **Messages are a derived list** — each lives at its
own path under `threadMessagesParentPath()`, no index document, so
`postMessage()` is one `qu.put()`.

- **`createThread(spaceId, threadId, config = {})`** — idempotent; returns
  the existing config unchanged if the thread already exists. `config` shape:
  `{writers, readers, replyMode, formatting, kind?, name?}` — see
  `THREAD_PRESETS` below for ready-made configs.
- **`getConfig(spaceId, threadId)`**, **`addReader`/`removeReader(spaceId, threadId, actorPub)`**.
- **`markRead(spaceId, threadId)`** / **`getLastReadAt(spaceId, threadId)`** —
  a generic, private, **thread-level** (not per-message) read marker.
- **`postMessage(spaceId, threadId, { body, replyTo = null, asSpaceId = null, extra = {} })`**
  → `Promise<{id, body, formattedHtml, mentions, author, replyTo, ts, ...extra}>`.
  **`extra` is spread flat onto the stored message** — a caller passing
  `extra: {title, url, appId}` gets those back as top-level fields on the
  result (and on every later `listMessages()` read), never nested under an
  `.extra` key. Applies the thread's configured `formatting` (markdown/mentions)
  and, for any thread with a specific `readers` list, encrypts for exactly
  those readers (fails closed if a reader has no resolvable X25519 key yet).
- **`notify(spaceId, recipientPub, body, extra = {})`** → `Promise<object>`
  (the stored message). Convenience for "tell one actor something" —
  creates (if needed) a `` `invite-${recipientPub}` `` mail thread
  (`THREAD_PRESETS.mail(recipientPub)`) and posts one message into it. The
  one-shot equivalent of `createThread()` + `postMessage()`.
- **`editMessage(spaceId, threadId, messageId, { body, asSpaceId = null })`** →
  `Promise<object>` (the updated message). **Author-only**, enforced here
  (not by the write ACL — a public thread's `writers: '*'` would otherwise
  let anyone overwrite anyone's message by knowing its id). Throws if the
  message doesn't exist or the caller isn't its original author.
- **`listMessages(spaceId, threadId, { limit, order = 'asc', cursor } = {})`**
  → `Promise<{messages: object[], cursor}>` (decrypted/formatted plain values).
- **`listReplies(spaceId, threadId, parentMessageId)`**.

**`THREAD_PRESETS`** — named configs proving "Forum/Chat/Mail/Notifications
differ only by config", all going through the same `createThread()`/
`postMessage()`/`listMessages()`:

| Preset | Shape | Use |
|---|---|---|
| `forum()` | `{writers:'*', readers:'*', replyMode:'flat', formatting:['markdown','mentions']}` | Public board — real `apps/forum`. |
| `chat(memberPubs)` | `{writers, readers: memberPubs, replyMode:'flat', formatting:['mentions']}` | Fixed-membership room, encrypted. |
| `group(memberPubs, name)` | Same as `chat` + `{kind:'group', name}` | Named multi-member room. Membership fixed at creation — no re-keying for add/remove. |
| `mail(ownerPub)` | `{writers:'*', readers:[ownerPub], formatting:['markdown','mentions']}` | Personal inbox — anyone can send, only owner reads. |
| `notifications(ownerPub)` | `{writers:'*', readers:[ownerPub], formatting:[]}` | System notices — see §5's `NotificationPrefsService`/`PushSubscriptionService` and `docs/building-an-app.md` §7. |

### `ChannelService`

`new ChannelService(qu, identityEngine, listService, accessService, messageService, syncFetch = null)`.
`apps/forum`'s Channel → Topic → per-Topic-Thread hierarchy (esoTalk-styled)
— a Channel and a Topic are both plain, unencrypted-metadata Documents; a
Topic's content is a real `MessageService` Thread keyed by the Topic's own
id ("a Topic **is** its Thread"). Two curated lists per space
(`ListService.addCurated()` — the same hardened, retry-on-conflict
primitive every other list uses, not an unprotected read-modify-write):
`listPath(spaceId, 'channels')` and one `listPath(spaceId, 'topics-<channelId>')`
per channel.

- **`createChannel(spaceId, { title, description = '', color = '', restricted = false, memberPubs = [], channelId })`**
  → `Promise<object>`. `channelId` is normally omitted (a fresh
  `crypto.randomUUID()` is generated) — only ever passed for a fixed,
  well-known id (see `apps/forum/index.js`'s own "General" channel
  migration). If `restricted`, protects the channel document's own writer
  ACL (`AccessService.protect(spaceId, 'docs', id, {writers: memberPubs})`)
  and always includes the creator in `memberPubs`, even if they didn't type
  their own pub in.
- **`listChannels(spaceId)`** → `Promise<object[]>`. **`getChannel(spaceId, channelId)`**
  → `Promise<object|null>`.
- **`createTopic(spaceId, channelId, { title })`** → `Promise<object>`. Throws
  if the channel doesn't exist. Creates the topic document, adds it to the
  channel's own topics list, and calls `messageService.createThread()` for
  it — `THREAD_PRESETS.forum()` for an open channel; for a restricted one, a
  config with the SAME encryption/membership shape as `THREAD_PRESETS.chat()`
  (`writers`/`readers` both `channel.memberPubs`) but `forum()`'s own
  `formatting: ['markdown', 'mentions']`, not `chat()`'s `['mentions']`-only
  — using `chat()` verbatim silently renders every message with an EMPTY
  body (`formattedHtml` is `null` without `'markdown'`, and `.innerHTML =
  null` renders as nothing at all under `[LegacyNullToEmptyString]`, not
  even the word "null") — confirmed live, not hypothetical.
- **`listTopics(spaceId, channelId)`** → `Promise<Array<object & {replyCount, lastActivityAt, lastAuthor}>>`,
  newest activity first (one `listMessages()` per topic — fine at
  community-forum scale, no pagination yet).
- **`addChannelMember(spaceId, channelId, actorPub)`** → `Promise<object>`
  (the updated channel). A no-op for an already-open channel or an
  already-present member. Grows the channel document's own writer ACL, then
  **both** `writers` and `readers` on every EXISTING topic's thread config
  in one write each (not `MessageService.addReader()` alone — that only
  grows `readers`, and `MessageService` has no `addWriter()`; a
  `THREAD_PRESETS.chat()`-shaped thread uses the SAME list for both, so a
  member added via `addReader()` alone could read future messages but
  never POST any). Same non-retroactive trade-off as `MessageService.
  addReader()` itself: a new member sees every topic going forward, nothing
  posted before they joined.
- **`syncFetch`** matters here specifically, more than for most other
  Services sharing the same `qu`/`list`/`access` instances: without it, a
  peer who opens the forum after a channel/topic was already created
  elsewhere never sees it. `ListService.listCuratedRawPaths()` already
  backfills the LIST document itself on a miss, but `@qu/engines`'
  `CollectionEngine` (which resolves each `$list` entry to its actual value
  on read) only ever does a LOCAL `qu.get()` per referenced path — it has
  no network access of its own, by design. `ChannelService` does its own
  per-item `syncFetch()`-and-retry instead of relying on `ListService`/
  `CollectionEngine` to have already done it — confirmed live: a second
  peer's board view rendered genuinely empty (no error — a `$list` entry
  resolving to `null` for a not-yet-local document is indistinguishable
  from "no such channel" without this) until this was wired up.

### `ReactionService`

`new ReactionService(qu, identityEngine, listService)`. `setReaction(spaceId, threadId, messageId, emoji, { asSpaceId } = {})`
(pass `emoji: null` to clear your own reaction — a second click of your
current reaction is the toggle-off, handled by the caller, not this
Service), `getReactions(spaceId, threadId, messageId)` → `Record<emoji, actorPub[]>`.

### `PinService`

`new PinService(qu, identityEngine, listService)`. `setPinned(spaceId, threadId, messageId, pinned, { asSpaceId } = {})`,
`listPinned(spaceId, threadId)` → array of pinned message ids.

### `PresenceService`

`new PresenceService(qu, identityEngine)`. `setPresence(spaceId, threadId, status, { asSpaceId } = {})`,
`getPresence(spaceId, threadId, memberPubs, { staleAfterMs = 15_000 } = {})`,
`startHeartbeat(spaceId, threadId, { intervalMs = 5_000, asSpaceId } = {})` (returns
a stop function), `publishReadReceipt(spaceId, threadId, uptoTs, { asSpaceId } = {})`,
`getReadReceipts(spaceId, threadId, memberPubs)`.

### `NotificationPrefsService`

`new NotificationPrefsService(qu, identityEngine)`. Granular, per-identity
push settings — **deliberately public/signed, not encrypted**: the party
that needs to read it (`@qu/relay`, deciding whether to push) can't decrypt
something only the owner's own key can read, so it's signed (nobody else can
silently flip your settings) but not private.

- `getOwnPrefs()` / `getPrefsFor(actorPub)` → always a full,
  default-filled `{enabled, mentions, apps: {[appId]: {enabled?, functions?: {[fn]: bool}}}}`
  — never `null`, and a tampered/unsigned record silently falls back to
  defaults rather than trusting attacker-controlled settings.
- `savePrefs(prefs)` — merges over defaults, signs, writes.
- **`static shouldNotify(prefs, { appId, mention = false, functionName = null })`**
  → `boolean` — the actual decision logic, pure given an already-resolved
  `prefs` object, shared by both `@qu/relay`'s real push decision and a
  settings UI's "would this notify me?" preview.

### `PushSubscriptionService`

`new PushSubscriptionService(qu, identityEngine, listService)`. `subscribe(subscription)`
(a `PushSubscription`-shaped object from `registration.pushManager.subscribe()`),
`unsubscribe(endpoint)`, `listOwnSubscriptions()`, `listSubscriptionsFor(actorPub)`
(what the relay reads to know where to send a Web Push).

### `ProfileService`

`new ProfileService(qu, identityEngine, syncFetch = null, getGeneration = null)`.

- `saveProfile({ alias = '', avatar = '', template = '', style = '', fields = [], preferredLocale = null, preferredTheme = null })`.
- `getOwnProfile()`, `getPublicProfile(actorPub)`.

`template`/`style` here are exactly what §10 (Templating) documents;
`preferredLocale`/`preferredTheme` are applied once at shell boot (device-local
`localStorage`, not live mid-session — see §7/§8).

### `DirectoryService`

`new DirectoryService(qu, identityEngine, listService)`. `setVisible(visible, extra = {})`
(opt in/out of the public directory), `listVisible()`, `isVisible(actorPub)`.

### `ActorService`

`new ActorService(identityEngine)`. `whoAmI()` → your own main public key
(base64url) — the one method almost every app calls first inside its mount IIFE.

### `formatActorLabel(actorPub, profile)` / `matchesActorQuery(actorPub, profile, query)`

Pure helpers (`packages/services/src/actor-format.js`) — the shared
"how do we display/search for an actor" logic every list-of-actors UI
(`apps/user-list`, `apps/contact-list`, forum author labels, ...) uses
instead of hand-rolling its own.

### `AssetService`

`new AssetService(qu, assetEngine, identityEngine, syncFetch = null)`. A thin
facade over `@qu/engines`' `AssetEngine` (which owns all chunking/hashing/
dedup/retry logic).

- `upload(spaceId, assetId, file, { readerPubs = [], asSpaceId = null, onProgress } = {})`.
- `verifySyncOut(spaceId, assetId, { readerPubs = [], asSpaceId = null, maxRetries, retryDelayMs, onSyncProgress } = {})` —
  a **separate** phase from `upload()`: "saved locally" and "confirmed
  synced to a peer" are deliberately not the same moment.
- `download(spaceId, assetId, options)`.

`@qu/ui`'s `<qu-asset-upload>`/`<qu-asset>` (§6) are the Custom Element layer
over exactly these three methods.

### Private storage primitives (`private-storage.js`)

The building blocks `FlagService`/`NotificationPrefsService`-style "encrypted
to yourself" storage is built on, exported directly for a Service that needs
its own private document shape:

- `putPrivate(qu, identityEngine, path, value)` / `getPrivate(qu, identityEngine, path)`.
- `getPrivateChildren(qu, identityEngine, parentPath, options = {})`.
- `createPrivateStore(qu, identityEngine)` → an object bundling the three
  above, pre-bound to one `qu`/`identityEngine` pair.

### Formatting/link/crypto helpers

- **`extractMentions(body)`** / **`formatMarkdown(body)`** / **`applyFormatting(body, formatterNames)`**
  (`thread-formatting.js`) — `formatMarkdown()` **always escapes the raw body
  first** (`escapeHtml()`), then applies a fixed whitelist of its own
  replacements — there is no path for a user-controlled message body to
  inject real HTML, verified and relied on directly by `apps/forum/client.js`
  setting `formattedHtml` via `innerHTML`.
- **`URL_RE_GLOBAL`** / **`detectLinks(text)`** (`link-detect.js`).
- **`isEncryptedEnvelope(val)`** / **`resolveReaderXKeys(readerPubs, getProfile)`** /
  **`decryptEnvelope(quBit, identity, getProfile)`** (`crypto-envelope.js`) —
  what every Service's own `#decryptMessage()`-style private method is built on.
- **`unwrap(quBitOrValue)`** / **`unwrapAll(list)`** (`unwrap.js`) — strips a
  `QuBit` down to its `.val` (or passes a plain value through unchanged),
  the one-liner every Service uses instead of checking "is this already
  unwrapped?" ad hoc.
- **`createFreshnessTracker(syncFetch, getGeneration)`** / **`createMissGate(getGeneration)`**
  (`sync-freshness.js`) — internal plumbing most Services thread through as
  their own `syncFetch`/`getGeneration` constructor arguments; not something
  an app author calls directly.

### `createTrustedCatalogStore(qu, relayPub)`

(`apps-catalog-store.js`) — mirrors the relay-signed `/apps.json` catalog
into `/store/apps/catalog/<name>`, verifying each entry's signature against
`relayPub` before accepting it. What `apps/app-list`'s `<qu-list parent="...">`
and the shell's own nav (`apps/shell/src/nav.js`) both read.

---

## 6. `@qu/ui`

`packages/ui/src/index.js` exports: `QuViewElement, QuBindElement, QuListElement,
QuKeyElement, QuIfElement, findQu, renderSubpage, renderAvatar,
renderAvatarOrAsset, ASSET_AVATAR_PREFIX, injectStyle, renderFlagToggle,
ensureTheme, DEFAULT_THEME, THEME_PRESETS, getStoredTheme, setStoredTheme,
QuAssetUploadElement, QuAssetElement, findAssetService`. (`@qu/ui/testing.js`
is a separate entry point — `installDom()`, `waitFor()` — for tests only, see
`docs/building-an-app.md` §9.)

### Custom Elements (`components.js`)

All resolve `.qu` (a `QuStore`) and `.syncFetch` by walking up from
themselves to `document` — set either as a plain property on the element
itself or an ancestor, **before** the element connects (`findQu(el)`/
`findSyncFetch(el)` are the exported ancestor-walk resolvers, same pattern
`findAssetService()` below reuses for `.assetService`).

- **`<qu-view path="...">`** / **`<qu-bind path="..." field="..." attr="...">`** —
  bind one document's field to an element/attribute. `attr` values: `value`,
  `textContent`, `innerHTML`, `checked`, any other generic attribute name, or
  omitted (`auto-default` — textContent for most elements, value for form
  controls).
- **`<qu-list path="...">`** (curated — one document *is* the array) vs.
  **`<qu-list parent="...">`** (derived — `watchChildren()` under `parent`,
  many sibling documents) — both stamp one clone of their child `<template>`
  per item, keyed by path. Settable properties (**must** be set on the
  ancestor **before** the list connects): `.relatedPaths` (extra paths to
  join in per item — a structured value, hence a JS property rather than a
  string attribute), `.onItemStamped(el, item)`, `.syncFetch`.
- **`<qu-key>`** — shows the current item's path-derived id (inside a
  `<qu-list>` template).
- **`<qu-if path="..." field="..." equals="..." negate>`** — toggles
  `.hidden` on itself based on a field comparison.

### `renderSubpage(...)` (`subpage.js`)

The shared "← back to X" building block every subpage in this repo uses —
see `docs/building-an-app.md` §4.2 for how a subpage fits into `segments`-based
routing.

### `renderAvatar(seed, label, avatarValue, { size = '2rem' } = {})` (`avatar.js`)

One shared renderer for a profile's `avatar` field, used everywhere an
identity shows up. `avatarValue` is one of three shapes: an `https://` image
URL (renders a real `<img>`), a short string/emoji (renders as text), or
unset (falls back to `label`'s first letter). The badge's background color
is derived deterministically from `seed` (a pub or group id) so it's stable
across re-renders without persisting a color anywhere.

### `renderAvatarOrAsset(seed, label, avatarValue, opts)` / `ASSET_AVATAR_PREFIX`

Same as `renderAvatar()`, plus a **fourth** `avatar` shape:
`` `asset:${assetId}` `` (an uploaded avatar image via `<qu-asset-upload>` —
see `apps/profile/client.js`'s own upload handler) — renders a real
`<qu-asset kind="image">` instead. `ASSET_AVATAR_PREFIX = 'asset:'` is
exported so a *writer* of this shape (currently only `apps/profile`) can
prefix an `assetId` with the same string this reader checks for, without
either side re-declaring the literal independently. Needs an `AssetService`
reachable via `findAssetService()` on the element or an ancestor; `seed`
doubles as the asset's `space-id` (avatars are always uploaded under their
owning identity's own pub).

### `renderFlagToggle({ flags, flagType, entityKind, entityRef, icon, activeIcon, title, activeTitle })` (`flag-toggle.js`)

A reusable "star/bookmark this" button. `flags` is any adapter object
exposing `hasPrivate(flagType, entityKind, entityRef)` / `setPrivate(flagType, entityKind, entityRef, on)`
— either `FlagService` itself, or a narrower hand-rolled adapter (see
`apps/bookmarks/client.js`'s own `renderBookmarkToggle()`, quoted in
`docs/building-an-app.md` §6.2, which adapts `BookmarksService`'s
`add(messageId)`/`remove(messageId)`/`isBookmarked(messageId)` to this shape).
**Imperative, not reactive** — updates itself immediately on its own click
(no round-trip needed to see your own action), and broadcasts a
`window`-level `qu:flag-changed` CustomEvent (`detail: {flagType, entityKind, entityRef, on}`)
so any other mounted UI showing the same flag's state can stay in sync.

### `<qu-asset-upload space-id="...">` / `<qu-asset space-id="..." asset-id="..." kind="auto|image|video|audio|file">` (`asset-components.js`)

The Custom Element layer over `AssetService` — holds no storage/sync logic
of its own, just calls `upload()`/`verifySyncOut()`/`download()` and renders.

- **`<qu-asset-upload>`** — a file picker. Optional `.readerPubs`/`.asSpaceId`
  properties (set before a file is picked) forward verbatim to
  `AssetService.upload()`/`.verifySyncOut()`. Fires **`qu-asset-uploaded`**
  (`detail: {assetId, meta}`, bubbles) the moment the local write is durable
  — a host reacts to this to remember the new `assetId` — then, if syncing is
  configured, **`qu-asset-synced`** (`detail: {assetId, synced, missing}`,
  bubbles) once sync verification finishes (success or exhausted retries).
- **`<qu-asset>`** — a read-only viewer. Downloads once (an uploaded asset's
  bytes never change) and renders `<img>`/`<video>`/`<audio>`/a download link
  by MIME type (or a forced `kind` attribute). Object URLs are cached per
  `assetId` (module-level, ref-counted) and revoked only when the *last*
  element referencing one disconnects — repeated re-renders inside a
  `<qu-list>` row rebuild never redundantly re-download/re-decrypt.
- **`findAssetService(el)`** — same ancestor-walk as `findQu()`/`findSyncFetch()`,
  for `.assetService`.

---

## 7. `@qu/i18n`

`packages/i18n/src/index.js`.

- **`createI18n(dictionaries, { locale, fallback = 'en' } = {})`** →
  `{t, locale}`. `dictionaries` shape: `{en: {...}, de: {...}}`. `t(key)`
  looks up `locale`, falling back to `fallback` then the key itself if
  missing in both. If `locale` isn't passed, `detectLocale()` picks one
  (stored preference, then browser language, then `fallback`).
- **`detectLocale()`** — the resolution `createI18n()` uses when no explicit
  `locale` is given.
- **`AVAILABLE_LOCALES`** = `[{code: 'en', ...}, {code: 'de', ...}]`.
- **`getStoredLocale()`** / **`setLocale(code)`** — `localStorage`-backed,
  same "device-local, not identity-bound" shape as `getStoredTheme()`/
  `setStoredTheme()` below. Takes effect on next page load, not live
  mid-session — every app's `const { t } = createI18n(DICT)` call happens
  once, at module load.

Every app in this repo declares its own small `DICT` (`en`/`de`) and calls
`createI18n(DICT)` once at the top of `client.js` — there is no shared
global dictionary, by design: an app's strings are its own concern, not a
central bottleneck.

---

## 8. Theming

`packages/ui/src/theme.js`. The shared design-token layer: one call injects
a `:root { --qu-color-accent: ...; }` block every app references via
`var(--qu-color-accent, #5b5bd6)` — note the CSS fallback is always the
exact literal value QuV2 hard-coded, so **an app that never calls
`ensureTheme()` at all renders identically to before**; the system is a
convenience for a host that wants to reskin every mounted app at once, never
a requirement for correctness.

- **`DEFAULT_THEME`** — the 7 tokens every component in this codebase
  actually references (not a speculative larger catalog):
  `--qu-color-accent` (`#5b5bd6`), `--qu-color-border` (`#8884`),
  `--qu-color-danger` (`#c00`), `--qu-radius-sm` (`0.3rem`),
  `--qu-radius-md` (`0.4rem`), `--qu-font` (`system-ui, sans-serif`),
  `--qu-font-mono` (`ui-monospace, monospace`).
- **`THEME_PRESETS`** — named accent palettes, each overriding just
  `--qu-color-accent`: `default` (`#5b5bd6`), `ocean` (`#0891b2`), `sunset`
  (`#ea580c`), `forest` (`#15803d`), `rose` (`#e11d48`). Used both by a
  device-local theme picker (`apps/profile`'s Settings) *and*, independently,
  by a profile's own public `style` field (§10) — one palette system, not two.
- **`getStoredTheme()`** / **`setStoredTheme(name)`** — `localStorage`,
  device-local (not identity-bound — a theme choice doesn't sync across
  devices the way a profile field does), `try`/`catch`-wrapped so private
  browsing/disabled storage degrades to "no override" rather than throwing.
- **`ensureTheme(overrides = {})`** — idempotent (guarded on
  `document.getElementById('qu-theme')`, same pattern as `injectStyle()` —
  the *first* caller wins, typically the shell/host mounted before any
  individual app). Applies, in priority order: `DEFAULT_THEME` → the stored
  preset (if any) → `overrides` (an explicit caller override always wins,
  same priority `createI18n()`'s explicit `locale` option has over the
  stored locale). Also sets `color-scheme: light dark` — every token is
  either alpha-blended (self-adapts to whatever's underneath) or a saturated
  color that reads fine on both schemes, so there's no separate per-scheme
  token set (yet — a token that genuinely needs one can be added to
  `overrides`, or to `DEFAULT_THEME` itself with a `prefers-color-scheme`
  rule, once a real app needs it).

Call `ensureTheme()` once near the top of your `mount()`, same as every real
app does.

---

## 9. Styling

`packages/ui/src/style.js` — the one-line idempotent `<style>`-injection
helper every app uses instead of hand-rolling the same boilerplate:

```js
export function injectStyle(id, css) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
```

Idempotent for the same reason `ensureTheme()` is: `mount()` can run more
than once per page load (navigate away from an app and back), and a
`<style>` element doesn't deduplicate itself the way a real stylesheet
`<link>` would. The established convention, followed by every app and every
`@qu/ui` component that has its own CSS:

```js
const STYLE_ID = 'qu-<yourapp>-style';
const STYLE = `
  .qu-<yourapp>-thing { /* ...use var(--qu-color-accent, #5b5bd6) etc... */ }
`;

export function mount(container, ctx) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  // ...
}
```

Prefix every class name with `qu-<yourapp>-` — there is no CSS scoping
(no Shadow DOM, no CSS Modules) in this codebase, so the prefix *is* the
isolation mechanism. Reference theme tokens with a fallback
(`var(--qu-color-accent, #5b5bd6)`) so your app still looks right even if
whatever host mounted you never called `ensureTheme()`.

---

## 10. Templating

There is no framework-level "template" concept in Quniverse — `<qu-list>`'s
`<template>` child (§6) is DOM stamping, not what this section means.
"Templating" here is `apps/profile`'s own, app-level pattern for **a
user-selectable visual variant of one view**, reused as-is by anyone who
wants the same kind of "pick a layout, pick a palette" feature. It's a
convention built from two primitives you already have — `THEME_PRESETS`
(§8) and a plain CSS class — not a new API surface.

### The pattern, in full (from `apps/profile/client.js`)

```js
const TEMPLATES = ['default', 'compact', 'banner'];

/** Shared by the real profile view AND the settings page's own live preview
 *  - so the preview can never drift from what a visitor actually sees. */
function applyTemplateStyle(el, template, style) {
  const validTemplate = TEMPLATES.includes(template) ? template : 'default';
  el.classList.add(`qu-template-${validTemplate}`);
  const stylePreset = THEME_PRESETS[style] || {};
  for (const [prop, value] of Object.entries(stylePreset)) el.style.setProperty(prop, value);
}
```

Three pieces working together:

1. **A fixed list of template names** (`TEMPLATES`) — each just a CSS class
   (`qu-template-compact`, `qu-template-banner`, ...) added to the view's
   root element. The actual layout differences live in ordinary CSS, scoped
   under that class:

   ```css
   .qu-profile-view.qu-template-banner .qu-profile-header {
     flex-direction: column; text-align: center; padding: 1.5rem;
     border-radius: var(--qu-radius-md, 0.4rem);
     background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 12%, transparent);
   }
   .qu-profile-view.qu-template-compact .qu-profile-header { gap: 0.5rem; }
   ```

2. **A palette choice reusing `THEME_PRESETS` directly** (`style`) — instead
   of inventing a second, parallel palette system for "per-item style" vs.
   "device theme," `apps/profile` sets the *same* `--qu-color-*` custom
   properties `ensureTheme()` would, but scoped to this one element via
   `el.style.setProperty(...)` (an inline style, higher specificity than the
   `:root` block `ensureTheme()` injected) rather than globally. A profile
   with `style: 'sunset'` renders with the sunset accent **for that profile's
   view only**, regardless of what theme the *visitor's own* device has set.

3. **Storage** — both `template` and `style` are plain string fields on the
   profile document (`ProfileService.saveProfile({ template, style, ... })`,
   §5), publicly readable exactly like `alias`/`avatar`.

### Wiring it into your own app

```js
import { THEME_PRESETS } from '@qu/ui';

const TEMPLATES = ['default', 'compact', 'banner']; // pick your own set

function applyTemplateStyle(el, template, style) {
  const validTemplate = TEMPLATES.includes(template) ? template : 'default';
  el.classList.add(`qu-yourapp-template-${validTemplate}`);
  const preset = THEME_PRESETS[style] || {};
  for (const [prop, value] of Object.entries(preset)) el.style.setProperty(prop, value);
}
```

Then, in a settings form, build a `<select>` from `TEMPLATES` for the
template and `Object.keys(THEME_PRESETS)` for the style — `apps/profile`'s
own settings subpage does exactly this, live-previewing via the *same*
`applyTemplateStyle()` call on a preview element as soon as either `<select>`
changes, so a user sees the real effect **before** saving (profile data
otherwise has no way to preview your own change — it renders identically to
how anyone else already sees it, not specially for its own author).

An `invalid`/unset `template` value always falls back to `'default'` rather
than throwing or rendering blank — the same "never trust a stored string
blindly" discipline `NotificationPrefsService.getPrefsFor()` (§5) applies to
a signature, applied here to a plain enum value instead.

---

## 11. `@qu/thread-ui`

Small, composable browser-UI widgets shared by every Thread-backed message
composer/reaction row — Forum today, Chat once it's ported (they're built
this way specifically so a future `apps/chat` can reuse them without
rework). No Custom Elements (unlike `@qu/ui`) — plain functions returning/
mutating real DOM, matching this package's own small-composable-pieces
philosophy rather than one opinionated mounted component. Browser-only.

### `insertAtCursor(el, text, { start, end } = {})`

Caret-aware text insertion into a `<textarea>`/`<input>` — confirmed
missing anywhere else in this repo before this package (nothing else here
ever needed to insert text mid-string at a live caret position). Inserts
`text` at the given range (defaulting to the field's CURRENT selection — a
collapsed selection is just the caret), moves the caret to the end of the
inserted text via `el.setRangeText()`, and fires a real `input` event
afterward so any listener already on the field (e.g.
`mountMentionAutocomplete()`'s own detector) sees the change exactly as if
the user had typed it.

### `EMOJI_QUICK` / `EMOJI_EXTENDED` / `renderEmojiPicker({ onPick, quick = [], extended = EMOJI_EXTENDED, trigger = '+', triggerTitle })`

A curated Unicode set (8 quick picks + ~160 extended — ported verbatim from
QuV2's own `apps/chat/client.js`) plus one reusable "+"-style trigger that
reveals a positioned panel of `extended` choices. Plain Unicode codepoints
render via whatever emoji font the host OS/browser already provides — under
Android that's Android's own system emoji font automatically, no separate
integration needed. Two call shapes from the SAME function:

- `quick` non-empty → a row of plain quick-pick buttons plus a trailing
  trigger (e.g. a reaction row's own "+" expand, appended AFTER the host
  app's own live-count reaction buttons — this function never draws counts
  itself, that stays the caller's job).
- `quick` omitted → just the trigger button alone (e.g. a composer's single
  😀 "insert emoji" button).

Clicking the trigger opens a small panel anchored to the trigger itself
(not a single shared global popup singleton) — closes on a pick, an outside
click, or Escape.

### `mountMentionAutocomplete(textareaEl, { services, subscribe })`

`@`-triggered actor completion, by alias OR pub, from the 2nd typed
character onward (`@ab` already narrows). Purely a compose-time UX
convenience — the wire format is unchanged, `@qu/services`' `thread-
formatting.js`'s `MENTION_RE`/`extractMentions()` still only ever look for
a full `@<pub>` token in a posted body; this only helps a user find and
insert the right one instead of typing a 16–64 character pub blind.

- **Candidate pool**: `services.directory.listVisible()` + `services.
  contacts.listContacts()`, deduplicated by `actorPub`, resolved to a real
  profile ONCE per mount (not per keystroke) via `services.profile.
  getPublicProfile()`. Filtering then reuses that cached pool synchronously
  via `matchesActorQuery()`/`formatActorLabel()` (`@qu/services`'
  `actor-format.js`, unchanged).
- **`subscribe`** (optional) — defense in depth: calls `subscribe?.('/store/directory')`
  on mount, same reasoning `apps/user-list/client.js`'s own `subscribe?.
  ('/store/directory')` call already documents. Does **not** backfill
  anything that was ALREADY there before this identity's own session first
  subscribed (`subscribe()` only ever covers future writes — see `@qu/sync`'s
  `SyncEngine.subscribe()` own doc comment); `DirectoryService.listVisible()`
  itself has no `syncFetch` backfill-on-miss (it's a DERIVED list, see its
  own doc comment — "a caller subscribing already catches this up," which
  assumes someone does). A contact (private, always locally available, no
  subscribe needed) remains the more dependable candidate source either way.
- Selecting a candidate (click, or Enter/Tab while the dropdown is open;
  arrow keys navigate, Escape closes) replaces the typed `@ab…` fragment
  with `@<fullPub>` via `insertAtCursor()`.
- Positioning is a deliberate simplification: the dropdown anchors to the
  textarea's own bottom-left corner (its `parentNode`, which needs `position:
  relative`), not the exact pixel position of the caret — functionally
  complete, not pixel-perfect (a precise caret-coordinate measurement needs
  a hidden mirror-div technique this repo has no precedent for).
- Returns a stop function — removes listeners, closes any open dropdown.

---

## See also

- [`docs/building-an-app.md`](./building-an-app.md) — shape, wiring, and the
  full worked extension-point/notification examples this reference points
  back to throughout.
- [`README.md`](../README.md) — architecture overview and the detailed,
  chronological build log (`#status`).
