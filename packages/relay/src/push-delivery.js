import { QuCrypto } from '@qu/core';
import { sendWebPush as defaultSendWebPush } from '@qu/push';
import { THREAD_PRESETS, NotificationPrefsService } from '@qu/services';

/**
 * PUSH DELIVERY — notification delivery for one thread message: figures out
 * who should be notified, checks each candidate's own `NotificationPrefsService`
 * settings, then does TWO independent things for each candidate that passes
 * - write an in-app notification record to their own notifications Thread
 * (always, so a header bell/feed has something to show even with push off
 * or unsupported), and send a generic (never-the-actual-content) Web Push to
 * every one of their registered devices (only if this relay has VAPID keys
 * AND they have subscriptions - unrelated to the first part).
 *
 * ROUTING IS PLUGGABLE (docs/v3-technical-concept.md §6.2: "simple
 * declarative mapping, not a template DSL"), not hardcoded per app the way
 * the prototype this is rebuilt from had it (an if/else chain naming
 * specific spaces like `calendar-<id>`/`geochase-<id>`/`chat` by string) -
 * V3 has no apps built yet to hardcode against, and hardcoding non-existent
 * app names would be exactly the kind of speculative complexity this
 * codebase's own principles warn against. `resolveNotification` (optional)
 * is that extension point: given `{spaceId, threadId, authorPub, mention,
 * mentions}`, it may return a specific `{appId, functionName, title, body,
 * url}` for a space it recognizes, or `null`/`undefined` to fall through to
 * the generic default below. A real per-app routing table (driven by
 * manifest `pushRouting` data, per §6.2) is exactly the kind of resolver
 * this hook is designed to plug in once apps exist - this class doesn't
 * need to change when that happens.
 */
export class PushDeliveryService {
  /**
   * @param {object} deps
   * @param {import('@qu/services').MessageService} deps.messages
   * @param {import('@qu/services').NotificationPrefsService} deps.notificationPrefs
   * @param {import('@qu/services').PushSubscriptionService} deps.pushSubscriptions
   * @param {import('./presence-tracker.js').PresenceTracker} deps.presence
   * @param {{publicKey: string, privateKey: string, subject: string}|null} deps.vapidKeys -
   *   `null` disables actual Web Push sends (in-app notifications still
   *   happen) - e.g. a relay that hasn't configured/generated VAPID keys yet.
   * @param {(spaceId: string|number, threadId: string, context: {authorPub: string|null, mention: boolean, mentions: string[]}) => ({appId?: string, functionName?: string, title: string, body: string, url: string}|null|undefined)} [deps.resolveNotification]
   *   See class doc comment. Called once per NOTIFIED candidate (not once
   *   per message) - `mention` varies per candidate, so the resolved
   *   title/functionName legitimately can too.
   * @param {typeof import('@qu/push').sendWebPush} [deps.sendWebPush] - Injectable for tests.
   */
  constructor({ messages, notificationPrefs, pushSubscriptions, presence, vapidKeys, resolveNotification = null, sendWebPush = defaultSendWebPush }) {
    this.messages = messages;
    this.notificationPrefs = notificationPrefs;
    this.pushSubscriptions = pushSubscriptions;
    this.presence = presence;
    this.vapidKeys = vapidKeys;
    this.resolveNotification = resolveNotification;
    this.sendWebPush = sendWebPush;
  }

