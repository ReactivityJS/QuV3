import { QuCrypto } from '@qu/core';
import { sendWebPush as defaultSendWebPush } from '@qu/push';
import { THREAD_PRESETS, NotificationPrefsService, paths } from '@qu/services';
import { createLogger } from '@qu/log';

const log = createLogger('PushDelivery');

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
 * specific spaces like `calendar-<id>`/`geochase-<id>`/`chat` by string).
 * `resolveNotification` (optional) is that extension point: given
 * `{spaceId, threadId, authorPub, mention, mentions}`, it may return a
 * specific `{appId, functionName, title, body, url}` for a space it
 * recognizes, or `null`/`undefined` to fall through to the generic default
 * below.
 *
 * NOW HAS A REAL IMPLEMENTATION: `createManifestNotificationResolver()`
 * (this file, below) is the "real per-app routing table" this doc comment
 * used to describe only hypothetically, before any app declared
 * `pushActions` for real - `relay.js` passes it as the DEFAULT
 * `resolveNotification` (an explicit `options.resolveNotification` still
 * overrides it). This class itself needed ZERO changes for that to work -
 * exactly the point of the hook existing as a plain function parameter.
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
    if (String(spaceId).startsWith(paths.NOTIFICATIONS_SPACE_PREFIX)) return;

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
        log.error(`in-app notification write failed for ~${actorPub.slice(0, 10)}…:`, err.message);
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
            log.warn(`push subscription for ~${actorPub.slice(0, 10)}… has expired`);
          }
        } catch (err) {
          log.error(`push send failed for ~${actorPub.slice(0, 10)}…:`, err.message);
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
    const spaceId = paths.notificationsSpaceId(actorPub);
    await this.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(actorPub));
    await this.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: payload.body,
      extra: { title: payload.title, url: payload.url, appId: payload.appId },
    });
  }
}

/**
 * The "real per-app routing table (driven by manifest `pushRouting` data...)"
 * the class doc comment above names as `resolveNotification`'s intended real
 * caller, now that apps exist. Matches a message's `spaceId` against every
 * loaded app's own `manifest.spaceId` (already published in the apps
 * catalog - see `apps-catalog.js`), then picks the `pushActions` entry whose
 * `type` matches (`'mention'` or `'create'`) - `apps/forum/manifest.quapp`'s
 * own `{id: 'mention', label: 'Mentions', type: 'mention'}` /
 * `{id: 'newMessage', label: 'New posts', type: 'create'}` is exactly the
 * shape this reads. Returns `null` (falls through to the class's own
 * generic wording) when no loaded app declares this spaceId, or the
 * matching app has no `pushActions` entry of the right type - "an app CAN
 * define its own notification actions" was always optional, never assumed.
 *
 * Deliberately narrow: body text NEVER includes actual message content
 * (see the class doc comment - "generic, never-the-actual-content Web
 * Push"), only the TITLE and click-through URL are app-specific here - a
 * pushAction's own `label` (e.g. "Mentions", "New posts") replaces the
 * hardcoded "Mentioned in .../New message in ..." wording, and the URL
 * uses the app's real, routable `name` instead of blindly reflecting
 * `spaceId` back (`#genericNotification()`'s own `url: '#/${spaceId}'`
 * fallback is flat-out WRONG for any app whose spaceId isn't also its own
 * name - `apps/forum` is exactly that case, a real UUID `spaceId` - a
 * click on one of ITS notifications would land on a hash the shell's
 * router can never resolve to anything).
 *
 * This is what `relay.js` passes as the DEFAULT `resolveNotification` -
 * `options.resolveNotification`, if a relay operator explicitly sets one,
 * still always wins (see `relay.js`'s own wiring), for a case this
 * manifest-driven convention genuinely can't express.
 *
 * @param {import('@qu/loader').QuLoader} loader
 * @returns {(spaceId: string|number, threadId: string, context: {authorPub: string|null, mention: boolean, mentions: string[]}) => ({appId: string, functionName: string, title: string, body: string, url: string}|null)}
 */
export function createManifestNotificationResolver(loader) {
  return function resolveNotification(spaceId, _threadId, { authorPub, mention }) {
    const wantType = mention ? 'mention' : 'create';
    for (const { manifest } of loader.listManifests()) {
      if (manifest.spaceId !== spaceId) continue;
      const action = (manifest.pushActions ?? []).find((a) => a.type === wantType);
      if (!action) return null;
      const appLabel = manifest.label ?? manifest.name;
      const who = (authorPub ?? 'someone').slice(0, 10);
      return {
        appId: manifest.name,
        functionName: action.id,
        title: `${action.label} — ${appLabel}`,
        body: `~${who}… sent a message`,
        url: `#/${manifest.name}`,
      };
    }
    return null;
  };
}
