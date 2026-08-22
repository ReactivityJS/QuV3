import { QuCrypto } from '@qu/core';
import { threadMetaPath, threadMessagePath, threadMessagesParentPath, threadReadMarkerPath } from './paths.js';
import { applyFormatting } from './thread-formatting.js';
import { putPrivate, getPrivate } from './private-storage.js';
import { isEncryptedEnvelope, resolveReaderXKeys, decryptEnvelope } from './crypto-envelope.js';
import { createFreshnessTracker } from './sync-freshness.js';

/**
 * MESSAGE SERVICE — the Entity API for a Thread's messages themselves (see
 * `@qu/engines`' `ThreadEngine`/`AccessEngine` for the pipeline half of
 * this). One of four focused services `ThreadService` (QuV2's 778-line,
 * five-concern monolith) split into, per docs/v3-technical-concept.md §4.3 -
 * see `reaction-service.js`, `pin-service.js`, `presence-service.js` for the
 * other three. `THREAD_PRESETS` at the bottom stays here: it configures
 * exactly the ACL shape this Service's `createThread()` writes, not a
 * reason to keep the other three concerns bundled with it.
 *
 * Handles the two things `ThreadEngine` deliberately leaves to this layer:
 *   - Content: applying the thread's configured formatters (markdown/mentions).
 *   - Privacy: a thread with a specific `readers` list is genuinely
 *     encrypted for exactly those readers (not just a UI-level filter) -
 *     every reader must have a published profile with an X25519 key (see
 *     `@qu/identity`), or posting fails closed rather than silently writing
 *     the message unencrypted.
 *
 * MESSAGES ARE A DERIVED LIST (docs/v3-technical-concept.md §4.2): each
 * message already lives at its own path under `threadMessagesParentPath()`,
 * enumerated via `ListService.listDerived()` - no index document, so
 * `postMessage()` is a single `qu.put()`, not a write-then-index-append pair
 * the way QuV2's `CollectionService`-backed version needed. One real
 * consequence: QuV2's `clearMessages()` (reset the index to `[]`, "unlink
 * without erasing", the messages themselves stayed as orphaned documents)
 * has NO derived-list equivalent - there is no index to reset, and
 * `QuStore` has no `delete()`. Re-adding an index just to support this one
 * operation would defeat the point of moving messages to a derived shape,
 * so it is deliberately NOT ported: a caller wanting a fresh history starts
 * a new `threadId` instead (the same trade-off `THREAD_PRESETS.group`'s own
 * doc comment already accepts for "can't re-key existing history").
 */
export class MessageService {
  #backgroundRefresh;

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./list-service.js').ListService} listService
   * @param {import('./access-service.js').AccessService} accessService - Mirrors
   *   `writers`/`readers` into the generic `acl/threads/<id>` convention
   *   (see `@qu/engines`' `AccessEngine`) alongside this thread's own `meta`
   *   document, so a Thread's write-ACL is enforced by the SAME central
   *   mechanism any other entity kind uses, not a Thread-only special case.
   * @param {(path: string) => Promise<object|null>} [syncFetch] - Optional:
   *   backfills a `meta` document, profile, or read marker this identity
   *   doesn't have LOCALLY yet on a local miss. NOT needed for the messages
   *   enumeration itself - see `listMessages()`'s own doc comment for why
   *   derived lists rely on sync's reconnect catch-up (§3.2) instead.
   * @param {() => number} [getGeneration] - Optional: enables a background
   *   staleness re-check for a thread config/read-marker that already
   *   exists locally (see sync-freshness.js).
   */
  constructor(qu, identityEngine, listService, accessService, syncFetch = null, getGeneration = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.list = listService;
    this.access = accessService;
    this.syncFetch = syncFetch;
    this.#backgroundRefresh = createFreshnessTracker(syncFetch, getGeneration);
  }

  /** @returns {Promise<string>} base64url pubkey of this identity's main key. */
  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * @param {string} actorPub
   * @returns {Promise<object|null>} Same as `identity.getProfile()`, but
   *   backfills via `syncFetch` (if provided) on a local miss before giving
   *   up - see the constructor's own doc comment for why.
   */
  async #getProfile(actorPub) {
    const local = await this.identity.getProfile(actorPub);
    if (local) {
      this.#backgroundRefresh(`/store/actors/~${actorPub}/profile`); // e.g. a reader's key rotated while this session was offline
      return local;
    }
    if (!this.syncFetch) return null;
    try {
      await this.syncFetch(`/store/actors/~${actorPub}/profile`);
    } catch {
      return null; // peer unreachable, or genuinely has no profile - either way, nothing more to try
    }
    return this.identity.getProfile(actorPub); // re-read now that syncFetch (on success) persisted it locally
  }

