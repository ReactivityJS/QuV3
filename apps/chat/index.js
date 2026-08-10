/**
 * CHAT — server-side half. UI-only (see client.js): unlike `apps/forum`,
 * there is no fixed public thread to seed at boot - a room only ever exists
 * once two members (or a group creator) actually open one, entirely
 * client-side (`services.chat.ensureRoom()`/`.createGroup()`). Documented
 * no-op, same reasoning `apps/bookmarks/index.js`/`apps/notifications/index.js`
 * already have for the same shape.
 */
export async function register(qu, manifest) {
  console.log(`[chat] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
