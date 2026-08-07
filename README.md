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
- [ ] `@qu/foundation` — Registry, HookBus, manifest/actions
- [ ] Storage adapters (`FsAdapter`, `IndexedDBAdapter`) implementing
      `getChildren()`
- [ ] `@qu/engines` — Document/Collection/Thread/Access/Asset engines
- [ ] `@qu/services` — `ListService` and friends
- [ ] `@qu/sync` — outbox, reconnect catch-up, ACL-on-sync fix
- [ ] Runtime bootstrap, Relay, Apps

## Development

```sh
npm install
npm test   # node --test packages/*/test
```
