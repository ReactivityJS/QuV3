# Qu V3 / Quniverse

A clean, structured rebuild of the layered architecture designed in
`ReactivityJS/Qu` (whitepaper) and implemented in `ReactivityJS/QuV2`: a small,
storage-agnostic core (`QuBit { path, val, ts, pub, sig }`) with Runtime,
Engines, Services, Sync and an application layer built on top of it as
replaceable, independently testable packages.

Read these first, in order:

1. [`docs/v3-architecture-spec.md`](./docs/v3-architecture-spec.md) — critical
   review of the original V3/Quniverse concept (Drupal CMS / ProcessWire CMS /
   GunDB inspired) against QuV2's actual, verified behavior. What to keep,
   what to challenge, what to defer.
2. [`docs/v3-technical-concept.md`](./docs/v3-technical-concept.md) — the
   resulting technical design: Core/Runtime/Engines/Services layer by layer,
   every identified weakness paired with a concrete solution, a storage-query
   API refinement (the `getChildren()` adapter contract), a cross-package
   dependency audit, and a positioning against GunDB/Drupal/ProcessWire.

## Status

Under active, incremental construction — one package at a time, each with its
own tests, built bottom-up per the dependency order in
`docs/v3-technical-concept.md` §11.

- [x] `@qu/core` — QuBit, QuCrypto, QuEvents, QuMount, QuStore, adapters
      (`VolatileAdapter`, `MemoryStoreAdapter`)
