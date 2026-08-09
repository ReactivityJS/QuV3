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
- [x] `@qu/log`, visible key generation, a real `WebSocketClientTransport` test, and
      **`apps/shell`** - Quniverse is usable in a real browser now, not just via
      curl/jsdom. Triggered by the user's own question "what's the next step to make
      Quniverse usable" plus two explicit requirements: logging (relay AND client)
      from the start, and generated keys visible in the log instead of silently
      disappearing into the volume.
      **`@qu/log`** (new, minimal, dependency-free package): `createLogger(scope)` +
      `setLogLevel()`/`getLogLevel()`, level resolved once at import time
      (`QU_LOG_LEVEL` in Node, `localStorage['qu:logLevel']` in a browser, default
      `info`). Migrates every previous bare `console.*` call in `@qu/relay` and
      `@qu/ui` (plus new, previously-silent debug logs in `admin-http.js` and
      `websocket-server-transport.js`). A real bug found and fixed along the way:
      `console.*` references were originally bound ONCE at `createLogger()` time
      instead of resolved fresh on every call - breaks any test that mocks
      `console.error` afterward (4 existing `@qu/ui` tests) - fixed by resolving
      dynamically on every log call instead.
      **Visible key generation**: `setupVapidKeys()` now returns a `generated` flag;
      `relay.js#bootInner()` logs, only on the very first boot (never on a restart
      that reuses an already-persisted/pinned value), the freshly generated identity
      mnemonic AND VAPID keys in copy-pasteable
      `QU_IDENTITY_MNEMONIC="..."`/`QU_VAPID_PUBLIC_KEY="..."`/
      `QU_VAPID_PRIVATE_KEY="..."` form - they already persist in the volume either
      way, but this is the only way to pin them explicitly (backup, multi-replica
      deployments without a shared volume).
      **`WebSocketClientTransport`** (`@qu/sync`'s browser-facing sync transport) had
      zero tests of its own - only a hand-built fake in `sync-engine.test.js`
      simulated its shape. New
      `packages/relay/test/websocket-client-integration.test.js`: a real client
      (Node 22's native `WebSocket`, no `ws` package, the exact path a real browser
      takes too), a real `QuRelay`, bidirectional sync + reconnect catch-up via
      `fetchPrefix()` - all green on the first run.
      **`createTrustedCatalogStore()`** extracted from `apps/app-list/client.js` into
      `@qu/services` (a second real caller - `apps/shell`'s own nav - justifies the
      extraction, the same pattern demonstrated elsewhere in this document).
      **Relay shell-serving**: new `serveShell`/`shellDir` options
      (`QU_SERVE_SHELL`/`QU_SHELL_DIR`), new `static-shell.js` (fixed routes `/`,
      `/index.html`, `/shell-bundle.js` + `.map`) - fills exactly the gap
      `http-router.js`'s own comment had documented as a deliberate omission.
      **`apps/shell`** itself: `index.html` + `client.js` (composition root,
      deliberately short) + `src/onboarding.js` (create/import identity, ported and
      trimmed from QuV2 - no QR/camera, no `@qu/qr` package in V3) + `src/router.js`
      (`#/<appId>`, nearly 1:1 from QuV2) + `src/services.js` (`createClientServices()`
      - this round's own, deliberately LOCAL `bootClientRuntime()`, see
      `runtime-container.js`'s own comment: arrives with its first real caller, no
      promotion into a shared package before a second one exists) + `src/nav.js`
      (compact top nav via `<qu-list parent="...">`) + `src/sync.js`
      (`connectToRelay()` - `WebSocketClientTransport` + `IndexedDBOutboxStore` +
      `SyncEngine({publishAllTo, outbox})`, the star-topology client pattern from
      `sync-engine.js`'s own comment). `scripts/build-apps.mjs` now also bundles
      `apps/shell/client.js` unconditionally (no `manifest.quapp` gate like the other
      apps - shell is a known special case). `#/~<pub>` shows a placeholder instead of
      crashing (no `apps/profile` in V3) - an explicit, accepted scope cut, not a
      silent bug.
      **Two real, previously invisible bugs**, found by the Playwright real-browser
      check this round newly established (see Verification below) - no earlier
      in-process test could ever have caught either, since "relay" and "client" always
      shared the same `qu` there:
      1. `<qu-list>` never threaded a `syncFetch` through to
         `watch()`/`watchChildren()` - a fresh browser store starts empty, and any
         `<qu-list parent="...">` (the app-catalog nav, user-list, contact-list)
         stayed empty until some unrelated write happened to trigger a re-read. Fixed
         with a new `findSyncFetch()` (mirrors `findQu()`'s own ancestor walk) instead
         of a property set directly on the `<qu-list>` element -
         `watch()`/`watchChildren()` call `syncFetch` SYNCHRONOUSLY at mount time, too
         early for a property set AFTER an `innerHTML` assignment already connected it
         (unlike `.relatedPaths`/`.onItemStamped`, which are read later, at per-item
         stamp time). New `@qu/ui` tests, plus wiring in
         `apps/app-list`/`user-list`/`contact-list` and `apps/shell`'s own `nav.js`.
      2. `ListService`/`ProfileService` already had a `syncFetch` constructor
         parameter designed in from the start (their own doc comment: "without it,
         `getPublicProfile()` for a profile published before this session connected
         returns null forever") - but it had never actually been wired to a real
         `SyncEngine`, because no real client caller existed yet. Made visible when
         `user-list` in a real browser showed other identities only as truncated
         pubkeys instead of their real alias. Fixed in `apps/shell/src/services.js`.
      Full suite green at 821 tests (up from 785). Verification: `npm run build`
      bundles all 4 client bundles cleanly; a real, isolated `QuRelay` (Playwright +
      headless Chromium) walked through onboarding ("create a new identity"), showed
      the nav with all 3 apps, navigated into `app-list` and showed its favorite
      stars; a SECOND, independent Node peer (its own identity, a real
      `WebSocketClientTransport` against the same relay) called `setVisible(true)`
      and appeared LIVE (no manual reload) in the real browser tab's `user-list`,
      with its alias correctly resolved - the first real cross-client sync proof in
      this repo. An earlier, noisy version of this check (repeated manual runs
      against the same long-running relay process) showed apparent duplicates; a
      clean, single-shot run with an isolated temp store proved that was an artifact
      of the test method, not a real rendering bug.
- [x] **`apps/profile`** — the last piece missing to make Quniverse's directory
      genuinely usable: no app anywhere called `DirectoryService.setVisible()`, so
      `user-list` stayed empty for any real identity. Closes that gap, and turns
      `#/~<pub>` from a placeholder into a real editable-own/read-only-others profile
      page, per the user's own explicit requirements (subpaths in the hash; `pub`/
      `epub`/`alias` as the base identity fields, already exactly what
      `ProfileService` returned; free-form custom fields with a public/private
      toggle, likewise already there; **new, no QuV2 precedent**: identity-bound
      language/theme preference with a fallback to default, and a profile's own
      template/style for visitors).
      **`ProfileService` extended** (`packages/services/src/profile-service.js`):
      `template`/`style` (public, part of the same signed profile document as
      `alias`/`avatar` — flow through `getPublicProfile()`'s `...rest` automatically)
      and `preferredLocale`/`preferredTheme` (private, self-encrypted, but
      deliberately NOT part of the free-form `fields` list — the private-extra
      document's shape changed from a flat `{key: value}` merge to
      `{customFields: {...}, preferredLocale, preferredTheme}`, so a user's own
      custom field literally named `"preferredLocale"` can never collide with the
      real, reserved one — a real risk under the old flat shape, covered by a new
      regression test).
      **Identity-bound language/theme, without breaking `@qu/i18n`'s existing
      device-local design**: `createI18n()` is called synchronously at every app's
      module top level, before `qu`/`identity` even exist — making it identity-aware
      directly would mean rebuilding it (and every app that calls it) around an async
      source. Instead, the identity's own private preference is the source of truth,
      and gets PROPAGATED into the existing device-local mechanism
      (`setLocale()`/new `setStoredTheme()`) once, at `apps/shell`'s own boot,
      turning that device-local layer into a propagation TARGET rather than a
      competing setting — an unset preference means neither function is ever called,
      so the existing browser-detection/`DEFAULT_THEME` fallback applies completely
      unchanged. Takes effect on next reload everywhere except the device that just
      changed it, where `apps/profile`'s own Settings subpath calls `setLocale()`/
      `setStoredTheme()` immediately for instant local feedback — consistent with
      `@qu/i18n`'s own already-documented "next page load, not live" behavior for
      locale.
      **`@qu/ui`**: new `THEME_PRESETS` (`default`/`ocean`/`sunset`/`forest`/`rose`,
      each only overriding `--qu-color-accent`, matching how narrow `DEFAULT_THEME`
      already was) plus `getStoredTheme()`/`setStoredTheme()`, mirroring
      `@qu/i18n`'s `getStoredLocale()`/`setLocale()` pattern exactly;
      `ensureTheme()` now applies a stored preset before any explicit `overrides`
      (an explicit override still wins). The SAME preset system is reused for a
      profile's own public `style` — one shared palette system, not two.
      **`apps/shell`**: `#/~<pub>` now dispatches to the `profile` catalog entry
      (instead of a placeholder) regardless of the normal by-name lookup — QuV2's own
      profile-link convention; `segments` (already parsed by `router.js`, never
      actually passed to a mounted app before now) is threaded into every app's mount
      context as a general shell capability, not something special-cased for
      `apps/profile`; boot reads the identity's own `preferredLocale`/`preferredTheme`
      once, right after `services` exists, and applies them best-effort.
      **`apps/profile` itself**: `#/profile` (bare) redirects immediately to
      `#/~<myPub>`; `#/~<pub>` is the editable own form for `pub === myPub`,
      read-only for anyone else (including their own `template`/`style`, applied as a
      scoped inline CSS custom property on the profile view itself, never globally);
      `#/~<pub>/settings` is the language/theme picker, own-profile only (redirects
      back to the plain view otherwise). Reactive via `watch(qu, actorPath(pub,
      'profile'), ...)`, same as QuV2. Directory visibility is a plain checkbox over
      `services.directory.isVisible()`/`setVisible()`. Avatar stays a text field
      (URL or emoji, `renderAvatar()` already supports both) — no file upload/
      `AssetEngine` this round, no QuV2 precedent, no current need. Deliberately NOT
      ported from QuV2's `apps/profile`: the identity backup/export/QR section — a
      separate device/identity-management concern, and no `@qu/qr` package exists in
      V3 (same reasoning `apps/shell`'s onboarding screen already documents for
      dropping QR entirely).
      **A real bug found while wiring this up, unrelated to profile itself**: own
      saves render-and-flash a "Saved!" status message, but `ProfileService.
      saveProfile()` always republishes the same public profile document this same
      component `watch()`es — so a save triggers its own re-render, which discards
      the whole form (including the exact DOM node a save button's click handler
      just set "Saved!" on) and rebuilds it from scratch. Fixed with a small
      `saveState` flag shared by reference between `mount()`'s closure and
      `renderOwnProfile()`/`renderSettings()`: the click handler sets it BEFORE
      awaiting the save, and the next `render()` reads-then-clears it to decide
      whether to show the flash — found and fixed via this round's own new
      `apps/profile` tests, not the manual browser check (all 5 "does this save take
      effect" tests failed identically until fixed).
      **Also found while testing this round, real but pre-existing**: Node 22 ships a
      native global `WebSocket` — unlike jsdom (which `installDom()` never copies
      onto `globalThis`), so once `apps/shell`'s own tests gained a `localStorage`
      fake (needed for the preference-propagation tests above),
      `WebSocketClientTransport` started actually succeeding at construction and
      attempting a REAL TCP connection to `ws://localhost/` (jsdom's configured
      origin, nothing listening) — a slow (~10s) OS-level timeout per test instead of
      the fast, synchronous failure these jsdom unit tests were always meant to have
      (see `apps/shell/client.js`'s own try/catch around `connectToRelay()` — no real
      sync is meant to happen in these tests at all). Fixed with an explicit
      `delete globalThis.WebSocket` at the top of `apps/shell/test/client.test.js`,
      restoring the original fast (~1s total), side-effect-free behavior.
      Full suite green at 848 tests. Verification: `npm run build` bundles
      `apps/profile` cleanly alongside the other three; a real, isolated `QuRelay` +
      Playwright with two fully independent browser contexts (two separate
      identities/devices) walked through the complete loop this round set out to
      close — identity A edits alias/avatar/template/style, adds one public and one
      private custom field, saves, toggles directory visibility on; identity B
      (a completely separate browser context, own onboarding) sees A appear LIVE in
      `user-list` with no manual reload, opens A's public profile and sees A's own
      `banner` template and `sunset` accent applied (not B's), the public custom
      field and its value, and confirms the private field never appears anywhere in
      the page; B adds A as a contact via the same toggle `user-list` uses. Separately,
      A's edits survive a reload, and setting a language + theme preference in
      Settings and reloading actually renders the shell's home placeholder text in
      German — the identity-bound preference propagation path working end to end,
      not just in jsdom.
- [x] **PWA installability + an update-available flow** — the user asked for the
      smaller central-infrastructure pieces (PWA, updater) before the next big app
      (a `apps/forum` client is the obvious next candidate — `MessageService`/
      `ReactionService`/`PinService` exist fully tested but unused, still deferred).
      `apps/shell/client.js`'s own doc comment already listed this as explicitly
      deferred; QuV2 (reference, read-only) had it fully built, researched via an
      Explore agent before designing this round's version.
      **`apps/shell/manifest.webmanifest`** (new): standard web app manifest,
      `display: "standalone"`, a single inline-SVG `data:` icon (`sizes: "any"`,
      `purpose: "any maskable"`) — no real image asset needed, same approach QuV2
      used. `index.html` links it + a `theme-color` meta tag.
      **`apps/shell/sw.js`** (new): deliberately NOT an offline data cache —
      Quniverse's real data lives in IndexedDB, synced over WebSocket
      (`apps/shell/src/sync.js`), not a static asset worth intercepting; the `fetch`
      handler is a pure pass-through, present only because some browsers require one
      before offering "Add to Home Screen" at all. No automatic `skipWaiting()` on
      install — it waits for an explicit `SKIP_WAITING` message from the page, which
      is what makes an observable "update available" moment possible rather than
      silently swapping code under a running page.
      **`apps/shell/src/pwa.js`** (new): `registerServiceWorker()` distinguishes a
      genuine update (a second worker installs while the page already has a
      controller) from the very first install (nothing controls the page yet) — only
      the former fires `onUpdateAvailable()`; `applyUpdate()` posts `SKIP_WAITING` to
      the waiting worker; a `controllerchange` listener reloads the page exactly
      once. `captureInstallPrompt()` captures `beforeinstallprompt` for a custom
      "Install app" button instead of relying on browser-chrome-specific UI.
      `mountPwaUi()` wires both into one small bar, hidden entirely until something
      is actually actionable. Not ported from QuV2: the "install the current hash
      route as its own shortcut" deep-link variant — a standalone feature beyond
      what "PWA + updater" itself needs. Web Push's actual subscribe flow
      (`packages/push`/`PushSubscriptionService` exist server-side already, no
      client ever calls `PushManager.subscribe()`) stays a separate, explicitly
      deferred feature — same "hook built, no caller wired up yet" pattern as
      `ProfileService`'s own `syncFetch` parameter before `apps/shell` existed.
      **`scripts/build-apps.mjs`**: `sw.js` has no bare `@qu/*` import (plain,
      unbundled JS, runs in the separate ServiceWorkerGlobalScope) so it doesn't go
      through esbuild — instead its one `__SW_VERSION__` placeholder gets replaced
      with a short hash of the just-built `shell-bundle.js`'s own bytes
      (`node:crypto`, no new dependency), written to `apps/shell/dist/sw.js`. Tying
      the version to the bundle's actual content (not a hand-maintained counter, the
      way QuV2 did it) means a browser reliably notices a real deploy and notices
      nothing on a no-op rebuild — verified directly: an unrelated comment-only edit
      (stripped by minification) left the hash unchanged, a real code edit changed
      it, and reverting produced the original hash again.
      **`@qu/relay`**: `static-shell.js`'s `ROUTES` gains `/manifest.webmanifest` and
      `/sw.js` (both get the same `cache-control: no-cache` every other shell route
      already had — the whole update flow depends on the browser never serving a
      stale `sw.js`). `static-apps.js` (per-app bundles, previously served with NO
      `cache-control` at all) gets the same treatment, so an app's own bundle can't
      stay stuck stale even after the shell's own update-triggered reload — a small,
      directly-related fix bundled into this round rather than a separate one.
      **A real, pre-existing test bug found while running the full suite for this
      round's verification** (not part of PWA/updater itself): `apps/profile/test/
      client.test.js`'s five save-flash assertions (`waitFor(() => container.
      querySelector('.qu-profile-status').textContent === 'Saved!')`) occasionally
      threw `Cannot read properties of null` instead of failing cleanly or passing —
      `render()` clears `root` synchronously before its async re-fetch on every
      render, including the one a save's own write triggers via `watch()`, so a poll
      can legitimately land in the gap where `.qu-profile-status` doesn't exist yet.
      Fixed with `?.textContent` (keep polling on `undefined` instead of throwing) —
      confirmed flaky beforehand (2-3 failures per 3 full-suite runs) and clean after
      (15/15 isolated runs, 3/3 full-suite runs).
      **A second real bug, found only by the manual Playwright check** (unit tests
      never load a real service worker at all, so nothing else could have caught
      this): `sw.js`'s own top doc comment originally referenced `apps/*/index.js`
      as an example path - the literal substring `*/` inside that text PREMATURELY
      closed the `/* ... */` block comment, corrupting everything after it into
      invalid syntax. `node --check` on the file itself confirmed it
      (`SyntaxError: Unexpected identifier '$'`, nowhere near the real problem) once
      Chromium's own "ServiceWorker script evaluation failed" pointed at the file at
      all - reworded to avoid the literal `*/` sequence.
      Full suite green at 862 tests. Verification: `npm run build` produces a
      correctly stamped `apps/shell/dist/sw.js`; a real, isolated `QuRelay` +
      Playwright confirmed `GET /manifest.webmanifest`/`GET /sw.js` serve with the
      right content-type and `cache-control: no-cache`; the FULL install-and-update
      loop end to end in one continuous browser session - onboarding, a real page's
      `navigator.serviceWorker.ready` resolves to an `activated` worker, the
      manifest `<link>` is present, the update bar starts correctly hidden; a real
      new version then gets built and deployed to the same running relay,
      `registration.update()` detects it and installs a waiting worker, the update
      bar becomes visible, clicking it posts `SKIP_WAITING` and reloads the page
      exactly once, and the shell re-mounts cleanly under the new controller.
- [x] **`apps/forum`** — a real browser client for the single public thread `apps/
      forum/index.js`'s `register()` has ensured exists since early in this project.
      `MessageService`/`ReactionService`/`PinService` (`@qu/services`) were already
      fully built and tested, with no real client ever wiring them up - the same
      "backfill hook built, no caller yet" gap earlier rounds already closed for
      `ProfileService`'s `syncFetch` and `DirectoryService.setVisible()`. Proposed as
      the obvious next step after `apps/profile`; built after the user asked for the
      smaller PWA/updater infrastructure first.
      **Scope, deliberately**: a client for the ONE existing global thread
      (`forum`/`general`) - no channels/topics. QuV2's own Forum had a
      Channel→Topic→per-topic-Thread hierarchy on a `DocumentService`/
      `CollectionService` pair V3 never ported (superseded by `ListService` - see
      `DirectoryService`'s own doc comment on why that split doesn't exist here);
      building a channels concept just for this app would be new service-layer
      design nobody asked for. Also out of scope, each with a real reason: no
      delete (`MessageService` has no delete primitive at all, only author-only
      `editMessage()`); no attachments (no Asset/Blob upload flow wired anywhere in
      V3 yet, and QuV2's own Forum - unlike its separate Chat app - never had one
      either); no restricted-thread management UI (the one thread is
      `THREAD_PRESETS.forum()` - `writers:'*', readers:'*'` - nothing to manage).
      **Reactions/pins, adapted from QuV2's Chat client** (QuV2's own Forum never had
      either - only Chat did), deliberately simplified: a fixed, always-visible row
      of 5 emoji buttons per message instead of a "⋮" popup menu or an expandable
      150-emoji grid (no other app in V3 uses a popup menu) - clicking a button that
      isn't your current reaction sets it, clicking your current one clears it,
      `ReactionService.setReaction()`'s own "second call replaces the first, `null`
      clears" semantics make that trivial. Pins get one collapsible bar at the top
      (not QuV2's popup+badge combination) listing every pinned message with an
      unpin button, plus a live Pin/Unpin button per message.
      **Reactivity**: the message list re-fetches via `services.messages.
      listMessages()` (never the raw watched QuBits) every time `watchChildren()`
      fires on the thread's messages parent path - the same `apps/profile` pattern
      of ignoring the raw callback value and re-reading through the Service that
      knows how to decrypt/format it correctly. Each rendered message gets its own
      `watchChildren()` on its reactions parent path (mirrors QuV2's Chat: reactions
      live in a separate per-message collection) and its own on the thread's shared
      pins parent path (so its Pin/Unpin button stays live even when a DIFFERENT
      message gets pinned) - every one of those watchers is torn down and rebuilt on
      each message-list re-render, simple and cheap enough with no pagination yet.
      `formattedHtml` (already computed by `MessageService.postMessage()`/
      `editMessage()` via `thread-formatting.js`) is inserted via `innerHTML`
      directly - verified safe (`formatMarkdown()` HTML-escapes the raw body FIRST,
      then applies only a small whitelist of its own substitutions) both by a unit
      regression test AND a real Playwright check with an actual `<script>` payload
      confirming nothing executes.
      **`apps/shell/src/services.js`** extended: `access`/`messages`/`reactions`/
      `pins`, wired with the same `syncFetch`/`getGeneration`/`list` already used for
      `ProfileService`.
      Full suite green at 871 tests. Verification: `npm run build` bundles
      `apps/forum` cleanly; a real, isolated `QuRelay` + Playwright with two
      independent browser contexts confirmed the whole loop live, no reloads: A
      posts, B sees it instantly; B reacts, A sees the live count; A pins, B sees
      the pinned bar; A edits their own message, B sees the edit; B (correctly)
      has no Edit button on A's message; B posts a `<script>` payload, A sees it
      rendered as inert text with nothing executed.
- [x] **Two real concurrency bugs, found by a fresh real-relay Playwright pass
      requested specifically to re-check current state for bugs** (both required a
      REAL live relay - neither is reachable from an isolated jsdom unit test, since
      both need a second genuinely-independent write racing against an in-flight
      render):
      1. **`apps/forum`**: `renderMessages()` rebuilds the ENTIRE message list from
         scratch on every write to ANY message in the thread (a new post, or anyone
         editing anything). A message someone had an open, unsaved Edit form on -
         with real typed text not yet saved - silently reverted to its read-only
         view the moment a completely UNRELATED message arrived, discarding
         whatever they'd typed. Fixed with `editingDrafts` (`messageId -> draft
         text`, updated live via the textarea's own `input` event, cleared on
         save/cancel): `renderMessage()` checks it before deciding whether to render
         read-only or re-open the edit form with the preserved draft. Confirmed live
         in a real two-browser-context Playwright run: A opens Edit, types
         unsaved text, B posts something unrelated, A's edit form is still open with
         the SAME unsaved text afterward.
      2. **`apps/profile`**: `render()` (the own-profile edit form's own re-render,
         triggered by `watch()` on this identity's profile path) had no protection
         against being invoked twice concurrently. It does real async work
         (`getOwnProfile()`/`isVisible()`, each with their own internal
         background-refresh/`syncFetch` backfill) between being triggered and
         actually touching the DOM - a real relay can fire the `watch()` callback
         twice in quick succession (the initial local read, then a fresher value
         arriving moments later), and without a guard, BOTH overlapping calls
         eventually append their own full form on top of each other. Found live
         (two "Add field" buttons on one screen after editing a fresh profile) and
         fixed with `renderToken`, a monotonic counter mirroring `apps/user-list`'s
         own `unlistedToken` guard for the identical "only the LATEST of several
         overlapping async calls may touch the DOM" shape: an older, superseded
         `render()` call's result is discarded, never applied. Reproduced as a unit
         regression test too (two `saveProfile()` calls fired without awaiting the
         first - confirmed red without the fix, green with it).
      Full suite green at 873 tests (2 new regression tests). No other apps
      (`app-list`/`user-list`/`contact-list`, and the PWA/updater flow) showed any
      console or page errors across the same full real-relay session covering
      onboarding, profile editing, directory visibility, User List, and the full
      Forum interaction set.
- [x] **`apps/profile`: an honest "reload to apply" prompt for language/theme, and
      a live template/style preview** — user-reported: language/theme "doesn't
      seem to have any effect", and asked to also verify whether even a reload
      helps (it does - confirmed with a real relay: `setLocale()`'s own doc
      comment already says "takes effect on next page load, not live
      mid-session", `ensureTheme()` is idempotent per page load - both correctly
      apply on a genuine reload, this file's own claim of "instant effect on THIS
      device" was simply wrong, and nothing ever told the user a reload was
      even needed).
      **Settings save**: replaced the old auto-clearing "Saved!" flash (accurate
      about the DATA, misleading about there being any visible effect yet) with a
      persistent status message + an explicit "Reload now" button - stays until
      the user acts, doesn't silently disappear after 1.5s like `apps/profile`'s
      other save flashes correctly still do (those DO take effect immediately,
      since they're rendered by this same watch()-driven component).
      **Template/style live preview**: `#/~<myOwnPub>` always renders the
      EDITABLE form for its owner, never `renderPublicProfile()` - meaning an
      owner could never see their own template/style take effect at all, not
      even after reloading, without asking someone else to look. New shared
      helpers `applyTemplateStyle()`/`renderProfileHeader()` (extracted from
      `renderPublicProfile()`'s own rendering, now reused by it too - the preview
      can never drift from what a visitor actually sees) back a small preview box
      in the edit form that updates on every alias/avatar keystroke and
      template/style selection, no save required.
      Full suite green at 875 tests (4 new: reload-prompt persistence, the
      "Reload now" click genuinely reloading, the live preview reacting without
      saving, and confirming preview changes are never silently persisted).
      Verified end to end with a real relay: reload really does apply a saved
      language/theme change (confirmed directly, independent of this round's UI
      fix); the reload prompt stays visible for 2+ seconds without auto-clearing;
      clicking "Reload now" itself applies German text + the sunset accent; the
      live preview updates instantly on every field change and is confirmed
      NOT persisted until "Save" is actually clicked.
- [x] **`apps/forum`'s space id is now a real UUID, not the literal string
      `"forum"`** — user flagged: apps may have human-readable names/labels,
      but the underlying storage SPACE must be a UUID, or two independent
      apps/deployments that both happen to pick the same word collide.
      `manifest.quapp` gained a new `spaceId` field (`@qu/foundation`'s
      manifest schema, with format validation - must look like a UUID),
      generated ONCE and committed there (`4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1`)
      rather than generated per relay deployment - a per-deployment UUID would
      isolate the "same" app's data across independent relays instead of
      keeping it addressable the same way everywhere, defeating the actual
      point. `apps/forum/index.js`'s `register()` now reads `manifest.spaceId`
      (throws a clear error if a manifest ever omits it) instead of a
      hardcoded constant; `apps/forum/client.js` reads its own `spaceId` off
      its own entry in the apps catalog (`ctx.apps`) at mount time, same
      place every other catalog field already comes from - `name`/`label`
      stay purely human-friendly display metadata, never a storage key.
      `packages/relay/src/apps-catalog.js`'s `buildAppsCatalog()` now
      publishes `spaceId` in every catalog entry. `npm run build` clean,
      `packages/relay/test/relay.test.js`'s real-repo-`apps/`-directory boot
      test updated to assert against the real UUID (full suite count below,
      alongside this round's other change).
- [x] **A universal, Drupal-hooks-inspired extension-point mechanism** — user:
      app UIs should be "as reactive as possible", with content-level features
      (Likes, Bookmarks, Reply, Share, context menus) built as generic,
      reusable, cross-app contributions rather than forum-specific code, and
      explicitly wanted three extension kinds covered "universally": UI
      extension (content plugins that render themselves, e.g. a Like button),
      callback hooks (e.g. extending what happens on save, or notification
      dispatch), and context-menu extension for an app - plus, in a follow-up
      message, Engines/Services/Apps alike should be able to **define** an
      extension point (not just contribute to one), "at least in the
      manifest, maybe also by code".
      **`manifest.quapp` gained two new fields** (`@qu/foundation`'s manifest
      schema, both structurally validated, both optional/additive/non-breaking
      like every other nav/UI field): `contributes` (`{point, export, kind?,
      order?}[]`) says "my OWN `clientMain` module exports a named function
      that implements extension point X"; `definesExtensionPoints`
      (`{point, kind?, description?}[]`) is the new, purely descriptive
      counterpart - "extension point X exists, here's what it means" -
      available to ANY manifest `kind` (engine/service/app alike), since it's
      just documentation, never enforced (same convention as `pushActions`/
      `actions`).
      **The actual runtime mechanism**, `@qu/foundation/extension-points.js`'s
      new `ExtensionPointHost`: the key trick making cross-app UI plugins
      possible at all despite only ONE app's `clientMain` ever being mounted
      in-place at a time (see `actions.js`'s own doc comment on that
      constraint, which is exactly why `actions`/`actionsForSlot()` stayed
      pure link-DATA and never tried to cross it) - nothing stops a
      DIFFERENT, already-catalog-known, already-integrity/signature-pinned
      app's `clientMainUrl` from being dynamically `import()`-ed just to grab
      one of its OTHER named exports, without ever calling `mount()` on it or
      putting it in charge of the screen (exactly what a shell already does
      for the ACTIVE app). Three thin, purpose-shaped callers share that one
      mechanism, matching the three usage kinds: `renderSlot(point,
      container, payload)` (UI/content plugin - mounts real DOM),
      `run()`/`notify()` (callback hooks - delegates to an internal `HookBus`
      with EXACTLY that class's existing `run`/`notify` semantics, manifest
      contributors lazily registered onto it the first time a `point` is
      asked for), `collect(point, payload)` (context menu / data-returning
      extension - flattens every contributor's returned items). One
      contributor throwing never breaks another or the host app. Each
      contributor module is fetched/evaluated at most once (cached by URL) -
      important since a contributor like a per-message Like button could be
      invoked from many rows.
      **`listDefinedPoints(apps)`** (a pure function, same style as
      `actionsForSlot()`): the CODE-level counterpart to reading
      `definesExtensionPoints` as static JSON - discovers every declared
      point across a catalog, tagged with what defined it, without grepping
      source.
      **Server-side Engines/Services** don't need `ExtensionPointHost` at all
      for their OWN contributions - they're already all loaded together in
      one process (no "only one mounted at a time" boundary to cross), so the
      already-existing `Registry.hooks` (`HookBus`) stays the right "by code"
      mechanism there; they CAN still declare `definesExtensionPoints` in
      their manifest purely for discoverability, documented in `registry.js`'s
      own doc comment now.
      `apps/shell/client.js` builds one `ExtensionPointHost` per route
      dispatch (from the same `apps` catalog fetch already happening there)
      and hands it to the mounted app as `ctx.extensionPoints`.
      `Registry`'s old "DEFERRED: a `capabilities` field..." note is retired -
      `contributes`/`definesExtensionPoints` is that idea's real, actually-wired
      successor.
      No real production consumer wired in yet (forum's reactions/pins stay
      as they are this round) - this round is deliberately just the
      mechanism, proven correct with 15 new `@qu/foundation` unit tests
      (rendering, order, error isolation, module-cache reuse, hook
      registration exactly-once, a caller-supplied shared `HookBus`,
      `listDefinedPoints()`) plus a real end-to-end `apps/shell` test that
      mounts one fake app which calls `ctx.extensionPoints.renderSlot()`,
      backed by a SECOND fake catalog app's contributed export - a genuine
      dynamic `import()` across two independent, unrelated modules, not
      mocked. Full monorepo suite green at 894 tests (covering both this and
      the `spaceId` change above), `npm run build` clean.
- [x] **`ExtensionPointHost` corrected: no new pub/sub duplicating Qu Core's
      OWN event system** — immediately after the round above, user feedback:
      "save hooks" probably shouldn't be their own implementation at all,
      since Qu Core's `on()` listener system already covers that; UI
      extensions (Share/Bookmark-style) should hook into a slot the same way,
      realized similarly to Core's own listeners - explicitly: **no new
      functionality in Qu**.
      Investigated before changing anything: `@qu/core/events.js`'s `QuEvents`
      (`on(topic, handler, {order})`/`emit(topic, payload, ctx)`, ordered,
      fault-isolated, listener errors caught per-handler) is EXACTLY the
      primitive `ExtensionPointHost`'s removed `run()`/`notify()` had been
      re-implementing via a private `HookBus` - and `QuStore.
      onStorageChange()` (built on that same `QuEvents`, already what
      `@qu/reactive`'s `watch()`/`watchChildren()`, `@qu/sync`, and
      `@qu/relay` all subscribe through) is ALREADY the established, correct
      way to react to a save/write, filtered by path - no named "hook point"
      string or manifest `contributes` entry was ever needed for that case at
      all, a contributor just calls `qu.onStorageChange()` directly wherever
      its own code runs.
      **Removed**: `ExtensionPointHost.run()`/`.notify()` and its private
      `HookBus` entirely, and the `'hook'` case from `manifest.quapp`'s
      `contributes` field (a `contributes` entry now only makes sense for
      `'ui'`/`'menu'`, since only THOSE need cross-app dynamic-import - a
      storage listener doesn't need help finding code that isn't there, it
      registers itself wherever it already lives). `'hook'` stays a legal
      `definesExtensionPoints` value FOR DISCOVERY ONLY (e.g. ThreadEngine
      documenting "`thread.messagePosted` fires via `qu.onStorageChange()`
      under this path prefix") - deliberately with no `export`/`contributes`
      counterpart and no `ExtensionPointHost` method backing it.
      **Rebuilt**: `renderSlot()` now registers each loaded contributor's
      function directly onto a real `@qu/core` `QuEvents` instance (`
      ExtensionPointHost`'s new `events` getter, replacing the old `hooks`
      getter) and fires it via `QuEvents.emit()` - reusing Core's own
      ordering/fault-isolation rather than a bespoke re-implementation, "the
      realization modeled like Core's own listeners" taken literally.
      `collect()` (context menu) deliberately stayed a small custom loop -
      `QuEvents.emit()` is documented fire-and-forget fan-out that discards
      return values on purpose, and gathering menu items back is a genuinely
      different primitive that forcing onto `QuEvents` would only distort.
      `@qu/foundation` gained a real (not phantom) `@qu/core` dependency for
      this - the declared package DAG already listed `foundation → core` as
      legal (`docs/v3-technical-concept.md`'s own dependency audit had
      previously found and removed that exact dependency as UNUSED dead
      weight; this is that direction's first genuine caller).
      Test suite updated to match: the `run()`/`notify()`/shared-`HookBus`
      tests replaced with `events`-getter/local-`.on()`/shared-`QuEvents`
      equivalents, plus a new explicit regression test that calling
      `renderSlot()` twice for the same point never double-registers
      contributors. Full suite green (892 tests), `npm run build` clean.
- [x] **File/image/video/audio attachments — `apps/profile` (avatar) +
      `apps/forum` (test integration)** — user: wants real chunked local
      storage + chunked sync-out/sync-in WITH RETRIES, verified end to end
      (locally stored, synced to the relay, remotely readable), with the
      actual LOGIC living centrally in the Engine and apps only consuming
      Qu Components (an upload/sync-progress widget, and image/video/audio/
      file display widgets).
      **What already existed, confirmed by research before writing anything**:
      `@qu/engines`' `AssetEngine` (chunking, per-chunk SHA-256 hashing,
      unencrypted-chunk dedup/resume, `getAsset()` reassembly+hash
      verification+`syncFetch` backfill) was fully built and tested but had
      ZERO real callers anywhere in V3 - `apps/forum`'s own doc comment used
      to say so explicitly. `@qu/services`' `crypto-envelope.js` doc comment
      had ALREADY anticipated `AssetService` "kept as-is" from QuV2, never
      ported. Blob storage turned out to be NOT a separate mechanism at all -
      the exact same `QuStore.put()`/`QuBit`/seal pipeline, just routed to a
      second `/blob` mount (separate `FsAdapter` root on the relay, separate
      IndexedDB database in the browser) - meaning `@qu/sync`'s existing
      outbox+reconnect-replay pipeline ALREADY carries blob chunks out
      transparently, with zero blob-specific code anywhere in `sync-engine.js`.
      The one genuine gap: no per-write retry/backoff of any kind existed for
      EITHER direction - sync-out relied purely on "resend everything
      unacked on next reconnect", sync-in's backfill was a single attempt.
      **`AssetEngine` gained two things, per the user's explicit "logic stays
      in the Engine" instruction**: `verifySyncOut(storePath, syncFetch,
      {decrypt?, putOptions?, maxRetries=3, retryDelayMs=1000,
      onSyncProgress?})` - asks the relay (via `syncFetch`) whether it
      actually has the meta doc + every chunk, and RE-`put()`s only what's
      missing (re-derived from the local copy), with exponential backoff -
      deliberately a genuine `put()`, never `putSealed()`, since a
      `putSealed()` re-announce is tagged `origin: 'sync'`, which
      `@qu/sync`'s own local-write listener explicitly ignores (confirmed by
      reading `sync-engine.js` directly, not assumed) - only a real local
      `put()` re-enters the outbox pipeline at all. `getAsset()` gained
      optional `{maxRetries, retryDelayMs}` (default `maxRetries: 1` =
      unchanged original single-attempt behavior) retrying the whole
      backfill-then-refetch cycle for the "relay hasn't caught up yet" race.
      Deliberately NOT part of `put()`'s own returned Promise - matches this
      codebase's own established convention (QuV2's Chat precedent, and
      `apps/forum`'s own composer below): an upload counts as "done" the
      moment it's saved LOCALLY, sync confirmation is a separate, trackable
      phase.
      **New `AssetService`** (`@qu/services`) - the thin Entity-API facade
      QuV2 had and V3 lacked, `upload()`/`download()`/`verifySyncOut()`,
      resolving reader-list encryption exactly like `MessageService.
      postMessage()` already does for message bodies (same `resolveReaderXKeys()`/
      `decryptEnvelope()` from `crypto-envelope.js`) - never re-implementing
      any chunking/retry logic itself, only key resolution + delegation.
      New `paths.assetPath()` (the `aclPath()` `kind` union already listed
      `'assets'` - this closes that anticipated-but-unbuilt gap).
      **Two new `@qu/ui` Custom Elements** (`asset-components.js`):
      `<qu-asset-upload space-id="...">` - file picker, two-phase progress
      (local save, then sync verification), fires `qu-asset-uploaded`/
      `qu-asset-synced` events; `<qu-asset space-id="..." asset-id="..."
      kind="auto|image|video|audio|file">` - downloads once (an uploaded
      asset's bytes never change), renders `<img>`/`<video controls>`/
      `<audio controls>`/a download link by MIME type, with a shared,
      ref-counted object-URL cache (revoked once the last referencing
      element disconnects) so a `<qu-list>`-driven re-render never
      redundantly re-downloads. A REAL bug caught by the forum integration
      (not the isolated unit tests, which mount fresh elements with no
      caller-set class): `<qu-asset>`'s `_mount()` did `this.className =
      'qu-asset'`, silently OVERWRITING any class a caller had already set
      (e.g. `apps/forum` marking one as `qu-forum-message-attachment`) -
      fixed to `classList.add()`, with a new regression test.
      `apps/shell`: `AssetEngine` is now constructed inside
      `createClientServices()` (not `createDefaultQu()` - avoids a second,
      redundant registration with no way to hand its instance to
      `AssetService` otherwise), wired as `services.assets`.
      **`apps/profile`**: the `avatar` field gains a third shape,
      `asset:<assetId>` (stored under the identity's OWN pub as a personal
      asset `spaceId`), alongside the existing URL/emoji ones - uploaded via
      `<qu-asset-upload>` next to the existing text field, rendered via a
      NEW local `renderAvatarOrAsset()` (deliberately NOT touching `@qu/ui`'s
      shared `renderAvatar()` - documented scope cut: `user-list`/
      `contact-list`/`forum` still only render OTHER actors' avatars via the
      plain URL/emoji path this round).
      **`apps/forum`** (the designated test integration): composer gets an
      attach button; picking a file uploads immediately (not deferred to
      Send, unlike QuV2's own Chat) so real upload/sync progress is visible
      before commit; `attachment: {assetId, name, mime, size}` rides on
      `postMessage()`'s existing `extra` param, no new Service field needed;
      messages render their attachment via `<qu-asset>`.
      **Verified live, with a real relay + two independent browser peers**
      (Playwright): peer A uploads a forum attachment - confirmed rendered
      locally as `<img>`, confirmed the relay's OWN `QU_BLOB_DIR` physically
      has the chunk file on disk (not just "the test passed", the actual
      bytes), confirmed peer B (a separate identity/session) downloads +
      decrypts + renders the SAME attachment via sync; peer A uploads a
      profile avatar - confirmed in the live preview, confirmed peer B sees
      it on peer A's public profile view. Retry/backoff itself is unit-
      tested (7 dedicated `AssetEngine` tests: verify-success, missing-piece
      re-send exactly once, give-up-after-maxRetries reporting, sync-in
      retry, unchanged default behavior) rather than live-network-simulated -
      reproducing a real dropped connection mid-sync in a live browser test
      is its own, separate undertaking.
      Full suite green (931 tests: +6 `AssetEngine` retry/verify, +8 new
      `AssetService`, +1 `paths.assetPath()`, +16 new `@qu/ui`
      asset-components, +2 new `apps/shell` services wiring, +3
      `apps/profile` avatar-asset, +3 `apps/forum` attachment), `npm run
      build` clean.

## Development

```sh
npm install
npm test   # node --test (recursive auto-discovery of packages/*/test/*.test.js)
```

## Running Quniverse (Relay + Docker)

**What "Quniverse" means today**: the `@qu/relay` server (`QuRelay`) plus whatever
apps it loads — the three client apps built on `<qu-list>` (`apps/app-list`/
`user-list`/`contact-list`), `apps/profile` (editable own profile, directory
visibility, `#/~<pub>`), and `apps/forum` (a real public message board - post,
react, pin, edit, all live), all reachable through **`apps/shell`**, the real
browser entry point served at `/` (see the status entry above for the full
account: onboarding, live sync, nav, per-route mounting). Opening a
browser tab and actually clicking around a live Quniverse UI is real and testable
today, not a deferred gap anymore.

- **Testable today**: everything above, end to end — the relay's whole HTTP surface
  (`/healthz`, `/apps.json`, `/config.json`, `/store/apps/catalog/*`, `/admin/*`,
  static app/shell serving), every package's own test suite (`npm test`), each of the
  three client apps' `mount()` functions in isolation (jsdom, real `@qu/services`
  instances, not mocks), `apps/shell` itself in isolation (jsdom, same rigor), AND a
  real multi-browser session against a real relay (see the status entry above's
  Playwright-verified account, including live cross-client sync between two real
  identities).
- **Still deliberately not built** (see the status entry above for the full list):
  PWA/offline support, QR-code identity import, `apps/profile` (so `#/~<pub>` shows a
  graceful placeholder rather than a real profile page), a Space switcher,
  `apps/relay-admin`.

### Build

```sh
npm install
npm run build   # bundles every app with a clientMain (esbuild) into apps/<name>/dist/client.js
```

`npm run build` is required before the relay can actually serve a working app bundle —
`dist/` is gitignored build output, and `@qu/relay`'s static file serving
(`packages/relay/src/static-apps.js`) just serves whatever bytes are on disk, it
doesn't bundle anything itself.

### Config

Three layers, each overriding the one before (`packages/relay/src/server.js`):

1. `QuRelay`'s own defaults.
2. `relay.config.json` in the working directory, if present — copy
   `relay.config.example.json` to get started.
3. Environment variables (`QU_*`, see below) — the layer a container orchestrator
   (docker-compose, Kubernetes, …) actually sets, so a deployment never needs to bake
   or bind-mount a config file just to change a port or data directory.

| Env var | Maps to | Notes |
|---|---|---|
| `QU_PORT` | `port` | default `8080` |
| `QU_STORE_DIR` | `storeDir` | default `./relay-data/store` |
| `QU_BLOB_DIR` | `blobDir` | default `./relay-data/blob` |
| `QU_APPS_DIR` | `appsDir` | default `./apps` |
| `QU_SERVE_SHELL` | `serveShell` | default `true` — serves `apps/shell` at `/`, `/index.html`, `/shell-bundle.js`; `"0"`/`"false"`/`"no"` disables it |
| `QU_SHELL_DIR` | `shellDir` | default `./apps/shell` |
| `QU_IDENTITY_MNEMONIC` | `identityMnemonic` | pins the relay's own signing identity across restarts; omit to generate-and-persist one on first boot |
| `QU_ADMIN_PUBS` | `adminPubs` | comma-separated base64url actor pubkeys allowed to use `/admin/*` (settings, data import/export) |
| `QU_VAPID_PUBLIC_KEY` / `QU_VAPID_PRIVATE_KEY` / `QU_VAPID_SUBJECT` | `vapidPublicKey`/`vapidPrivateKey`/`vapidSubject` | Web Push (`@qu/push`); omit the keys to generate-and-persist a pair on first boot |
| `QU_REMOTE_APPS_JSON` | `remoteApps` | JSON array, same shape as `relay.config.json`'s `remoteApps` field |
| `QU_LOG_LEVEL` | *(not a `QuRelayOptions` field)* | `debug`/`info`(default)/`warn`/`error` — controls every `@qu/log` logger process-wide (see `packages/log`), read directly by `@qu/log` itself rather than through the config-layering table above |

**Getting your own actor pubkey**, to put in `QU_ADMIN_PUBS` (there's no `apps/relay-admin`
UI in V3 yet either — this is the Node equivalent for now):

```sh
node -e "
import('@qu/core').then(async ({ QuStore, MemoryStoreAdapter, QuCrypto }) => {
  const { QuIdentityEngine } = await import('@qu/identity');
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  const mnemonic = identity.generateMnemonic();
  await identity.importMnemonic(mnemonic);
  const { publicKey } = await identity.getMainKey();
  console.log('mnemonic (save this - it is the only way back to this identity):', mnemonic);
  console.log('pubkey (base64url, safe to share/put in QU_ADMIN_PUBS):', QuCrypto.toBase64Url(publicKey));
});
"
```

**Generated keys appear once in the logs.** If you don't pin `QU_IDENTITY_MNEMONIC`
and/or `QU_VAPID_PUBLIC_KEY`/`QU_VAPID_PRIVATE_KEY`, the relay generates fresh ones on
first boot and persists them under `QU_STORE_DIR` — that's enough for a single,
persistent deployment, nothing further to do. But on that exact first boot, `relay.js`
also logs them once, already formatted as ready-to-paste `QU_*="..."` lines (via
`@qu/log`, at `warn` level so they show even at the default log level) — pin them from
there into your environment if you want an explicit backup, or if you're running
multiple relay replicas without a shared volume (each would otherwise generate its own,
independent identity). A restart that just reuses an already-persisted or explicitly
pinned identity/keys stays silent — this only ever fires on the boot that actually
generated something. Treat your log stream accordingly until you've either pinned these
or decided the volume-only persistence is enough — a mnemonic is as sensitive as any
other seed phrase.

### Start — plain Node

```sh
npm run relay          # node packages/relay/src/server.js, uses relay.config.json + QU_* env if present
```

### Start — Docker

```sh
docker compose up --build
```

Uses the repo's `Dockerfile` (multi-stage: builds + `npm run build`s in a `builder`
stage, ships only production deps + built output in the `runtime` stage) and
`docker-compose.yml`. Config is env-var only in the container (see the table above) —
`docker-compose.yml` sets `QU_STORE_DIR`/`QU_BLOB_DIR` under `/data`, backed by a named
volume (`quniverse-data`), so identity/store/blob/VAPID keys all survive a
`docker compose down && docker compose up`. Set `QU_ADMIN_PUBS` there to your own
pubkey from above to unlock `/admin/*`. To iterate on apps without rebuilding the
image, uncomment the `./apps:/app/apps` bind mount in `docker-compose.yml` — but
`npm run build` still needs to have run on the *host* first, the container doesn't
build bundles itself.

### Verify it's alive

```sh
curl http://localhost:8080/healthz      # {"status":"ok","peerId":"relay-..."}
curl http://localhost:8080/config.json  # relayPub, adminPubs, relay-wide settings
curl http://localhost:8080/apps.json    # every loaded app with a clientMain
```

Or just open `http://localhost:8080/` in a browser — that's `apps/shell` itself now, not
a stub.
