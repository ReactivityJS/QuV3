import { QuCrypto } from '@qu/core';
import { notificationPrefsPath } from './paths.js';

const DEFAULTS = Object.freeze({ enabled: true, mentions: true, apps: {} });

/**
 * NOTIFICATION PREFERENCES SERVICE — granular, per-identity push
 * notification settings: a global on/off, a global @mention on/off, and
 * per-app (optionally per-FUNCTION within an app, e.g. Chat's "newMessage"
 * vs. Inbox's "newMail") overrides.
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

  /** @returns {Promise<{enabled: boolean, mentions: boolean, apps: Record<string, {enabled?: boolean, functions?: Record<string, boolean>}>}>} */
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
   * @param {{enabled?: boolean, mentions?: boolean, apps?: Record<string, {enabled?: boolean, functions?: Record<string, boolean>}>}} prefs
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
   * @param {{appId: string, mention?: boolean, functionName?: string}} event
   * @returns {boolean}
   */
  static shouldNotify(prefs, { appId, mention = false, functionName = null }) {
    if (!prefs.enabled) return false;
    if (mention && prefs.mentions === false) return false;
    const appPrefs = prefs.apps?.[appId];
    if (appPrefs?.enabled === false) return false;
    if (functionName && appPrefs?.functions?.[functionName] === false) return false;
    return true;
  }
}
