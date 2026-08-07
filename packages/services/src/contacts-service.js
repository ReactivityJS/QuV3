const FLAG_TYPE = 'favorite';
const ENTITY_KIND = 'user';

/**
 * CONTACTS SERVICE — "people I know", `flagType: 'favorite'` on
 * `entityKind: 'user'` over the universal `FlagService` - the same
 * "favoriting" concept `FavoritesService` is for apps, one layer up, with
 * each entry resolved against its public profile for display.
 */
export class ContactsService {
  /**
   * @param {import('./flag-service.js').FlagService} flagService
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   */
  constructor(flagService, identityEngine) {
    this.flags = flagService;
    this.identity = identityEngine;
  }

  /**
   * @param {string} actorPub - base64url Ed25519 public key of the contact.
   * @param {object} [data] - Optional local-only metadata (e.g. a nickname).
   * @returns {Promise<Array<object>>}
   */
  async addContact(actorPub, data = {}) {
    return this.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, actorPub, true, data);
  }

  /** @param {string} actorPub @returns {Promise<Array<object>>} */
  async removeContact(actorPub) {
    return this.flags.setPrivate(FLAG_TYPE, ENTITY_KIND, actorPub, false);
  }

  /**
   * @returns {Promise<Array<{actorPub: string, starredAt: number, profile: object|null}>>}
   *   Every contact, with their CURRENT public profile resolved (null if
   *   they haven't published one, or it no longer verifies).
   */
  async listContacts() {
    const starred = await this.flags.listPrivate(FLAG_TYPE, ENTITY_KIND);
    return Promise.all(
      starred.map(async ({ id, starredAt, ...data }) => ({
        actorPub: id,
        starredAt,
        ...data,
        profile: await this.identity.getProfile(id),
      }))
    );
  }

  /** @param {string} actorPub @returns {Promise<boolean>} */
  async isContact(actorPub) {
    return this.flags.hasPrivate(FLAG_TYPE, ENTITY_KIND, actorPub);
  }
}
