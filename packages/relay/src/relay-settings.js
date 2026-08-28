/**
 * RELAY SETTINGS — this relay's own admin-editable operational config
 * (default locale, message rate limit, disabled apps, the Flag TYPE
 * catalog - see `@qu/services`' `FlagService`). Data, not code: an admin
 * changes what a "flag" even IS (Like/Bookmark/Favorite, which entity kinds
 * it applies to) without a deploy, same reasoning `disabledApps` already
 * has for turning an app off without touching its manifest.
 *
 * Stored under LOCAL_ONLY_PREFIX (see `@qu/sync`'s `sync-engine.js`) - this
 * relay's OWN settings must never sync out to a peer relay, and `@qu/sync`
 * refuses any INCOMING synced write under this prefix too, so it can't be
 * clobbered by a peer either. Read publicly by the relay's own `/config.json`
 * route (see `http-router.js`); written only via the signed, admin-checked
 * `POST /admin/settings` route (see `admin-http.js`) - never through the
 * normal `qu.put()` pipeline a regular client could reach.
 */
const RELAY_SETTINGS_PATH = '/store/secure/admin/settings';

export const DEFAULT_RELAY_SETTINGS = Object.freeze({
  defaultLocale: 'en',
  rateLimits: Object.freeze({ maxMessagesPerMinute: 0 }), // 0 = unlimited
  disabledApps: Object.freeze([]),
  // Apps still fully enabled (loaded, reachable at #/<name>, its
  // contributions still active) but hidden from apps/app-list's own browse
  // page. Distinct from `disabledApps`: hiding is purely a discoverability/
  // declutter concern (still fully functional wherever it's actually used),
  // disabling turns the app off entirely. Two reasons an app ends up here by
  // DEFAULT (an admin can still edit this list via `POST /admin/settings` -
  // these are a starting point, not a hardcoded rule):
  //   - No genuine standalone page of its own - a plugin that only ever
  //     renders through another app's extension point (`pins`, `reactions`
  //     - each declares a `clientMain` because ExtensionPointHost needs one
  //     to dynamically import it as a CONTRIBUTOR, not because it has
  //     anything useful to show if a user actually navigates to `#/pins`
  //     directly - no `mount()` export at all, in fact).
  //   - Already reachable from a fixed spot in the shell's own default UI,
  //     so listing it again here is pure redundancy: `notifications` (the
  //     header's bell), `profile` (the avatar menu's own Profile/Settings
  //     links), `app-list` (itself - listing itself inside itself is
  //     circular), `search` (the header's always-visible search icon),
  //     `relay-admin` (the avatar menu's own Relay Admin link, admin-only).
  hiddenFromAppList: Object.freeze(['pins', 'reactions', 'notifications', 'profile', 'app-list', 'search', 'relay-admin']),
  // Admin-editable Flag TYPE catalog - what a "flag" even IS is data, not
  // code, same reasoning as `disabledApps`. Shipped with a sane starter set
  // so liking/favoriting works out of the box with zero admin action; the
  // entity kinds here are exactly the ones @qu/services' FavoritesService
  // ('app'), ContactsService ('user') and ReactionService/MessageService
  // ('thread-message') already support.
  flagTypes: Object.freeze([
    Object.freeze({ id: 'favorite', label: 'Favorite', icon: '⭐', mode: 'private', entityKinds: Object.freeze(['app', 'user']) }),
    Object.freeze({ id: 'like', label: 'Like', icon: '👍', mode: 'public', entityKinds: Object.freeze(['thread-message']) }),
  ]),
  // Who may create a Channel-shaped group (today: `apps/forum`'s
  // `ChannelService.createChannel()`; named generically, not `forum.*`,
  // because `THREAD_PRESETS.chat()`/`group()` already back a future Chat
  // "create group" flow with the exact same shape - see that module's own
  // doc comment). `allowMemberCreate: false` and `allowMemberRestricted:
  // false` still let this relay's own `adminPubs` create channels/restricted
  // channels regardless - an admin is never locked out by their own policy.
  // NOTE - honored CLIENT-SIDE only today (`apps/forum/client.js` hides the
  // form): `ChannelService.createChannel()` stores a channel exactly like
  // `createTopic()` stores a topic, both plain `documentPath()` "docs" -
  // there is no path-level way yet to tell "a new channel" apart from "a new
  // topic" for a pipeline Engine (`@qu/engines`' `AccessEngine`-style) to
  // gate generically. Real enforcement needs channel documents to get their
  // own distinguishable path/kind first - real, valuable follow-up work, not
  // done here to avoid gating on a value-shape heuristic instead.
  channels: Object.freeze({ allowMemberCreate: true, allowMemberRestricted: false }),
  // Who may create a Chat group (`apps/chat`'s `ChatService.createGroup()`,
  // via `THREAD_PRESETS.group()`) - the exact same shape `channels` above
  // already anticipated (see this file's own comment there: "THREAD_PRESETS.
  // chat()/group() already back a future Chat 'create group' flow with the
  // exact same shape"). No `allowMemberRestricted` counterpart here - unlike
  // a Channel, a chat room/group is ALWAYS reader-restricted (genuinely
  // encrypted for its fixed member list, never a public option), so there is
  // no "restricted vs open" distinction left to gate. `allowMemberCreateGroup:
  // false` still lets this relay's own `adminPubs` create a group regardless -
  // same "an admin is never locked out by their own policy" rule `channels`
  // already has. NOTE - honored CLIENT-SIDE only today, same documented scope
  // as `channels` above: `apps/chat/client.js` hides the "+ New group" link
  // and gates its own create-group form, but nothing yet stops a modified
  // client from calling `services.chat.createGroup()` directly - real
  // server-side enforcement needs a distinguishable path/kind for a chat
  // group's thread config the same way `channels`' own note describes.
  chat: Object.freeze({ allowMemberCreateGroup: true }),
  // Admin-editable, cross-app-consistent ordering for extension-point items
  // - `{[point]: [id, ...]}`, consulted by `@qu/foundation`'s
  // `ExtensionPointHost` (via `rankFor()`, see that module's own doc
  // comment) to sort BOTH manifest-declared plugin contributors AND a host
  // app's own native items (`core.<name>` ids) for the same point, so e.g.
  // "reactions on the left, the read-tick on the right" is ONE setting that
  // renders identically wherever `content.messageFooter` appears (both
  // `apps/forum` and `apps/chat` today), not a per-app hardcoded order. An
  // id absent from a point's list here keeps its own manifest/hardcoded
  // default order, appended after every explicitly configured id - see
  // `rankFor()`'s own doc comment for the exact precedence.
  extensionOrder: Object.freeze({}),
  // Server-side Open Graph unfurling for URLs typed into chat/forum
  // messages (see `link-preview.js`'s own doc comment for why this is
  // relay-side rather than a direct client fetch: IP-leak + CORS). An
  // admin-visible kill switch, not a per-domain allowlist/blocklist - the
  // SSRF defense itself (private/internal address ranges) is a hard-coded
  // safety floor in `link-preview.js`, never something a relay operator
  // should be able to loosen via this setting.
  linkPreviews: Object.freeze({ enabled: true }),
  // How many items a platform-owned chrome nav/views/settings section
  // (`apps/shell/src/chrome.js`) shows directly before collapsing the rest
  // into a "More…" trigger - see that file's own doc comment for the full
  // "Chrome Inversion" reasoning. An admin-tunable UX call (how many
  // channels/views fit before a list gets unwieldy), not a fixed constant,
  // same reasoning `rateLimits`/`channels` already have for being data here
  // rather than a hardcoded number in `chrome.js`. Does not apply to a
  // `list:`-registered (reactive `<qu-list>`-backed) section - see
  // `chrome.js`'s `applyMenuThreshold()` doc comment for why capping a live,
  // keyed-reconciliation list needs its own separate solution, not this one.
  chrome: Object.freeze({ menuThreshold: 8 }),
  // RELAY FEDERATION - see `@qu/relay`'s `FederationManager` for the
  // mechanism this config drives (relay-to-relay sync, built on the exact
  // same `@qu/sync` protocol client<->relay sync already uses).
  federation: Object.freeze({
    // OFF by default - a client-suggested peer (see `http-router.js`'s
    // `POST /federation/suggest`) lands in `pending` for an admin to
    // approve, rather than being dialed automatically the instant a
    // (possibly compromised) client reports a URL. An admin who wants
    // automatic onboarding of client-discovered relays can opt in.
    autoLearn: false,
    // How many further relays a single on-demand forwarded query (a local
    // cache miss - see `SyncEngine`'s `onLocalMiss` hook) may transit
    // before giving up - bounds worst-case fan-out/latency in a mesh of
    // federated relays, not a security boundary (this relay has no
    // read/subscribe ACL to begin with - see `FederationManager.forward()`'s
    // own doc comment).
    hopLimit: 3,
    // Per-hop timeout for that same on-demand forwarding - deliberately its
    // own, shorter budget, independent of whatever timeout the ORIGINAL
    // requester is itself waiting on (see `FederationManager.forward()`).
    hopTimeoutMs: 3000,
    // Consecutive failed (re)connect attempts to a peer before it's marked
    // `dead` and this relay stops auto-retrying it (see
    // `FederationManager#connectPeer()`) - the peer configuration itself is
    // NEVER removed, only its live connection attempts stop; an admin can
    // retry it manually.
    tryLimit: 10,
    // Every relay THIS relay dials out to, as an ordinary outbound
    // WebSocket client of that peer's own public sync endpoint - see
    // `FederationManager`'s own top doc comment. Each entry:
    // `{url, relayId, label, prefixes, addedAt, addedBy, source}` -
    // `relayId` starts unset and gets trust-on-first-use PINNED (persisted
    // back here) the first time a `relay-hello-ack` verifies; `prefixes` is
    // what this relay actively subscribes to + backfills from that peer
    // (eager replication) - a peer with an empty `prefixes` list is still
    // dialed/handshaked (so it can serve on-demand forwarded lookups - see
    // `FederationManager.forward()`) but replicates nothing proactively.
    peers: Object.freeze([]),
    // Client-suggested peers (see `POST /federation/suggest`) awaiting
    // admin approval, since `autoLearn` defaults to off - each entry:
    // `{url, relayId, suggestedBy, suggestedAt}`. An admin approves one by
    // moving it into `peers` (and removing it from here) via the admin UI's
    // own federation section, or rejects it by removing it from here alone.
    pending: Object.freeze([]),
    // URLs and/or relayIds (either form - see `FederationManager`'s own
    // `#isBlacklisted()`) this relay will never dial out to, accept a
    // `relay-hello` from, or auto-learn from a client suggestion, even if
    // `autoLearn` is on. Checked before `autoLearn` ever applies.
    blacklist: Object.freeze([]),
  }),
});

