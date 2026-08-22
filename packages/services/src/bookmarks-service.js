/**
 * BOOKMARKS SERVICE — a private, per-identity "save this for later" list
 * over content that isn't necessarily this identity's own (forum messages,
 * to start). Same thin-wrapper-over-`FlagService` shape as
 * `FavoritesService` (see its own doc comment) - `FlagService`'s private
 * mode (self-encrypted, listed via `listPrivate()`) already IS the generic
 * "Drupal-Flag-style mark/like/bookmark mechanism", this class just fixes
 * `flagType` so callers never repeat that string constant (or risk a typo
 * splitting one bookmark list into two).
 *
 * `entityKind` DEFAULTS to `'forumMessage'` (this Service's original, only
 * caller - Forum - needs zero changes) but is now an optional parameter, not
 * a hard-coded constant - Quniverse V4's "first capability migration"
 * (docs/v4-concept.md §2/§7): the exact same `FlagService`-wrapper shape
 * this class already was now ALSO bookmarks a generic `EntityService`-created
 * Entity (`entityKind: 'entity'`), proving one Capability implementation
 * spans both the legacy Thread-message shape and the new generic Entity
 * shape without forking any logic - not a new capability, a generalization
 * of this one. A future second real content kind gets its own `entityKind`
 * string too, still through this same `FlagService` primitive - no
 * speculative generality beyond making the parameter not-hard-coded.
 */
const FLAG_TYPE = 'bookmark';
const DEFAULT_ENTITY_KIND = 'forumMessage';

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
   * @param {string} [entityKind] - Defaults to `'forumMessage'` - pass
   *   `'entity'` to bookmark a generic Entity (see class doc comment).
   */
  async add(messageId, snapshot = {}, entityKind = DEFAULT_ENTITY_KIND) {
    return this.flags.setPrivate(FLAG_TYPE, entityKind, messageId, true, snapshot);
  }

  /** @param {string} messageId @param {string} [entityKind] */
  async remove(messageId, entityKind = DEFAULT_ENTITY_KIND) {
    return this.flags.setPrivate(FLAG_TYPE, entityKind, messageId, false);
  }

  /** @param {string} messageId @param {string} [entityKind] @returns {Promise<boolean>} */
  async isBookmarked(messageId, entityKind = DEFAULT_ENTITY_KIND) {
    return this.flags.hasPrivate(FLAG_TYPE, entityKind, messageId);
  }

  /**
   * @param {string} [entityKind] - Defaults to `'forumMessage'` - each
   *   `entityKind` has its own independent list (bookmarking an Entity never
   *   shows up in the forum-message list or vice versa).
   * @returns {Promise<Array<{id: string, starredAt: number, [key: string]: *}>>}
   *   Unsorted, same as `FlagService.listPrivate()` itself returns - sort
   *   by `starredAt` (or anything else) is the caller's job.
   */
  async list(entityKind = DEFAULT_ENTITY_KIND) {
    return this.flags.listPrivate(FLAG_TYPE, entityKind);
  }
}