  /**
   * Creates a thread, or returns the existing config unchanged if one
   * already exists at this id - idempotent by design, so a caller can
   * always call this before posting without risking silently resetting an
   * existing thread's ACL (the same "ensure" pattern a lazily-created
   * personal inbox needs).
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {object} config - See THREAD_PRESETS for ready-made shapes.
   * @param {'*'|string[]} [config.writers='*'] - base64url actor pubkeys allowed to post, or '*' for anyone.
   * @param {'*'|string[]} [config.readers='*'] - base64url actor pubkeys allowed to read, or '*' for public.
   *   A non-'*' list means every message is ENCRYPTED for exactly these readers.
   * @param {'flat'|'threaded'} [config.replyMode='flat']
   * @param {string[]} [config.formatting=[]] - 'markdown' and/or 'mentions'.
   * @returns {Promise<object>} The thread's config (existing or newly created).
   */
  async createThread(spaceId, threadId, config = {}) {
    const existing = await this.getConfig(spaceId, threadId);
    if (existing) return existing;

    const normalized = { writers: '*', readers: '*', replyMode: 'flat', formatting: [], ...config };
    await this.qu.put(threadMetaPath(spaceId, threadId), normalized);
    // Mirror into the generic ACL convention - see this method's own
    // "accessService" param doc comment above. includeSelfAsWriter:false
    // because `normalized.writers` already IS the intended writer set
    // (verbatim from the caller's config, e.g. THREAD_PRESETS.chat's
    // memberPubs) - silently appending the creator on top would change
    // that set out from under a caller who deliberately specified it.
    await this.access.protect(spaceId, 'threads', threadId, { writers: normalized.writers, readers: normalized.readers }, { includeSelfAsWriter: false });
    return normalized;
  }

  /**
   * Backfills via `syncFetch` (if provided) on a local miss - see
   * `createThread()`'s doc comment for why this matters even for a caller
   * that only wants to READ a config.
   * @param {string|number} spaceId @param {string} threadId @returns {Promise<object|null>}
   */
  async getConfig(spaceId, threadId) {
    const path = threadMetaPath(spaceId, threadId);
    const local = await this.qu.get(path);
    if (local) {
      this.#backgroundRefresh(path);
      return local.val;
    }
    if (!this.syncFetch) return null;
    await this.syncFetch(path).catch(() => {});
    const retried = await this.qu.get(path);
    return retried?.val ?? null;
  }

