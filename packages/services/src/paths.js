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
 * The PARENT path `ListService.listDerived()` (equivalently
 * `QuStore.getChildren()`) enumerates to find every Entity in a space - one
 * level above `entityPath()`. Not added alongside `entityPath()` itself
 * originally (see that function's own doc comment: "enumerating 'every
 * entity of type X' is an app-level query concern for a later phase") -
 * added now for `apps/cms`, the first real caller that needs to list every
 * page in a space. Lists EVERY entity regardless of `_type` (there is no
 * per-type index) - a caller wanting only one type filters the resolved
 * `quBit.val._type` client-side, same "cheap for a modest collection"
 * tradeoff every other derived-list consumer in this codebase already makes.
 * @param {string|number} spaceId @returns {string}
 */
export function entitiesParentPath(spaceId) {
  return `/store/${spaceId}/entities`;
}

/**
 * One Entity's own document path (Quniverse V4, see docs/v4-concept.md
 * §3.1/§3.3) - `@qu/engines`' `EntityEngine` stamps `_id`/`_created` and
 * requires `_type` on writes here, same convention `documentPath()` and
 * `EntityEngine`'s own doc comment describe for `DocumentEngine`. No
 * parent/listing path yet - enumerating "every entity of type X" is an
 * app-level query concern for a later phase, not added speculatively ahead
 * of a real caller (see this file's own doc comment).
 * @param {string|number} spaceId @param {string} entityId @returns {string}
 */
export function entityPath(spaceId, entityId) {
  return `/store/${spaceId}/entities/${entityId}`;
}

/**
 * The path `AssetService`/`@qu/engines`' `AssetEngine` chunk/reassemble
 * under - see `AssetEngine`'s own doc comment for why this stays under
 * `/store` (the `assets` segment routes `put()` to it) even though the
 * actual chunk bytes end up on the separate `blob` MOUNT, not here - this
 * path only ever holds the small `{name, mime, size, blobPath, ...}` meta
 * document, at `${assetPath(...)}/meta`.
 * @param {string|number} spaceId @param {string} assetId @returns {string}
 */
export function assetPath(spaceId, assetId) {
  return `/store/${spaceId}/assets/${assetId}`;
}

/**
 * The ACL descriptor path for a resource - deliberately a SIBLING of the
 * resource's own path (`acl/<kind>/<id>`), not nested inside it, so
 * `@qu/engines`' `AccessEngine` can gate a write without knowing anything
 * about how that resource's own data is shaped. `kind` lives in the PATH
 * (not the ACL document's own content) so a doc and a list that happen to
 * share the same id never collide on the same ACL entry.
 * @param {string|number} spaceId
 * @param {'docs'|'lists'|'assets'|'threads'|'entities'} kind
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

/**
 * A thread's own root - one level above `meta`/`msgs`/`reactions`/`pins`/
 * `reads`/`typing`, every one of which lives under this SAME prefix. Not
 * itself a document any Service reads/writes - it exists for a caller that
 * needs to address the whole thread namespace at once, e.g.
 * `SyncEngine.fetchPrefix()` forcing a full resync of a room (messages +
 * meta + reactions + pins + read receipts + typing, in one request) - see
 * `apps/chat/client.js`'s own "Reload messages" room-menu item.
 * @param {string|number} spaceId @param {string} threadId @returns {string}
 */
export function threadPath(spaceId, threadId) {
  return `/store/${spaceId}/threads/${threadId}`;
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
 * One (tag, entity) pairing - the FORWARD direction of Quniverse V4's
 * `TagService` (see docs/v4-concept.md §4): "what has tag X" (of one
 * `entityKind` at a time - see `TagService`'s own doc comment for why tag
 * queries are deliberately scoped per kind, not cross-kind). Same "one QuBit
 * per item under a shared parent, no index document" derived-list shape as
 * `flagPath()`.
 * @param {string|number} spaceId @param {string} tag @param {string} entityKind @param {string} entityId @returns {string}
 */
export function tagPath(spaceId, tag, entityKind, entityId) {
  return `/store/${spaceId}/tags/${tag}/${entityKind}/${entityId}`;
}

/** The PARENT path `ListService.listDerived()` enumerates to find every entity (of one `entityKind`) tagged `tag` - one level above `tagPath()`. @param {string|number} spaceId @param {string} tag @param {string} entityKind @returns {string} */
export function tagParentPath(spaceId, tag, entityKind) {
  return `/store/${spaceId}/tags/${tag}/${entityKind}`;
}

/**
 * The REVERSE direction of `TagService`: "what tags does this entity have" -
 * a separate derived list from `tagPath()`, not a re-read of it, so both
 * "what has tag X" and "what tags does entity Y have" stay O(1) writes with
 * no read-modify-write of a shared document.
 * @param {string|number} spaceId @param {string} entityKind @param {string} entityId @param {string} tag @returns {string}
 */
export function entityTagPath(spaceId, entityKind, entityId, tag) {
  return `/store/${spaceId}/entity-tags/${entityKind}/${entityId}/${tag}`;
}

/** The PARENT path `ListService.listDerived()` enumerates to find every tag on one entity - one level above `entityTagPath()`. @param {string|number} spaceId @param {string} entityKind @param {string} entityId @returns {string} */
export function entityTagsParentPath(spaceId, entityKind, entityId) {
  return `/store/${spaceId}/entity-tags/${entityKind}/${entityId}`;
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
 * One actor's own signed reaction on a generic Entity (Quniverse V4, see
 * docs/v4-concept.md §4) - the entity-scoped counterpart to
 * `threadReactionPath()`, same "one QuBit per actor under a shared parent"
 * shape, just one level shallower (an Entity has no `threadId`/`messageId`
 * pair, only its own single id) - see `ReactionService`'s own doc comment
 * for why this is two new methods on the SAME class rather than an
 * overload of its existing thread-message ones.
 * @param {string|number} spaceId @param {string} entityId @param {string} actorPub @returns {string}
 */
export function entityReactionPath(spaceId, entityId, actorPub) {
  return `/store/${spaceId}/entities/${entityId}/reactions/${actorPub}`;
}

/** The PARENT path `ListService.listDerived()` enumerates to find every actor's reaction on one Entity - one level above `entityReactionPath()`. @param {string|number} spaceId @param {string} entityId @returns {string} */
export function entityReactionsParentPath(spaceId, entityId) {
  return `/store/${spaceId}/entities/${entityId}/reactions`;
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
 * One actor's SINGLE, GLOBAL presence slot - `PresenceService`. Redesigned
 * away from a per-(space,thread) path (every room a member had open used to
 * get its own presence QuBit, heartbeat-written independently - O(N) writes
 * per open room instead of O(1)): presence is a fact about the ACTOR, not
 * about any one room, so there is exactly one path per actor for the whole
 * of Quniverse, mirroring `directoryEntryPath()`'s own "global, not
 * per-space" shape. A room reads it for each of its already-known members
 * (`PresenceService.getUserPresences()`) the same "no derived-list
 * enumeration needed, just known paths" way the old per-thread version did.
 * @param {string} actorPub @returns {string}
 */
export function presencePath(actorPub) {
  return `/store/presence/${actorPub}`;
}

/**
 * This identity's own PRIVATE presence-visibility preference
 * ('public'|'contacts'|'off' - see `PresenceService.setVisibility()`) - only
 * the owner ever needs to read this (it governs how THEIR OWN future
 * `presencePath()` writes get encrypted, if at all), so it lives under the
 * same `private/` convention `threadReadMarkerPath()` uses, not at a path
 * anyone else would ever look up.
 * @param {string} actorPub @returns {string}
 */
export function presenceSettingsPath(actorPub) {
  return `/store/actors/~${actorPub}/private/presence-settings`;
}

/**
 * One actor's PUBLIC read receipt for a thread ("I've read up to timestamp
 * X") - VISIBLE TO OTHER MEMBERS, unlike `threadReadMarkerPath()` above.
 * Same fixed-member-list reasoning `presencePath()`'s own `getUserPresences()`
 * has - no derived-list enumeration needed, `PresenceService.getReadReceipts()`
 * just reads one path per already-known member. Stays thread-scoped, unlike
 * presence (see `presencePath()`'s own doc comment for why): "read up to X"
 * is inherently a fact about one thread's own history.
 * @param {string|number} spaceId @param {string} threadId @param {string} actorPub @returns {string}
 */
export function threadReadReceiptPath(spaceId, threadId, actorPub) {
  return `/store/${spaceId}/threads/${threadId}/reads/${actorPub}`;
}

/**
 * The PARENT path of every member's read receipt in a thread - one level
 * above `threadReadReceiptPath()`. `PresenceService.getReadReceipts()`
 * itself still reads one already-known per-member path each (no derived-
 * list enumeration needed, see that method's own doc comment) - this
 * parent exists purely so a live UI can `watchChildren()` it the same way
 * it already watches `threadMessagesParentPath()`, and re-run its own
 * `getReadReceipts()` read whenever ANY member's receipt changes. Without
 * this, a receipt arriving via sync updates the store but nothing ever
 * re-reads it - a sender's own read-tick would silently freeze at whatever
 * it was on first render, since receipts live under a sibling of `msgs/`,
 * never a write `threadMessagesParentPath()`'s own watch would ever see.
 * @param {string|number} spaceId @param {string} threadId @returns {string}
 */
export function threadReadReceiptsParentPath(spaceId, threadId) {
  return `/store/${spaceId}/threads/${threadId}/reads`;
}

/**
 * One actor's "is currently typing" flag for a thread - `PresenceService.
 * publishTyping()`/`getTypingMembers()`. Deliberately its OWN dedicated
 * path, not piggybacked on `presencePath()`: unlike online/offline (a fact
 * about the ACTOR, see `presencePath()`'s own doc comment), "is typing" is
 * inherently a fact about ONE thread ("typing here right now") - a global
 * per-actor presence QuBit has no room context to attach it to. Same
 * "sibling of `meta`/`msgs`/`presence`/`reads`, no ACL special-case" shape
 * `threadReadReceiptPath()` already uses.
 * @param {string|number} spaceId @param {string} threadId @param {string} actorPub @returns {string}
 */
export function threadTypingPath(spaceId, threadId, actorPub) {
  return `/store/${spaceId}/threads/${threadId}/typing/${actorPub}`;
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
 * The space id `@qu/relay`'s `PushDeliveryService` writes an in-app
 * notification into, and `apps/notifications` reads back - one PRIVATE
 * Thread (`readers: [actorPub]`, see `THREAD_PRESETS.notifications()`) per
 * identity, always thread id `NOTIFICATIONS_THREAD_ID`. Shared here (not a
 * string literal re-typed in both places) so the writer and the reader can
 * never drift apart on the exact convention.
 * @param {string} actorPub @returns {string}
 */
export function notificationsSpaceId(actorPub) {
  return `${NOTIFICATIONS_SPACE_PREFIX}${actorPub}`;
}

/**
 * The fixed prefix every `notificationsSpaceId()` starts with - what
 * `PushDeliveryService` checks an INCOMING message's own spaceId against to
 * recognise (and skip) a notifications thread as a delivery TARGET, never a
 * delivery SOURCE (a relay-authored notice about a message in a
 * notifications thread would otherwise loop forever). Exported so that
 * check never has to re-type the literal `notificationsSpaceId()` itself
 * already uses.
 */
export const NOTIFICATIONS_SPACE_PREFIX = 'notifications-';

/** The fixed (single, per-identity) thread id under `notificationsSpaceId()` - see that function's own doc comment. */
export const NOTIFICATIONS_THREAD_ID = 'notifications';

/**
 * One identity's own personal `apps/cms` space - "the current user's own
 * space" the CMS app builds "my pages" on, same per-actor-derived-space
 * convention `notificationsSpaceId()` already established (a real, separate
 * space - not just a path prefix under `/store/actors/~<pub>/...` - because a
 * page is a normal, independently-addressable Entity with its own ACL, not a
 * private per-actor document). Deliberately NOT the app's own fixed manifest
 * `spaceId` (that one is reserved for the GLOBAL, admin-writable space - see
 * `apps/cms/manifest.quapp`) - every user gets their own, so two users' pages
 * never collide and one user's ACL never has to enumerate every other user.
 * @param {string} actorPub @returns {string}
 */
export function cmsUserSpaceId(actorPub) {
  return `${CMS_USER_SPACE_PREFIX}${actorPub}`;
}

/** The fixed prefix every `cmsUserSpaceId()` starts with - exported for the same "never re-type the literal" reason `NOTIFICATIONS_SPACE_PREFIX` is. */
export const CMS_USER_SPACE_PREFIX = 'cms-';

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
 * One piece of content's signed "you were mentioned" marker in the
 * MENTIONED actor's own GLOBAL mention index (Quniverse V4's `MentionService`,
 * see docs/v4-concept.md §4) - global, not per-space, same reasoning
 * `directoryEntryPath()`/`notificationPrefsPath()` already use (the
 * mentioned actor may be mentioned in ANY space, not just one). Signed by
 * the CONTENT'S AUTHOR (whoever wrote the mentioning text), never the
 * mentioned actor - same "path is addressing, not trust" caveat
 * `threadReactionPath()`'s own doc comment documents: a reader must key off
 * the QuBit's own verified `pub`, never assume the mentioned actor wrote it.
 *
 * `spaceId`/`entityKind`/`entityId` are joined into ONE flat `~`-separated
 * segment (same "both sides derive the same key, no nesting" trick
 * `webrtcPairKey()` uses) rather than three nested path segments -
 * `QuStore.getChildren()`/`ListService.listDerived()` only ever lists DIRECT
 * (one level deep) children, so `actorMentionsParentPath()` must be exactly
 * one segment above every entry, not three.
 * @param {string} actorPub - The MENTIONED identity (whose index this lives under).
 * @param {string|number} spaceId @param {string} entityKind @param {string} entityId @returns {string}
 */
export function actorMentionPath(actorPub, spaceId, entityKind, entityId) {
  return `/store/mentions/${actorPub}/${spaceId}~${entityKind}~${entityId}`;
}

/** The PARENT path `ListService.listDerived()` enumerates to find everything that mentions `actorPub` - one level above `actorMentionPath()`. @param {string} actorPub @returns {string} */
export function actorMentionsParentPath(actorPub) {
  return `/store/mentions/${actorPub}`;
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

/**
 * Deterministic per-pair key for WebRTC signaling paths (`WebRtcSignalService`)
 * - the two participants' pubkeys, lexicographically sorted and joined, so
 * BOTH sides independently compute the exact same path with no prior
 * negotiation. Same "both sides derive the same answer locally, no extra
 * message needed" pattern `@qu/webrtc`'s `WebRTCTransport` uses for its own
 * deterministic-initiator tie-break.
 * @param {string} pubA @param {string} pubB @returns {string}
 */
export function webrtcPairKey(pubA, pubB) {
  return pubA < pubB ? `${pubA}~${pubB}` : `${pubB}~${pubA}`;
}

/**
 * One pair's SDP offer, written by whichever side is the deterministic
 * initiator - see `webrtcPairKey()`. Lives under the Thread's own namespace
 * (a sibling of `meta`/`msgs`, same convention `threadReadReceiptPath()` uses)
 * so it inherits the existing relay-backed sync stack's offline-tolerant
 * delivery (outbox replay, reconnect catch-up) for free - no new relay
 * message type needed. NOT covered by `AccessEngine` (its thread-path regex
 * only recognizes `meta`/`msgs/...`) - `WebRtcSignalService` itself checks a
 * signal's verified `pub` against the Thread's known member list before
 * trusting it, same discipline `PresenceService`/`ReactionService` already
 * document.
 * @param {string|number} spaceId @param {string} threadId @param {string} pairKey @returns {string}
 */
export function webrtcOfferPath(spaceId, threadId, pairKey) {
  return `/store/${spaceId}/threads/${threadId}/webrtc/${pairKey}/offer`;
}

/** The answerer's SDP answer - see `webrtcOfferPath()`'s own doc comment. @param {string|number} spaceId @param {string} threadId @param {string} pairKey @returns {string} */
export function webrtcAnswerPath(spaceId, threadId, pairKey) {
  return `/store/${spaceId}/threads/${threadId}/webrtc/${pairKey}/answer`;
}

/**
 * One trickled ICE candidate, keyed by `fromActorPub` (each side writes
 * under its OWN pubkey, never the other's) and an incrementing `seq` - one
 * QuBit per candidate, same "one item per path under a shared parent,
 * enumerate via getChildren" shape thread messages/reactions/pins already
 * use.
 * @param {string|number} spaceId @param {string} threadId @param {string} pairKey
 * @param {string} fromActorPub @param {number} seq @returns {string}
 */
export function webrtcIceCandidatePath(spaceId, threadId, pairKey, fromActorPub, seq) {
  return `/store/${spaceId}/threads/${threadId}/webrtc/${pairKey}/ice/${fromActorPub}/${seq}`;
}

/**
 * The PARENT path of one side's own trickled ICE candidates - one level
 * above `webrtcIceCandidatePath()`. A caller watches the OTHER side's own
 * pubkey here to receive their trickled candidates.
 * @param {string|number} spaceId @param {string} threadId @param {string} pairKey @param {string} fromActorPub @returns {string}
 */
export function webrtcIceCandidatesParentPath(spaceId, threadId, pairKey, fromActorPub) {
  return `/store/${spaceId}/threads/${threadId}/webrtc/${pairKey}/ice/${fromActorPub}`;
}

/**
 * A sibling of `webrtcOfferPath()` a callee writes to explicitly DECLINE a
 * call before any `RTCPeerConnection` negotiation ever starts (`@qu/services`'
 * `WebRtcSignalService.declineCall()`) - lets the caller show "call declined"
 * instead of silently waiting out `negotiationTimeoutMs`. Same tombstone/
 * signed-QuBit convention as offer/answer/ICE, just a different leaf name.
 * @param {string|number} spaceId @param {string} threadId @param {string} pairKey @returns {string}
 */
export function webrtcDeclinePath(spaceId, threadId, pairKey) {
  return `/store/${spaceId}/threads/${threadId}/webrtc/${pairKey}/declined`;
}

/**
 * A sibling of `webrtcDeclinePath()` for the OPPOSITE end of a call's
 * lifecycle: one side explicitly hanging up an ALREADY-connected call
 * (`WebRtcSignalService.hangupCall()`/`onHangup()`). Real `RTCPeerConnection`s
 * have no built-in "graceful bye" signal - closing one side's connection
 * doesn't promptly tell the other side anything (ICE just eventually times
 * out, `'disconnected'`, which `PeerConnection` deliberately treats as
 * self-recovering, not a failure - see that class's own doc comment) - this
 * is what lets the OTHER side learn "the call ended" immediately and
 * reliably instead of being left looking connected indefinitely.
 * @param {string|number} spaceId @param {string} threadId @param {string} pairKey @returns {string}
 */
export function webrtcHangupPath(spaceId, threadId, pairKey) {
  return `/store/${spaceId}/threads/${threadId}/webrtc/${pairKey}/hungup`;
}
