/**
 * REACTIONS — server-side half. Purely a UI plugin (a `content.messageReactions`
 * contribution rendered from WITHIN whatever host app defines that point -
 * currently `apps/forum`, see client.js) - nothing to register here, but
 * every loadable package still needs a `main` module per its manifest (see
 * `@qu/foundation`'s manifest schema), so this stays a documented no-op
 * rather than pointing `main` at nothing. `ReactionService`'s storage needs
 * no server-side setup at all (thread-scoped, same as `MessageService`).
 */
export async function register(qu, manifest) {
  console.log(`[reactions] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
