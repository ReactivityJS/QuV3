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

Building something on top of Quniverse? Start here instead:

3. [`docs/building-an-app.md`](./docs/building-an-app.md) — a practical,
   self-contained guide to writing a new app: the `manifest.quapp`/`index.js`/
   `client.js` shape, the `mount()` context contract, subpages, appearing in
   the nav automatically, hooking into extension points (defining your own
   and contributing to someone else's - the real `apps/forum`/`apps/bookmarks`
   pair, worked through end to end) and into notifications (`pushActions`),
   plus the full Services catalog every app gets handed.
4. [`docs/api-reference.md`](./docs/api-reference.md) — the complete API
   reference: every `@qu/core`/`@qu/services`/`@qu/ui`/`@qu/foundation`/
   `@qu/reactive`/`@qu/i18n` export, including theming, styling, and the
   template system `apps/profile` uses as its own worked example.

(The detailed per-round build log has moved to the bottom of this file, under
[Status](#status) - skip it unless you want the "why" behind a specific
piece; it's not needed to build an app.)

**Experimental, separate from the above:** [`docs/v5-space-core-guide.md`](./docs/v5-space-core-guide.md)
documents a from-scratch, Yjs-native PoC (`packages/space-core`/
`space-storage`/`space-transport`) exploring a CRDT-based replacement for
QuStore/QuBit's sync model - a different data model and API, evaluated
alongside V3/V4, not (yet) replacing it. Includes a real WebSocket relay
you can run standalone or via Docker.

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
- [x] **Blob-chunk ACL gap closed in `AccessEngine`** — user asked for the
      next robustness step; found by directly reading `access-engine.js`'s
      own path regexes while implementing attachments above:
      `resolveResource()` only ever matched `/store/...` paths (`DOC_RE`/
      `COLLECTION_RE`/`ASSET_RE`/`THREAD_RE`) - a blob chunk
      (`/blob/<space>/<id>/chunk_N`) never matched ANY of them, so every
      chunk write (local AND via `@qu/sync`'s incoming-write check, both
      call the exact same `assertWriteAuthorized()`) sailed through
      completely UNGATED - unlike every other entity kind, which is at
      least protected once someone bothers to create an ACL doc.
      **First pass** (this round's own initial fix, then sharpened by user
      feedback before landing): a new `BLOB_RE` maps a chunk path back to
      the SAME `{spaceId, kind: 'assets', resourceId}` its `toBlobPath()`
      (asset-engine.js) conversion came FROM, so it resolves to the same
      optional `/store/<space>/acl/assets/<id>` ACL doc every other kind
      already uses - parity, zero new ACL machinery.
      **User's sharper catch**: an optional ACL doc gives ZERO real
      protection today, because nothing in `AssetService`/`AssetEngine`
      ever CREATES one - "open unless an ACL doc exists" would in practice
      mean chunks stay open forever. Asked for a real check: does the
      chunk's writer actually match the signer already established for
      that asset (its meta document's own `pub`)?
      **Landed design**: once an asset's meta document exists (i.e. it has
      an established owner - the signer of that first, still-unrestricted
      write, same "first writer establishes it" bootstrap the ACL-doc case
      already documents), only that SAME signer may write its chunks - an
      ownership self-consistency check against the sibling meta doc,
      re-derived fresh every time, no new ACL doc or auto-created
      restriction needed. Before the meta doc exists yet (chunks are
      written CONCURRENTLY with, before, their own meta write - see
      `AssetEngine#handlePut()`), there's no owner to check against, so
      the very first upload still bootstraps normally. An explicit ACL doc,
      if one is ever created, still takes precedence over this fallback
      (checked first, unchanged from the original fix) - the meta-signer
      check only fires in its absence. Every OTHER kind (docs/collections/
      threads) is deliberately UNCHANGED - still fully open with no ACL doc,
      exactly as designed; this is a blob-chunk-specific fallback, not a
      general default-openness change.
      Verified: 5 new unit tests (`access-engine.test.js` - bootstrap-open,
      owner-mismatch rejected, unsigned rejected once an owner exists,
      explicit ACL doc still takes precedence, every other kind unaffected)
      + 1 real cross-Engine integration test (`asset-engine.test.js` -
      `AssetEngine` + `AccessEngine` registered together: a hostile second
      uploader signed as a DIFFERENT identity cannot hijack an
      already-uploaded asset id, the original upload is left untouched, the
      real owner can still legitimately re-upload/retry). `SyncEngine`
      needed ZERO changes - its existing `assertWriteAuthorized()` call
      site (confirmed by reading `sync-engine.js` directly) is already
      path-unfiltered, so the fix closes both the local AND the sync-bypass
      gap uniformly for free. Re-ran the exact same live relay + Playwright
      scenario from the round above (forum attachment upload) as a sanity
      check post-fix - confirmed a legitimate single-uploader chunk write
      still reaches the relay's `QU_BLOB_DIR` correctly with `AccessEngine`
      now actually enforcing something there. Full suite green (937 tests),
      `npm run build` clean.
- [x] **`apps/bookmarks` — a genuine second `contributes` consumer, proving
      the extension-point mechanism against real production code, not a
      synthetic test fixture** — the other half of the two-part robustness
      round above (user: "Ja, beides nacheinander umsetzen" - do both, one
      after the other). `content.messageActions` is a new
      `definesExtensionPoints` entry on `apps/forum/manifest.quapp`
      (`{point, kind:'ui', description}`); `apps/forum/client.js`'s
      `renderMessage()` now calls `extensionPoints.renderSlot('content.
      messageActions', slotEl, {services, messageId, spaceId, threadId,
      body, author})` per message, into a `.qu-forum-message-extensions`
      span - `services` is passed straight through so a contributor never
      needs to construct its own Service instances. `apps/bookmarks` is the
      first (and, deliberately, only) app declaring a `contributes: [{point:
      'content.messageActions', export: 'renderBookmarkToggle', kind: 'ui',
      order: 10}]` entry - forum has never imported bookmarks, nor vice
      versa; the only coupling is the shared point name and payload shape.
      New `BookmarksService` (`@qu/services`) is a thin `FlagService` wrapper
      exactly like `FavoritesService`'s own established template
      (`FLAG_TYPE='bookmark'`, `ENTITY_KIND='forumMessage'`), storing a small
      self-contained snapshot (`body`, `author`, `spaceId`, `threadId`)
      alongside the flag - forum messages have no permalink/re-fetch-by-id
      mechanism yet (a known, separate scope cut), so "My Bookmarks" renders
      entirely from the stored snapshot, no re-fetch needed.
      `renderBookmarkToggle()` builds a small inline `{hasPrivate,
      setPrivate}` adapter around `services.bookmarks` and hands it to the
      existing `renderFlagToggle()` (`@qu/ui`) - the same
      duck-typed-adapter pattern `apps/app-list`'s own favorites toggle
      already established, letting a narrower wrapper Service plug into a
      shared widget without `renderFlagToggle()` itself needing to know
      about `BookmarksService`. `apps/bookmarks`'s own `mount()` renders "My
      Bookmarks": `watchChildren()` over the caller's private-flag parent
      path, newest-first by `starredAt`, each row showing the stored
      snapshot with an author link and a ✕ remove button - kept
      deliberately simple (no pagination, no re-fetch), matching this
      codebase's "minimal first, no speculative depth" convention.
      Wired into `apps/shell/src/services.js`'s `createClientServices()`
      unconditionally, same as every other Service.
      Real (not synthetic) cross-app test technique: `apps/forum/test/
      client.test.js` builds a `clientMainUrl` via `new URL('../../
      bookmarks/client.js', import.meta.url).href` - a real `file://`
      reference to the actual production `apps/bookmarks/client.js` - and
      hands it to a real `ExtensionPointHost`, so `renderSlot()` dynamically
      imports and runs genuine production code end to end, not a test
      double. Three new tests cover: the real bookmark toggle renders and
      round-trips per message (click → 📑, persisted, matches the stored
      snapshot's `body`/`spaceId`/`threadId`); the slot stays empty with no
      crash when no `extensionPoints`/contributing app is configured; and
      privacy - a second identity viewing the SAME message via a mirrored
      thread sees its own, independent, unbookmarked toggle state, proving
      `FlagService`'s per-identity isolation holds through the extension
      point too. Plus 4 `bookmarks-service.test.js` unit tests, 8
      `apps/bookmarks/test/client.test.js` tests (mount rendering/removal/
      live-add/sort/teardown, toggle behavior), and 1 new `apps/shell/test/
      services.test.js` wiring test. `packages/relay/test/relay.test.js`'s
      real-repo-apps-directory boot test updated to expect `bookmarks`
      alongside the other client-bearing manifests in `/apps.json`.
      Full suite green (953 tests), `npm run build` bundles `apps/bookmarks`
      automatically (generic `apps/*` + `manifest.quapp` discovery, no
      script change needed). Live Playwright verification against a real
      relay with two independent browser identities: peer A posts a forum
      message, peer B sees it live; the real `apps/bookmarks` toggle button
      is dynamically imported and rendered for both; A bookmarks the
      message (🔖 → 📑) while B's own toggle stays 🔖 (privacy confirmed
      live, not just in unit tests); A's "My Bookmarks" page shows the
      snapshot; removing it there resets A's forum toggle back to 🔖 live.
- [x] **Three live user-reported bugs fixed** — all three found and
      confirmed via real Playwright repros against a real relay before
      touching any code, not from reading alone (root causes turned out to
      be genuinely different from the first plausible guess in every case):
      1. **PWA update flow reloaded the page unprompted, right after a
         totally normal theme-change reload** — user: changing the theme
         and reloading showed `"[sw ...] installed, waiting for
         SKIP_WAITING"` and the page hung. Root cause: `Clients.claim()`
         (`sw.js`'s own `activate` handler) fires a `controllerchange`
         event even the very FIRST time a page goes from "no controller" to
         "controlled" - `apps/shell/src/pwa.js`'s `registerServiceWorker()`
         treated ANY `controllerchange` as a genuine update and called
         `window.location.reload()` unconditionally. Confirmed live via a
         repro with no user interaction at all: onboarding alone triggered
         one unprompted extra navigation shortly after the first service
         worker activated. If that landed while the page was ALREADY
         reloading for an unrelated reason (the theme "Reload now" click),
         the boot sequence could restart before finishing, surfacing as a
         hang. Fixed by snapshotting `navigator.serviceWorker.controller`
         at the START of `registerServiceWorker()`, before `.register()`
         even runs, and only reloading on `controllerchange` if a
         controller already existed then - mirrors the exact same
         first-install-vs-genuine-update check `onUpdateAvailable`'s own
         `statechange` handler already used. Verified: the exact same
         zero-interaction repro now shows 0 unexpected navigations (was 1);
         2 new/updated unit tests in `pwa.test.js`.
      2. **A file upload's own "Syncing..." status got stuck at 100%
         forever** — user: local upload worked and synced correctly (a
         second peer saw it fine), but the UPLOADER's own composer widget
         stayed on `"Syncing · matrix.avif (314.0 KB) · 100%"` until a
         manual reload. TWO independent bugs, both found via a live repro
         with console instrumentation, not guessing: (a) **CSS
         specificity**: `.qu-asset-upload-progress { display: flex; ...}`
         (an author-stylesheet class rule) silently beat the browser's own
         `[hidden] { display: none }` UA rule at equal specificity, so
         `status.hidden = true` was being set correctly (confirmed via
         `getComputedStyle` in a real browser: `hiddenAttr: true, display:
         'flex'`) but had ZERO visual effect - the SAME anti-pattern was
         found (via a codebase-wide sweep once the first instance was
         confirmed) and fixed in FIVE total places: `qu-asset-upload`'s own
         progress row, `apps/shell`'s PWA update/install bar, `apps/forum`'s
         pending-attachment row, and `apps/user-list`'s/`apps/contact-list`'s
         live search-filter rows (search was silently never actually hiding
         non-matching rows either - same bug, different symptom, caught
         opportunistically). Fixed with a `.classname[hidden] { display:
         none; }` override per class (higher specificity, wins regardless
         of source order). (b) **A real logic bug in `AssetEngine
         .verifySyncOut()`**, found while instrumenting: `syncFetch(path)
         .then(() => true)` ignored the RESOLVED VALUE entirely - a
         legitimate `null` (`SyncEngine.fetch()`'s own documented "the peer
         confirms it does NOT have this yet" result, not an error) was
         counted as "found", so the very first verification pass could
         falsely report `synced: true` before the relay genuinely had
         anything. Fixed by checking `v != null` instead of "did it
         resolve at all". Verified live: the SAME repro now shows an honest
         `"Syncing 0%"` first, then correctly resolves and hides once
         actually synced (previously: instant false "100%", stuck
         forever). 1 new engine-level regression test (a `syncFetch` that
         resolves `null`, never throws) + jsdom can't reliably model CSS
         cascade resolution so the CSS fix's real regression evidence is
         the live repro itself, not a unit test.
      3. **An unlisted user found via exact FP/pub search showed no
         avatar** — user: the SAME uploaded avatar was visible on the
         user's own profile page. Root cause: a KNOWN, EXPLICITLY documented
         scope cut from the attachments round (`apps/profile/client.js`'s
         own top doc comment even named it: "user-list/contact-list/forum
         still only ever call `@qu/ui`'s plain `renderAvatar()` for OTHER
         actors' avatars... falls back to the initials badge everywhere
         else this round"). `renderAvatar()` only ever understood an emoji,
         an `https://` URL, or unset - it has no idea an uploaded avatar's
         `avatar` field can also hold `asset:<assetId>` (`<qu-asset-upload>`
         via `@qu/services`' `AssetService`); only `apps/profile`'s own
         PRIVATE `renderAvatarOrAsset()` helper understood that third shape.
         Fixed by promoting it into `@qu/ui/avatar.js` as a shared,
         exported `renderAvatarOrAsset()` (plus the `ASSET_AVATAR_PREFIX`
         constant it needs, also now shared rather than duplicated) and
         wiring it into all three other call sites (`user-list`'s main
         listing AND its unlisted-search row, `contact-list`, `forum`'s
         message-author avatars) - `apps/profile/client.js` now imports the
         SAME shared function instead of keeping its own copy. Each of the
         three apps sets `.assetService = services.assets` once on its own
         mount `container`, the same "set on an ancestor before descendant
         Custom Elements connect" discipline `.qu` already requires
         throughout `@qu/ui`. Verified: 5 new unit tests (`avatar.test.js`)
         + 1 new integration test (`user-list/test/client.test.js`, a real
         `AssetEngine`-backed unlisted actor) + a live two-peer Playwright
         repro (peer A uploads a real avatar via Profile Settings without
         ever joining the directory, peer B finds them by exact pub search)
         confirming the unlisted row now renders a genuine `<qu-asset>`
         with a real `<img src="blob:...">`, matching the profile page.
      All three: full suite green (960 tests), `npm run build` clean, and
      each verified with its own dedicated live Playwright repro against a
      real relay - not just unit tests - both to confirm the bug existed
      before touching code and to confirm the fix afterward.
- [x] **Notifications, finished** — user asked for a review of the
      Notifications/Push implementation (granular per-app, apps hooking in
      their own notification actions) and Sharing (to/from Quniverse), plus
      floated an "app skeleton" idea; review found `@qu/push`/
      `NotificationPrefsService`/`PushSubscriptionService`/
      `PushDeliveryService` already solidly built and wired into `relay.js`'s
      boot (fires on every thread message write), but with THREE real gaps:
      no client ever called `PushManager.subscribe()`, no UI ever read the
      in-app notifications Thread `PushDeliveryService` already writes, and
      `pushActions` (already a manifest field, already published in the apps
      catalog) never actually drove `resolveNotification`'s wording/routing -
      every notification used the generic fallback regardless. Sharing turned
      out to be completely unimplemented (no `navigator.share()`, no
      `share_target`, no extension-point contribution - though the original
      extension-point README entry named "Share" as a planned example
      alongside Bookmarks). User picked "finish Notifications" as the next
      concrete round; Sharing and an app-skeleton reference stay open follow-
      ups.
      **`packages/services/src/paths.js`**: new `notificationsSpaceId(actorPub)`/
      `NOTIFICATIONS_SPACE_PREFIX`/`NOTIFICATIONS_THREAD_ID` - `@qu/relay`'s
      `push-delivery.js` used to hand-type the `"notifications-" + actorPub`
      convention in two separate places; now both server AND the new client
      app share one definition.
      **`packages/relay/src/push-delivery.js`**: new exported
      `createManifestNotificationResolver(loader)` - the "real per-app
      routing table" the class's own doc comment had described only
      hypothetically since before any app existed to drive it. Matches an
      incoming message's `spaceId` against every loaded app's own
      `manifest.spaceId`, then picks the `pushActions` entry whose `type`
      matches (`'mention'`/`'create'`) - `apps/forum`'s own `{id: 'mention',
      label: 'Mentions', type: 'mention'}` is exactly the shape this reads.
      Returns a title built from the app's OWN declared wording (`"Mentions
      — Forum"` instead of the generic `"Mentioned in 4eb04aa2-..."` - a
      real, user-visible improvement: forum's spaceId is a UUID, so the
      generic fallback's `url: '#/${spaceId}'` was ALSO flat-out broken,
      pointing at a hash the shell's router could never resolve - the new
      resolver uses the app's real, routable `name` instead) or `null` to
      fall through to the existing generic wording when no app/pushAction
      matches. `relay.js` now passes this as the DEFAULT `resolveNotification`
      (an explicit `options.resolveNotification` still overrides it) - zero
      changes needed to `PushDeliveryService` itself, exactly the point of
      the hook already being a plain function parameter.
      **`apps/shell/src/services.js`**: wired `NotificationPrefsService`/
      `PushSubscriptionService` into `createClientServices()` - the same
      "hook built, no client caller yet" gap this file's own doc comment
      already names for `syncFetch`/`getGeneration` before this session,
      just for these two Services instead.
      **`apps/profile/client.js`** (Settings subpage, next to language/theme):
      a real `PushManager.subscribe()` flow (`subscribeToPush()`) - requests
      Notification permission, waits for the ALREADY-registered service
      worker (`navigator.serviceWorker.ready` - no new registration needed,
      `apps/shell`'s own `registerServiceWorker()` already did that at boot),
      fetches this relay's VAPID public key from `/push/vapid-public-key`,
      subscribes, and stores the result via `services.pushSubscriptions`.
      Plus the granular prefs UI itself: global enabled/@mentions checkboxes,
      and a per-app checkbox for every installed app that declares at least
      one `pushActions` entry (fetched from `/apps.json`, filtered) - exactly
      the "granular... diverse apps" shape asked for, visibly wired to real
      per-app manifest data, not a hardcoded list.
      **`apps/notifications`** (new app, 🔔, navOrder 12): a live feed over
      the viewer's own notifications Thread, `watchChildren()`-reactive, each
      item clickable straight to its real in-app route. Uses `MessageService`'s
      existing generic per-thread `markRead()`/`getLastReadAt()` read-marker
      (built earlier, never had a caller) for an unread highlight - "opened
      the feed" is this round's whole definition of "seen it", a per-item
      dismiss is real, straightforward follow-up work, not this round's ask.
      Deliberately NOT built this round: an unread-count badge on the
      shell's own nav entry (the data already supports it - `apps/shell/src/nav.js`
      itself would need to grow that, a separate nav-level concern this app
      doesn't own) and per-item dismiss/delete (`QuStore` itself has no
      `delete()`, matching every other Thread in this codebase).
      **Two real races found and fixed while building this, both the same
      class of bug `apps/profile/client.js`/`apps/user-list/client.js` had
      already independently discovered and fixed for THEIR OWN re-render
      logic earlier this session**: (1) `apps/notifications/client.js`'s
      `render()` had no monotonic-token guard against `watchChildren()`
      firing twice in quick succession - confirmed via a genuinely flaky
      test (an item correctly marked read by a NEWER render could still show
      the "unread" highlight, because an OLDER, now-stale render finished
      LAST and won the DOM). Fixed with the same `renderToken` pattern
      `apps/profile/client.js` already established. (2) Two of my OWN new
      tests used `waitFor(async () => ...)` - `@qu/ui/testing.js`'s
      `waitFor()` never awaits its predicate (`while (!check())`), so an
      async predicate is always truthy on the FIRST call regardless of what
      it resolves to; both tests looked like they were waiting for an
      async write to land but weren't. Fixed with real poll loops instead.
      Verified: full suite green (980 tests, stable across repeated runs -
      confirmed the two races above were genuinely gone, not just
      coincidentally passing once), `npm run build` bundles `apps/notifications`
      automatically. Live two-peer Playwright verification against a real
      relay: peer A mentions peer B in the forum; B's Notifications feed
      shows it live with the REAL manifest-driven title ("Mentions — Forum",
      not the generic fallback) and a working click-through URL (`#/forum`,
      not a broken UUID hash); B disables Forum notifications in Profile
      Settings; a second mention from A produces NO new notification
      (per-app opt-out confirmed suppressing delivery, live, not just via
      `NotificationPrefsService.shouldNotify()`'s own unit tests); B's real
      `PushManager.subscribe()` flow was exercised in a real Chromium
      (correctly rejected in an incognito-style context - "Push API does
      not support incognito mode", a genuine Chrome limitation - and,
      separately, timed out reaching an actual push service from a
      persistent context, since this sandbox has no outbound route to one)
      - the code path itself is proven correct up to exactly the boundary
      `@qu/push`'s own doc comment already honestly documents ("has NOT
      been verified end-to-end against a real push service").
- [x] Docs: `docs/building-an-app.md` + `docs/api-reference.md` - the
      "work correctly from a fresh repo checkout, not from AI chat context"
      pass. Every previous round's README entry above is a *build log*
      (chronological, "why", written for someone who already knows the
      codebase); neither of these two new files is - both are written
      assuming nothing from prior context, and every code excerpt in either
      is either quoted verbatim from real, current source (spot-checked
      against it after writing, not just at draft time) or explicitly
      labeled "simplified from the real X."
      **`docs/building-an-app.md`**: the two-file `manifest.quapp`/`index.js`/
      `client.js` shape; the full manifest field reference (including
      `spaceId` - why it's a hardcoded UUID generated once, never derived
      from `name`, with `apps/forum`'s own original `'forum'`-as-spaceId
      near-miss as the concrete reason); the `mount(container, ctx)` contract
      field by field (`qu`/`identity`/`services`/`apps`/`segments`/`subscribe`/
      `syncFetch`/`extensionPoints`); subpages via `segments[1..]`; why nothing
      needs registering for nav appearance; both extension-point mechanisms
      (`actions`/`actionsForSlot` for pure-data link slots vs.
      `contributes`/`definesExtensionPoints`/`ExtensionPointHost` for live
      code) walked through end to end on the real `apps/forum`
      (defines `content.messageActions`) / `apps/bookmarks` (contributes to
      it) pair, quoted directly from current source rather than reconstructed
      pseudocode; notification hooks (`pushActions`, the manifest-driven
      resolver, `MessageService.notify()`); building; and testing, including
      the two real bugs this session found and fixed in its OWN test code
      (`waitFor()` never awaiting an async predicate; the overlapping-render
      race needing a monotonic `renderToken` guard) written up as documented
      gotchas so the next app author doesn't re-discover them the hard way.
      **`docs/api-reference.md`**: the complete method-by-method surface of
      `@qu/core`/`@qu/identity`/`@qu/reactive`/`@qu/foundation`/`@qu/services`
      (every Service class, all of `paths`)/`@qu/ui`/`@qu/i18n`, plus three
      sections the two-file guide only points at: **Theming** (`ensureTheme()`/
      `THEME_PRESETS`/`getStoredTheme()`/`setStoredTheme()`, and why the CSS
      fallback value is always QuV2's own original literal - an app that
      never calls `ensureTheme()` renders identically to before, the system
      is a convenience, never a requirement); **Styling** (the `STYLE_ID`
      + `injectStyle()` convention every app follows, and why the
      `qu-<app>-` class prefix *is* the isolation mechanism in a codebase
      with no CSS scoping); and **Templating** - `apps/profile`'s own
      `template`/`style`/`applyTemplateStyle()` pattern (a fixed set of CSS
      classes for layout + reusing `THEME_PRESETS` scoped to one element via
      inline `style.setProperty()`, not a second palette system) written up
      as a named, reusable convention with a "wiring it into your own app"
      variant, not just described in place.
      **README** restructured alongside these: the entire chronological
      [Status](#status) log (this section) moved from right after the intro
      to the very bottom of the file, and replaced up top with two new
      "start here instead" links directly to the two new docs - so a reader
      building an app never has to scroll past ~1600 lines of build history
      to find the one page that's actually about building an app.
      Verified: full suite still green (983 tests) after the restructure;
      every quoted code excerpt in both new docs re-checked line-by-line
      against its real source file after writing, not just recalled from
      memory - one drift caught and fixed this way (`apps/bookmarks/client.js`'s
      real `renderBookmarkToggle()` uses a `snapshot` local + `t(...)`-sourced
      button titles; the first draft had simplified both away).
- [x] Forum: Channels/Boards (esoTalk-styled, QuV2's own shape), restricted
      boards with real encryption + a growable invite list, @mention
      autocomplete, a shared emoji-picker/composer-toolbar widget
      (`packages/thread-ui`, new package), and two confirmed duplicate-
      content bug fixes - user-reported ("manchmal duplizieren... Inhalte
      oder Boards - auch bereits bei QuV2!"), root-caused via source
      reading, both fixed and regression-tested BEFORE any new feature work
      started.
      **Bug 1a - duplicate MESSAGES**: `apps/forum/client.js`'s
      `renderMessages()`/`renderPinned()`/per-message reaction+pin `render()`
      had no `renderToken`/generation guard (unlike `apps/notifications/
      client.js`/`apps/profile/client.js`, which already established this
      pattern) - two `watchChildren()` fires in quick succession (a local
      write's own notify, then a live relay echo) could race, and an OLDER,
      slower render finishing AFTER a newer one cleared the newer render's
      correct output and appended stale/duplicate content on top. Fixed
      with the same monotonic-token guard on every async render function in
      the file; a new regression test artificially delays a `listMessages()`
      call to prove the race is closed (confirmed it reproduces against the
      pre-fix code, not just a test that happens to pass).
      **Bug 1b - duplicate BOARDS (QuV2's own bug, confirmed in its source)**:
      QuV2's `newChannelForm()` had no double-submit guard AND minted a
      fresh random channel id on every submit - two submits before the
      first finished created two genuinely different, both-valid channel
      documents. The fix, now that V3 has boards at all: every create form
      (`Create channel`, `Create topic`) disables its own submit button for
      the duration of the create call, the same `sendBtn.disabled = true`
      convention already used for posting a message - a regression test
      double-clicks a real button in a real DOM and confirms exactly one
      channel results.
      **`packages/thread-ui`** (new package) - the answer to "Engine oder
      Service?!": neither. A client-only UI widget belongs in the same
      category as `@qu/ui`'s `renderFlagToggle()`/`renderAvatar()`, not the
      storage-pipeline layer. Exports `insertAtCursor()` (caret-aware
      textarea insertion - confirmed nothing like it existed anywhere in
      this repo before now), `EMOJI_QUICK`/`EMOJI_EXTENDED`/
      `renderEmojiPicker()` (8 quick picks + a "+"-expandable ~160-emoji
      curated grid, ported verbatim from QuV2's own `apps/chat/client.js` -
      plain Unicode codepoints render via whichever emoji font the OS
      already provides, so "matches Android" is satisfied by construction,
      no separate integration needed), and `mountMentionAutocomplete()`
      (`@`-triggered completion by alias OR pub from the 2nd typed
      character, over `DirectoryService`/`ContactsService`/`actor-format.js`
      - the wire format is unchanged, purely a compose-time insert helper).
      Built as small composable functions, not one opinionated mounted
      component, specifically so a future `apps/chat` port can reuse them
      without rework - the actual point of this round's own "Engine oder
      Service?!" question. Wired into Forum's composer (emoji-insert
      button + mention autocomplete) and its reaction row (existing 5-emoji
      quick row + a new "+" expand, which V3's reactions never had before).
      **Channels/Boards** (`@qu/services`' new `ChannelService`) - Channel
      → Topic → per-Topic-Thread, same shape QuV2 shipped, rebuilt on V3's
      already-hardened `ListService.createCurated()`/`addCurated()` instead
      of QuV2's unprotected `DocumentService`/`CollectionService` pair (the
      actual fix for Bug 1b's storage-layer half, on top of the UI-layer
      double-submit guard above). `apps/forum/client.js` gained real
      routing (`#/forum`, `#/forum/c/<channelId>`, `#/forum/t/<topicId>`),
      a board view (channel sidebar + merged recent-activity feed), and a
      channel view (topic list + "new topic" form). `apps/forum/index.js`'s
      `register()` now also wraps the ORIGINAL flat public thread in a real
      "General" channel/topic - same thread id, no data migration, existing
      messages from before this round stay exactly where a visitor now
      expects to find them.
      **Restricted boards** - real end-to-end encryption for an explicit
      member list, not a UI-level filter: a checkbox + comma-separated
      pubkey list at creation (always includes the creator even if they
      didn't type their own pub), a 🔒 badge everywhere a restricted
      channel/topic shows up, and (per explicit ask this round, beyond what
      QuV2 ever shipped) an "invite member" field on an already-restricted
      channel - `ChannelService.addChannelMember()` grows the channel's own
      ACL, then BOTH `writers` and `readers` on every existing topic's
      thread config in one write each (not `MessageService.addReader()`
      alone - that only grows `readers`, and a `THREAD_PRESETS.chat()`-
      shaped thread needs the SAME list grown for `writers` too, or a new
      member could read but never post). Same non-retroactive trade-off as
      every other growable-membership feature in this codebase: new
      members see topics going forward, nothing posted before they joined.
      **Two more real bugs found via this round's own live, multi-peer
      Playwright verification** (not hypothetical, not caught by any unit
      test beforehand):
      (1) a restricted topic's `createTopic()` originally used
      `THREAD_PRESETS.chat(memberPubs)` verbatim - correct for encryption/
      membership, but `chat()` only enables `'mentions'` formatting, not
      `'markdown'`, so `formattedHtml` came back `null` for every message,
      and `apps/forum/client.js`'s `p.innerHTML = message.formattedHtml`
      rendered as a genuinely EMPTY body (`[LegacyNullToEmptyString]` turns
      `innerHTML = null` into nothing at all, not even the word "null") -
      confirmed live: Ada could post into her own restricted board, but the
      message showed with no text at all. Fixed by building a topic config
      with `chat()`'s own encryption/membership shape but `forum()`'s own
      formatting, plus a defensive plain-text fallback in the renderer for
      any thread config that ever lacks markdown again.
      (2) A second peer's board view rendered genuinely empty - no crash,
      no error - for boards that existed before that peer's own session
      started. Root cause: `ChannelService` is the FIRST real client-side
      reader of a CURATED list anywhere in this codebase; `ListService.
      listCuratedRawPaths()` already backfills the LIST document itself on
      a miss, but `@qu/engines`' `CollectionEngine` (which resolves each
      `$list` entry to its actual value on read) only ever does a LOCAL
      `qu.get()` per referenced path, with no network access of its own, by
      design. Fixed by threading `syncFetch` into `ChannelService` and
      having it do its own per-item backfill-and-retry, instead of
      assuming `ListService`/`CollectionEngine` already covered it - also
      newly required registering `CollectionEngine` on the CLIENT `qu`
      itself (`apps/shell/src/services.js`), never needed there before
      since no prior Service read a curated list client-side.
      Verified: full suite green (1022 tests, stable across repeated runs),
      `npm run build` bundles `packages/thread-ui` into `apps/forum`
      cleanly. Live, real-relay, three-peer Playwright verification (17/17
      checks): Peer A creates an open AND a restricted board (Bob invited
      at creation), posts in both; Peer B sees the open board immediately
      and the restricted one only because he's a member, and can genuinely
      decrypt its content; Peer C (not invited) sees the restricted board
      LISTED (metadata isn't hidden, documented limitation) but never its
      plaintext; a real double-click on "Create channel" produces exactly
      one board; Peer A types `@` in the composer, a real dropdown appears
      and inserts a full pub on selection; the composer's emoji button and
      a reaction row's "+" both open the real extended emoji panel.
- [x] **Shell header redesign** - `apps/shell`'s old plain app-icon strip
      (`./src/nav.js`) is replaced by a fixed, always-visible top bar
      (`./src/header.js`): the Quniverse logo doubles as the Home button
      (`#`), Back/Forward buttons next to it (plain `history.back()`/
      `.forward()` - every route change already pushes a real History entry
      via `location.hash = ...`, nothing extra to track), a live
      unread-count Notification bell (`#/notifications` - the exact gap
      `apps/notifications/client.js`'s own doc comment had flagged as
      "a separate, nav-level concern this app doesn't own"), and the signed-in
      identity's own avatar+name as the shell's one main menu. The menu:
      favorited apps as quick links (live off the same `qu:flag-changed`
      event `apps/app-list`'s star toggle already broadcasts), a small
      divider, then Profile, User Settings, App List (browse/favorite/flag
      every app), and a Relay Admin link shown only when this identity's pub
      is in `/config.json`'s `adminPubs` (`apps/relay-admin` itself still
      isn't built - the link degrades to the same graceful "app not found"
      placeholder every other forward-declared route already gets).
      **Brand mark**: a real `logo.svg`/`favicon.svg` (the same purple-circle
      "Q" mark the PWA manifest always embedded as inline base64, now one
      external file `@qu/relay`'s `serveShell()` serves at both `/logo.svg`
      and `/favicon.svg`, referenced from `index.html`'s `<link rel="icon">`
      and from `manifest.webmanifest`'s own icon entry instead of duplicating
      the artwork inline).
      **User Settings extension point**: `apps/profile` now declares
      `userSettings.contributions` in its own manifest's
      `definesExtensionPoints` and renders it (via `ctx.extensionPoints`,
      newly threaded into this app's `mount()`) at the bottom of Settings
      (`#/~<pub>/settings`) - any app, or a future relay-level settings
      section, can hook its own per-user preferences in there without
      `apps/profile` ever importing it, the same `ExtensionPointHost`
      mechanism Forum's `content.messageActions` point already proved out,
      just profile as a HOST for the first time instead of a contributor.
      **A real bug found via live Playwright verification, not caught by any
      unit test beforehand**: `.qu-shell-menu[hidden]` and the plain
      `.qu-shell-menu { display: flex }` rule have EQUAL CSS specificity -
      the browser's own `[hidden] { display: none }` UA rule lost the
      cascade tie to this stylesheet's later rule, so a "closed" menu
      (`.hidden === true`) stayed visually on top of the page, intercepting
      clicks on whatever was underneath it (confirmed live: favoriting an
      app from the still-"closed" menu's own App List link, then trying to
      star a different app, hit the invisible-but-present menu instead).
      Fixed with an explicit `.qu-shell-menu[hidden] { display: none; }`
      override.
- [x] **`apps/chat`** - QuV2's messenger (`apps/chat/client.js`, 2600+ lines:
      room list, 1:1/group rooms, reactions, pins, replies, forwarding,
      attachments, voice messages, location sharing, search) ported onto
      V3's primitives, deliberately LEANER wherever V3 already gives a real,
      free substitute instead of re-implementing the same feature twice -
      see the app's own top doc comment for the full account. New in
      `@qu/services`: **`ChatService`** (`chat-service.js`) - ported near-
      unchanged from QuV2 (`ChatService.roomId()`'s deterministic,
      order-independent 1:1-room-id hash; `createGroup()`'s fixed-member-list
      group + per-member invite mailbox, delivered via `THREAD_PRESETS.mail`
      exactly the way relay-settings.js's own `channels` comment had already
      anticipated: "`THREAD_PRESETS.chat()`/`group()` already back a future
      Chat 'create group' flow with the exact same shape") plus one genuine
      V3 addition, `ensureRoom()` (wraps the room-id derivation + idempotent
      `MessageService.createThread()` in one call, so `apps/chat` never has
      to reach past its Service layer for a raw hash the way QuV2's own
      `client.js` did). **Reuse over re-implementation** - the actual
      difference V3's extension-point mechanism makes over a straight port:
      reactions/pins are NOT reimplemented here at all - `apps/chat`'s room
      view renders the exact SAME `content.messageReactions`/
      `content.messagePinToggle` points `apps/forum` already defines, and
      `apps/reactions`/`apps/pins` (unmodified, admin-toggleable) render
      straight into it, since `ExtensionPointHost.renderSlot()` is keyed
      purely by point NAME, not by which app's manifest declared it first;
      mention/emoji autocomplete and attachments reuse `@qu/thread-ui`/
      `<qu-asset-upload>`/`<qu-asset>` unchanged, the same primitives
      `apps/forum`'s own composer already uses. **User-specific settings**
      (per the migration's own ask): `apps/chat` contributes
      `renderChatSettings()` to `apps/profile`'s existing
      `userSettings.contributions` extension point (show-sender-name-in-1:1
      + own-message-color, self-encrypted via `@qu/services`'
      private-storage) - reachable at `#/~<pub>/settings`, the one place
      every app's per-user preferences already live, no chat-specific
      settings screen needed. **Relay Admin settings** (same ask): a new
      `settings.chat.allowMemberCreateGroup` policy in
      `packages/relay/src/relay-settings.js`, mirroring Channels' own
      `allowMemberCreate` exactly (no `allowMemberRestricted` counterpart -
      a chat room/group is ALWAYS reader-restricted, never a public option),
      plus a "Chat" section in `apps/relay-admin/client.js` right after
      "Channels". Read receipts moved from QuV2's three-state tick
      (sent/relay-confirmed/read) to a simpler two-state one (sent/read) -
      `PresenceService.publishReadReceipt()`/`.getReadReceipts()` (PUBLIC)
      already existed unmodified; nothing in `services` currently exposes a
      relay-confirmation hook (`SyncEngine.waitForAck()`) to a client, so
      the middle state is a documented, honest scope cut rather than a
      half-built one. **Not ported this round** (documented in the app's own
      top doc comment, not silently dropped): forwarding, voice messages
      (MediaRecorder), location sharing, per-chat/global search with
      link/file/image/date filters, visual `@mention` highlighting inside a
      bubble (the `mentions` field still drives push-notification routing,
      which is the part that actually matters functionally) - each a real,
      valid follow-up in its own right, not attempted half-way here.
      Verified: full suite green (1078 tests, `chat-service.test.js` +
      `apps/chat/test/client.test.js` new, `relay-settings.test.js`/
      `apps/relay-admin/test/client.test.js` extended for the new `chat`
      policy, `packages/relay/test/relay.test.js`'s real-apps-directory
      catalog test updated for the new app), `npm run build` bundles
      `apps/chat/client.js` cleanly, and a real `QuRelay` boot against the
      actual `apps/` directory confirms `chat` registers, loads, and
      publishes a correctly-shaped `/apps.json` catalog entry (`spaceId`,
      `clientMainUrl`, `pushActions`, the `contact-row` action, the
      `userSettings.contributions` contribution).
- [x] **Message chrome redesign + admin-configurable, cross-app extension
      ordering** - per explicit ask: Edit/Pin/Bookmark move out of a row of
      always-visible buttons into ONE "⋮" context menu
      (`@qu/thread-ui`'s new `renderContextMenu()`, same trigger/panel/
      outside-click-close shape as its own `renderEmojiPicker()`), and the
      per-message footer becomes ONE row (menu trigger + timestamp +
      Reactions' own live widget, plus a read-tick in `apps/chat`) instead
      of scattered action rows. Two new, generic extension points replace
      the old `content.messageActions`/`content.messagePinToggle`/
      `content.messageReactions`: **`content.messageFooter`** (`kind: 'ui'`,
      the row) and **`content.messageMenu`** (`kind: 'menu'`, `collect()`-
      based - Pin/Bookmark now resolve their current state FRESH each time
      the menu opens, no more always-on `watchChildren()` subscription for
      either). Both `apps/forum` and `apps/chat` render the identical two
      points with the identical native-item set (Edit/timestamp/menu
      natively, Reply/read-tick chat-only), proving the reuse: neither app
      imports the other, both just agree on point names/payload shapes.
      **New admin-configurable ordering** (the actual ask: "reactions on
      the left, the read-tick on the right, identical in Forum and Chat"):
      `@qu/foundation`'s new `rankFor()` (`extension-order.js`) ranks a
      point's items - both manifest-declared plugin contributors AND a
      host app's own native items (`core.<name>` ids) - against a NEW
      relay-settings field, `extensionOrder: {[point]: [id, ...]}`,
      admin-edited via two new `apps/relay-admin` sections ("Message row
      order"/"Message menu order") with ▲/▼ reordering (deliberately NOT
      drag-and-drop - no library, no custom HTML5 drag-event wiring, exactly
      as capable for these short lists). `ExtensionPointHost` gained an
      `extensionOrder` constructor option + a `.order` getter so a host app
      can rank its own native items the identical way; `apps/shell/client.js`
      fetches `settings.extensionOrder` from `/config.json` once (same
      "won't reflect a live admin edit without a reload" trade-off
      `adminPubs` itself already has) and threads it into every
      `ExtensionPointHost` it builds. An id absent from a point's
      configured order keeps its own manifest/hardcoded default position,
      appended after every explicitly-configured one - a freshly installed
      plugin never jumps ahead of an admin's explicit arrangement.
      `apps/reactions` repointed its existing contribution to
      `content.messageFooter` unchanged; `apps/pins`'/`apps/bookmarks`' own
      per-message toggles converted from live Custom Elements to
      `collect()`-style menu-item resolvers (`pinMenuItem()`/
      `bookmarkMenuItem()`) - `apps/pins`' `forum.topicToolbar` "Pinned bar"
      is untouched (still continuously on-screen, still a live Custom
      Element - only the per-message TOGGLE moved). Verified: full suite
      green (1101 tests - new `extension-order.test.js`, extended
      `extension-points.test.js`/`relay-settings.test.js`/
      `apps/relay-admin/test/client.test.js`/`packages/thread-ui`'s new
      `context-menu.test.js`, `apps/forum`'s and `apps/chat`'s own test
      suites reworked around the menu/footer instead of the old inline
      buttons), `npm run build` bundles cleanly.
- [x] **Chat composer redesign + voice messages + location sharing** - per
      explicit ask ("V2's composer was nicer/more structured, bring voice
      messages and location sharing back, using V3's own advantages"):
      `apps/chat`'s composer is now a rounded "pill" (textarea + emoji
      trigger) plus a tool cluster (attach/location) and ONE circular action
      button that MORPHS between 🎙️ (composer empty) and ➤ send (composer
      has text) - Telegram/WhatsApp's own composer language, replacing the
      old flat text-input-plus-row-of-buttons layout. Bubbles gained a
      subtle "tail" (asymmetric corners, sharp on the avatar side) and a
      faint shadow so they read as distinct surfaces; `apps/forum`'s own
      message card got the same shadow/radius touch-up.
      **Voice messages**: `MediaRecorder` (feature-detected, degrades to a
      hint on an unsupported browser/device) records a `Blob`, uploaded
      through the EXACT SAME `services.assets.upload()` +
      `message.extra.attachment` path a file attachment already used before
      this round - so `<qu-asset kind="auto">`'s existing MIME sniff just
      picks `audio` and renders a native `<audio controls>` player, zero new
      rendering code. **Location sharing**: one-time `navigator.geolocation`
      position, sent as `message.extra.location: {lat, lng}` - deliberately
      NO embedded map-tile preview image (fetching one on every view would
      leak a room's location to a third-party tile server beyond the relay/
      its members), just a link out to OpenStreetMap plus the raw
      coordinates as text. Both reuse `apps/chat`'s pre-existing encrypted-
      room/attachment machinery unchanged - no new Service, no new
      extension point, no new `@qu/services` code at all for either
      feature. Verified: full suite green (1104 tests - `MediaRecorder`/
      `navigator.geolocation` mocked in `apps/chat/test/client.test.js`,
      including the composer's mic/send morph itself), `npm run build`
      bundles cleanly.
- [x] **Popup opacity/positioning, fixed chat layout, message permalinks,
      live read receipts, DM message requests, forum unread indicator,
      image lightbox** - a round driven by direct usage feedback rather
      than a single feature request:
      **Opaque, viewport-aware popups**: `--qu-color-surface` (`@qu/ui`'s
      `theme.js`) was referenced with inconsistent, often-transparent
      per-callsite fallbacks (`canvas`, `#8882`, `transparent`) but never
      actually DEFINED anywhere - root cause of "reactions/context-menu
      overlay is too transparent". Now a real token (`#ffffff` light /
      `#242426` dark via a new `prefers-color-scheme: dark` block). A new
      shared `flipUpIfNeeded()` (`@qu/thread-ui`'s `popup-position.js`)
      measures real post-layout geometry to flip a panel from opening
      downward to upward when there isn't room below - wired into
      `renderEmojiPicker()`, `renderContextMenu()`, and
      `mountTriggerAutocomplete()` alike, so none of them can open off the
      bottom of the screen again.
      **Fixed chat header/composer**: `apps/chat`'s room view is now a flex
      COLUMN sized to the viewport (`calc(100vh/100dvh - shell header -
      screen padding)`) with the header/composer as `flex-shrink: 0`
      siblings around ONE scrollable `.qu-chat-messages-scroll` middle -
      simpler and more robust than `position: fixed/sticky` since only the
      shell's own top offset needs accounting for, not chat's own bars.
      **Message permalinks + scroll-follow** (`apps/chat` AND `apps/forum`):
      a message's timestamp is now its own link
      (`#/chat/<room>/m/<id>`/`#/forum/t/<topic>/m/<id>`); landing on one
      scrolls the target into view and briefly highlights it. Chat (an
      internal scroll container) tracks a `stuckToBottom` state - true by
      default, false when landing on an older permalink - so a live
      incoming message only auto-scrolls the view when the user was
      already at the bottom; Forum (a plain page scroll, oldest-to-newest
      like an ordinary thread) needs no such state machine, just
      `scroll-margin-top` to clear the shell's fixed header.
      `apps/search`'s `searchChat`/`searchForum` and
      `apps/notifications`' `resolveChatReference`/`resolveForumReference`
      now link straight to the specific message too, not just its room/topic.
      **Fixed a real bug**: chat's read-tick footer segment never updated
      live - `PresenceService.publishReadReceipt()` writes under a path
      (`threadReadReceiptsParentPath()`, new) that nothing watched, since it
      is a SIBLING of the messages parent path, not a child. Fixed with a
      dedicated watch + a surgical `refreshReadTicks()` that updates just
      the tick DOM in place, deliberately NOT a full `renderMessages()`
      rebuild (which would otherwise tear down whatever the user happened
      to have open - a context menu, an in-progress edit - the moment
      anyone's read position changed, an actual regression caught by a new
      test opening the menu and finding it destroyed a tick after opening).
      **New: chat "message requests"** - a first-ever 1:1 DM from a
      non-contact used to sync in perfectly but render nowhere (the room
      list only ever enumerated Contacts), reading as "chat doesn't sync
      with new people". `ChatService.ensureRoom()` now posts a `dm-invite`
      into the recipient's mailbox on GENUINE first creation only (reusing
      the same mechanism/thread `createGroup()`'s own invites already use),
      best-effort (a failure - e.g. the sender's profile/X-key not yet
      known to the recipient - never blocks the room itself from being
      created). `apps/chat`'s room list surfaces these as a "Message
      requests" section (sender's avatar/alias/pubkey, Accept adds the
      Contact and opens the room, Decline dismisses privately) - never a
      silent, un-consentable room appearing in the main list.
      **Forum's own unread indicator**: NOT a port of chat's read tick (a
      PUBLIC, one-fixed-peer signal that makes no sense for a Topic with
      any number of readers) - a PRIVATE "have I seen this since my last
      visit" badge/left-accent-bar per post, driven by the SAME
      `MessageService.markRead()`/`getLastReadAt()` the room list's own
      unread dot already uses, the familiar forum-software idiom instead.
      **Image lightbox/zoom**: confirmed both `apps/forum` and `apps/chat`
      already render every attachment through the ONE centralized
      `@qu/ui` `<qu-asset>`/`<qu-asset-upload>` Custom Elements (nothing to
      migrate) - added fullscreen + click-to-zoom directly there
      (`openImageLightbox()`), so both apps get it from one central change,
      exactly the "later, central image-viewer upgrade" this was meant to
      set up for. Also fixed an unrelated, pre-existing latent bug found
      along the way: `asset-components.js`'s `cacheKey()` concatenated
      `spaceId`/`assetId` with a literal NUL byte instead of a printable
      separator (a previous session's encoding mishap, invisible in a
      terminal - `file` reported the whole module as binary).
      Verified: full suite green (1164 tests - new
      `packages/thread-ui/test/popup-position.test.js`, extended
      `emoji.test.js`/`context-menu.test.js`/`theme.test.js`, extended
      `apps/chat/test/client.test.js` (permalinks, live read-tick, message
      requests) and `apps/forum/test/client.test.js` (permalinks, unread
      badge), extended `packages/services/test/chat-service.test.js`
      (dm-invite/listMyDmRequests), extended
      `packages/ui/test/asset-components.test.js` (lightbox open/zoom/
      close)), `npm run build` bundles cleanly.
- [x] **Real-world usage fixes: chat layout, popup clamping, composer
      squeeze, mobile catch-up, push notifications, restricted-channel
      invite resilience** - a round driven by actual usage of the previous
      one, not a feature request:
      **Chat's fixed layout rewritten as genuine `position: fixed`**, not a
      `calc(100vh - ...)` height reverse-engineering the shell's own
      padding - that calc was fragile by construction and confirmed to
      overflow the real viewport by a hair, producing a DOUBLE scrollbar
      (inner AND outer page) with the composer and newest message(s) pushed
      below the visible area. Fixed positioning (top/bottom insets, no
      calc()) is immune to that class of drift entirely. Also: sending any
      message (text/voice/location) now always scrolls to the bottom
      (`stuckToBottom = true`) even if the user had scrolled away, and the
      "stuck to bottom" auto-scroll uses `scrollTo({behavior:'smooth'})`
      instead of an instant jump.
      **Popup positioning, round 2**: `flipUpIfNeeded()` (`@qu/thread-ui`)
      now ALSO clamps horizontally (`translateX`, works regardless of a
      panel's own `left:0`/`right:0` CSS anchor) - the context menu's own
      `right: 0` anchor was overflowing off the LEFT edge for a trigger near
      a narrow/mobile viewport's left side, unaddressed by the earlier
      vertical-only flip. Also now reads `window.visualViewport` instead of
      `innerWidth`/`innerHeight` when available - a mobile on-screen
      keyboard shrinks the VISIBLE viewport without changing `innerHeight`,
      which could make the composer's own emoji picker (opened right when a
      keyboard is very likely showing) conclude "there's room below" while
      the keyboard was actually covering that space.
      **`<qu-asset-upload>`'s in-progress status now floats ABOVE itself**
      (`position: absolute; bottom: 100%`) instead of sitting inline in the
      same flex row as a composer's text input - its own min-content width
      (filename + percentage + an 8rem bar) could easily be wider than the
      room left over, squeezing the input down to a barely-visible sliver,
      confirmed live. The FINISHED-attachment preview row (`apps/chat`'s/
      `apps/forum`'s own `pendingAttachmentEl`) moved from below the input
      row to above it too, for the same "context for what's about to be
      sent belongs above, not as a footnote after" reasoning. Attachment
      images/videos are now also capped to a message-appropriate
      `max-height` (20rem) in the shared `<qu-asset>` renderer - the
      lightbox (already built last round) is what full-size viewing is for.
      **Search's type filter now works standalone**: an image/video filter
      with no text at all used to show nothing (`apps/search/client.js`
      required a non-empty query before calling any contributor at all,
      and `searchChat()`/`searchForum()` required a body-text match before
      even checking the type - an image message's body is never
      descriptive text a query could match). Both now treat "at least one
      of query/types is set" as enough to search, and a type filter alone
      returns every locally-available match of that type.
      **Mobile foreground catch-up**: backgrounding a mobile browser/PWA
      does NOT reliably close the underlying WebSocket (the OS may keep it
      alive, or a flaky network may let it go silently stale) - a real
      transport reconnect event, the thing that normally triggers a
      catch-up fetch, may simply never fire even though real time passed
      while suspended, confirmed live (a chat room left mounted through a
      phone screen lock never picked up messages sent while locked, only
      leaving and re-entering the room did). `SyncEngine` gained a new
      public `refreshSubscriptions()` - the exact same "bump generation,
      resubscribe, reciprocal catch-up" cycle a real reconnect already runs
      internally, callable on demand without touching the transport.
      `apps/shell/client.js` calls it on every `document.visibilitychange`
      -> visible, closing the gap for every mounted app's active
      subscriptions at once, no per-app code needed.
      **Push notifications**: the actual root cause of "push doesn't work
      at all, even for a mention" - `apps/shell/sw.js` had NO `push`/
      `notificationclick` handlers at all (a real, previously-documented
      gap; the client-side subscribe flow in `apps/profile/client.js`'s
      Settings subpage already existed and worked, so a user could
      correctly believe they'd "enabled notifications" while the service
      worker silently dropped every push event it received). Added both
      handlers: `push` shows the notification from the relay's own
      generic `{title, body, url}` payload, `notificationclick` focuses an
      already-open tab on this origin (navigating it to the notification's
      target) rather than always spawning a new one.
      **Restricted-channel invite resilience**: traced a reported
      `AccessEngine: writer not authorized to write to threads "..."`
      rejection to `ChannelService.addChannelMember()`'s own topic-growth
      loop - a plain sequential `for` loop meant ONE topic's membership
      growth failing silently aborted growing every topic AFTER it in the
      channel, with the failure never surfaced anywhere (the UI's own
      `await addChannelMember(...)` call had no `catch` at all - a genuine
      unhandled rejection). Now `Promise.allSettled()`s every topic (one
      failure no longer blocks the rest) and throws a descriptive error
      listing how many topics still need a retry; `apps/forum/client.js`'s
      invite form catches and displays it instead of failing silently.
      Verified: full suite green (1175 tests - extended
      `apps/chat/test/client.test.js` (send-always-scrolls-to-bottom),
      extended `packages/thread-ui/test/popup-position.test.js`
      (horizontal clamp, visualViewport), extended
      `packages/sync/test/sync-engine.test.js` (`refreshSubscriptions()`),
      extended `apps/chat/test/client.test.js`/`apps/forum/test/client.test.js`
      (type-only search), extended `packages/services/test/channel-service.test.js`
      and `apps/forum/test/client.test.js` (partial invite failure)),
      `npm run build` bundles cleanly. NOT built this round (scoped as
      explicit follow-ups): link preview cards for URLs (needs a
      metadata-fetch mechanism, almost certainly server/relay-proxied to
      avoid leaking a viewer's IP to arbitrary third-party sites on every
      message render - a genuinely new feature, not a fix); no automated
      test coverage for `apps/shell/sw.js`'s new `push`/`notificationclick`
      handlers (this repo has no service-worker test harness at all yet -
      same pre-existing gap the file's own doc comment already
      acknowledged for its other event handlers).
- [x] **Chat scroll-follow redesign: no more jump-then-back, a real "new
      message" banner, permalink-to-top, anchor release on return to
      bottom** - root-caused the reported "scrolling jumps down and then
      back to the previous post": `renderMessages()` always cleared and
      fully rebuilt `messagesRoot` on every single new message, which
      collapses `messagesScroll`'s own `scrollHeight` to ~0 for one frame -
      the BROWSER itself force-clamps `scrollTop` down to fit that
      momentarily-empty content, and that clamp does NOT reverse itself
      once the content regrows a moment later. Two changes close this
      together: **(1) incremental append** - the common case (a plain new
      message, nothing else changed, detected by comparing an `{id,
      editedAt}` snapshot of the previous render against the new one) now
      only appends the new message(s) to the EXISTING `<ul>`, never
      touching or rebuilding anything already on screen, so nothing above
      it can ever collapse or get re-clamped in the first place; **(2)** the
      remaining, rarer full-rebuild cases (first mount, an edit, a
      deletion, a fresh permalink target) snapshot `stuckToBottom` and
      `scrollTop` BEFORE touching the DOM and explicitly restore them
      afterward when the view must not move - never trusting the LIVE
      `stuckToBottom` flag (the collapse's own spurious `scroll` event
      could have just corrupted it) or the browser's own post-collapse
      resting position.
      **Per explicit ask**: a new message while NOT at the bottom no longer
      scrolls (or jumps) AT ALL - a small sticky "↓ New message" banner
      (`newMessageBanner`, `position: sticky` so it stays pinned near the
      bottom of the visible scroll area with zero JS position math)
      appears instead, click-to-catch-up. A permalinked message now scrolls
      to the TOP of the view (`scrollIntoView({block: 'start'})`, not
      `'center'`) so it's unambiguous which message a link pointed to.
      Scrolling back down to the bottom yourself - either manually or via
      the new banner - strips a lingering `/m/<id>` back out of the URL
      (`history.replaceState`, no `hashchange`/remount) so a later reload
      of the same tab lands on the latest message again, not back on the
      old permalinked one.
      Verified: full suite green (1180 tests - 6 new
      `apps/chat/test/client.test.js` cases covering incremental append
      (both the "not at bottom, banner appears, existing DOM node
      untouched" and "at bottom, scrolls smoothly, existing DOM node
      untouched" paths), the banner's click-to-catch-up, permalink
      block:'start', and anchor release on returning to the bottom - plus a
      new `simulateScroll()` test helper, since jsdom's own `scrollHeight`/
      `clientHeight` are fixed getter-only 0s that can't otherwise express
      "near the bottom" vs "far from it"), `npm run build` bundles cleanly.
- [x] **Chat scroll-to-bottom: true-bottom correction for late-loading
      attachments, persistent scroll-to-bottom button** - the prior round's
      banner still wasn't landing at the TRUE bottom whenever an image or
      video attachment was involved: `scrollToBottom()` reads
      `messagesScroll.scrollHeight` at call time, which understates the
      real total height while `<qu-asset>` is still asynchronously
      downloading/decoding the attachment - it resolves and inserts its
      actual `<img>`/`<video>` well after the row's own render already
      returned, growing the container's height a moment later with nothing
      re-correcting the scroll position. Fixed with a `ResizeObserver` on
      `messagesRoot` that re-corrects (instantly, not a second animated
      scroll) whenever content resizes while still stuck to the bottom -
      guarded off the moment the user has scrolled away again, so a
      slow-loading image two messages back can't yank them back down to
      "now" after they've already moved on; also guarded for hosts with no
      `ResizeObserver` at all (jsdom, this repo's test DOM - the position
      is already correct for text-only messages either way, this only ever
      mattered for the async-attachment case).
      **Per explicit ask**: the one-shot "new message" banner is now a
      persistent "↓ scroll to bottom" button (`scrollToBottomBtn`,
      `.qu-chat-scroll-bottom-btn`) shown whenever the user isn't at the
      bottom for ANY reason - manually scrolled up, or landed on an older
      permalinked message - not just reactively when a new message happens
      to arrive, matching how Telegram/WhatsApp/Slack already do this
      rather than a one-shot toast. A separate `hasUnseenMessage` flag only
      changes the button's label/styling (plain "↓" vs "↓ New message",
      the latter also getting a `.qu-chat-scroll-bottom-btn-unseen`
      accent-color modifier) - never its visibility, which is `stuckToBottom`
      alone. Clicking it (or scrolling down to the bottom manually) still
      releases a lingering permalink anchor from the URL, same as before.
      Verified: full suite green (1181 tests - 2 new
      `apps/chat/test/client.test.js` cases (button visible+unseen-styled
      on landing on a permalink; button visible-but-not-unseen-styled
      specifically from manual scroll-up alone, no new message needed) plus
      renamed selectors/assertions across the existing scroll-follow
      tests), `npm run build` bundles cleanly. The `ResizeObserver`
      correction path itself has no jsdom-based test (jsdom implements no
      `ResizeObserver` at all, same class of gap as `scrollIntoView`/
      `scrollTo` elsewhere in this file's own tests) - verify visually in a
      real browser with a slow-loading image attachment.
- [x] **Chat voice messages: real Start/Pause/Resume/Finish/Preview/Send
      flow, ported from QuV2** - V3's voice messages were tap-to-record/
      tap-to-stop-and-send-immediately, with no way to listen back or bail
      out before something already went out; QuV2
      (https://github.com/ReactivityJS/QuV2) had a real Start/Pause/Stop/
      preview-before-send flow and the user asked for it ported over
      unchanged. Rebuilt as an explicit state machine (`recorderState`:
      `'idle' -> 'recording' <-> 'paused' -> 'preview' -> 'idle'`, with a
      discard escape hatch from `'recording'`/`'paused'` straight back to
      `'idle'`, bypassing preview entirely) driving a new `voiceRecorderEl`
      panel that REPLACES the normal composer row (not layered over it)
      while active - a live elapsed-time readout (frozen, not ticking,
      while paused - tracked as accumulated-ms-from-prior-spans plus
      time-since-current-span-started, not naively `Date.now() - startedAt`)
      and Pause/Resume + Finish + Discard buttons during
      recording/paused; Finish stops the `MediaRecorder` into `'preview'`
      instead of sending - a real `<audio controls>` player over the
      recorded `Blob` appears, with Send (uploads + posts the message, the
      exact same `services.assets.upload()` + `message.extra.attachment`
      path as before) and Discard as the only two ways out. Discarding
      mid-recording needed a `discardingOnStop` flag to tell the shared
      `MediaRecorder.onstop` handler "throw this take away" apart from a
      normal finish-into-preview stop, since `MediaRecorder` only exposes
      the one event either way. Teardown now also stops any still-open
      `getUserMedia()` stream and revokes the preview's object URL if the
      room view unmounts mid-recording/preview, closing a media-stream/
      URL leak the old tap-to-stop flow didn't have room for.
      Verified: full suite green (1183 tests - replaced the single old
      immediate-send voice message test in
      `apps/chat/test/client.test.js` with three covering the full
      start/pause/resume/finish/preview/send path, mid-recording discard,
      and preview-stage discard; extended the file's own `FakeMediaRecorder`
      test double with `pause()`/`resume()`), `npm run build` bundles
      cleanly. NOT built this round (still scoped as explicit follow-ups,
      unchanged from this app's own top doc comment "SCOPE" section): a
      waveform scrubber (the native `<audio controls>` element's own
      scrubber already covers playback position, both live and once sent)
      and a press-and-hold-to-record/slide-to-cancel gesture.
- [x] **Link preview cards (title/description/image) for URLs in chat/forum
      messages** - new `@qu/relay` module `link-preview.js`: server-side
      Open Graph unfurling (`og:title`/`og:description`/`og:image`,
      falling back to `<title>`/plain `<meta name="description">`),
      exposed at `GET /link-preview?url=...` (`http-router.js`). Relay-side,
      not a direct client fetch of the target site, for the two reasons
      that rule that out: it would leak the VIEWER's own IP to every site
      anyone ever pasted a link to, and it would hit CORS on most sites
      that don't send permissive headers.
      **SSRF was the actual hard part**: `url` is caller-supplied (a viewer
      typed it into their own message), so fetching it server-side without
      validation would let anyone probe this relay's OWN internal network
      through it as an open proxy (a cloud metadata endpoint, `localhost`,
      a private subnet's admin panels, ...). `assertSafeUrl()` rejects
      non-http(s) schemes, embedded credentials, non-default ports, and -
      the part a naive hostname-string check would miss - resolves the
      hostname and rejects any IP in a private/loopback/link-local/
      reserved range (checked against ALL resolved addresses, not just the
      first, closing a DNS-rebinding-style multi-answer gap), re-validated
      on every redirect hop with `redirect: 'manual'` so a public hostname
      redirecting to a private address is still caught. Response reads are
      capped at 512KB (a page's `<head>` never needs more) and a 5s
      timeout. Results (and failures, at a shorter TTL) are cached
      in-memory so the SAME url is fetched from the target site at most
      once per TTL window, not once per viewer per render.
      New `<qu-link-preview url="...">` custom element (`@qu/ui`'s new
      `link-preview-components.js`, same `_mount()`/mount-token/
      `injectStyle()` skeleton `<qu-asset>` already established) fetches
      `/link-preview` (same-origin, no base-URL config needed - same
      precedent as `apps/profile/client.js`'s own `/push/vapid-public-key`
      call) with its own client-side cache layer on top of the relay's,
      and renders NOTHING (never an empty card) when there's nothing
      preview-worthy - a dead link, the feature disabled, or a page with
      no title/description/image. Wired into both `apps/chat`'s and
      `apps/forum`'s message rendering: only the FIRST link in a message
      gets a card (Telegram/Slack precedent - a multi-link message
      otherwise turns into a wall of cards). An admin kill switch
      (`settings.linkPreviews.enabled`, default on) is exposed in
      `apps/relay-admin` - deliberately NOT an allowlist/blocklist editor,
      since the actual SSRF defense is a hard-coded safety floor, never
      something an admin should be able to loosen through that UI.
      **Incidental fix while touching `apps/forum/client.js`'s message
      render path**: `renderMessages()` fired `MessageService.markRead()`
      without awaiting it - a caller (or a test) that unmounted the view
      right after seeing an unread badge render had no guarantee the read
      marker had actually landed yet. Found because it made one of this
      round's own new tests flaky; now awaited (still swallowing its own
      errors exactly as before), closing a real, if narrow, race for any
      caller relying on "this view saw it, so it's marked read by now".
      Verified: full suite green (1228 tests - new
      `packages/relay/test/link-preview.test.js` (27 cases: OG/title/
      description parsing, HTML entity decoding, attribute-order
      tolerance, the "nothing preview-worthy -> null" rule, every SSRF
      guard listed above individually, redirect-chain following +
      re-validation + the cap, content-type/status rejection, the body-size
      cap, and both the positive and negative cache paths), extended
      `packages/relay/test/http-router.test.js` (`/link-preview` route:
      success shape, disabled-via-settings 404, missing-param 400) and
      `packages/relay/test/relay-settings.test.js`, new
      `packages/ui/test/link-preview-components.test.js` (8 cases: render,
      hidden-on-nothing-worthy, hidden-on-fetch-failure, hidden-on-non-ok,
      no-image variant, cross-element caching, no-url-attribute, and
      attribute-change remount), extended `apps/chat/test/client.test.js`/
      `apps/forum/test/client.test.js` (card presence + "only the first
      link" + "no link, no card") and `apps/relay-admin/test/client.test.js`
      (pre-population, save payload, the new section's own toggle-and-save
      round trip), `npm run build` bundles cleanly.
- [x] **Forum topic view: ported onto Chat's fixed "room" layout (base
      unification, minus voice)** - explicit ask: "the base for Forum and
      Chat really is identical - Forum just doesn't need voice messages,
      but should get the same scrolling/message/composer improvements".
      `mountTopicView()`'s topic thread was a plain page-scroll view (its
      own OLD doc comment: "no internal scroll container the way
      apps/chat's own room view has one"); it's now the exact same fixed
      viewport-below-the-shell-header layout `apps/chat/client.js`'s
      `mountRoomView()` already uses, complete with the SAME
      `isSimpleAppend()`-driven incremental append (no more DOM-clear-
      induced scroll jump), the SAME persistent `scrollToBottomBtn` +
      `hasUnseenMessage`/`stuckToBottom` state machine, and the SAME
      `ResizeObserver` true-bottom correction for late-loading image/video
      attachments. The persistent mini-channel sidebar (this app's own
      "the channel list never disappears" idiom) is a FLEX SIBLING inside
      the SAME fixed box, not lost or covered - a new `.qu-forum-layout-room`
      modifier class (`qu-forum-layout-room`, added ALONGSIDE the base
      `.qu-forum-layout`, never replacing it) means board/channel views
      keep their older plain page-scroll layout completely unchanged; only
      a topic's actual thread is pinned, mirroring "only a chat ROOM, never
      the room list, is pinned" in `apps/chat/client.js`. Composer redesigned
      to match Chat's rounded-pill/tool-cluster/circular-action-button
      visual language, minus the mic and its morph behavior entirely -
      Forum's action button is simply always "send". Sending a post, same
      as Chat, always scrolls to the bottom even if the user had scrolled
      away. **Incidental find while testing**: none, this round's own
      earlier `markRead()`-await fix already closed the one real bug
      surfaced along the way.
      Verified: full suite green (1234 tests - rewrote
      `apps/forum/test/client.test.js`'s composer-button lookups (class-
      based, not `.textContent === 'Send'`, since the button is now a
      bare "➤" glyph with a `title`) and its "no back link" test (the
      topic view no longer goes through `renderSubpage()`), added 6 new
      tests mirroring `apps/chat/test/client.test.js`'s own scroll-follow
      coverage (permalink shows the button, scroll-to-bottom releases the
      URL anchor, incremental append while not/while at the bottom, click-
      to-catch-up, send-always-scrolls), `npm run build` bundles cleanly.
      Also manually verified live in a real headless-Chromium browser
      (relay + shell, not just jsdom) at both desktop and mobile viewport
      widths: fixed header/scroll/composer, the persistent scroll-to-bottom
      button appearing/disappearing correctly, the sidebar collapsing to a
      horizontal tab bar on narrow viewports, unread badges, and zero
      console errors.

