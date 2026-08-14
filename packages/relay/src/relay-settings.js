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
  // page - for an app with no genuine standalone page of its own (a plugin
  // that only ever renders through another app's extension point, e.g.
  // apps/pins - it declares a `clientMain` because ExtensionPointHost needs
  // one to dynamically import it as a CONTRIBUTOR, not because it has
  // anything useful to show if a user actually navigates to `#/pins`
  // directly - no `mount()` export at all, in fact). Distinct from
  // `disabledApps`: hiding is purely a discoverability/declutter concern
  // (still fully functional wherever it's actually used), disabling turns
  // the app off entirely.
  hiddenFromAppList: Object.freeze([]),
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
});

/**
 * @param {import('@qu/core').QuStore} qu
 * @returns {Promise<{defaultLocale: string, rateLimits: {maxMessagesPerMinute: number}, disabledApps: string[], hiddenFromAppList: string[], flagTypes: Array<{id: string, label: string, icon: string, mode: string, entityKinds: string[]}>, channels: {allowMemberCreate: boolean, allowMemberRestricted: boolean}, chat: {allowMemberCreateGroup: boolean}, extensionOrder: Record<string, string[]>, linkPreviews: {enabled: boolean}}>}
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