- [x] `@qu/foundation` — Registry (Engine/Service lookup), HookBus,
      DependencyResolver, manifest schema, Actions/Slots (`mount` renamed to
      `slot` throughout — see `actions.js`, it collided with `QuMount`/DOM
      `mount()`). `registerCapability`/`capabilities` deliberately **not**
      ported yet — dead API in QuV2, comes back paired with its first real
      caller (see `registry.js`'s doc comment). **Added later**:
      `RuntimeContainer` (docs/v3-technical-concept.md §2.1) — a lazy-singleton
      module registry (`register(name, factory)`/`resolve(name)`), the fix
      for QuV2's `relay.js`/`shell.js` "god object" composition roots.
      Factories run at most once, on first `resolve()`; a circular
      dependency (A resolves B resolves A) is reported as the exact cycle
      instead of overflowing the stack, same failure mode
      `DependencyResolver` already uses for a circular manifest `requires`
      chain. §7 Finding 5's `bootClientRuntime()` helper deliberately **not**
      built alongside it — it only pays for itself once there are two real
      `apps/` composition roots to de-duplicate, and V3 has none yet; same
      "comes back with its first real caller" reasoning as
      `registerCapability` above.
- [x] `@qu/runtime` — `FsAdapter` (Node) and `IndexedDBAdapter` (browser),
      each implementing the full `QuAdapter` contract including
      `getChildren()`. Deliberately no shared `.` entry point — only
      `@qu/runtime/fs` and `@qu/runtime/indexeddb` — so a bundle for one
      platform can never accidentally pull in the other's code. The
      `(ts,rel)` sort/cursor logic itself lives once, in `@qu/core`'s new
      `adapters/cursor.js`, reused by `MemoryStoreAdapter` and both of
      these — not reimplemented three times. A conformance test suite runs
      the identical scenarios against all three adapters and asserts they
      agree.
- [x] `@qu/engines` — Document/Collection/Thread/Asset/Access engines.
      `AccessEngine`'s pure decision logic is exported as
      `assertWriteAuthorized()` (throws, doesn't return a boolean — see
      `access-engine.js`'s doc comment) so `@qu/sync` can apply the
      *identical* check to synced writes later — V3's fix for the
      confirmed ACL-bypass-on-sync gap. `ThreadEngine` no longer carries
      its own writer check at all (that was QuV2's migration-era
      "redundant safety net" for pre-uniform-convention data — doesn't
      apply to a fresh build); it now only stamps `_id`/`createdAt`, same
      shape as `DocumentEngine`. A conformance-style end-to-end smoke test
      wires all five engines together on one `QuStore`.
- [x] `@qu/services` (first slice) — `paths`, `unwrap`, `sync-freshness`,
      and **`ListService`**, docs/v3-technical-concept.md §4.2's centerpiece
      redesign: ONE list primitive with two strategies (`listDerived()` —
      no index document, just `QuStore.getChildren()`, for items already
      colocated under a shared parent; `listCurated()`/`addCurated()`/
      `removeCurated()` — a hardened, lock+retry `{$list}` index, replacing
      QuV2's `CollectionService` *and* `StarredService`'s independently
      weaker copy of the same read-modify-write pattern). Regression tests
      reproduce both adversarial races the design doc cites (10 concurrent
      same-process adds; two independent `ListService` instances racing on
      one list) and a synthetic "permanently loses the race" case proving
      the retry gives up gracefully instead of hanging. Deliberately no
      `@qu/core`/`@qu/engines` runtime dependency yet — this slice's source
      only touches the `QuStore` interface it's handed, both are
      devDependencies for tests only. **Deferred to the next round**:
      `StarredService`/`FlagService` (need `@qu/identity` for "my own
      signing key", not yet built) and the `ThreadService` decomposition
      (§4.3) built on top of `ListService`.
- [x] `@qu/identity` — one BIP-39 seed (`@scure/bip39`, audited, not
      hand-rolled), SLIP-10 (Ed25519) derivation for a "main" identity plus
      any number of deterministic, unlinkable per-space pseudonymous
      identities, and attestations that privately prove a space identity
      belongs to a main one (individually encrypted per trusted contact,
      envelope-encrypted once regardless of recipient count). Ported
      essentially unchanged — already bug-free (bounded key/attestation
      caches, `importMnemonic()` already validates the mnemonic before
      deriving) — with one clarity rename: QuV2's `bip32.js` (its own doc
      comment already said "SLIP-10", the filename didn't) is now
      `slip10.js`. No incognito-alias vault — per
      docs/v3-technical-concept.md §1.5, deterministic per-space keys
      already give unlinkable identity at zero sync/storage cost, so V3
      doesn't carry the added complexity of a stored, synced secondary-key
      table. A capstone smoke test signs a thread message with a *real*,
      seed-derived space identity (not a hand-rolled test keypair) and
      confirms `AccessEngine` still gates it correctly, and that a
      *different* space identity derived from the same seed cannot post as
      it. One test-design bug (three identities sharing one `QuStore` — the
      engine's own one-seed-per-store guard correctly rejected it) was
      caught and fixed by moving to one store per identity, with explicit
      QuBit copies standing in for what `@qu/sync` will do for real.
- [x] `@qu/services` (second slice) — `private-storage` (self-encryption
      helpers), `StarredService`, `FlagService`, and its
      `FavoritesService`/`ContactsService` facades. **`StarredService` and
      `FlagService` are not redundant** — `StarredService` is the generic
      "private list I own" primitive (also used directly by non-flag
      features), `FlagService` is the Drupal-Flag-style domain API with two
      modes: *private* (delegates to `StarredService`) and *public* (a
      visible counter — one signed slot per actor, enumerated via
      `ListService.listDerived()`, a completely different mechanism
      `StarredService` can't provide since self-encrypted data is
      inherently private-only). `StarredService` deliberately does NOT
      route through `ListService.addCurated()` — that mode stores
      *references* to items living elsewhere; a starred entry has no
      separate item to reference, so `StarredService` got its own
      lock+retry mutation (same proven pattern, adapted to an inline
      object-array instead of a path-array) rather than being forced
      through the wrong shape. This closes a real gap: QuV2's
      `StarredService` had **no** race mitigation at all. No legacy
      namespace mapping either (same "nothing to migrate in a fresh build"
      reasoning as `ThreadEngine`). One refinement surfaced while building
      `FlagService.getPublicFlags()`: `ListService.listDerived()`'s
      `limit` no longer defaults to 50 — a like-counter silently capped at
      50 would just be wrong, so that default now belongs to whichever
      caller actually wants pagination, not to the generic primitive.
- [x] `@qu/services` (third slice) — the `ThreadService` decomposition
      (§4.3): QuV2's 778-line, five-concern `thread-service.js` split into
      **`MessageService`** (+ `THREAD_PRESETS`), **`ReactionService`**,
      **`PinService`**, **`PresenceService`**, plus the supporting
      `AccessService` (generic writer/reader ACL Entity API),
      `crypto-envelope` (reader-list encrypt/decrypt, shared by
      `MessageService` and `AccessService`), and `thread-formatting`/
      `link-detect` (the markdown/mentions subset). Messages, reactions and
      pins all moved to the **derived**-list shape §4.2's migration table
      specifies: `postMessage()`/`setReaction()`/`setPinned()` are each a
      single `qu.put()`, no index write, enumerated via
      `ListService.listDerived()` - `MessageService.listMessages()` no
      longer needs its own `syncFetch` backfill for the enumeration itself
      (sync's reconnect catch-up, §3.2, covers that), and gets real
      `{limit, cursor}` pagination "for free" as a result (returns
      `{messages, nextCursor}` - a return-shape change from QuV2's plain
      array). Two design calls made while building this, both recorded in
      §4.3 itself: PUBLIC read receipts moved into `PresenceService`
      (identical one-signed-QuBit-per-known-member shape as presence, kept
      apart from `MessageService`'s PRIVATE `markRead()`/`getLastReadAt()`,
      which is about *this* identity's own read position, not a signal for
      others) - and QuV2's `clearMessages()` was **not** ported, since a
      derived list has no index to reset (`QuStore` has no `delete()`
      either); a caller wanting a clean history starts a new `threadId`
      instead. One found-and-documented subtlety: two messages posted in
      the same millisecond tie-break on their (random) storage path, not
      posting order - `QuStore.getChildren()`'s own `(ts,rel)` contract, an
      inherent local-first limitation (no central sequencer), not a bug -
      see `message-service.js`'s own doc comment and its test suite's
      `tick()` helper for how tests account for it.
- [x] `@qu/sync` — `SyncEngine` (path-based pub/sub replication: local
      writes broadcast to subscribers, incoming synced QuBits authenticity-
      checked then persisted straight to the adapter via `putSealed()`),
      `Transport` contract + `WebSocketClientTransport` (queues writes
      before the socket opens, exponential-backoff auto-reconnect),
      `MemoryOutboxStore` (+ `@qu/runtime`'s new `IndexedDBOutboxStore`,
      `./indexeddb-outbox`) for the persistent sync-out queue that survives
      a reload while offline, and `fetchPrefix()` reciprocal catch-up on
      every (re)connect. Ported essentially unchanged (docs/
      v3-technical-concept.md §3.1/§3.2 both verified already-correct in
      QuV2) **except the one confirmed gap this milestone exists to close**
      (§3.3, V3 milestone #1): `#handleSync` now calls `@qu/engines`'
      `assertWriteAuthorized()` on every incoming synced write - the same
      authorization decision `AccessEngine` already makes for a
      locally-originated `put()`, previously never applied to a synced one
      at all (`putSealed()` deliberately bypasses the TRANSFORM step that
      would otherwise run it, to avoid re-signing data this device didn't
      write - see `#persistDirectly()`'s own doc comment). A write that
      fails the check is rejected silently: not persisted, not acked, not
      re-broadcast - indistinguishable from never having arrived. Verified
      with a regression test reproducing the exact exploit (a peer with no
      `AccessEngine` of its own signs and sends a forged write for a
      writer-restricted resource; the relay's `SyncEngine` rejects it) and
      a companion test confirming a properly-authorized synced write still
      goes through normally. Since there was no existing per-package unit
      test suite for `@qu/sync` to extend (QuV2 only had one big end-to-end
      smoke test with a real relay process), this round built an in-memory
      `Transport` test harness (`RelayTransport`/`ClientTransport` over a
      shared `TestNetwork`) modeling the real client-relay star topology
      closely enough for deterministic coverage of subscribe/fetch/
      fetchPrefix/reconnect/outbox-replay/hub-re-broadcast, with no real
      network or timers beyond a small polling helper for async delivery.
- [x] `@qu/push` — dependency-free Web Push: RFC 8292 VAPID auth
      (`generateVapidKeys()`/`signVapidJwt()`, hand-rolled ES256 JWT, no JOSE
      library) + RFC 8291/8188 payload encryption (`encryptPayload()`, ECDH +
      HKDF + AES-128-GCM, all via `node:crypto`) + `sendWebPush()`. Ported
      essentially unchanged - ~40 tests including a real encrypt/decrypt
      round-trip against a simulated browser subscriber, VAPID JWT structure/
      signature verification via plain `node:crypto`, and a mocked-`fetch()`
      suite covering request shape, encryption (payload is never plaintext
      on the wire), and 404/410 → `expired: true` mapping.
- [x] `@qu/services` (fourth slice) — `NotificationPrefsService` (per-identity
      push settings: global on/off, global @mention on/off, per-app/per-
      function overrides; `static shouldNotify()` is the pure decision logic
      both a relay and a settings UI share) and `PushSubscriptionService`
      (a browser's registered Web Push endpoints). Both PUBLIC/signed, not
      encrypted - the party that needs to read them to decide whether to
      push (`@qu/relay`) has no way to decrypt owner-only data.
      `PushSubscriptionService` moved to the **derived**-list shape (§4.2):
      QuV2's version needed its own backfill-before-read-modify-write
      workaround for a confirmed two-device race (device B's subscribe()
      silently discarding device A's); a derived list has nothing shared to
      race on - each device's subscription is its own path, `subscribe()`
      is a single `qu.put()`, the whole workaround doesn't exist to need.
- [x] `@qu/relay` — a Node.js peer: persists to disk (`@qu/runtime`'s
      `FsAdapter`, both `/store` and `/blob`), replicates via `@qu/sync`,
      and delivers Web Push. Built on `RuntimeContainer` (§2.1) from day
      one, not refactored into it later - `PresenceTracker`,
      `RelaySettings`, `VapidKeyStore`, `PushDeliveryService`, `AdminHttp`
      and `HttpRouter` are each independently testable modules, not methods
      on one growing composition-root class the way QuV2's 894-line
      `relay.js` was. Routing/replication itself is exactly `@qu/sync`'s
      `SyncEngine` (nothing relay-specific to add there beyond the
      `WebSocketServerTransport` - assigns each connection a stable
      peerId, per-peer rate limiting, live-adjustable via
      `setRateLimit()`). `PushDeliveryService` ports QuV2's notification
      pipeline (candidate resolution from thread `readers`/`mentions`,
      `NotificationPrefsService` gating, in-app notification write +
      presence-suppressed Web Push) with ONE deliberate redesign: routing
      is now **pluggable** (`resolveNotification(spaceId, threadId,
      {authorPub, mention, mentions})`) instead of a hardcoded per-app
      if/else chain naming apps that don't exist in V3 yet
      (`calendar-<id>`/`geochase-<id>`/`chat`) - the exact extension point
      §6.2's manifest-driven `pushRouting` table plugs into once apps
      exist. `AdminHttp` ports the signature-gated settings + Data Explorer
      routes unchanged. **Deliberately out of scope**: app
      discovery/loading, static app serving, shell serving, the
      `apps.json` catalog - all need `@qu/loader` + `apps/shell`, neither
      built in V3 yet (see `http-router.js`'s own doc comment for the
      exact routes this omits). Caught in review before committing: an
      early draft of the `authorPub` derivation dropped `QuBit.pub`'s
      base64→base64url conversion (present in QuV2's own version) - would
      have made every "is this the author"/"who gets notified" comparison
      silently fail, since every other actor-pub string in this codebase is
      base64url. 79 new tests across both packages
      (`@qu/push`, `@qu/relay`) plus the two new `@qu/services` additions,
      full suite (554 tests, up from 475) green, including a `relay.test.js`
      that boots a REAL relay (real disk, real HTTP, real WebSocket) and reproduces
      the §3.3 ACL-on-sync fix end-to-end against it.
- [x] `@qu/loader` — loads Engines/Services/Apps from a `manifest.quapp`,
      resolving `requires` via `@qu/foundation`'s `DependencyResolver` (real
      resolution now, not the "logs a warning and silently skips" QuV2
      started from) in dependency-first order, deduplicating diamond
      dependencies automatically (a package required by two others in the
      same load only ever loads once). Two loading paths sharing one base
      class: `RemoteLoader` (isomorphic - zero Node built-ins, only `fetch`/
      `URL`/dynamic `import()` of a `data:` URL, so a future browser bundle
      can import `@qu/loader/remote` standalone) does `loadRemote()` -
      integrity (`sha256-<base64>` of the fetched bytes) is MANDATORY, never
      optional, and an optional publisher signature is strictly enforced
      once `trustedPublisherPubs` is given (unsigned, or signed-but-
      unconfigured, loads with a visible warning; signed-and-wrong never
      does). A remote package's `requires` is deliberately never
      auto-resolved against other remote sources - it may only reference
      names already loaded/registered locally, so loading ONE remote
      package can never transitively pull in a chain of others with no
      operator review. `QuLoader` (Node-only) extends it with
      `loadLocal()` + `discoverLocalPackages()` (scans a directory's
      immediate subdirectories for `manifest.quapp`, skipping - with a
      warning, not a hard failure - anything that fails validation, so one
      app's typo can't block every other app from being discovered). 33
      tests including a diamond-dependency load-order check, a circular-
      `requires` rejection, and a full discover+resolve+load+register
      round-trip against real files on disk; `RemoteLoader`'s tests mock
      `fetch()` (no real network) but exercise genuine `QuCrypto.sha256()`/
      `sign()`/`verify()` calls against real generated keypairs - full
      suite (587 tests) green. **Now wired into `@qu/relay`** - see the
      next bullet.
- [x] `@qu/loader` × `@qu/relay` integration, plus `apps/forum` — the
      first real app. `boot()` now discovers and dependency-orders every
      local app under `appsDir` (default `./apps`, auto-loaded via
      `QuLoader.loadLocal()`) and, if configured, `remoteApps` from trusted
      manifest URLs - the exact order `@qu/loader`'s own doc comment
      describes. `HttpRouter` gained `/apps.json` (`apps-catalog.js`'s
      `buildAppsCatalog()` - every loaded app with a `clientMain`, still
      listed-but-`enabled:false` when an admin has disabled it) and static
      app serving under `/apps/<name>/...` (`static-apps.js`, path-
      traversal-protected) so other relays can `loadRemote()`/`loadLocal()`
      what this one hosts. `apps/forum` is genuinely real, not a fixture:
      `register()` idempotently ensures the shared public forum thread
      exists (via `MessageService.createThread()` + `THREAD_PRESETS.forum()`,
      both already-built infrastructure), verified end to end by booting an
      actual `QuRelay` against the real repo `apps/` directory and reading
      back the real thread config it created. Deliberately SERVER-ONLY (no
      `clientMain`) - V3 has no browser UI framework yet (`@qu/reactive`/
      `@qu/ui`, what QuV2's own `apps/forum/client.js` needed), and building
      one just to give this app a UI would be exactly the kind of
      speculative complexity this codebase's own principles warn against;
      `buildAppsCatalog()` already correctly omits a `clientMain`-less app
      from `/apps.json`, so this is real, complete infrastructure today,
      not a placeholder. Found and fixed while writing the integration
      tests: `boot()` starting the HTTP/WebSocket server BEFORE loading
      apps means a genuine app-loading failure (e.g. a missing `requires`)
      used to leave the server listening with no cleanup - `boot()` now
      tears down whatever it already started via `close()` before
      rethrowing, so a failed boot never leaks an open port. Also caught:
      several existing relay tests implicitly relied on `QuRelay`'s
      `./apps` default resolving to nothing, which broke the moment a real
      `apps/` directory existed - fixed by giving every test an explicit,
      isolated `appsDir` unless it specifically wants real app-loading
      behavior. 40 new tests (`apps-catalog.test.js`, `static-apps.test.js`,
      `http-router.test.js` additions, `relay.test.js` additions,
      `apps/forum/test/index.test.js`) - full suite (627 tests) green.
      Manual smoke test: boot a real relay against the real `apps/`
      directory, confirm `/apps.json`/`/apps/forum/manifest.quapp` both
      respond correctly and the real forum thread exists afterward.
- [x] `@qu/reactive`, `@qu/i18n`, `@qu/ui` (§5's client UI layer), plus
      `@qu/services`' fifth slice (`ProfileService`/`DirectoryService`/
      `ActorService`/`actor-format`) and three real, client-bearing apps -
      `apps/app-list`, `apps/user-list`, `apps/contact-list` - the first
      Quniverse platform UI. **Resolves §5's open spike**: `@qu/reactive`'s
      `watch()` and `@qu/ui`'s Custom Elements (`<qu-view>`/`<qu-bind>`/
      `<qu-list>`/`<qu-key>`/`<qu-if>`) are ported unchanged (they were
      already correct, just untested in QuV2 - now with a real test suite,
      including jsdom-based DOM tests this codebase never had before) and
      shipped as real, documented, OPTIONAL infrastructure - but all three
      new apps stay IMPERATIVE like their QuV2 originals, because their
      data genuinely isn't the "one watched Qu path -> one array" shape
      `<qu-list>` expects (search-filtered results, profiles resolved
      across multiple Services per row) - not a forced-fit decision, a
      confirmed one. `@qu/i18n` (`createI18n`/`detectLocale`/`setLocale`)
      ported unchanged - deliberately no global singleton, so it stays
      genuinely opt-in per package.
      **New**: `@qu/ui/theme.js`'s `ensureTheme()` - the shared design-token
      layer QuV2 never had (every app there hard-coded its own `#5b5bd6`/
      `#8884`/`#c00`/radii independently). Idempotent like `injectStyle()`;
      every consumer references a token with the exact QuV2 literal as its
      CSS fallback (`var(--qu-color-border, #8884)`), so calling
      `ensureTheme()` is additive, never required - the "scalable AND
      optional" styling the platform needed. Also fixed while porting:
      `avatar.js` no longer hand-rolls its own local `ensureStyle()`
      duplicate of `style.js`'s `injectStyle()` (a QuV2 leftover, in the
      one file with the least excuse to still have it).
      `DirectoryService` is a REDESIGN, not a port: QuV2 built it on
      `DocumentService`+`CollectionService` (both superseded by §4.2);
      V3's version is a plain derived list (`ListService.listDerived()`
      over `directory/entries`, an actor's own signed entry as its own
      path, `null` tombstones on going invisible - the same convention
      `PinService`/`FlagService.setPublic()` already use) - no separate
      curated index that could drift out of sync with what it references,
      and no `syncFetch` backfill needed (a derived list rides sync's own
      reconnect catch-up, §3.2, same as `MessageService`/`ReactionService`).
      Caught by its own regression test before committing: an early
      `listVisible()` draft did `{ actorPub, ...quBit.val }` - since a
      directory entry's OWN value can itself carry an `actorPub` field, the
      spread order let a forged entry's self-claimed actor override the
      verified signer; fixed to `{ ...quBit.val, actorPub }` (verified
      value always wins, spread first). `ProfileService` ported essentially
      unchanged (every piece it needs - `private-storage.js`,
      `sync-freshness.js`, `@qu/identity`'s `publishMainProfile()`/
      `getProfile()` - already existed with an identical shape).
      `ActorService` is deliberately a NARROW slice of QuV2's version -
      only `whoAmI()`, the one method `user-list` actually calls; the rest
      (`signIn`/`vouchForSpaceIdentity`/`decryptForMe`/...) lands with
      their own real caller, not speculatively now. Promoted `@qu/identity`
      from a `@qu/services` devDependency to a real one - `profile-service.js`
      is the first source file in the package to actually import it at
      runtime, not just reference it in a JSDoc type.
      **New**: a minimal client build step (`scripts/build-apps.mjs`,
      `npm run build`, `esbuild` as a new root devDependency) - a scoped-
      down port of QuV2's `scripts/build-all.mjs`, bundling every app's
      `client.js` (whose manifest declares a `clientMain`) into a fully
      self-contained `apps/<name>/dist/client.js` (`dist/` gitignored, same
      as QuV2). Genuinely load-bearing, not speculative: bare imports like
      `@qu/i18n`/`@qu/ui`/`@qu/services` don't resolve in a raw browser, and
      `@qu/relay`'s static app serving just serves whatever bytes are on
      disk - without this step, these three apps could never actually run.
      Scoped to only what's needed this round (bundling `apps/*` client
      entry points, not every `@qu/*` package for remote-loading) - grows
      once `@qu/loader`'s `loadRemote()` needs that for real.
      **New test infrastructure**: `@qu/ui/testing`'s `installDom()`
      (a jsdom bootstrap - Node has no DOM, and `@qu/ui`'s Custom Elements
      extend `HTMLElement` at module-evaluation time, so even importing
      `components.js` requires one first) and `waitFor()` (polls a
      condition instead of guessing a fixed number of microtask-flush
      ticks - found to be necessary, not just tidier, when a test's
      real async chain runs deeper than a mocked one, e.g. a real
      `ContactsService.listContacts()`'s own internal `Promise.all`).
      88 new tests across `@qu/reactive`/`@qu/i18n`/`@qu/ui`/`@qu/services`'
      new files/the three apps, plus one new `@qu/relay` integration test
      confirming `/apps.json` correctly lists all three alongside the
      already-loaded `apps/forum` (still correctly omitted, still no
      `clientMain`) - full suite (746 tests) green. Manual smoke test: real
      `npm run build` (bundles verified free of any leftover bare `@qu/*`
      import), then a real `QuRelay` booted against the real repo `apps/`
      directory - `/apps.json` lists exactly the three client apps with
      correct `clientMainUrl`s, and `/apps/<name>/dist/client.js` serves
      the actual built, self-contained bytes for each.
- [x] `apps/app-list`/`user-list`/`contact-list` REBUILT genuinely on
      `<qu-list>` - the previous round's "these three stay imperative, the
      data isn't `<qu-list>`'s shape" conclusion above turned out to be a
      real, fixable gap in `<qu-list>` itself, not an inherent property of
      the data. Raised directly by the user: all three ARE lists from the
      store (flagged apps, flagged users, the directory) even though each
      needs some referenced data per row - closing that gap was preferred
      over leaving the apps imperative, and turned out to also fix a real
      efficiency problem in private lists, not just an aesthetic one.
      **`@qu/reactive`**: new `watchChildren(qu, parentPath, callback, opts)` -
      `watch()`'s counterpart for DERIVED lists (many sibling documents
      under a shared prefix, no single value to `watch()`), built on
      `getChildren()` with the same monotonic-call-counter race guard as
      `watch()`. Regression caught by its own test: an early version
      refetched on a write to ANY descendant path, not just a direct
      child - narrowed to match `getChildren()`'s own documented "one
      level deep" contract.
      **`@qu/services`**: private (self-encrypted) lists redesigned from a
      single self-encrypted BLOB per namespace (`StarredService` - the
      WHOLE array re-encrypted on every mutation, O(n) per write, and
      un-reactive by construction) onto the SAME per-item derived-list
      shape `ListService`'s public lists already use. `StarredService`
      deleted outright (verified via grep: zero callers besides
      `FlagService`'s private mode). New `private-storage.js` primitives:
      `getPrivateChildren()` (derived-list fetch + decrypt, xKey resolved
      once not per item, tombstones skipped before decrypting - mirrors
      `ListService.listDerived()`) and `createPrivateStore(qu, identity)`,
      a Qu-SHAPED facade (`{get, put, getChildren, onStorageChange}`) that
      transparently self-encrypts/decrypts. That facade is what avoided
      needing any new UI-layer component for "reactive private data" -
      `<qu-view>`/`<qu-list>`/`watch()`/`watchChildren()` are all already
      duck-typed against exactly this interface (`findQu()` just walks up
      for the nearest `.qu`), so a container with
      `.qu = createPrivateStore(qu, identity)` gets every reactive
      primitive to work transparently through encryption with zero changes
      to `@qu/reactive`/`@qu/ui`. `FlagService`'s private mode rewritten
      onto these (constructor no longer takes a `starredService`) while
      preserving the EXACT same consumer shape - `ContactsService`/
      `FavoritesService` needed zero changes. Tombstone convention (`null`
      = removed, written PLAIN/unencrypted, matching every other derived
      list in the codebase) applies here too, checked before decrypting.
      **`@qu/ui`**: `<qu-list>` gained a `parent` attribute (derived lists,
      via `watchChildren()`) alongside the existing `path` attribute
      (curated lists, `watch()`) - both modes share the same `_render()`.
      Regression caught by its own test: derived-mode tombstones
      (`quBit.val: null`) were still rendering, since the old `validItems`
      filter only checked `item?.path`, which a tombstone still has -
      fixed to also check `!('quBit' in item) || item.quBit?.val`, scoped
      so curated-mode items (no `.quBit` field at all) are unaffected. New
      `relatedPaths` property on `<qu-list>` - a JS function
      `(itemId, item) => Record<string,string>` resolved once per stamped
      item, exposed to descendants via a new `related="name"` attribute on
      `<qu-view>`/`<qu-bind>`/`<qu-if>` (alternative to `path`). Kept as a
      JS callback, not a string-template DSL - same anti-pattern-matching-
      engine principle already documented for search below. New
      `onItemStamped(els, itemId, item)` hook on `<qu-list>`, called once
      per newly-stamped item before DOM insertion - added when a genuine
      compositional gap showed up TWICE independently while rebuilding the
      apps (mounting `renderFlagToggle()`'s existing imperative helper into
      a slot; giving one descendant its own `.qu` distinct from the item's
      inherited context) - a real escape hatch for what pure declarative
      HTML/`related` can't express, not a second templating mechanism.
      **`@qu/relay`**: new `apps-catalog-store.js` - `publishAppsCatalog()`
      writes one signed QuBit per app under `/store/apps/catalog/<name>`
      (same field shape as `/apps.json`'s `buildAppsCatalog()`), called
      once after boot's app-loading and again after any `disabledApps`
      change via Relay Admin, so enable/disable reflects into the store
      live, no restart needed. Deliberately NO new `AccessEngine` ACL -
      consistent with the codebase's established convention for every
      other derived list (directory/reactions/pins/presence): "path is
      addressing, signer is truth". Instead, the relay's own pubkey is
      exposed via a new `relayPub` field on `/config.json`, and
      `apps/app-list` verifies every catalog entry's signer against it
      before trusting it. `/apps.json` unchanged, still fed by the same
      `buildAppsCatalog()`.
      **The three apps**, all now built on `<qu-list parent="...">`:
      `app-list` filters catalog entries to `relayPub`-signed and
      `enabled !== false` before rendering, `.onItemStamped` mounts
      `renderFlagToggle()` against `createPrivateStore()`; `user-list`
      re-verifies each directory entry's signer against its own path
      segment (same check `DirectoryService.listVisible()` already does
      internally - binding straight to the raw path bypasses that Service)
      and resolves avatar/alias imperatively per row, because a profile
      document is a signed, WRAPPED envelope
      (`{profile: {...}, signature}`) that only `getPublicProfile()` can
      safely unwrap - a real finding made while wiring this up: a first
      draft tried `related="profile"` and would have rendered raw,
      unverified envelope garbage instead of an alias, so `relatedPaths`
      was removed from that file as genuinely the wrong fit, not kept as
      dead flexibility; `contact-list` lists `<qu-list parent="...">`
      against `privateFlagParentPath(self, 'favorite', 'user')` with `.qu`
      set to `createPrivateStore()`, so Remove-then-gone is fully live,
      no manual re-fetch, unlike the previous imperative version. All
      three keep client-side search as a plain post-render visibility
      toggle over already-`<qu-list>`-rendered rows' own text - still not
      promoted into a new reactive filter primitive, disproportionate
      machinery for three apps, and not a "workaround" of list
      construction since the list itself stays fully `<qu-list>`-driven.
      Full suite green at 785 tests (up from 746, net of `StarredService`'s
      tests removed and everything above's new coverage added). Manual
      smoke test: a real `QuRelay` booted against the real `apps/`
      directory - `/config.json` returns a real `relayPub`,
      `/store/apps/catalog/*` holds all three apps' entries each signed by
      that exact key: `npm run build` bundles all three cleanly with no
      leftover bare `@qu/*` imports.

## Development

```sh
npm install
npm test   # node --test (recursive auto-discovery of packages/*/test/*.test.js)
```
