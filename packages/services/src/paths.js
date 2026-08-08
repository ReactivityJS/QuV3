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
 * One identity's own self-encrypted PRIVATE flag on an entity
 * (`FlagService.setPrivate()`) - the private-mode counterpart to
 * `flagPath()` below: same "one QuBit per (flag, entity)" shape, enumerated
 * via `private-storage.js`'s `getPrivateChildren()` instead of
 * `ListService.listDerived()` (the extra step being decryption, not a
 * different storage shape). This is what `FavoritesService`/`ContactsService`
 * are built on - each favorite/contact is its OWN small encrypted document,
 * not an entry in one shared array, so adding/removing one is a single
 * write (O(1)), never a read-modify-write of everything this identity has
 * ever flagged.
 * @param {string} actorPub - This identity's OWN pubkey (never someone else's - a private flag has no meaning for anyone but its owner).
 * @param {string} flagType @param {string} entityKind @param {string} entityRef
 * @returns {string}
 */
export function privateFlagPath(actorPub, flagType, entityKind, entityRef) {
  return `/store/actors/~${actorPub}/private/flags/${flagType}/${entityKind}/${entityRef}`;
}

/**
 * The PARENT path `private-storage.js`'s `getPrivateChildren()` enumerates
 * to find every entity this identity has privately flagged with `flagType`/
 * `entityKind` - one level above `privateFlagPath()`.
 * @param {string} actorPub @param {string} flagType @param {string} entityKind
 * @returns {string}
 */
