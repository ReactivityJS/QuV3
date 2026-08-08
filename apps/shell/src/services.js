import { ListService, FlagService, ContactsService, FavoritesService, ProfileService, DirectoryService, ActorService } from '@qu/services';

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
  return {
    contacts: new ContactsService(flags, identity),
    favorites: new FavoritesService(flags),
    profile: new ProfileService(qu, identity, syncFetch, getGeneration),
    directory: new DirectoryService(qu, identity, list),
    actors: new ActorService(identity),
  };
}
