/**
 * FOLLOW SERVICE — the "Followable" Capability (Quniverse V4, see
 * docs/v4-concept.md §4), a private, per-identity "notify me about this"
 * list. Same thin-wrapper-over-`FlagService` shape as `BookmarksService`/
 * `FavoritesService`/`ContactsService` (see those files' own doc comments) -
 * `FlagService`'s private mode already IS the generic mechanism, this class
 * just fixes `flagType` so callers never repeat that string constant.
 *
 * Unlike `BookmarksService`, `entityKind` is a REQUIRED parameter here, not
 * defaulted - Follow has no single legacy caller to default for (it's a
 * brand-new capability, not a generalization of an existing one), so there
 * is no "original" `entityKind` to make implicit. A caller follows a Forum
 * Topic, a generic Entity, or a User by simply passing the `entityKind` it
 * already knows, same discipline `flagPath()`'s own doc comment describes.
 */
const FLAG_TYPE = 'follow';

export class FollowService {
  /** @param {import('./flag-service.js').FlagService} flagService */
  constructor(flagService) {
    this.flags = flagService;
  }

  /**
   * @param {string} entityKind @param {string} entityId
   * @param {object} [data] - Extra fields to store alongside (e.g. a snapshot for a "Following" list).
   */
  async follow(entityKind, entityId, data = {}) {
    return this.flags.setPrivate(FLAG_TYPE, entityKind, entityId, true, data);
  }

  /** @param {string} entityKind @param {string} entityId */
  async unfollow(entityKind, entityId) {
    return this.flags.setPrivate(FLAG_TYPE, entityKind, entityId, false);
  }

  /** @param {string} entityKind @param {string} entityId @returns {Promise<boolean>} */
  async isFollowing(entityKind, entityId) {
    return this.flags.hasPrivate(FLAG_TYPE, entityKind, entityId);
  }

  /**
   * @param {string} entityKind
   * @returns {Promise<Array<{id: string, starredAt: number, [key: string]: *}>>}
   *   Unsorted, same as `FlagService.listPrivate()` itself returns.
   */
  async listFollowed(entityKind) {
    return this.flags.listPrivate(FLAG_TYPE, entityKind);
  }
}
