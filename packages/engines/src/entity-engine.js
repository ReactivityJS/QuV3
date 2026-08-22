/**
 * ENTITY ENGINE — the "entities" convention (Quniverse V4, see
 * docs/v4-concept.md §3.1/§3.3). Registers against the `entities` path
 * segment (see QuStore's Engine index in @qu/core/store.js), but self-guards
 * with `ENTITY_PATH_RE` before doing anything - the SAME pattern
 * `ThreadEngine`'s own `MESSAGE_PATH_RE` guard already uses, and for the
 * identical reason: QuStore's segment match is "this segment appears
 * ANYWHERE in the path," not "at the position this Engine actually cares
 * about." `AccessService.protect(spaceId, 'entities', id)` writes to
 * `acl/entities/<id>` (`aclPath()`'s own shape) - a path that ALSO contains
 * an "entities" segment, but is an ACL descriptor, not an Entity itself.
 * Without this guard, protecting any `kind: 'entities'` resource (e.g.
 * `ChannelService`'s own restricted-topic ACL) would incorrectly run THIS
 * Engine's `_type`-required check against the ACL document, and reject the
 * write outright (confirmed live: `ChannelService.createTopic()` for a
 * restricted channel threw here before this guard was added, the first real
 * caller to ever protect an `entities`-kind resource).
 *
 * Behaviour: every entity gets a stable `_id` and a `_created` timestamp on
 * first write, without overwriting either if the caller already supplied
 * them - exactly `DocumentEngine`'s stamping behaviour (see that file's own
 * doc comment), reused verbatim rather than re-invented.
 *
 * The one genuine difference from `DocumentEngine`, and the reason this is a
 * real pipeline Engine rather than a Service-layer convention: `_type` is
 * REQUIRED for an Entity (a Document has no such requirement - see
 * docs/v4-concept.md §1's "Engine vs. Service vs. Capability" decision
 * tree). A write with no `_type` and no already-stored `_type` to fall back
 * on is rejected - this is the trust-boundary job that must hold no matter
 * which caller reaches `qu.put()`, which is exactly what justifies an Engine
 * (not a Service) for it. An UPDATE that omits `_type` (the common case - a
 * caller patching only a few fields) is not rejected: the already-stored
 * `_type` is read back and re-attached, so `_type` can never silently
 * disappear from an entity once set.
 *
 * This Engine does NOT expose createEntity/getEntity-style convenience
 * methods - that's @qu/services' EntityService's job (the friendly API apps
 * actually call). This class only owns the pipeline behaviour.
 */
const ENTITY_PATH_RE = /^\/store\/([^/]+)\/entities\/([^/]+)$/;

export class EntityEngine {
  /** @param {import('@qu/core').QuStore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: 'entities',
      order: 5,
      put: async (ctx) => {
        if (!ENTITY_PATH_RE.test(ctx.path)) return; // e.g. acl/entities/<id> - an ACL descriptor, not an Entity itself, see class doc comment

        const val = { ...ctx.val };
        if (!val._id) val._id = globalThis.crypto.randomUUID();
        if (!val._created) val._created = Date.now();
        if (!val._type) {
          const existing = await this.qu.get(ctx.path);
          if (!existing?.val?._type) {
            throw new Error(`EntityEngine: entity write to "${ctx.path}" is missing required "_type"`);
          }
          val._type = existing.val._type;
        }
        return { value: val };
      },
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }
}