  /**
   * Grows a thread's reader list in place. Needed for a thread whose
   * membership is expected to change over time WITHOUT re-keying history:
   * only messages posted AFTER this call are encrypted for (and so visible
   * to) the newly added reader - exactly the same "can't see history from
   * before you joined" trade-off most messengers accept for group
   * membership changes.
   *
   * A no-op (not an error) for an already-public thread (`readers: '*'`)
   * or a reader already present - safe to call unconditionally.
   * @param {string|number} spaceId @param {string} threadId @param {string} actorPub
   * @returns {Promise<object>} The thread's (possibly updated) config.
   */
  async addReader(spaceId, threadId, actorPub) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) throw new Error(`MessageService.addReader: no thread "${threadId}" in space "${spaceId}" - call createThread() first`);
    if (!Array.isArray(config.readers) || config.readers.includes(actorPub)) return config;
    const updated = { ...config, readers: [...config.readers, actorPub] };
    const signKey = await this.identity.getMainKey();
    await this.qu.put(threadMetaPath(spaceId, threadId), updated, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
    await this.access.protect(spaceId, 'threads', threadId, { writers: updated.writers, readers: updated.readers }, { includeSelfAsWriter: false });
    return updated;
  }

  /**
   * The inverse of `addReader()` - stops a former member from being
   * resolved as an encryption target for future messages (past messages
   * remain readable to them; this isn't retroactive, same caveat as `addReader()`).
   * @param {string|number} spaceId @param {string} threadId @param {string} actorPub
   * @returns {Promise<object>} The thread's (possibly updated) config.
   */
  async removeReader(spaceId, threadId, actorPub) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) throw new Error(`MessageService.removeReader: no thread "${threadId}" in space "${spaceId}"`);
    if (!Array.isArray(config.readers)) return config;
    const updated = { ...config, readers: config.readers.filter((pub) => pub !== actorPub) };
    const signKey = await this.identity.getMainKey();
    await this.qu.put(threadMetaPath(spaceId, threadId), updated, { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey });
    await this.access.protect(spaceId, 'threads', threadId, { writers: updated.writers, readers: updated.readers }, { includeSelfAsWriter: false });
    return updated;
  }

  /**
   * Records "I've seen everything in this thread up to now" - a generic,
   * per-identity, PRIVATE read-marker (see `threadReadMarkerPath()`'s own
   * doc comment for the contrast with `PresenceService`'s PUBLIC read
   * receipts). Still a SYNCED path (not local-only) - marking something
   * read on one device should be reflected on another.
   * @param {string|number} spaceId @param {string} threadId
   */
  async markRead(spaceId, threadId) {
    const actorPub = await this.#myActorPub();
    await putPrivate(this.qu, this.identity, threadReadMarkerPath(spaceId, threadId, actorPub), { readAt: Date.now() });
  }

  /**
   * @param {string|number} spaceId @param {string} threadId
   * @returns {Promise<number>} Epoch ms of the last `markRead()` call, or 0 if never marked.
   */
  async getLastReadAt(spaceId, threadId) {
    const actorPub = await this.#myActorPub();
    const path = threadReadMarkerPath(spaceId, threadId, actorPub);
    const existing = await this.qu.get(path);
    if (existing) {
      this.#backgroundRefresh(path);
    } else if (this.syncFetch) {
      await this.syncFetch(path).catch(() => {});
    }
    const marker = await getPrivate(this.qu, this.identity, path);
    return marker?.readAt ?? 0;
  }

  /**
   * Posts a message. Applies the thread's configured formatters, enforces
   * writer ACL (via `AccessEngine`, on the `qu.put()` below), and encrypts
   * for the thread's readers if it isn't public.
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {{body: string, replyTo?: string, asSpaceId?: string|number, extra?: object}} params
   *   `asSpaceId` posts under a pseudonymous space identity (see
   *   `@qu/identity`) instead of the main identity. `extra` is merged into
   *   the stored message as-is - e.g. relay-authored notifications attach
   *   `{title, url, appId, image}` alongside the normal human-authored
   *   `body`/`formattedHtml`/`mentions` shape.
   * @returns {Promise<object>} The stored message (plain value).
   */
  async postMessage(spaceId, threadId, { body, replyTo = null, asSpaceId = null, extra = {} }) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) {
      throw new Error(`MessageService.postMessage: no thread "${threadId}" in space "${spaceId}" - call createThread() first`);
    }

    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const authorPub = QuCrypto.toBase64Url(signKey.publicKey);
    const { formattedHtml, mentions } = applyFormatting(body, config.formatting);

    // Set _id ourselves (instead of leaving it to ThreadEngine's own
    // "stamp if missing" default) so the id used in the storage PATH and
    // the id embedded in the message body are guaranteed to be the same
    // value, not two independently-generated UUIDs.
    const messageId = globalThis.crypto.randomUUID();
    const message = { _id: messageId, body, formattedHtml, mentions, author: authorPub, replyTo, ...extra };
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };

    if (config.readers !== '*') {
      const xKey = asSpaceId ? await this.identity.getSpaceXKey(asSpaceId) : await this.identity.getMainXKey();
      putOptions.encryptWith = await this.#resolveReaderXKeys(config.readers);
      putOptions.senderXPrivateKey = xKey.privateKeyPkcs8;
    }

    const path = threadMessagePath(spaceId, threadId, messageId);
    const quBit = await this.qu.put(path, message, putOptions);
    // No index write - messages are a DERIVED list (see class doc comment),
    // this qu.put() alone is what listMessages()'s getChildren() enumerates.
    return { id: messageId, ...message, ts: quBit.ts };
  }

  /**
   * Convenience for "tell one other actor something happened" - creates
   * (if needed) a single-reader mail thread for them and posts one message
   * into it. The one-shot equivalent of `createThread()`+`postMessage()`.
   *
   * @param {string|number} spaceId - The calling app's own space.
   * @param {string} recipientPub
   * @param {string} body
   * @param {object} [extra] - Merged into the stored message as-is, same as `postMessage()`'s own `extra`.
   * @returns {Promise<object>} The stored message (plain value).
   * @throws {Error} If the recipient has no resolvable encryption key yet -
   *   same fail-closed behavior `postMessage()` already has for any private thread.
   */
  async notify(spaceId, recipientPub, body, extra = {}) {
    const threadId = `invite-${recipientPub}`;
    await this.createThread(spaceId, threadId, THREAD_PRESETS.mail(recipientPub));
    return this.postMessage(spaceId, threadId, { body, extra });
  }

  /**
   * Overwrites an existing message's body in place (same path, same
   * `_id`/`replyTo`), re-applying the thread's formatters and re-encrypting
   * for its readers exactly like `postMessage()` - editing is really just
   * "post again at the same id".
   *
   * AUTHOR-ONLY, enforced HERE rather than by the pipeline's ACL: the
   * writers check only answers "is this signer allowed to post IN this
   * thread at all" - for a public thread (`writers: '*'`) that would let
   * literally anyone overwrite anyone else's message just by knowing its
   * id, which the write ACL was never meant to prevent. This check is the
   * actual guard.
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {string} messageId
   * @param {{body: string, asSpaceId?: string|number}} params
   * @returns {Promise<object>} The updated message (plain value).
   * @throws {Error} If the message doesn't exist, can't be read, or the
   *   caller isn't its original author.
   */
  async editMessage(spaceId, threadId, messageId, { body, asSpaceId = null }) {
    const config = await this.getConfig(spaceId, threadId);
    if (!config) {
      throw new Error(`MessageService.editMessage: no thread "${threadId}" in space "${spaceId}"`);
    }

    const path = threadMessagePath(spaceId, threadId, messageId);
    const quBit = await this.qu.get(path);
    if (!quBit) throw new Error(`MessageService.editMessage: no message "${messageId}"`);
    const existing = await this.#decryptMessage(quBit);
    if (!existing) throw new Error(`MessageService.editMessage: cannot read message "${messageId}"`);

    const signKey = asSpaceId ? await this.identity.getSpaceKey(asSpaceId) : await this.identity.getMainKey();
    const authorPub = QuCrypto.toBase64Url(signKey.publicKey);
    if (existing.author !== authorPub) {
      throw new Error(`MessageService.editMessage: only the original author can edit message "${messageId}"`);
    }

    const { formattedHtml, mentions } = applyFormatting(body, config.formatting);
    const message = { _id: messageId, body, formattedHtml, mentions, author: authorPub, replyTo: existing.replyTo ?? null, editedAt: Date.now() };
    const putOptions = { signWith: signKey.privateKeyPkcs8, writerPub: signKey.publicKey };

    if (config.readers !== '*') {
      const xKey = asSpaceId ? await this.identity.getSpaceXKey(asSpaceId) : await this.identity.getMainXKey();
      putOptions.encryptWith = await this.#resolveReaderXKeys(config.readers);
      putOptions.senderXPrivateKey = xKey.privateKeyPkcs8;
    }

    await this.qu.put(path, message, putOptions);
    return { id: messageId, ...message };
  }

  /**
   * Lists a thread's messages, oldest-first by default, decrypting each if
   * the thread is private and this identity is one of its readers.
   *
   * UNLIKE QuV2's collection-backed version, this does NOT need its own
   * `syncFetch` backfill for the enumeration itself: a DERIVED list IS
   * `QuStore.getChildren()` over the adapter's actual local state, and
   * keeping that state current after a reconnect is sync's own reconnect
   * catch-up (docs/v3-technical-concept.md §3.2), not something each
   * Service re-implements - see `ListService.listDerived()`'s own doc
   * comment. Nor does it need a second per-message fetch: `listDerived()`
   * already returns each entry's full QuBit inline, not just a path to
   * resolve separately.
   *
   * ORDERING CAVEAT: two messages posted within the same millisecond (`ts`
   * has millisecond resolution) tie-break on `rel` - their storage path,
   * which starts with a random `messageId` (see `postMessage()`) - NOT on
   * posting order. This is `QuStore.getChildren()`'s own documented
   * `(ts,rel)` contract (deterministic and pagination-safe, not
   * necessarily meaningful), and an inherent limit for a local-first
   * system with no central sequencer, not something `MessageService`
   * special-cases around: two messages genuinely written at the same
   * millisecond (by this device or two different ones) have no single
   * "true" order to recover. In practice this only matters for messages
   * posted faster than 1/ms (automated/bot senders, not human typing
   * speed) - see this file's own test suite for how tests account for it.
   *
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {{limit?: number, order?: 'asc'|'desc', cursor?: string}} [options]
   * @returns {Promise<{messages: object[], nextCursor: string|null}>}
   *   `nextCursor` is non-null only when `limit` was given and exactly
   *   `limit` entries came back - pass it as `options.cursor` for the next page.
   */
  async listMessages(spaceId, threadId, { limit, order = 'asc', cursor = null } = {}) {
    const entries = await this.list.listDerived(threadMessagesParentPath(spaceId, threadId), { limit, order, cursor });
    const messages = [];
    for (const entry of entries) {
      const val = await this.#decryptMessage(entry.quBit);
      if (val) messages.push({ id: val._id, ts: entry.quBit.ts, ...val });
    }
    const nextCursor = limit && entries.length === limit ? entries[entries.length - 1].cursor : null;
    return { messages, nextCursor };
  }

  /**
   * A single message by id - cheaper than `listMessages()` when a caller
   * already knows exactly which one it wants (e.g. resolving a notification's
   * stored `{spaceId, threadId, messageId}` reference back into real
   * content - see `apps/notifications`' own doc comment). No internal
   * `syncFetch` backfill, matching `listDerived()`'s own documented
   * convention - a miss here is the CALLER's job to backfill first (an
   * explicit `syncFetch(threadMessagePath(...))` call), same as every other
   * read in this Service.
   * @param {string|number} spaceId @param {string} threadId @param {string} messageId
   * @returns {Promise<object|null>} `{id, ts, ...}` (same shape `listMessages()`
   *   entries have), or `null` if missing or undecryptable.
   */
  async getMessage(spaceId, threadId, messageId) {
    const quBit = await this.qu.get(threadMessagePath(spaceId, threadId, messageId));
    if (!quBit?.val) return null;
    const val = await this.#decryptMessage(quBit);
    return val ? { id: val._id, ts: quBit.ts, ...val } : null;
  }

  /**
   * @param {string|number} spaceId
   * @param {string} threadId
   * @param {string} parentMessageId
   * @returns {Promise<Array<object>>} Every message whose `replyTo` matches
   *   `parentMessageId` - reads the FULL (unpaginated) message list, same as
   *   QuV2's version, since a reply search can't know in advance how far
   *   back to page.
   */
  async listReplies(spaceId, threadId, parentMessageId) {
    const { messages } = await this.listMessages(spaceId, threadId);
    return messages.filter((m) => m.replyTo === parentMessageId);
  }

  /**
   * @param {Array<string>} readerPubs - base64url Ed25519 actor pubkeys.
   * @returns {Promise<Array<Uint8Array>>} Their raw X25519 public keys.
   * @throws {Error} If any reader has no published profile/X key - fails
   *   closed rather than posting a partially-unprotected message.
   */
  async #resolveReaderXKeys(readerPubs) {
    return resolveReaderXKeys(readerPubs, (pub) => this.#getProfile(pub));
  }

  /**
   * @param {object} quBit
   * @returns {Promise<object|null>} The decrypted message, or the message
   *   as-is if it was never encrypted, or null if this identity can't
   *   decrypt it (not a listed reader, or the sender's profile/key is unresolvable).
   */
  async #decryptMessage(quBit) {
    if (!isEncryptedEnvelope(quBit.val)) return quBit.val;
    return decryptEnvelope(quBit, this.identity, (pub) => this.#getProfile(pub));
  }
}

