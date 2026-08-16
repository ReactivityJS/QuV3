/**
 * TODO — server-side half. Like Calendar/Chat, every shared list lives
 * under this app's ONE fixed space (`manifest.spaceId`) - see `client.js`'s
 * own top doc comment for why. Nothing else to bootstrap server-side: every
 * list is created lazily by whoever first uses the app.
 *
 * Unlike Calendar (which needs a `notify.threadCandidates` hook to
 * disambiguate TWO different `'create'`-type push actions sharing the same
 * `invite-<actorPub>` mailbox shape - calendar invites vs. per-event guest
 * invites), this app has only ONE `'create'`-type `pushActions` entry
 * (`invite`, which BOTH list invites and task-assignment notifications
 * share - both post into that same mailbox via `MessageService.notify()`),
 * so `@qu/relay`'s manifest-driven resolver's own default type-based match
 * already lands on it correctly with no extra wiring here.
 */
export async function register(qu, manifest) {
  console.log(`[${manifest.name}] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
