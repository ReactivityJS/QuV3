import { QuCrypto } from '@qu/core';
import { pushSubscriptionPath, pushSubscriptionsParentPath } from './paths.js';

/** @param {string} endpoint @returns {Promise<string>} A short, stable, path-safe id for one subscription. */
async function subscriptionId(endpoint) {
  const hash = await QuCrypto.sha256(new TextEncoder().encode(endpoint));
  return QuCrypto.toBase64Url(hash).slice(0, 24);
}

/**
 * PUSH SUBSCRIPTION SERVICE — stores a browser's `PushSubscription` (the
 * endpoint + keys `PushManager.subscribe()` returns) so `@qu/relay`'s push
 * delivery knows where and how to reach this identity. Supports multiple
 * subscriptions per identity (one per device/browser), each independently
 * add/removable.
 *
 * A DERIVED list (docs/v3-technical-concept.md §4.2), unlike QuV2's
 * `CollectionService`-backed version: each subscription already lives at
 * its own path (`pushSubscriptionPath()`) under a shared parent
 * (`pushSubscriptionsParentPath()`), enumerated via
 * `ListService.listDerived()` - `subscribe()` is a single `qu.put()`, no
 * separate index document to keep in sync, and so no
 * backfill-before-read-modify-write race to guard against either (QuV2's
 * own doc comment for this class describes exactly that race: two devices
 * subscribing independently, the second one's unconditional index overwrite
 * silently discarding the first's entry - a derived list has no shared
 * index for two devices to race on in the first place, each writes its OWN
 * path).
 *
 * PUBLIC, signed, not encrypted - same reasoning as
 * `NotificationPrefsService`'s own doc comment (the relay, which has no way
 * to decrypt private data, is the reader that matters here). An endpoint+
 * keys pair is already shared with the push service vendor by design; this
 * isn't a new exposure, just a second party (this relay) holding the same
 * information the browser already gave to Google/Mozilla/etc.
 */
export class PushSubscriptionService {
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

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} subscription
   *   A browser's `PushSubscription.toJSON()`.
   * @returns {Promise<void>}
   */
  async subscribe(subscription) {
    const mainKey = await this.identity.getMainKey();
    const id = await subscriptionId(subscription.endpoint);
    const path = pushSubscriptionPath(await this.#myActorPub(), id);
    await this.qu.put(
      path,
      { endpoint: subscription.endpoint, keys: subscription.keys },
      { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey }
    );
  }

  /**
   * Clears a subscription - a `null`-valued tombstone QuBit (`QuStore` has
   * no `delete()`), same convention every other derived-list entry in this
   * package uses.
   * @param {string} endpoint
   * @returns {Promise<void>}
   */
  async unsubscribe(endpoint) {
    const mainKey = await this.identity.getMainKey();
    const id = await subscriptionId(endpoint);
    const path = pushSubscriptionPath(await this.#myActorPub(), id);
    await this.qu.put(path, null, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });
  }

  /** @returns {Promise<Array<{endpoint: string, keys: object}>>} This identity's own subscriptions (e.g. for a "manage devices" UI). */
  async listOwnSubscriptions() {
    return this.listSubscriptionsFor(await this.#myActorPub());
  }

  /**
   * What `@qu/relay`'s push delivery calls - every currently active
   * subscription for a GIVEN recipient, not just "my own". No `limit` - see
   * `ListService.listDerived()`'s own doc comment for why a generic list
   * primitive never defaults one: a relay silently notifying only SOME of
   * an identity's devices because of an arbitrary cap would be a real,
   * hard-to-notice bug, not a convenience.
   * @param {string} actorPub
   * @returns {Promise<Array<{endpoint: string, keys: object}>>}
   */
  async listSubscriptionsFor(actorPub) {
    const entries = await this.list.listDerived(pushSubscriptionsParentPath(actorPub));
    return entries.filter((e) => e.quBit.val).map((e) => e.quBit.val);
  }
}
