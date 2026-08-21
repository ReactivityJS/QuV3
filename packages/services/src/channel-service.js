import { QuCrypto, isEncryptedEnvelope } from '@qu/core';
import { documentPath, listPath, threadMetaPath } from './paths.js';
import { THREAD_PRESETS } from './message-service.js';
import { decryptEnvelope } from './crypto-envelope.js';

/**
 * CHANNEL SERVICE — Forum's Channel -> Topic -> per-Topic-Thread hierarchy
 * (esoTalk-styled, QuV2's own Forum shape), rebuilt on V3's primitives
 * instead of QuV2's `DocumentService`/`CollectionService` pair (neither
 * exists in V3 - superseded by `ListService`, see `DirectoryService`'s own
 * doc comment for the same substitution). A Channel and a Topic are both
 * plain, unencrypted-metadata Documents (`documentPath()`); a Topic's
 * actual message content lives in a real `MessageService` Thread keyed by
 * the topic's own id - "a Topic IS its Thread," no separate concept.
 *
 * TWO curated lists per space (`ListService.createCurated()`/`addCurated()`,
 * the SAME hardened, retry-on-conflict primitive every other list in this
 * codebase uses - not QuV2's unprotected `documents.create()` +
 * `collections.addItem()` pair): `listPath(spaceId, 'channels')` (every
 * channel), and one `listPath(spaceId, 'topics-<channelId>')` per channel
 * (that channel's own topics). This is what actually fixes the "double-
 * clicking Create sometimes makes two boards" class of bug QuV2 had -
 * `ListService.addCurated()`'s own lock+retry already exists; the OTHER
 * half of that fix (disabling the submit button while a create is in
 * flight) is the client's job, not this Service's.
 *
 * RESTRICTED CHANNELS - real end-to-end encryption, not a UI-only filter:
 * the channel Document AND every Topic Document created under it are
 * protected via `AccessService.protect()` with BOTH `writers` AND `readers`
 * set to `memberPubs` - unlike most `kind: 'docs'` resources elsewhere in
 * this codebase (which deliberately leave `readers: '*'`, see
 * `AccessService.writeOptionsFor()`'s own "GOTCHA for docs/lists" doc
 * comment - nothing generic decrypts a plain Document read back), THIS
 * Service is decrypt-aware for its own two doc shapes (`#decrypt()` below,
 * the same `isEncryptedEnvelope()`/`decryptEnvelope()` pair `MessageService`/
 * `AssetService` already use internally) - so a restricted channel's title
 * AND description, and every one of its topics' own titles, are genuinely
 * ciphertext at rest, not just access-controlled. `#resolveItems()`'s
 * existing "drop anything unresolvable" behavior means `decryptEnvelope()`
 * returning `null` for a non-member (see its own doc comment - no listed
 * reader entry, no throw) makes `listChannels()`/`listTopics()` filter
 * themselves by membership for free, no separate check needed; `getChannel()`
 * returns `null` for a non-member even via a direct/bookmarked board URL.
 * Every Topic CREATED under a restricted channel also gets
 * `THREAD_PRESETS.chat(memberPubs)` instead of the public
 * `THREAD_PRESETS.forum()` for its own message THREAD - the relay, and any
 * non-member, sees ciphertext only, for metadata and content alike.
 *
 * WHAT'S STILL NOT HIDDEN (accepted, documented trade-off - a bigger
 * invite-mailbox redesign like Chat's own group rooms was explicitly
 * declined for now): the encrypted envelope's own `to: [{pub, key}, ...]`
 * array (`QuStore.put()`'s encryption shape) lists every reader's raw
 * X25519 pubkey in the clear - someone inspecting the raw synced store
 * directly (not through this app's own UI, which never shows this) can
 * still enumerate a restricted channel's MEMBERSHIP, just not its title,
 * description, or any topic's title/content. And none of this is
 * retroactive: a restricted channel/topic created before this Service
 * started requesting `readers` restriction stays plaintext until re-created.
 *
 * GROWING MEMBERSHIP (`addChannelMember()`) - not something QuV2 ever
 * shipped ("creator-only at creation, no UI wired up" was its own
 * documented v1 gap). `MessageService.addReader()` alone isn't enough here:
 * it only grows a thread's `readers`, but `THREAD_PRESETS.chat()` uses the
 * SAME list for `writers` too, and `MessageService` has no `addWriter()` -
 * so this Service grows both fields on the thread's own config document in
 * one write (mirroring exactly what `addReader()` does internally, just for
 * both fields at once) rather than risking two separate calls racing each
 * other's `access.protect()` overwrite. Same non-retroactive trade-off
 * `addReader()` itself documents: a newly added member sees every topic
 * going forward, nothing posted before they joined.
 */
