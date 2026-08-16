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
 *
 * WHO GETS NOTIFIED IS ALSO EXTENSIBLE, the same way: the built-in
 * readers/mentions logic below is the DEFAULT candidate set, never removed
 * or special-cased away, but any app can ADD to it via `@qu/foundation`'s
 * `Registry.hooks` (`registry.hooks.on('notify.threadCandidates', handler)`,
 * registered inside that app's own `register(qu, manifest, registry)` -
 * exactly the mechanism that doc comment already names as the server-side
 * analogue of the client's `contributes`/`ExtensionPointHost`). A handler is
 * `(payload: {qu, registry, spaceId, threadId, quBit, authorPub, mentions})
 * -> Array<{actorPub, functionName}> | Promise<...>` - see `deliverThreadMessage()`'s
 * own `registry.hooks.collect('notify.threadCandidates', ...)` call. NO
 * concrete hook is registered anywhere in this codebase yet (a deliberate,
 * documented scope cut - see this branch's own plan notes on "Future Work":
 * Forum notifying a topic's author on any reply, or anyone watching a topic/
 * board; Chat giving a group-invite notification its own wording) - this
 * round only builds the mechanism itself, so that next round is pure
 * addition (a new `registry.hooks.on(...)` call in an app's own `register()`),
 * never a `packages/relay` change. With `registry` omitted (or no handler
 * registered for the point), behavior is BYTE-FOR-BYTE identical to before
 * this existed - `HookBus.collect()` on an unregistered point returns `[]`.
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
   * @param {(spaceId: string|number, threadId: string, context: {authorPub: string|null, mention: boolean, mentions: string[], functionName: string|null}) => ({appId?: string, functionName?: string, title: string, body: string, url: string}|null|undefined)} [deps.resolveNotification]
   *   See class doc comment. Called once per NOTIFIED candidate (not once
   *   per message) - `mention` varies per candidate, so the resolved
   *   title/functionName legitimately can too. `context.functionName` is
   *   set when a `notify.threadCandidates` hook already decided this
   *   candidate's function (see class doc comment) - `null` for a plain
   *   generic (readers/mentions) candidate.
   * @param {import('@qu/foundation').Registry} [deps.registry] - Optional -
   *   see class doc comment's "WHO GETS NOTIFIED IS ALSO EXTENSIBLE"
   *   section. Omitted (or no handler registered), `notify.threadCandidates`
   *   simply contributes nothing - existing behavior is unaffected.
   * @param {typeof import('@qu/push').sendWebPush} [deps.sendWebPush] - Injectable for tests.
   */
  constructor({ messages, notificationPrefs, pushSubscriptions, presence, vapidKeys, resolveNotification = null, registry = null, sendWebPush = defaultSendWebPush }) {
    this.messages = messages;
    this.notificationPrefs = notificationPrefs;
    this.pushSubscriptions = pushSubscriptions;
    this.presence = presence;
    this.vapidKeys = vapidKeys;
    this.resolveNotification = resolveNotification;
    this.registry = registry;
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
    // `_id` and the path's own messageId segment are guaranteed identical
    // (see `MessageService.postMessage()`'s own doc comment) - reading it
    // off the QuBit here avoids a relay.js regex change just to thread it
    // through. Used only to give a stored notification a live reference back
    // to its real content (see `#writeInAppNotification()`'s `ref` param) -
    // `apps/notifications` resolves it via `content.resolveReference` to
    // render the SAME per-app template Search uses, instead of this file's
    // own deliberately generic title/body wording (see class doc comment).
    const messageId = quBit.val?._id ?? null;

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

    // Additional candidates/wording from any app's own `notify.
    // threadCandidates` hook (see class doc comment) - `[]` when `registry`
    // is omitted or nothing is registered, making this whole block a no-op.
    // Merged by actorPub: a hook can either give an EXISTING generic
    // candidate a more specific `functionName` (e.g. Chat's own invite hook
    // correcting the wording for a recipient the generic private-thread
    // logic above already included), or introduce a genuinely NEW actorPub
    // the generic logic wouldn't have (e.g. a topic's author, or a watcher,
    // who isn't a "reader" of a public forum thread at all).
    const hookCandidates = this.registry
      ? await this.registry.hooks.collect('notify.threadCandidates', { qu: this.messages.qu, registry: this.registry, spaceId, threadId, quBit, authorPub, mentions })
      : [];
    const hookFunctionNameByActor = new Map();
    const knownActors = new Set(candidates.map((c) => c.actorPub));
    for (const hc of hookCandidates) {
      if (!hc?.actorPub || hc.actorPub === authorPub) continue;
      if (hc.functionName) hookFunctionNameByActor.set(hc.actorPub, hc.functionName);
      if (!knownActors.has(hc.actorPub)) {
        candidates.push({ actorPub: hc.actorPub, mention: false });
        knownActors.add(hc.actorPub);
      }
    }

    for (const { actorPub, mention } of candidates) {
      const hookFunctionName = hookFunctionNameByActor.get(actorPub) ?? null;
      const resolved = this.resolveNotification?.(spaceId, threadId, { authorPub, mention, mentions, functionName: hookFunctionName }) ?? this.#genericNotification(spaceId, authorPub, mention);
      const appId = resolved.appId ?? String(spaceId);
      const functionName = resolved.functionName ?? hookFunctionName ?? (mention ? 'mention' : 'newMessage');

      // `threadId` here is the REAL thread this message was posted to (e.g.
      // a chat room's own roomId) - exactly what a per-conversation
      // `apps[appId].mutedThreads` entry is keyed by (see
      // NotificationPrefsService.shouldNotify()'s own doc comment, and
      // `apps/chat`'s chat-room "Mute" menu item that sets it).
      const prefs = await this.notificationPrefs.getPrefsFor(actorPub);
      if (!NotificationPrefsService.shouldNotify(prefs, { appId, mention, functionName, threadId })) continue;

      try {
        const ref = messageId ? { spaceId, threadId, messageId } : undefined;
        await this.#writeInAppNotification(actorPub, { title: resolved.title, body: resolved.body, appId, url: resolved.url, ref, actions: resolved.actions });
      } catch (err) {
        log.error(`in-app notification write failed for ~${actorPub.slice(0, 10)}…:`, err.message);
      }

      if (!this.vapidKeys) continue;
      // Still visibly connected (see PresenceTracker) - the in-app
      // notification just written above already covers them (their own
      // client sees it live via subscribe(), same as the header badge), a
      // redundant push would just be noise. `resolved.bypassPresence`
      // (set by e.g. Phone's own `incomingCall` pushAction, see
      // `createManifestNotificationResolver()`'s own doc comment) overrides
      // this - a call ringing in a background tab needs the OS-level push
      // notification too, "the in-app copy already covers them" doesn't
      // hold for something meant to be noticed immediately.
      if (!resolved.bypassPresence && this.presence.isRecentlyOnline(actorPub)) continue;

      const subscriptions = await this.pushSubscriptions.listSubscriptionsFor(actorPub);
      for (const subscription of subscriptions) {
        try {
          const pushPayload = { title: resolved.title, body: resolved.body, appId, url: resolved.url };
          if (resolved.actions) pushPayload.actions = resolved.actions;
          const result = await this.sendWebPush(subscription, pushPayload, this.vapidKeys);
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
   *
   * `ref` (additive, optional) is the ONLY thing that carries real content
   * identity onto an otherwise deliberately generic notification (see class
   * doc comment) - `apps/notifications` uses it to resolve the real message
   * via the originating app's OWN `content.resolveReference` contributor and
   * render it with that SAME app's `content.searchResultTemplate` (the exact
   * template Search already uses), falling back to this generic title/body
   * when it's absent (an older notification, predating this field) or
   * unresolvable. Never sent to Web Push (see `deliverThreadMessage()`'s own
   * call site) - only the in-app copy gets it, on purpose: a lock-screen
   * push payload should stay small and never carry a raw content pointer.
   *
   * `actions` (additive, optional) is `apps/shell/src/notification-popups.js`'s
   * OWN multi-button toast input - the exact shape a stored message's own
   * `actions` field needs to already be in for that watcher to use it
   * verbatim instead of falling back to a single generic "open" action (see
   * that file's own doc comment). Also forwarded to the Web Push payload
   * itself (see `deliverThreadMessage()`'s own call site) so `apps/shell/
   * sw.js` can render the SAME Accept/Decline buttons on the OS notification.
   * @param {string} actorPub - The notification's owner/recipient.
   * @param {{title: string, body: string, appId: string, url: string, ref?: {spaceId: string|number, threadId: string, messageId: string}, actions?: Array<{action: string, title: string, url: string}>}} payload
   */
  async #writeInAppNotification(actorPub, payload) {
    const spaceId = paths.notificationsSpaceId(actorPub);
    await this.messages.createThread(spaceId, paths.NOTIFICATIONS_THREAD_ID, THREAD_PRESETS.notifications(actorPub));
    await this.messages.postMessage(spaceId, paths.NOTIFICATIONS_THREAD_ID, {
      body: payload.body,
      extra: {
        title: payload.title,
        url: payload.url,
        appId: payload.appId,
        ...(payload.ref ? { ref: payload.ref } : {}),
        ...(payload.actions ? { actions: payload.actions } : {}),
      },
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
 * `context.functionName` (set when a `notify.threadCandidates` hook already
 * decided this candidate's function - see `PushDeliveryService`'s own doc
 * comment) is matched by `pushActions[].id` DIRECTLY when present, instead
 * of the coarse `mention`-derived `type` lookup below - a hook-sourced
 * functionName (e.g. Forum's future `'reply-own-topic'`) is already exact,
 * unlike the generic `'mention'`/`'create'` a plain readers/mentions
 * candidate only ever implies. `null`/absent `functionName` (every
 * candidate today, since no hook is registered yet) falls through to the
 * ORIGINAL type-based lookup, unchanged.
 *
 * A pushAction MAY additionally declare `urlTemplate`/`bypassPresence`/
 * `actions` (Phone's own `incomingCall` entry is the first real user - see
 * `apps/phone/manifest.quapp`) for a notification that needs to point at a
 * SPECIFIC target rather than just "open the app": `urlTemplate` and each
 * `actions[].hrefTemplate` may contain a literal `{pub}` placeholder,
 * substituted with this event's `authorPub` (the actor who posted the
 * message - for Phone, the caller) - e.g. `'#/phone/{pub}/accept'` becomes
 * `'#/phone/<callerPub>/accept'`. Every other app's existing pushActions
 * entries (no `urlTemplate`) are completely unaffected - `url` still falls
 * back to the original flat `#/<appId>`, and `actions`/`bypassPresence` are
 * simply omitted from the returned object, exactly as before this existed.
 *
 * @param {import('@qu/loader').QuLoader} loader
 * @returns {(spaceId: string|number, threadId: string, context: {authorPub: string|null, mention: boolean, mentions: string[], functionName?: string|null}) => ({appId: string, functionName: string, title: string, body: string, url: string, actions?: Array<{action: string, title: string, url: string}>, bypassPresence?: boolean}|null)}
 */
export function createManifestNotificationResolver(loader) {
  return function resolveNotification(spaceId, _threadId, { authorPub, mention, functionName = null }) {
    for (const { manifest } of loader.listManifests()) {
      if (manifest.spaceId !== spaceId) continue;
      const action = functionName
        ? (manifest.pushActions ?? []).find((a) => a.id === functionName)
        : (manifest.pushActions ?? []).find((a) => a.type === (mention ? 'mention' : 'create'));
      if (!action) return null;
      const appLabel = manifest.label ?? manifest.name;
      const who = (authorPub ?? 'someone').slice(0, 10);
      const substitutePub = (template) => template.replaceAll('{pub}', authorPub ?? '');
      return {
        appId: manifest.name,
        functionName: action.id,
        title: `${action.label} — ${appLabel}`,
        body: `~${who}… sent a message`,
        url: action.urlTemplate ? substitutePub(action.urlTemplate) : `#/${manifest.name}`,
        ...(action.bypassPresence ? { bypassPresence: true } : {}),
        ...(Array.isArray(action.actions) ? { actions: action.actions.map((a) => ({ action: a.action, title: a.title, url: substitutePub(a.hrefTemplate) })) } : {}),
      };
    }
    return null;
  };
}
