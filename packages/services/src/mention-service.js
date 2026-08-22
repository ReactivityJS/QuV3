import { actorMentionPath, actorMentionsParentPath } from './paths.js';
import { extractMentions } from './thread-formatting.js';

/**
 * MENTION SERVICE — the "Mentionable" Capability (Quniverse V4, see
 * docs/v4-concept.md §4), generalizing `thread-formatting.js`'s
 * `extractMentions()` (already real, see that file's own doc comment) with
 * the one real gap it doesn't cover: a stored REVERSE index for "what
 * mentions me" (`mentionedIn()`), which cannot be derived without storage.
 *
 * The FORWARD direction (`mentionsOf()`) deliberately has NO stored index -
 * it's a thin, stateless passthrough to `extractMentions()`. Recomputing
 * from the CURRENT text is always correct, including after
 * `MessageService.editMessage()`/`EntityService.updateEntity()` - a stored
 * forward index would silently go stale the moment content is edited,
 * without anything here ever re-syncing it.
 *
 * `indexMentions()` writes one signed QuBit per mentioned actor into THEIR
 * OWN global mention list (`actorMentionPath()`), signed by the CONTENT'S
 * AUTHOR (whoever called this), not the mentioned actor - same "path is
 * addressing, not trust" caveat `ReactionService`'s own doc comment
 * documents: `mentionedIn()`'s results are only as trustworthy as their own
 * verified `pub`, never the path alone.
 *
 * SCOPE CUT (documented, not fixed): re-indexing an edited text that now
 * mentions FEWER actors than before does not remove the now-stale entry for
 * a no-longer-mentioned actor - reconciling a mention index against edits is
 * real added complexity nothing has asked for yet (see
 * docs/v4-concept.md's Phase 2 plan).
 */
export class MentionService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./list-service.js').ListService} listService
   */
  constructor(qu, identityEngine, listService) {
    this.qu = qu;
    this.identity = identityEngine;
    this.list = listService;
  }

  /** @returns {Promise<{privateKeyPkcs8: ArrayBuffer, publicKey: Uint8Array}>} */
  async #signingKey(asSpaceId) {
    return asSpaceId ? this.identity.getSpaceKey(asSpaceId) : this.identity.getMainKey();
  }

  /**
   * Pure, stateless - see class doc comment for why this has no stored index.
   * @param {string} text @returns {string[]} Unique candidate actor ids mentioned in `text`.
   */
  mentionsOf(text) {
    return extractMentions(text);
  }

  /**
   * Extracts every mention in `text` and writes a marker into each mentioned
   * actor's own global mention index.
   * @param {string|number} spaceId @param {string} entityKind @param {string} entityId
   * @param {string} text
   * @param {{asSpaceId?: string|number}} [options]
   * @returns {Promise<string[]>} The mentioned actor ids (same as `mentionsOf(text)`).
   */
  async indexMentions(spaceId, entityKind, entityId, text, { asSpaceId = null } = {}) {
    const mentioned = this.mentionsOf(text);
    if (mentioned.length === 0) return mentioned;

    const signKey = await this.#signingKey(asSpaceId);
    const writeOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };
    await Promise.all(
      mentioned.map((mentionedActorPub) =>
        this.qu.put(actorMentionPath(mentionedActorPub, spaceId, entityKind, entityId), { mentionedAt: Date.now() }, writeOptions)
      )
    );
    return mentioned;
  }

  /**
   * @param {string} actorPub
   * @returns {Promise<Array<{spaceId: string, entityKind: string, entityId: string, mentionedAt: number}>>}
   *   Everything that currently mentions `actorPub`, across every space and
   *   entity kind - unsorted, same as `ListService.listDerived()` itself
   *   returns.
   */
  async mentionedIn(actorPub) {
    const entries = await this.list.listDerived(actorMentionsParentPath(actorPub));
    return entries
      .filter((e) => e.quBit.val)
      .map((e) => {
        const key = e.path.slice(e.path.lastIndexOf('/') + 1);
        const [spaceId, entityKind, entityId] = key.split('~');
        return { spaceId, entityKind, entityId, mentionedAt: e.quBit.val.mentionedAt };
      });
  }
}
