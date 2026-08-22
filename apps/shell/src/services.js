import { ListService, FlagService, ContactsService, FavoritesService, ProfileService, DirectoryService, ActorService, AccessService, SharingService, MessageService, ReactionService, PinService, PresenceService, AssetService, BookmarksService, NotificationPrefsService, PushSubscriptionService, ChannelService, ChatService, EntityService, CommentableService } from '@qu/services';
import { AssetEngine, CollectionEngine, EntityEngine } from '@qu/engines';

/**
 * The fixed, known set of client-side Services every app under `apps/*`
 * (built so far) actually needs, wired once here and handed to every
 * mounted app via the SAME `{qu, identity, services, apps}` context object
 * `apps/app-list`/`user-list`/`contact-list`'s own tests already construct
 * by hand. Deliberately a plain local function, NOT promoted into a shared
 * `@qu/foundation` `bootClientRuntime()` helper - this is `apps/shell`'s
 * OWN first real caller of that idea (see `@qu/foundation`'s
 * `runtime-container.js`, which explicitly defers it to "whichever of
 * `@qu/relay`/`apps/shell` is built first, not spec'd speculatively") - it
 * gets promoted once a SECOND real caller (e.g. a future `apps/demo`)
 * actually needs the same wiring, not before.
 *
 * `syncFetch`/`getGeneration` (from `connectToRelay()`'s `sync.fetch`/
 * `sync.getGeneration`, see `client.js`) are threaded into `ListService`
 * AND `ProfileService` - both already had this exact backfill parameter
 * designed in from the start (see either's own constructor doc comment:
 * "without it, ... would return null forever, no matter how long it
 * waits"), just never wired to a real `SyncEngine` until now, because no
 * real client existed to wire them from. A real cross-browser check while
 * building this file's first caller (`apps/shell`) caught it: without this,
 * `services.profile.getPublicProfile()` for a peer whose profile was
 * published before this session connected fell back to a raw truncated
 * pubkey forever, in `apps/user-list`/`apps/contact-list` alike.
 *
 * @param {import('@qu/core').QuStore} qu
 * @param {import('@qu/identity').QuIdentityEngine} identity
 * @param {{syncFetch?: (path: string) => Promise<object|null>, getGeneration?: () => number}} [sync]
 */