/**
 * Ready-made configs proving "Forum/Chat/Mail/Notifications differ only by
 * config" - each still goes through the exact same `createThread()`/
 * `postMessage()`/`listMessages()` as any other thread.
 */
export const THREAD_PRESETS = {
  /** A public board: anyone can read, anyone can post, markdown + mentions. */
  forum: () => ({ writers: '*', readers: '*', replyMode: 'flat', formatting: ['markdown', 'mentions'] }),

  /** A shared room restricted to a fixed member list. */
  chat: (memberPubs) => ({ writers: memberPubs, readers: memberPubs, replyMode: 'flat', formatting: ['markdown', 'mentions'] }),

  /**
   * A named multi-member room - same encrypted-for-a-fixed-member-list
   * shape as `chat`, plus `name` (display) and `kind: 'group'` (so a
   * generic reader of `getConfig()` can tell a group apart from a 1:1 room
   * without a separate metadata store). Membership is fixed at creation:
   * adding/removing members would mean re-keying every future message for a
   * different reader set, which is real future work, not implemented here.
   */
  group: (memberPubs, name) => ({ writers: memberPubs, readers: memberPubs, replyMode: 'flat', formatting: ['markdown', 'mentions'], kind: 'group', name }),

  /** A personal inbox: anyone can send TO it, only the owner can read it - exactly a mailbox. */
  mail: (ownerPub) => ({ writers: '*', readers: [ownerPub], replyMode: 'flat', formatting: ['markdown', 'mentions'] }),

  /** System/app-generated notices, visible only to the owner, no formatting. */
  notifications: (ownerPub) => ({ writers: '*', readers: [ownerPub], replyMode: 'flat', formatting: [] }),

  /**
   * A membership list that GROWS over time (via `addReader()`/
   * `removeReader()`, unlike `chat`/`group`'s fixed list). `writers: '*'`
   * because only the owning app's own code posts into it (a system activity
   * feed, not open user content), so there's no separate writer allowlist
   * to maintain in lockstep with `readers`.
   */
  activity: (memberPubs) => ({ writers: '*', readers: memberPubs, replyMode: 'flat', formatting: [] }),
};
