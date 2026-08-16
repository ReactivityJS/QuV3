import { QuCrypto } from '@qu/core';
import { notificationPrefsPath } from './paths.js';

const DEFAULTS = Object.freeze({ enabled: true, mentions: true, apps: {} });

/**
 * A per-function override is either the ORIGINAL plain boolean (just
 * enabled/disabled, e.g. `{newMessage: false}`) or the newer
 * `{enabled?, popup?}` object form that additionally carries the popup
 * delivery-mode flag Phone's incoming-call toast needs (see
 * `NotificationPrefsService.shouldPopup()`). A stored plain boolean is
 * ALWAYS read as `{enabled: value, popup: false}` - an old preference
 * write predates the popup concept entirely, so it can't have meant to opt
 * into it.
 * @param {boolean|{enabled?: boolean, popup?: boolean}|undefined} raw
 * @returns {boolean} Whether this function is enabled at all (default true - absent means unset, not disabled).
 */
function functionEnabled(raw) {
  if (raw === undefined) return true;
  if (typeof raw === 'boolean') return raw;
  return raw.enabled !== false;
}

/**
 * @param {boolean|{enabled?: boolean, popup?: boolean}|undefined} raw
 * @param {boolean} defaultPopup - Used only when `raw` is absent entirely (never overridden yet) - the CALLER's own suggested default for this function (e.g. Phone's `incomingCall` passing `true`), since this service has no notion of per-app defaults itself.
 * @returns {boolean}
 */
function functionPopup(raw, defaultPopup) {
  if (raw === undefined) return defaultPopup;
  if (typeof raw === 'boolean') return false; // legacy value never opted into popups - see functionEnabled()'s own doc comment
  return raw.popup ?? defaultPopup;
}

/**
 * NOTIFICATION PREFERENCES SERVICE — granular, per-identity push
 * notification settings: a global on/off, a global @mention on/off, and
 * per-app (optionally per-FUNCTION within an app, e.g. Chat's "newMessage"
 * vs. Inbox's "newMail", or Phone's "incomingCall") overrides. A
 * per-function override also carries an optional POPUP delivery-mode flag
 * (`{enabled, popup}, see `shouldPopup()`) - the in-app toast "Zwischenlösung"
 * built for Phone's incoming-call UX (`apps/shell/src/notification-popups.js`),
 * generalized to any notification type: `enabled` still gates whether a
 * notification happens at all (in-app record + push), `popup` is a SEPARATE,
 * additive question of whether it should also interrupt with a toast. An
 * app may also carry `mutedThreads: string[]` - per-CONVERSATION silencing
 * (e.g. `apps/chat`'s own chat-room "Mute" menu item), independent of the
 * function-level `enabled`/`popup` split above: muting one 1:1/group thread
 * never touches this app's OTHER threads or its global on/off switches.
 *
 * DELIBERATELY PUBLIC, not private/encrypted - this is the one piece of
 * "personal settings" data in this codebase that CAN'T be private, because
 * the party that needs to READ it to make a decision is `@qu/relay` (deciding
 * whether to send a push), which has no way to decrypt something only the
 * owner's own key can read. Signed (so nobody else can silently flip your
 * settings), but not encrypted - a documented, deliberate trade-off.
 */