/**
 * @param {import('@qu/core').QuStore} qu
 * @returns {Promise<{defaultLocale: string, rateLimits: {maxMessagesPerMinute: number}, disabledApps: string[], hiddenFromAppList: string[], flagTypes: Array<{id: string, label: string, icon: string, mode: string, entityKinds: string[]}>, channels: {allowMemberCreate: boolean, allowMemberRestricted: boolean}, chat: {allowMemberCreateGroup: boolean}, extensionOrder: Record<string, string[]>, linkPreviews: {enabled: boolean}, chrome: {menuThreshold: number}}>}
 *   Always fully populated - missing fields fall back to `DEFAULT_RELAY_SETTINGS`.
 */
export async function getSettings(qu) {
  const stored = await qu.get(RELAY_SETTINGS_PATH);
  const val = stored?.val ?? {};
  return {
    ...DEFAULT_RELAY_SETTINGS,
    ...val,
    rateLimits: { ...DEFAULT_RELAY_SETTINGS.rateLimits, ...val.rateLimits },
    channels: { ...DEFAULT_RELAY_SETTINGS.channels, ...val.channels },
    chat: { ...DEFAULT_RELAY_SETTINGS.chat, ...val.chat },
    extensionOrder: { ...DEFAULT_RELAY_SETTINGS.extensionOrder, ...val.extensionOrder },
    linkPreviews: { ...DEFAULT_RELAY_SETTINGS.linkPreviews, ...val.linkPreviews },
    chrome: { ...DEFAULT_RELAY_SETTINGS.chrome, ...val.chrome },
    federation: { ...DEFAULT_RELAY_SETTINGS.federation, ...val.federation },
  };
}

/**
 * @param {import('@qu/core').QuStore} qu
 * @param {object} patch - Shallow-merged into the current settings (a
 *   nested `rateLimits` patch replaces that whole sub-object - a caller
 *   sending a partial rate-limits patch loses the untouched fields, same
 *   "send the full sub-object" contract every other Service's `update()`
 *   in this codebase already has for a nested field).
 * @returns {Promise<object>} The merged, persisted settings.
 */
export async function saveSettings(qu, patch) {
  const merged = { ...(await getSettings(qu)), ...patch };
  await qu.put(RELAY_SETTINGS_PATH, merged);
  return merged;
}

export { RELAY_SETTINGS_PATH };
