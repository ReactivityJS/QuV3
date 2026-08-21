/**
 * PINS — server-side half. Purely a UI plugin (a `content.messageMenu`
 * + `content.topicToolbar` contribution rendered from WITHIN whatever host
 * app defines those points - `apps/forum` and `apps/chat` both do, see client.js) -
 * nothing to register here, but every loadable package still needs a
 * `main` module per its manifest (see `@qu/foundation`'s manifest schema),
 * so this stays a documented no-op rather than pointing `main` at nothing.
 * `PinService`'s storage needs no server-side setup at all (thread-scoped,
 * same as `MessageService`/`ReactionService`).
 */
export async function register(qu, manifest) {
  console.log(`[pins] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
