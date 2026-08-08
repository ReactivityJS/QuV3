import { QuCrypto } from '@qu/core';
import { actorPath } from '@qu/identity';
import { putPrivate, getPrivate } from './private-storage.js';
import { createFreshnessTracker } from './sync-freshness.js';

/** @param {string} actorPub @returns {string} */
function privateExtraPath(actorPub) {
  return `/store/actors/~${actorPub}/private/profile-extra`;
}

/**
 * PROFILE SERVICE — the Entity API for "my editable profile", built on top
 * of @qu/identity's already-existing public profile (`publishMainProfile()`/
 * `getProfile()`) plus `private-storage.js`'s self-encryption, the same
 * mechanism `FlagService`'s private mode uses for favorites/contacts.
 *
 * The split this adds beyond what `QuIdentityEngine` already does: a
 * profile here is `alias` + `avatar` (always public - Contacts/User List
 * need them to show anyone at all) plus an arbitrary, owner-defined list of
 * custom `fields`, each individually flagged `'public'` or `'private'`:
 *   - `'public'` fields are merged into the same signed, unencrypted
 *     document `getProfile()` already publishes - visible to anyone, no
 *     different from `alias`/`avatar`.
 *   - `'private'` fields are self-encrypted (see `private-storage.js`) at a
 *     SEPARATE path - visible only to this identity itself when it calls
 *     `getOwnProfile()` again. This is NOT "visible to trusted contacts
 *     only" (that's what `@qu/identity`'s attestation mechanism is for, a
 *     different sharing model) - a private field here means "I keep this
 *     in my own profile as a personal note/reminder, nobody else ever
 *     sees it", the simplest possible reading of "private toggle".
 *
 * Also public (visible to every visitor): `template`/`style` - which layout
 * and accent palette `apps/profile` renders THIS identity's public page
 * with (see `@qu/ui`'s `THEME_PRESETS` for `style`'s value space) - a
 * genuinely new concept, no QuV2 precedent, requested directly by the user.
 *
 * Also PRIVATE, but NOT part of the free-form `fields` list -
 * `preferredLocale`/`preferredTheme`: this identity's own device-agnostic
 * language/theme preference, synced across ITS OWN devices via the same
 * self-encryption every other private field uses, applied to a NEW device
 * at `apps/shell` boot by writing it into `@qu/i18n`'s/`@qu/ui`'s existing
 * device-local mechanisms (`setLocale()`/`setStoredTheme()`) - see
 * `apps/shell/client.js`'s own doc comment for why this round deliberately
 * does NOT make `createI18n()`/`ensureTheme()` themselves async or
 * identity-aware. Kept as dedicated fields, not entries in the free-form
 * `fields` list, so a user's own custom field literally named
 * "preferredLocale" can never collide with this reserved one - the private
 * extra document's shape is `{customFields: {key: value}, preferredLocale,
 * preferredTheme}`, not a flat merge of all three.
 *
 * Ported essentially unchanged from QuV2 for the `alias`/`avatar`/`fields`
 * core - every piece it builds on (`private-storage.js`, `sync-freshness.js`,
 * `@qu/identity`'s `publishMainProfile()`/`getProfile()`/`actorPath()`)
 * already exists in V3 with an identical shape.
 */