  /**
   * @param {string|number} spaceId @param {string} threadId @param {object} quBit - The message QuBit as just persisted.
   * @returns {Promise<void>}
   */
  async deliverThreadMessage(spaceId, threadId, quBit) {
    // A relay-authored notice about a message IN a notifications thread
    // would loop forever (deliver -> write notice -> deliver -> ...) -
    // notifications threads are a delivery TARGET, never a delivery SOURCE.
    // Checked first, before any other work.
    if (String(spaceId).startsWith('notifications-')) return;

    const config = await this.messages.getConfig(spaceId, threadId);
    if (!config) return;

    // quBit.pub is plain base64 (QuStore's own on-wire QuBit shape) - every
    // actor pub elsewhere in this codebase (config.readers, mentions,
    // NotificationPrefsService/PushSubscriptionService lookups) is
    // base64url, so this MUST be converted, not compared/looked-up as-is.
    const authorPub = quBit.pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)) : null;
    const mentions = Array.isArray(quBit.val?.mentions) ? quBit.val.mentions : [];

    /** @type {Array<{actorPub: string, mention: boolean}>} */
    let candidates;
    if (Array.isArray(config.readers)) {
      // A private thread: every OTHER reader gets a notice.
      candidates = config.readers.filter((pub) => pub !== authorPub).map((actorPub) => ({ actorPub, mention: mentions.includes(actorPub) }));
    } else {
      // A public thread: notifying every reader would mean notifying the
      // entire relay for every post - only explicit @mentions get pushed here.
      candidates = mentions.filter((pub) => pub !== authorPub).map((actorPub) => ({ actorPub, mention: true }));
    }

    for (const { actorPub, mention } of candidates) {
      const resolved = this.resolveNotification?.(spaceId, threadId, { authorPub, mention, mentions }) ?? this.#genericNotification(spaceId, authorPub, mention);
      const appId = resolved.appId ?? String(spaceId);
      const functionName = resolved.functionName ?? (mention ? 'mention' : 'newMessage');

      const prefs = await this.notificationPrefs.getPrefsFor(actorPub);
      if (!NotificationPrefsService.shouldNotify(prefs, { appId, mention, functionName })) continue;

      try {
        await this.#writeInAppNotification(actorPub, { title: resolved.title, body: resolved.body, appId, url: resolved.url });
      } catch (err) {
        console.error(`[PushDelivery] in-app notification write failed for ~${actorPub.slice(0, 10)}…:`, err.message);
      }

      if (!this.vapidKeys) continue;
      // Still visibly connected (see PresenceTracker) - the in-app
      // notification just written above already covers them (their own
      // client sees it live via subscribe(), same as the header badge), a
      // redundant push would just be noise.
      if (this.presence.isRecentlyOnline(actorPub)) continue;

      const subscriptions = await this.pushSubscriptions.listSubscriptionsFor(actorPub);
      for (const subscription of subscriptions) {
        try {
          const result = await this.sendWebPush(subscription, { title: resolved.title, body: resolved.body, appId, url: resolved.url }, this.vapidKeys);
          if (result.expired) {
            // Cannot clean this up ourselves - unsubscribing is a signed
            // write only the subscription's OWNER can make (see
            // PushSubscriptionService). Logged so an operator watching
            // relay logs can see stale subscriptions accumulating; the
            // owner's own client naturally re-subscribes/cleans up next
            // time it runs.
            console.warn(`[PushDelivery] push subscription for ~${actorPub.slice(0, 10)}… has expired`);
          }
        } catch (err) {
          console.error(`[PushDelivery] push send failed for ~${actorPub.slice(0, 10)}…:`, err.message);
        }
      }
    }
  }

  /** @returns {{title: string, body: string, url: string}} Fallback wording when no `resolveNotification` rule matched (or none was configured). */
  #genericNotification(spaceId, authorPub, mention) {
    const appId = String(spaceId);
    const who = (authorPub ?? 'someone').slice(0, 10);
    return mention
      ? { title: `Mentioned in ${appId}`, body: `~${who}… sent a message`, url: `#/${appId}` }
      : { title: `New message in ${appId}`, body: `~${who}… sent a message`, url: `#/${appId}` };
  }

  /**
   * Writes one notification into `actorPub`'s own notifications Thread
   * (space `notifications-<actorPub>`) - `createThread()` is idempotent
   * (see `MessageService`), so this is safe to call before that identity
   * has ever opened a Notifications app. `THREAD_PRESETS.notifications()`
   * sets `writers: '*'`, so no special authorization is needed for a
   * system notice, same as any other writer.
   * @param {string} actorPub - The notification's owner/recipient.
   * @param {{title: string, body: string, appId: string, url: string}} payload
   */
  async #writeInAppNotification(actorPub, payload) {
    const spaceId = `notifications-${actorPub}`;
    await this.messages.createThread(spaceId, 'notifications', THREAD_PRESETS.notifications(actorPub));
    await this.messages.postMessage(spaceId, 'notifications', {
      body: payload.body,
      extra: { title: payload.title, url: payload.url, appId: payload.appId },
    });
  }
}
