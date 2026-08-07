/**
 * THREAD ENGINE — the one primitive Forum, Chat, Mail-Inbox and
 * Notifications are all built from. A "mail inbox" is just a Thread that
 * happens to have one reader; a "forum board" is a Thread with public
 * readers/writers; a "chat room" is a Thread scoped to a fixed member list.
 * They differ only in CONFIG (writers/readers/formatting) and UI, never in
 * mechanism.
 *
 * This Engine owns exactly ONE pipeline-level concern for message writes
 * (`/store/<space>/threads/<threadId>/msgs/<messageId>`): stamping `_id`/
 * `createdAt` if the caller didn't set them (same pattern as
 * `DocumentEngine`).
 *
 * Writer-ACL enforcement is deliberately NOT this Engine's job.
 * `@qu/engines`' `AccessEngine` (`order: 0`, runs before this Engine's
 * `order: 5` on every `put()`) already enforces a thread's writers
 * uniformly, via the SAME `acl/<kind>/<id>` sibling-document convention
 * every other entity kind uses (see access-engine.js). This is a
 * deliberate simplification versus the QuV2 prototype this is rebuilt
 * from, which kept a second, thread-specific writer check here as a
 * "redundant safety net" for migrating already-deployed data that
 * predated the uniform convention - that concern doesn't exist for a
 * fresh build, so there is exactly one place this check lives now (see
 * docs/v3-technical-concept.md, principle 5: "one primitive per problem").
 *
 * A thread only stays protected once its `acl/threads/<id>` document
 * exists - creating that document is `@qu/services`' `ThreadService`'s
 * responsibility as part of creating the thread, the same obligation
 * Document/Collection/Asset creation already has (no ACL doc = open by
 * default, everywhere in this system, not a Thread-specific gap).
 *
 * Composing content (formatting/mentions), resolving a `readers` list for
 * encryption, and reply-listing all live in `@qu/services`' `ThreadService`
 * instead - this Engine only concerns itself with the one thing that must
 * hold no matter who's calling `qu.put()`, not the friendly API around it.
 */
const MESSAGE_PATH_RE = /^\/store\/([^/]+)\/threads\/([^/]+)\/msgs\/([^/]+)$/;

export class ThreadEngine {
  /** @param {import('@qu/core').QuStore} qu */
  constructor(qu) {
    this.qu = qu;
    this._unregister = qu.registerEngine({
      segment: 'threads',
      order: 5,
      put: async (ctx) => {
        if (!MESSAGE_PATH_RE.test(ctx.path)) return; // not a message path (e.g. thread meta) - no stamping applies

        const val = { ...ctx.val };
        if (!val._id) val._id = globalThis.crypto.randomUUID();
        if (!val.createdAt) val.createdAt = Date.now();
        return { value: val };
      },
    });
  }

  /** Unregisters this Engine from the QuStore it was constructed with. */
  dispose() {
    this._unregister();
  }
}