export class ProfileService {
  #backgroundRefresh;

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   `SyncEngine.fetch()` (see @qu/sync), for backfilling a profile this
   *   identity doesn't have LOCALLY yet. Without it, `getPublicProfile()`
   *   for someone whose profile was published before this session
   *   subscribed would return null forever, no matter how long it waits.
   * @param {() => number} [getGeneration] - Optional: `SyncEngine.getGeneration()`
   *   (see @qu/sync) - background-refreshes an already-cached profile that
   *   might have changed (new alias/avatar) while this session was offline
   *   (see `sync-freshness.js`).
   */
  constructor(qu, identityEngine, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * Publishes (or replaces) this identity's whole profile - both the public
   * document and the private extra document. Replaces wholesale rather
   * than patching, so removing a field is just not including it in
   * `fields` - see `getOwnProfile()` for the read shape this mirrors.
   *
   * @param {{alias?: string, avatar?: string, template?: string, style?: string, fields?: Array<{key: string, value: string, visibility: 'public'|'private'}>, preferredLocale?: string|null, preferredTheme?: string|null}} profile
   *   `template`/`style` are PUBLIC (part of the signed document, like
   *   `alias`/`avatar`). `preferredLocale`/`preferredTheme` are PRIVATE and
   *   deliberately NOT part of `fields` - see this class's own doc comment.
   * @returns {Promise<string>} This identity's actor pubkey (base64url).
   */
  async saveProfile({ alias = '', avatar = '', template = '', style = '', fields = [], preferredLocale = null, preferredTheme = null }) {
    const publicExtra = {};
    const customFields = {};
    for (const { key, value, visibility } of fields) {
      if (!key) continue;
      if (visibility === 'private') customFields[key] = value;
      else publicExtra[key] = value;
    }

    const actorPub = await this.identity.publishMainProfile({ alias, avatar, template, style, ...publicExtra });
    await putPrivate(this.qu, this.identity, privateExtraPath(actorPub), { customFields, preferredLocale, preferredTheme });
    return actorPub;
  }

  /**
   * This identity's OWN full profile, public and private fields both
   * resolved and merged back into one `fields` list (each tagged with
   * where it came from) - the shape the editor UI round-trips through
   * `saveProfile()`. Nobody but this identity can ever call this
   * meaningfully for itself; there is no "get someone else's private
   * fields" - see `getPublicProfile()` for what a THIRD PARTY sees instead.
   *
   * @returns {Promise<{pub: string, epub: string, alias: string, avatar: string, template: string, style: string, fields: Array<{key: string, value: string, visibility: 'public'|'private'}>, preferredLocale: string|null, preferredTheme: string|null}>}
   */
  async getOwnProfile() {
    const actorPub = await this.#myActorPub();

    // Backfill/background-refresh BOTH pieces - a freshly imported identity
    // (see @qu/identity's importMnemonic()) starts with an empty local
    // store, so without this its alias/avatar/epub and any private fields
    // would silently stay blank forever, even though the real data is
    // sitting on the relay under this exact actorPub.
    const profilePath = actorPath(actorPub, 'profile');
    const localProfile = await this.qu.get(profilePath);
    if (localProfile) this.#backgroundRefresh(profilePath);
    else if (this.syncFetch) await this.syncFetch(profilePath).catch(() => {});

    const extraPath = privateExtraPath(actorPub);
    const localExtra = await this.qu.get(extraPath);
    if (localExtra) this.#backgroundRefresh(extraPath);
    else if (this.syncFetch) await this.syncFetch(extraPath).catch(() => {});

    const { alias = '', avatar = '', template = '', style = '', xPublicKey = '', ...publicExtra } = (await this.identity.getProfile(actorPub)) ?? {};
    const { customFields = {}, preferredLocale = null, preferredTheme = null } = (await getPrivate(this.qu, this.identity, extraPath)) ?? {};

    const fields = [
      ...Object.entries(publicExtra).map(([key, value]) => ({ key, value, visibility: 'public' })),
      ...Object.entries(customFields).map(([key, value]) => ({ key, value, visibility: 'private' })),
    ];
    return { pub: actorPub, epub: xPublicKey, alias, avatar, template, style, fields, preferredLocale, preferredTheme };
  }

  /**
   * What ANYONE (not just the owner) sees for a given identity - the signed
   * public document, plus the identity's two public keys surfaced under
   * clear names: `pub` (the Ed25519 signing key - same as `actorPub`, the
   * identity itself) and `epub` (the X25519 encryption key - what a reader/
   * sender resolves to encrypt/decrypt for this identity, see
   * `crypto-envelope.js`). Both are shown in the public profile UI
   * per-request - a Qu identity IS its keypair, so hiding them serves no
   * one.
   * `template`/`style` (see this class's own doc comment) flow through here
   * automatically via `...rest` below - they're part of the same signed
   * public document as `alias`/`avatar`, no separate handling needed.
   * @param {string} actorPub
   * @returns {Promise<{pub: string, epub: string, alias: string, avatar: string, template: string, style: string, [key: string]: string}|null>}
   */
  async getPublicProfile(actorPub) {
    let profile = await this.identity.getProfile(actorPub);
    if (profile) {
      this.#backgroundRefresh(actorPath(actorPub, 'profile'));
    } else if (this.syncFetch) {
      try {
        await this.syncFetch(actorPath(actorPub, 'profile'));
      } catch {
        return null; // peer unreachable, or genuinely has no profile - either way, nothing more to try
      }
      profile = await this.identity.getProfile(actorPub);
    }
    if (!profile) return null;
    const { xPublicKey = '', ...rest } = profile;
    return { pub: actorPub, epub: xPublicKey, ...rest };
  }
}
