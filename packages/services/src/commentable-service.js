/**
 * COMMENTABLE SERVICE — the "Commentable" Capability (Quniverse V4, see
 * docs/v4-concept.md §4), closing the one Capability that table still listed
 * as "reuse existing, not wired yet." A thin wrapper over `MessageService`,
 * same shape as `FollowService`/`TagService` wrapping `FlagService`: no new
 * storage, no new Engine, just fixed naming so a caller never has to decide
 * what a comment thread's own `threadId` should be.
 *
 * Uses the ENTITY'S OWN id as the attached comment Thread's `threadId` -
 * exactly the "same id, no separate concept" convention `ChannelService`'s
 * own doc comment already established for Topic<->Thread (there, a Topic IS
 * its Thread); this Service applies that one layer up, for ANY commentable
 * Entity, and for COMMENTS specifically rather than the entity's own content
 * (an Entity's `content` field - see `content.js` - and its attached
 * comments are deliberately two different things, an earlier V4 decision:
 * a commentable Entity has its OWN content, comments are a separate,
 * attached Thread, not "content = the thread's first message").
 *
 * `enableComments()` mirrors `createThread()`'s own idempotency - safe to
 * call every time an Entity is created, no separate "does this already have
 * comments" check needed by callers.
 */
export class CommentableService {
  /** @param {import('./message-service.js').MessageService} messageService */
  constructor(messageService) {
    this.messages = messageService;
  }

  /**
   * @param {string|number} spaceId @param {string} entityId
   * @param {object} [config] - See `MessageService.createThread()`'s own
   *   `config` doc comment / `THREAD_PRESETS` - the caller decides the
   *   comment thread's own writers/readers/formatting, typically mirroring
   *   the entity's own protection level (e.g. a restricted channel's topic).
   * @returns {Promise<object>} The comment thread's config (existing or newly created).
   */
  async enableComments(spaceId, entityId, config = {}) {
    return this.messages.createThread(spaceId, entityId, config);
  }

  /**
   * @param {string|number} spaceId @param {string} entityId @param {string} body
   * @param {{replyTo?: string, asSpaceId?: string|number, extra?: object}} [options]
   * @returns {Promise<object>} The stored comment.
   */
  async postComment(spaceId, entityId, body, options = {}) {
    return this.messages.postMessage(spaceId, entityId, { body, ...options });
  }

  /**
   * AUTHOR-ONLY - enforced by `MessageService.editMessage()` itself.
   * @param {string|number} spaceId @param {string} entityId @param {string} commentId @param {string} body
   * @param {{asSpaceId?: string|number}} [options]
   * @returns {Promise<object>} The updated comment.
   */
  async editComment(spaceId, entityId, commentId, body, options = {}) {
    return this.messages.editMessage(spaceId, entityId, commentId, { body, ...options });
  }

  /**
   * @param {string|number} spaceId @param {string} entityId
   * @param {{limit?: number, order?: 'asc'|'desc', cursor?: string}} [options]
   * @returns {Promise<{messages: object[], nextCursor: string|null}>}
   */
  async listComments(spaceId, entityId, options = {}) {
    return this.messages.listMessages(spaceId, entityId, options);
  }

  /**
   * @param {string|number} spaceId @param {string} entityId @param {string} commentId
   * @returns {Promise<object|null>}
   */
  async getComment(spaceId, entityId, commentId) {
    return this.messages.getMessage(spaceId, entityId, commentId);
  }
}
