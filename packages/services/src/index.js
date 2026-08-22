/**
 * QU SERVICES — public entry point. paths, unwrap, sync-freshness,
 * ListService, private-storage (incl. `getPrivateChildren()`/
 * `createPrivateStore()` - the self-encrypted derived-list primitives
 * `FlagService`'s private mode and `@qu/ui`'s `<qu-list>` both build on),
 * FlagService, FavoritesService, ContactsService, AccessService,
 * crypto-envelope, thread-formatting, link-detect, the `ThreadService`
 * decomposition (§4.3): MessageService (+ THREAD_PRESETS), ReactionService,
 * PinService, PresenceService, NotificationPrefsService,
 * PushSubscriptionService, ProfileService, DirectoryService,
 * actor-format's formatActorLabel/matchesActorQuery, AssetService (the
 * Entity API over `@qu/engines`' AssetEngine - file/image/video/audio
 * attachments), BookmarksService (a private per-identity list, now
 * generalized over any entityKind - forum messages by default, or a generic
 * Entity - the same `FlagService`-wrapper shape as `FavoritesService`),
 * createTrustedCatalogStore (the signer-filtered `/store/apps/catalog`
 * facade shared by `apps/app-list` and `apps/shell`), ChannelService
 * (Forum's Channel -> Topic hierarchy), ChatService (`apps/chat`'s
 * 1:1-room-id-derivation + group-invite mechanism, on top of
 * MessageService), WebRtcSignalService (bridges `@qu/webrtc`'s generic
 * `WebRTCTransport` to a Thread's own signaling namespace, carrying SDP/ICE
 * over the existing relay-backed sync stack), and Quniverse V4's generic
 * Entity layer (docs/v4-concept.md): EntityService (the Entity API over
 * `@qu/engines`' EntityEngine), EntityTypeRegistry/defaultEntityTypes (the
 * static, swappable Content-Type+Fields registry), and createContent (the
 * universal Content shape - deliberately separate from any editor). See
 * each file's own doc comment.
 */
export * as paths from './paths.js';
export { unwrap, unwrapAll } from './unwrap.js';
export { createFreshnessTracker, createMissGate } from './sync-freshness.js';
export { ListService } from './list-service.js';
export { getPrivate, putPrivate, getPrivateChildren, createPrivateStore } from './private-storage.js';
export { FlagService } from './flag-service.js';
export { FavoritesService } from './favorites-service.js';
export { BookmarksService } from './bookmarks-service.js';
export { ContactsService } from './contacts-service.js';
export { AccessService } from './access-service.js';
export { SharingService } from './sharing-service.js';
export { isEncryptedEnvelope, resolveReaderXKeys, decryptEnvelope } from './crypto-envelope.js';
export { extractMentions, formatMarkdown, applyFormatting, escapeHtml } from './thread-formatting.js';
export { URL_RE_GLOBAL, detectLinks } from './link-detect.js';
export { MessageService, THREAD_PRESETS } from './message-service.js';
export { ChannelService } from './channel-service.js';
export { ChatService } from './chat-service.js';
export { ReactionService } from './reaction-service.js';
export { PinService } from './pin-service.js';
export { PresenceService } from './presence-service.js';
export { NotificationPrefsService } from './notification-prefs-service.js';
export { PushSubscriptionService } from './push-subscription-service.js';
export { ProfileService } from './profile-service.js';
export { DirectoryService } from './directory-service.js';
export { formatActorLabel, matchesActorQuery } from './actor-format.js';
export { ActorService } from './actor-service.js';
export { createTrustedCatalogStore } from './apps-catalog-store.js';
export { AssetService } from './asset-service.js';
export { WebRtcSignalService } from './webrtc-signal-service.js';
export { EntityService } from './entity-service.js';
export { EntityTypeRegistry, defaultEntityTypes } from './entity-types.js';
export { CONTENT_FORMATS, createContent, renderContent } from './content.js';
export { FollowService } from './follow-service.js';
export { TagService } from './tag-service.js';
export { MentionService } from './mention-service.js';