export class ChannelService {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   * @param {import('./list-service.js').ListService} listService
   * @param {import('./access-service.js').AccessService} accessService
   * @param {import('./message-service.js').MessageService} messageService
   * @param {(path: string) => Promise<object|null>} [syncFetch] - See
   *   `#resolveItems()`'s own doc comment for exactly what gap this closes -
   *   without it, a peer who joins AFTER a channel/topic was created never
   *   sees it, confirmed live (not hypothetical): `ListService.
   *   listCuratedRawPaths()` already backfills the LIST document itself
   *   on a miss, but `@qu/engines`' `CollectionEngine` (which resolves each
   *   `$list` entry to its actual value on READ) only ever does a LOCAL
   *   `qu.get()` per referenced path - it has no network access of its own,
   *   by design (Engines are synchronous-pipeline participants, not I/O).
   *   A channel/topic document that already existed before this identity's
   *   OWN session first subscribed to this space is exactly the case
   *   `subscribe()`'s own doc comment names as OUT of its scope ("only
   *   affects FUTURE writes") - only an explicit per-path `syncFetch()`
   *   closes it, which is what this Service does itself instead of relying
   *   on `ListService`/`CollectionEngine` to have already done it.
   */
  constructor(qu, identityEngine, listService, accessService, messageService, syncFetch = null) {
    this.qu = qu;
    this.identity = identityEngine;
    this.list = listService;
    this.access = accessService;
    this.messages = messageService;
    this.syncFetch = syncFetch;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * Same syncFetch-backfilled resolver shape every other Service's own
   * `#getProfile()` already uses (e.g. `AccessService`'s, `access-service.js:
   * 42-51`) - `#decrypt()` below needs it to resolve a channel/topic
   * document's SENDER's X key (`decryptEnvelope()`'s own contract).
   * @param {string} actorPub
   * @returns {Promise<object|null>}
   */
  async #getProfile(actorPub) {
    const local = await this.identity.getProfile(actorPub);
    if (local || !this.syncFetch) return local;
    await this.syncFetch(`/store/actors/~${actorPub}/profile`).catch(() => {});
    return this.identity.getProfile(actorPub);
  }

  /**
   * Decrypts a channel/topic QuBit's `val` for the current identity, or
   * passes a still-plaintext one through unchanged (an already-existing
   * restricted channel/topic created before `readers` restriction was
   * added here - see class doc comment's "not retroactive" note). Returns
   * `null` for an encrypted value this identity can't decrypt (not a
   * listed reader) - `decryptEnvelope()`'s own contract, no throw - which
   * is exactly what makes `#resolveItems()`'s `.filter(Boolean)` below
   * double as membership filtering, for free.
   * @param {{val: object, pub: string|null}} quBit
   * @returns {Promise<object|null>}
   */
  async #decrypt(quBit) {
    if (!isEncryptedEnvelope(quBit.val)) return quBit.val;
    return decryptEnvelope(quBit, this.identity, (pub) => this.#getProfile(pub));
  }

  #channelsListPath(spaceId) {
    return listPath(spaceId, 'channels');
  }

  #topicsListPath(spaceId, channelId) {
    return listPath(spaceId, `topics-${channelId}`);
  }

  /**
   * @param {string|number} spaceId
   * @param {{title: string, description?: string, color?: string, restricted?: boolean, memberPubs?: string[], channelId?: string}} options
   *   `channelId` - normally omitted (a fresh `crypto.randomUUID()` is
   *   generated); only ever passed explicitly for a fixed, well-known id
   *   (see `apps/forum/index.js`'s own "General" channel migration).
   * @returns {Promise<object>} The stored channel.
   */
  async createChannel(spaceId, { title, description = '', color = '', restricted = false, memberPubs = [], channelId } = {}) {
    const id = channelId ?? globalThis.crypto.randomUUID();
    const myPub = await this.#myActorPub();
    const mainKey = await this.identity.getMainKey();
    let writeOptions = { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey };

    // Always includes the creator - otherwise they couldn't read/write
    // their own restricted channel's topics.
    const allMembers = restricted ? [...new Set([myPub, ...memberPubs])] : [];

    if (restricted) {
      await this.access.protect(spaceId, 'docs', id, { writers: allMembers, readers: allMembers });
      writeOptions = await this.access.writeOptionsFor(spaceId, 'docs', id);
    }

    const channel = { _id: id, title, description, color, createdBy: myPub, createdAt: Date.now(), restricted, memberPubs: allMembers };
    await this.qu.put(documentPath(spaceId, id), channel, writeOptions);
    await this.list.addCurated(this.#channelsListPath(spaceId), documentPath(spaceId, id), {
      signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey,
    });
    return channel;
  }

  /**
   * Resolves each referenced document path to its plain value, backfilling
   * via `this.syncFetch` on a local miss before giving up - see the
   * constructor's own doc comment for exactly why this can't just be
   * `ListService.listCurated()` (which stops at "ask a peer for the LIST
   * document itself," never each thing IT references).
   * @param {string[]} itemPaths
   * @returns {Promise<object[]>} Resolved values only - a path that's still
   *   unresolvable after the backfill attempt is silently dropped, not
   *   returned as `null` (every real caller here wants "every channel/topic
   *   we could actually find," not a same-length array with gaps).
   */
  async #resolveItems(itemPaths) {
    const resolved = await Promise.all(itemPaths.map(async (path) => {
      let quBit = await this.qu.get(path);
      if (!quBit?.val && this.syncFetch) {
        await this.syncFetch(path).catch(() => {});
        quBit = await this.qu.get(path);
      }
      if (!quBit?.val) return null;
      return this.#decrypt(quBit);
    }));
    return resolved.filter(Boolean);
  }

  /** @param {string|number} spaceId @returns {Promise<object[]>} Every channel - resolved values, not paths. */
  async listChannels(spaceId) {
    const itemPaths = await this.list.listCuratedRawPaths(this.#channelsListPath(spaceId));
    return this.#resolveItems(itemPaths);
  }

  /** @param {string|number} spaceId @param {string} channelId @returns {Promise<object|null>} */
  async getChannel(spaceId, channelId) {
    const path = documentPath(spaceId, channelId);
    let quBit = await this.qu.get(path);
    if (!quBit?.val && this.syncFetch) {
      // A peer opening a direct/shared link to a channel it has never
      // listed via listChannels() first - same backfill-on-miss reasoning
      // as #resolveItems(), just for a single known path instead of a list.
      await this.syncFetch(path).catch(() => {});
      quBit = await this.qu.get(path);
    }
    if (!quBit?.val) return null;
    return this.#decrypt(quBit);
  }

  /**
   * @param {string|number} spaceId @param {string} channelId
   * @param {{title: string}} options
   * @returns {Promise<object>} The stored topic.
   * @throws {Error} If the channel doesn't exist.
   */
  async createTopic(spaceId, channelId, { title }) {
    const channel = await this.getChannel(spaceId, channelId);
    if (!channel) throw new Error(`ChannelService.createTopic: no channel "${channelId}" in space "${spaceId}"`);

    const id = globalThis.crypto.randomUUID();
    const myPub = await this.#myActorPub();
    const mainKey = await this.identity.getMainKey();
    let topicWriteOptions = { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey };
    // A restricted channel's topic TITLE gets the exact same treatment as
    // the channel's own title (see class doc comment's "RESTRICTED
    // CHANNELS" section) - protected AND encrypted, not just access-
    // controlled, so it's genuine ciphertext to a non-member, same as the
    // channel doc itself.
    if (channel.restricted) {
      await this.access.protect(spaceId, 'docs', id, { writers: channel.memberPubs, readers: channel.memberPubs });
      topicWriteOptions = await this.access.writeOptionsFor(spaceId, 'docs', id);
    }
    const topic = { _id: id, title, channelId, author: myPub, createdAt: Date.now() };
    await this.qu.put(documentPath(spaceId, id), topic, topicWriteOptions);
    await this.list.addCurated(this.#topicsListPath(spaceId, channelId), documentPath(spaceId, id), {
      signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey,
    });
    // A Topic IS its Thread - same id, no separate concept (see class doc
    // comment). Deliberately NOT `THREAD_PRESETS.chat(memberPubs)` verbatim
    // for a restricted topic - `chat()` is QuV2's own messenger-style
    // preset, `formatting: ['mentions']` only, no markdown (a 1:1/group chat
    // was never meant to render as forum prose). A restricted BOARD is
    // still a forum topic, just encrypted - the encryption/membership shape
    // is exactly `chat()`'s (`writers`/`readers` both the member list), but
    // formatting must stay `forum()`'s own (`markdown` + `mentions`), or
    // every message renders with an empty body: `apps/forum/client.js`
    // unconditionally inserts `message.formattedHtml`, which is `null`
    // (and `[LegacyNullToEmptyString]` on `.innerHTML` silently renders as
    // nothing, not even the word "null") whenever `markdown` isn't in a
    // thread's `formatting` list - confirmed live, a real bug caught by
    // this feature's own end-to-end verification, not a hypothetical.
    const threadConfig = channel.restricted
      ? { writers: channel.memberPubs, readers: channel.memberPubs, replyMode: 'flat', formatting: ['markdown', 'mentions'] }
      : THREAD_PRESETS.forum();
    await this.messages.createThread(spaceId, id, threadConfig);
    return topic;
  }

  /**
   * @param {string|number} spaceId @param {string} channelId
   * @returns {Promise<Array<object & {replyCount: number, lastActivityAt: number, lastAuthor: string, unreadCount: number}>>}
   *   Newest activity first - cheap at community-forum scale (one
   *   `listMessages()` per topic, no pagination), same accepted cost model
   *   `apps/forum/client.js`'s own per-message watchers already use.
   *   `unreadCount` - this identity's own count of THIS topic's messages
   *   posted by someone else since its own `MessageService.markRead()`
   *   marker (0 if never marked, i.e. everyone else's posts count) - the
   *   same "unread-by-me" definition `apps/forum/client.js`'s own per-
   *   message badge already uses (see that file's own "UNREAD-BY-ME" doc
   *   comment), just aggregated per topic instead of per message, so a
   *   board/channel overview can show it without opening every topic.
   */
  async listTopics(spaceId, channelId) {
    const itemPaths = await this.list.listCuratedRawPaths(this.#topicsListPath(spaceId, channelId));
    const topics = await this.#resolveItems(itemPaths);
    const myPub = await this.#myActorPub();
    const withActivity = await Promise.all(topics.map(async (topic) => {
      const [{ messages }, lastReadAt] = await Promise.all([
        this.messages.listMessages(spaceId, topic._id, { order: 'desc' }),
        this.messages.getLastReadAt(spaceId, topic._id),
      ]);
      const last = messages[0];
      const unreadCount = messages.filter((m) => m.author !== myPub && m.ts > lastReadAt).length;
      return {
        ...topic,
        replyCount: messages.length,
        lastActivityAt: last?.ts ?? topic.createdAt,
        lastAuthor: last?.author ?? topic.author,
        unreadCount,
      };
    }));
    return withActivity.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /**
   * Grows BOTH `writers` and `readers` on a topic's thread config in one
   * write - see class doc comment on why not `MessageService.addReader()`
   * alone - AND, separately, the topic's own TITLE Document: adding a
   * reader to the ACL alone doesn't let them decrypt ciphertext that was
   * already encrypted for the OLD member list, so the title has to be
   * re-read (plaintext, since this identity - already a member - can
   * decrypt it) and re-written with a freshly resolved `encryptWith` that
   * now includes the new member's key too - same "grow the ACL, then
   * re-encrypt" two-step `addChannelMember()` itself already does for the
   * channel document below.
   */
  async #growTopicMembership(spaceId, topicId, actorPub) {
    const config = await this.messages.getConfig(spaceId, topicId);
    if (config && Array.isArray(config.writers)) {
      const writers = config.writers.includes(actorPub) ? config.writers : [...config.writers, actorPub];
      const readers = Array.isArray(config.readers) && !config.readers.includes(actorPub) ? [...config.readers, actorPub] : config.readers;
      if (writers !== config.writers || readers !== config.readers) {
        const updated = { ...config, writers, readers };
        const mainKey = await this.identity.getMainKey();
        await this.qu.put(threadMetaPath(spaceId, topicId), updated, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });
        await this.access.protect(spaceId, 'threads', topicId, { writers: updated.writers, readers: updated.readers }, { includeSelfAsWriter: false });
      }
    }

    const docAcl = await this.access.getAcl(spaceId, 'docs', topicId);
    if (docAcl && Array.isArray(docAcl.readers) && !docAcl.readers.includes(actorPub)) {
      const [topic] = await this.#resolveItems([documentPath(spaceId, topicId)]);
      if (topic) {
        await this.access.addWriter(spaceId, 'docs', topicId, actorPub);
        await this.access.addReader(spaceId, 'docs', topicId, actorPub);
        const writeOptions = await this.access.writeOptionsFor(spaceId, 'docs', topicId);
        await this.qu.put(documentPath(spaceId, topicId), topic, writeOptions);
      }
    }
  }

  /**
   * Adds `actorPub` to a restricted channel's membership - grows the
   * channel document's own writer ACL, then every one of its EXISTING
   * topics' thread membership (new topics created after this call already
   * pick up the grown `channel.memberPubs` automatically via
   * `createTopic()`). A no-op for an already-open channel (nothing to grow
   * - every topic's thread is already public) or an already-present member.
   *
   * PER-TOPIC FAILURES DON'T ABORT THE REST - `Promise.allSettled()`, not a
   * plain sequential loop that stops at the first `throw`. A prior version
   * used a sequential `for` loop: one topic's `#growTopicMembership()` call
   * failing (a stale local read racing a concurrent write, a transient
   * local-write error, ...) meant every topic AFTER it in the list silently
   * never got grown at all, with no error surfaced anywhere the admin who
   * just invited someone would ever see - a real, confirmed cause of "this
   * member can't post in some (but not all) topics of a channel they were
   * just added to," with a relay/other peer's own `SyncEngine` rejecting
   * their writes outright once they actually tried
   * (`AccessEngine: writer not authorized to write to threads "..."`,
   * a real, previously-unexplained log line). The channel-level membership
   * add above (readable/writable channel doc, `channel.memberPubs`) still
   * always fully succeeds before this runs; only per-topic growth can now
   * partially fail, and does so LOUDLY (thrown here, not swallowed) so a
   * caller (see `apps/forum/client.js`'s own invite form) can tell the
   * admin something needs a retry instead of believing the invite fully
   * worked.
   * @param {string|number} spaceId @param {string} channelId @param {string} actorPub
   * @returns {Promise<object>} The (possibly updated) channel.
   * @throws {Error} If the channel-level add succeeded but growing one or
   *   more EXISTING topics' own membership failed - the channel doc itself
   *   is still updated either way; only some topics may need a retry.
   */
  async addChannelMember(spaceId, channelId, actorPub) {
    const channel = await this.getChannel(spaceId, channelId);
    if (!channel) throw new Error(`ChannelService.addChannelMember: no channel "${channelId}" in space "${spaceId}"`);
    if (!channel.restricted || channel.memberPubs.includes(actorPub)) return channel;

    await this.access.addWriter(spaceId, 'docs', channelId, actorPub);
    // Growing `readers` too (not just `writers`) is what makes the
    // `writeOptionsFor()` call right below actually re-encrypt the channel
    // document FOR the new member - `writers` alone only lets them WRITE,
    // it has no bearing on `encryptWith`'s own reader list (see class doc
    // comment's "RESTRICTED CHANNELS" section).
    await this.access.addReader(spaceId, 'docs', channelId, actorPub);
    const writeOptions = await this.access.writeOptionsFor(spaceId, 'docs', channelId);
    const updated = { ...channel, memberPubs: [...channel.memberPubs, actorPub] };
    await this.qu.put(documentPath(spaceId, channelId), updated, writeOptions);

    const topics = await this.listTopics(spaceId, channelId);
    const results = await Promise.allSettled(topics.map((topic) => this.#growTopicMembership(spaceId, topic._id, actorPub)));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(`ChannelService.addChannelMember: added to the channel, but failed to grow membership for ${failed.length}/${topics.length} existing topic(s) - ${failed.map((r) => r.reason?.message ?? r.reason).join('; ')}`);
    }
    return updated;
  }
}