export class NotificationPrefsService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   */
  constructor(qu, identityEngine) {
    this.qu = qu;
    this.identity = identityEngine;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /** @returns {Promise<{enabled: boolean, mentions: boolean, apps: Record<string, {enabled?: boolean, functions?: Record<string, boolean|{enabled?: boolean, popup?: boolean}>, mutedThreads?: string[]}>}>} */
  async getOwnPrefs() {
    return this.getPrefsFor(await this.#myActorPub());
  }

  /**
   * Reads ANY identity's prefs (they're public) - what `@qu/relay`'s push
   * delivery calls for the RECIPIENT of a notification, since the relay has
   * no identity of its own to call `getOwnPrefs()` as.
   * @param {string} actorPub
   * @returns {Promise<object>} Always a full, default-filled object - never null.
   */
  async getPrefsFor(actorPub) {
    const stored = await this.qu.get(notificationPrefsPath(actorPub));
    const record = stored?.val;
    if (!record) return { ...DEFAULTS };
    // Signature is checked defensively - a tampered/unsigned record falls back to defaults
    // rather than trusting attacker-controlled settings that could, say, silently disable pushes.
    const { prefs, signature } = record;
    if (!prefs || !signature) return { ...DEFAULTS };
    let isValid = false;
    try {
      isValid = await QuCrypto.verify(
        new TextEncoder().encode(JSON.stringify(prefs)),
        QuCrypto.fromBase64Url(signature),
        QuCrypto.fromBase64Url(actorPub)
      );
    } catch {
      isValid = false; // malformed base64/signature - treat exactly like "did not verify"
    }
    return isValid ? { ...DEFAULTS, ...prefs, apps: prefs.apps ?? {} } : { ...DEFAULTS };
  }

  /**
   * @param {{enabled?: boolean, mentions?: boolean, apps?: Record<string, {enabled?: boolean, functions?: Record<string, boolean|{enabled?: boolean, popup?: boolean}>}>}} prefs
   * @returns {Promise<void>}
   */
  async savePrefs(prefs) {
    const merged = { ...DEFAULTS, ...prefs, apps: prefs.apps ?? {} };
    const mainKey = await this.identity.getMainKey();
    const signature = await QuCrypto.sign(new TextEncoder().encode(JSON.stringify(merged)), mainKey.privateKeyPkcs8);
    await this.qu.put(
      notificationPrefsPath(await this.#myActorPub()),
      { prefs: merged, signature: QuCrypto.toBase64Url(signature) },
      { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey }
    );
  }

  /**
   * The actual decision logic - pure, given an already-resolved prefs
   * object, so both the relay (deciding whether to push) and a settings UI
   * (previewing "would this notify me?") share one implementation.
   * @param {object} prefs - As returned by getPrefsFor()/getOwnPrefs().
   * @param {{appId: string, mention?: boolean, functionName?: string, threadId?: string}} event -
   *   `threadId` (additive, optional) is the per-CONVERSATION mute this
   *   identity may have set for `appId` (see `apps[appId].mutedThreads`
   *   below, and `apps/chat`'s own chat-room "Mute" menu item) - absent for
   *   any caller that doesn't have a notion of a specific thread (or
   *   doesn't care), in which case this check is simply skipped, unchanged
   *   from before this field existed.
   * @returns {boolean}
   */
  static shouldNotify(prefs, { appId, mention = false, functionName = null, threadId = null }) {
    if (!prefs.enabled) return false;
    if (mention && prefs.mentions === false) return false;
    const appPrefs = prefs.apps?.[appId];
    if (appPrefs?.enabled === false) return false;
    if (threadId && appPrefs?.mutedThreads?.includes(threadId)) return false;
    if (functionName && !functionEnabled(appPrefs?.functions?.[functionName])) return false;
    return true;
  }

  /**
   * The popup-delivery-mode counterpart to `shouldNotify()` - "should a
   * notification for this event also pop an in-app toast" (see
   * `apps/shell/src/notification-popups.js`), a separate, ADDITIVE question
   * from whether it should be notified/pushed at all. Always `false` when
   * `shouldNotify()` itself is `false` - a popup for a notification that
   * wouldn't even be recorded/pushed makes no sense.
   * @param {object} prefs - As returned by getPrefsFor()/getOwnPrefs().
   * @param {{appId: string, mention?: boolean, functionName?: string, threadId?: string, defaultPopup?: boolean}} event -
   *   `defaultPopup` is the CALLER's own suggested default for this specific
   *   function when this identity has never explicitly set one (e.g. Phone's
   *   own `resolveNotification` passing `true` for `incomingCall`, vs. the
   *   overall default of `false` for an ordinary chat message) - this
   *   service has no built-in notion of per-app defaults, so it never
   *   invents one on its own. `threadId` - see `shouldNotify()`'s own doc
   *   comment; a muted thread never pops either, same as it's never notified.
   * @returns {boolean}
   */
  static shouldPopup(prefs, { appId, mention = false, functionName = null, threadId = null, defaultPopup = false }) {
    if (!NotificationPrefsService.shouldNotify(prefs, { appId, mention, functionName, threadId })) return false;
    const raw = functionName ? prefs.apps?.[appId]?.functions?.[functionName] : undefined;
    return functionPopup(raw, defaultPopup);
  }
}
