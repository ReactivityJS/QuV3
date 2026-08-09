/**
 * NOTIFICATIONS — server-side half. Purely a UI app (a live feed over this
 * identity's own notifications Thread, written by `@qu/relay`'s
 * `PushDeliveryService` - see client.js) - nothing to register here, but
 * every loadable package still needs a `main` module per its manifest (see
 * @qu/foundation's manifest schema), so this stays a documented no-op
 * rather than pointing `main` at nothing. The notifications Thread itself
 * is created lazily, by whichever relay first delivers a notification to a
 * given identity (`PushDeliveryService#writeInAppNotification()`'s own
 * `createThread()` call is idempotent) - this app never needs to create it.
 */
export async function register(qu, manifest) {
  console.log(`[notifications] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