export function createClientServices(qu, identity, { syncFetch = null, getGeneration = null } = {}) {
  const list = new ListService(qu, syncFetch, getGeneration);
  const flags = new FlagService(qu, identity, list);
  const access = new AccessService(qu, identity, syncFetch);
  // Unlike AccessEngine/ThreadEngine (never registered client-side - ACL
  // enforcement and id/timestamp stamping are meaningfully exercised only
  // server-side, see the relay's own composition), AssetEngine MUST be
  // registered on THIS qu too: chunking is a WRITE-TIME behavior on the
  // ORIGINATING side - a qu.put() to an "assets" path with no AssetEngine
  // registered would just try to seal/persist a raw File/Blob directly,
  // which is not what any caller wants. Constructed HERE (not in
  // `client.js`'s `createDefaultQu()`) so there's exactly one instance per
  // `qu`, with a real reference `AssetService` can hold onto directly -
  // `AssetEngine.getAsset()`/`.verifySyncOut()` are plain method calls on
  // this object, not something `qu.get()`'s engine-dispatch could resolve
  // back out again once registered (only `put()` is ever intercepted).
  const assetEngine = new AssetEngine(qu);
  // First real client-side reader of a CURATED list (`ListService.
  // listCurated()`/`ChannelService`, see its own doc comment) - every
  // OTHER Service so far only ever reads DERIVED lists (`listDerived()`,
  // no Engine needed - see `ListService`'s own class doc comment) or
  // curated PRIVATE lists (`FlagService`'s private mode, resolved through
  // `private-storage.js` directly, not through `CollectionEngine`).
  // `CollectionEngine` resolves a curated list's `{$list: [path, ...]}`
  // index into actual referenced values on READ (`qu.get()`'s TRANSFORM
  // step) - without it registered here, `listCurated()` gets back the raw,
  // unresolved index document instead of real channel/topic values. Same
  // "write/read-time behavior needs the Engine on THIS qu too" reasoning
  // `AssetEngine` above already documents.
  new CollectionEngine(qu);
  // Quniverse V4's generic Entity layer (docs/v4-concept.md §3.1) - a WRITE-
  // TIME behavior (`_id`/`_created` stamping, the `_type`-required check),
  // same "must be registered on THIS qu too" reasoning `AssetEngine` above
  // already documents. First real client-side need: `apps/forum`'s Topic is
  // now an Entity (see `ChannelService`'s own "QUNIVERSE V4" doc comment).
  new EntityEngine(qu);
  const messages = new MessageService(qu, identity, list, access, syncFetch, getGeneration);
  return {
    // The raw, generic Service `contacts`/`favorites`/`bookmarks` below each
    // narrow to one fixed flagType/entityKind pair - exposed directly too
    // (first real client caller: apps/calendar's own "My Calendars" private
    // star list, `flagType: 'calendar'`) for any app that needs a private
    // flag shape those three named facades don't cover, without inventing a
    // fourth single-purpose wrapper Service per new use.
    flags,
    contacts: new ContactsService(flags, identity),
    favorites: new FavoritesService(flags),
    profile: new ProfileService(qu, identity, syncFetch, getGeneration),
    directory: new DirectoryService(qu, identity, list),
    actors: new ActorService(identity),
    access,
    // The generic "shared resource with owner/editor/viewer members, invite
    // by alias/pub, ACL kept in sync as roles change" Entity API (see its
    // own doc comment) - extracted FROM apps/calendar's own inline logic
    // once a second real caller (apps/todo's shared lists) needed the exact
    // same shape. Shares this same `access`/`messages`/`flags` instance.
    sharing: new SharingService(qu, identity, access, messages, flags, syncFetch),
    // `apps/forum`'s first real client caller (see its own doc comment) -
    // MessageService/ReactionService/PinService existed fully tested since
    // early in this session, with nothing wiring them to a real client
    // until now, same "backfill hook built, no caller yet" gap this file's
    // own doc comment already describes for syncFetch/getGeneration
    // themselves.
    messages,
    reactions: new ReactionService(qu, identity, list),
    pins: new PinService(qu, identity, list),
    // apps/forum's Channel -> Topic -> per-Topic-Thread hierarchy (see its
    // own doc comment) - shares this same `list`/`access`/`messages`
    // instance. `syncFetch` matters here specifically (unlike most other
    // Services sharing this file's own `list`/`access` instances): without
    // it, a peer who opens the forum after a channel/topic was already
    // created elsewhere never sees it - confirmed live, see
    // ChannelService's own constructor doc comment for the full mechanism.
    channels: new ChannelService(qu, identity, list, access, messages, syncFetch),
    // Quniverse V4's generic Entity layer (docs/v4-concept.md §3.1) -
    // `ChannelService` above already constructs its own internal copies of
    // both (Forum's Topic is an Entity, see that class's own "QUNIVERSE V4"
    // doc comment) - exposed here too, unconditionally, for any OTHER app's
    // own EntityType (Article/Page/Task/Event, §3.3) to use directly, the
    // same "present regardless of which app happens to be mounted" posture
    // `bookmarks` below already has.
    entities: new EntityService(qu, identity),
    commentable: new CommentableService(messages),
    // apps/chat's room presence (online/offline/last-seen) + public read
    // receipts - shares no state with `messages` (see PresenceService's own
    // doc comment on why it isn't a ListService shape at all), first real
    // client caller.
    presence: new PresenceService(qu, identity),
    // apps/chat's 1:1-room-id-derivation + group-invite mechanism, on top
    // of this SAME `messages` instance (a chat room is just another
    // MessageService thread, see ChatService's own doc comment).
    chat: new ChatService(messages, identity),
    // First real client caller of AssetEngine (see its own doc comment) -
    // same "backfill hook built, no caller yet" gap this file's doc comment
    // already describes for syncFetch/getGeneration themselves.
    assets: new AssetService(qu, assetEngine, identity, syncFetch),
    // apps/bookmarks reads/writes this directly (both as its own "My
    // Bookmarks" page AND as a content.messageActions contributor rendered
    // from WITHIN apps/forum - see either's own doc comment) - present here
    // unconditionally, same as every other Service, regardless of which app
    // happens to be mounted right now.
    bookmarks: new BookmarksService(flags),
    // First real client callers of either (see either's own doc comment) -
    // same "backfill hook built, no caller yet" gap this file's doc comment
    // already describes for syncFetch/getGeneration themselves.
    // apps/profile's Settings subpage reads/writes notificationPrefs (the
    // granular enabled/mentions/per-app toggles) and drives
    // pushSubscriptions.subscribe() from a real PushManager.subscribe()
    // call; apps/notifications only ever reads the resulting in-app
    // notifications Thread, never either of these two directly.
    notificationPrefs: new NotificationPrefsService(qu, identity),
    pushSubscriptions: new PushSubscriptionService(qu, identity, list),
  };
}
