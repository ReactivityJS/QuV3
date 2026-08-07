/**
 * ENTITY PATHS — the one place that knows how entity identifiers map to Qu
 * storage paths. Every Service imports from here instead of building path
 * strings inline, so the on-disk layout can change in one place without
 * touching Service logic.
 *
 * Renamed from QuV2's "collection" vocabulary to "list" throughout,
 * matching `ListService` (docs/v3-technical-concept.md §4.2) - there is no
 * separate "collectionId" indirection here: a caller building a curated
 * list path gets the full path directly from `listPath()`, and a caller
 * wanting a derived list's parent (e.g. `threadMessagesParentPath()`) gets
 * exactly the path `ListService.listDerived()`/`QuStore.getChildren()`
 * expects - one level up from where the individual items live.
 *
 * Only the helpers this round's code (`ListService` + its tests) actually
 * needs are exported here. More are added alongside the Service that
 * consumes them (e.g. reaction/pin/flag paths land with `ThreadService`/
 * `FlagService`), not speculatively ahead of a real caller.
 */

/**
 * @param {string|number} spaceId @returns {string} The space's own storage
 *   root - what a subscribe() call needs to cover everything under a space.
 */
export function spacePath(spaceId) {
  return `/store/${spaceId}`;
}

/** @param {string|number} spaceId @param {string} docId @returns {string} */
export function documentPath(spaceId, docId) {
  return `/store/${spaceId}/docs/${docId}`;
}

/**
 * The ACL descriptor path for a resource - deliberately a SIBLING of the
 * resource's own path (`acl/<kind>/<id>`), not nested inside it, so
 * `@qu/engines`' `AccessEngine` can gate a write without knowing anything
 * about how that resource's own data is shaped. `kind` lives in the PATH
 * (not the ACL document's own content) so a doc and a list that happen to
 * share the same id never collide on the same ACL entry.
 * @param {string|number} spaceId
 * @param {'docs'|'lists'|'assets'|'threads'} kind
 * @param {string} resourceId
 * @returns {string}
 */
export function aclPath(spaceId, kind, resourceId) {
  return `/store/${spaceId}/acl/${kind}/${resourceId}`;
}

/**
 * A CURATED list's own document path (`ListService.listCurated()`/
 * `addCurated()`/`removeCurated()` - a `{$list: [path, ...]}` index of
 * references to items that live elsewhere, resolved via `@qu/engines`'
 * `CollectionEngine`). Use this for hand-picked/user-ordered selections of
 * items NOT already colocated under one shared path prefix - if they ARE
 * (e.g. a thread's own messages), use a *ParentPath() helper and
 * `ListService.listDerived()` instead, no index document needed at all.
 * @param {string|number} spaceId @param {string} listId
 * @returns {string}
 */
export function listPath(spaceId, listId) {
  return `/store/${spaceId}/lists/${listId}`;
}

/** @param {string|number} spaceId @param {string} threadId @returns {string} */
export function threadMetaPath(spaceId, threadId) {
  return `/store/${spaceId}/threads/${threadId}/meta`;
}

/** @param {string|number} spaceId @param {string} threadId @param {string} messageId @returns {string} */
export function threadMessagePath(spaceId, threadId, messageId) {
  return `/store/${spaceId}/threads/${threadId}/msgs/${messageId}`;
}

/**
 * The PARENT path of a thread's messages - what `ListService.listDerived()`
 * (equivalently `QuStore.getChildren()`) takes to enumerate them, since
 * each message already lives at its own path (`threadMessagePath()`) one
 * level below this. No separate index document, no `ListService.addCurated()`
 * call needed when posting a message - just `qu.put(threadMessagePath(...))`.
 * @param {string|number} spaceId @param {string} threadId @returns {string}
 */
export function threadMessagesParentPath(spaceId, threadId) {
  return `/store/${spaceId}/threads/${threadId}/msgs`;
}

/**
 * A PRIVATE, self-encrypted "list of things I've marked" - `StarredService`'s
 * one storage location per (identity, namespace). Not a `ListService` shape
 * at all (neither derived nor curated-via-references): the whole namespace's
 * items live INLINE in this one document, self-encrypted, because they're
 * small records that only exist as entries in this list (there is no
 * separate QuBit elsewhere to reference) - see `starred-service.js`'s own
 * doc comment.
 * @param {string} actorPub @param {string} namespace @returns {string}
 */
export function starredPath(actorPub, namespace) {
  return `/store/actors/~${actorPub}/private/starred/${namespace}`;
}

/**
 * One actor's own signed slot for a PUBLIC flag (`FlagService.setPublic()`)
 * - same "one QuBit per actor, enumerated via `ListService.listDerived()`"
 * shape as everything else in the derived-list family (reactions, pins).
 * @param {string|number} spaceId @param {string} flagType @param {string} entityKind
 * @param {string} entityRef @param {string} actorPub @returns {string}
 */
export function flagPath(spaceId, flagType, entityKind, entityRef, actorPub) {
  return `/store/${spaceId}/flags/${flagType}/${entityKind}/${entityRef}/${actorPub}`;
}

/**
 * The PARENT path `ListService.listDerived()` enumerates to find every
 * actor's flag on one entity - one level above `flagPath()`.
 * @param {string|number} spaceId @param {string} flagType @param {string} entityKind
 * @param {string} entityRef @returns {string}
 */
export function flagParentPath(spaceId, flagType, entityKind, entityRef) {
  return `/store/${spaceId}/flags/${flagType}/${entityKind}/${entityRef}`;
}
