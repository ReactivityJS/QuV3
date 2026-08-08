import { QuCrypto } from '@qu/core';

/**
 * ACTOR SERVICE — the Entity API for identities. Thin, renamed front door
 * over `@qu/identity`'s `QuIdentityEngine` (which already returns plain
 * values, not QuBits, so there's little to unwrap here) - the point of
 * this wrapper is vocabulary: apps think in terms of "actors", not BIP-32
 * derivation paths or attestations.
 *
 * Deliberately a NARROW slice of QuV2's version, not a full port: only
 * `whoAmI()` - the one method `apps/user-list`'s client (the first real
 * caller in V3) actually needs. QuV2's `ActorService` also carries
 * `createRecoveryPhrase()`/`signIn()`/`publishMainProfile()`/
 * `createSpaceIdentity()`/`getProfile()`/`vouchForSpaceIdentity()`/
 * `resolveActor()`/`signPayload()`/`decryptForMe()` - none of those have a
 * real V3 caller yet (an onboarding flow, a future Relay Admin Data
 * Explorer, ...), so porting them now would be exactly the "build the
 * general thing before its real need exists" complexity this codebase's
 * own principles warn against. Add each one alongside the app that
 * actually calls it, same pattern already used for
 * `Registry.registerCapability()`.
 */
export class ActorService {
  /** @param {import('@qu/identity').QuIdentityEngine} identityEngine */
  constructor(identityEngine) {
    this.identity = identityEngine;
  }

  /** @returns {Promise<string>} This identity's own main actor public key (base64url) - "who am I". */
  async whoAmI() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }
}