export function privateFlagParentPath(actorPub, flagType, entityKind) {
  return `/store/actors/~${actorPub}/private/flags/${flagType}/${entityKind}`;
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

/**
 * One actor's PRIVATE (self-encrypted) "read up to" marker for a thread -
 * `MessageService.markRead()`/`getLastReadAt()`. Lives under the actor's own
 * `private/` prefix, same convention `privateFlagPath()` uses - see
 * private-storage.js. Not visible to (or enumerable by) anyone else, which
 * is the whole point: how far YOU'VE read is nobody else's business. Compare
 * `threadReadReceiptPath()` below - a deliberately DIFFERENT, PUBLIC
 * mechanism for the opposite case (telling others you've read something).
 * @param {string|number} spaceId @param {string} threadId @param {string} actorPub @returns {string}
 */
export function threadReadMarkerPath(spaceId, threadId, actorPub) {
  return `/store/actors/~${actorPub}/private/thread-read/${spaceId}/${threadId}`;
}

/**
 * One actor's own signed slot for a PUBLIC "reaction" (one emoji at a time)
 * on one message - `ReactionService`, same "one QuBit per actor under a
 * shared parent, enumerated via `ListService.listDerived()`" shape as
 * `flagPath()`/`flagParentPath()` above, just scoped to a message instead of
 * an arbitrary entity.
 * @param {string|number} spaceId @param {string} threadId @param {string} messageId
 * @param {string} actorPub @returns {string}
 */
export function threadReactionPath(spaceId, threadId, messageId, actorPub) {
  return `/store/${spaceId}/threads/${threadId}/reactions/${messageId}/${actorPub}`;
}

/**
 * The PARENT path `ListService.listDerived()` enumerates to find every
 * actor's reaction on one message - one level above `threadReactionPath()`.
 * @param {string|number} spaceId @param {string} threadId @param {string} messageId @returns {string}
 */
export function threadReactionsParentPath(spaceId, threadId, messageId) {
  return `/store/${spaceId}/threads/${threadId}/reactions/${messageId}`;
}

/**
 * One message's own pin marker - `PinService`. Unlike reactions/flags this
 * is NOT per-actor (any current writer of the thread may pin or unpin any
 * message, same rule QuV2's own pins carried - see PinService's doc
 * comment), so there is exactly one QuBit per PINNED message, not one per
 * (message, actor) pair. Still a DERIVED list, enumerated the same way -
 * `null` clears a pin (a tombstone, same convention `FlagService.setPublic()`
 * uses), since `QuStore` has no `delete()`.
 * @param {string|number} spaceId @param {string} threadId @param {string} messageId @returns {string}
 */
export function threadPinPath(spaceId, threadId, messageId) {
  return `/store/${spaceId}/threads/${threadId}/pins/${messageId}`;
}

/**
 * The PARENT path `ListService.listDerived()` enumerates to find every
 * currently-pinned message in a thread - one level above `threadPinPath()`.
 * @param {string|number} spaceId @param {string} threadId @returns {string}
 */
export function threadPinsParentPath(spaceId, threadId) {
  return `/store/${spaceId}/threads/${threadId}/pins`;
}

/**
 * One actor's current presence slot in a thread - `PresenceService`. Not a
 * `ListService` shape at all (neither derived nor curated): a thread already
 * has a fixed, externally-known member list (see `THREAD_PRESETS.chat`), so
 * "who's online" only ever means reading ONE already-known path per member,
 * never discovering who exists - see `PresenceService.getPresence()`.
 * @param {string|number} spaceId @param {string} threadId @param {string} actorPub @returns {string}
 */
export function threadPresencePath(spaceId, threadId, actorPub) {
  return `/store/${spaceId}/threads/${threadId}/presence/${actorPub}`;
}

/**
 * One actor's PUBLIC read receipt for a thread ("I've read up to timestamp
 * X") - VISIBLE TO OTHER MEMBERS, unlike `threadReadMarkerPath()` above.
 * Same fixed-member-list reasoning as `threadPresencePath()` - no derived-list
 * enumeration needed, `PresenceService.getReadReceipts()` just reads one
 * path per already-known member.
 * @param {string|number} spaceId @param {string} threadId @param {string} actorPub @returns {string}
 */
export function threadReadReceiptPath(spaceId, threadId, actorPub) {
  return `/store/${spaceId}/threads/${threadId}/reads/${actorPub}`;
}

/**
 * One identity's own signed entry in the opt-in public directory -
 * `DirectoryService`. A DERIVED list (docs/v3-technical-concept.md §4.2):
 * each entry already lives at its own path under
 * `directoryEntriesParentPath()`, enumerated via `ListService.listDerived()`
 * - `setVisible(true, ...)` is a single `qu.put()`, `setVisible(false)`
 * writes `null` (a tombstone, same convention `threadPinPath()` uses -
 * `QuStore` has no `delete()`), not a separate curated index to maintain.
 * Global, not per-space: there is exactly one directory for the whole
 * Quniverse, unlike a thread's messages/reactions/pins.
 * @param {string} actorPub @returns {string}
 */
export function directoryEntryPath(actorPub) {
  return `/store/directory/entries/${actorPub}`;
}

/**
 * The PARENT path `ListService.listDerived()` enumerates to find every
 * currently-visible directory entry - one level above `directoryEntryPath()`.
 * @returns {string}
 */
export function directoryEntriesParentPath() {
  return '/store/directory/entries';
}

/**
 * One actor's notification preferences document - `NotificationPrefsService`.
 * PUBLIC (signed, not encrypted, see that Service's own doc comment for
 * why): the party that needs to READ this to make a decision is `@qu/relay`,
 * which has no way to decrypt something only the owner's own key can read.
 * @param {string} actorPub @returns {string}
 */
export function notificationPrefsPath(actorPub) {
  return `/store/actors/~${actorPub}/notification-prefs`;
}

/**
 * One of an actor's registered Web Push subscriptions (one per device/
 * browser) - `PushSubscriptionService`. A DERIVED list
 * (docs/v3-technical-concept.md §4.2): each subscription already lives at
 * its own path under `pushSubscriptionsParentPath()`, enumerated via
 * `ListService.listDerived()` - `subscribe()` is a single `qu.put()`, no
 * index write. PUBLIC (signed, not encrypted) for the same reason
 * `notificationPrefsPath()` is - `@qu/relay`'s push delivery is the reader
 * that matters here.
 * @param {string} actorPub @param {string} subscriptionId @returns {string}
 */
export function pushSubscriptionPath(actorPub, subscriptionId) {
  return `/store/actors/~${actorPub}/push-subscriptions/${subscriptionId}`;
}

/**
 * The PARENT path `ListService.listDerived()` enumerates to find every one
 * of an actor's registered push subscriptions - one level above
 * `pushSubscriptionPath()`.
 * @param {string} actorPub @returns {string}
 */
export function pushSubscriptionsParentPath(actorPub) {
  return `/store/actors/~${actorPub}/push-subscriptions`;
}

/**
 * One relay-hosted app's catalog announcement (`@qu/relay`'s
 * `apps-catalog-store.js`) - a DERIVED list (docs/v3-technical-concept.md
 * §4.2): each app's entry lives at its own path under
 * `appCatalogParentPath()`, so a client can `<qu-list parent="...">` it
 * directly (see `@qu/ui`'s `components.js`) instead of polling the relay's
 * `/apps.json` HTTP endpoint (kept as a lightweight compat/debug route,
 * fed by the exact same `buildAppsCatalog()` data). Global, not per-space -
 * a relay hosts one app catalog, same reasoning `directoryEntryPath()` is
 * global. Signed by the RELAY's own identity, never a regular client's -
 * a reader verifies the entry's signer against the relay's own pubkey
 * (exposed via `/config.json`), the same "path is addressing, signer is
 * truth" convention every other derived list in this codebase already
 * relies on (no `AccessEngine` ACL needed - see `apps-catalog-store.js`'s
 * own doc comment for why that's a deliberate, not missing, choice).
 * @param {string} name - The app's manifest `name`.
 * @returns {string}
 */
export function appCatalogEntryPath(name) {
  return `/store/apps/catalog/${name}`;
}

/**
 * The PARENT path `ListService.listDerived()`/`<qu-list parent="...">`
 * enumerates to find every currently-catalogued app - one level above
 * `appCatalogEntryPath()`.
 * @returns {string}
 */
export function appCatalogParentPath() {
  return '/store/apps/catalog';
}
