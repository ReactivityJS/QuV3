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
- [ ] Apps (needs `@qu/loader` first)

## Development

```sh
npm install
npm test   # node --test (recursive auto-discovery of packages/*/test/*.test.js)
```
