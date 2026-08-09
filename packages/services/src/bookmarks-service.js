/**
 * BOOKMARKS SERVICE — a private, per-identity "save this for later" list
 * over content that isn't necessarily this identity's own (forum messages,
 * to start). Same thin-wrapper-over-`FlagService` shape as
 * `FavoritesService` (see its own doc comment) - `FlagService`'s private
 * mode (self-encrypted, listed via `listPrivate()`) already IS the generic
 * "Drupal-Flag-style mark/like/bookmark mechanism", this class just fixes
 * `flagType`/`entityKind` so callers never repeat those two string
 * constants (or risk a typo splitting one bookmark list into two).
 *
 * `entityKind` is scoped to `'forumMessage'` specifically, not a generic
 * `'content'` - matches `FavoritesService`'s own `'app'` scoping: the
 * closest real need, not speculative generality ahead of a second content
 * kind actually wanting bookmarks (a future one would get its own
 * `entityKind`, still through this same `FlagService` primitive).
 */
const FLAG_TYPE = 'bookmark';
const ENTITY_KIND = 'forumMessage';

export class BookmarksService {
  /** @param {import('./flag-service.js').FlagService} flagService */
  constructor(flagService) {
    this.flags = flagService;
  }

  /**
   * @param {string} messageId
   * @param {object} [snapshot] - A small, self-contained copy of the
   *   bookmarked message (e.g. `{body, author, spaceId, threadId}`) - a
   *   "My Bookmarks" view can render straight from this without needing to
   *   re-fetch/re-decrypt the original message (which, being a DERIVED
   *   list entry, has no dedicated permalink/re-fetch-by-id path of its
   *   own yet - see apps/forum's own doc comment on that scope cut).
   */
  async add(messageId, snapshot = {}) {
    return this.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, messageId, true, snapshot);
  }

  /** @param {string} messageId */
  async remove(messageId) {
    return this.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, messageId, false);
  }

  /** @param {string} messageId @returns {Promise<boolean>} */
  async isBookmarked(messageId) {
    return this.flags.hasPrivate(FLAG_TYPE, ENTITY_KIND, messageId);
  }

  /**
   * @returns {Promise<Array<{id: string, starredAt: number, [key: string]: *}>>}
   *   Unsorted, same as `FlagService.listPrivate()` itself returns - sort
   *   by `starredAt` (or anything else) is the caller's job.
   */
  async list() {
    return this.flags.listPrivate(FLAG_TYPE, ENTITY_KIND);
  }
}
