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
});

/**
 * @param {import('@qu/core').QuStore} qu
 * @returns {Promise<{defaultLocale: string, rateLimits: {maxMessagesPerMinute: number}, disabledApps: string[], flagTypes: Array<{id: string, label: string, icon: string, mode: string, entityKinds: string[]}>, channels: {allowMemberCreate: boolean, allowMemberRestricted: boolean}}>}
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
