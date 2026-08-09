import { QuCrypto } from '@qu/core';
import { documentPath, listPath, threadMetaPath } from './paths.js';
import { THREAD_PRESETS } from './message-service.js';

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
 * the channel Document itself is protected via `AccessService.protect()`
 * (`writers: memberPubs`, `readers` deliberately left at the default `'*'`
 * - encrypting a plain Document would make it unreadable, since nothing
 * reading a Document expects a decrypt step, see `AccessService.
 * writeOptionsFor()`'s own doc comment) so only members may rename/edit it
 * later; every Topic CREATED under it gets `THREAD_PRESETS.chat(memberPubs)`
 * instead of the public `THREAD_PRESETS.forum()` - genuine encryption for
 * exactly that member list, the relay included, sees ciphertext only. This
 * only locks CONTENT: the channel's and its topics' TITLES stay visible
 * plaintext metadata (same "path is addressing, not proof of readability"
 * limitation as everywhere else in this codebase) - fully hiding a
 * restricted channel's existence is real future work, not implemented here.
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
      await this.access.protect(spaceId, 'docs', id, { writers: allMembers });
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
      return quBit?.val ?? null;
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
    return quBit?.val ?? null;
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
    const topic = { _id: id, title, channelId, author: myPub, createdAt: Date.now() };
    await this.qu.put(documentPath(spaceId, id), topic, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });
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
   * @returns {Promise<Array<object & {replyCount: number, lastActivityAt: number, lastAuthor: string}>>}
   *   Newest activity first - cheap at community-forum scale (one
   *   `listMessages()` per topic, no pagination), same accepted cost model
   *   `apps/forum/client.js`'s own per-message watchers already use.
   */
  async listTopics(spaceId, channelId) {
    const itemPaths = await this.list.listCuratedRawPaths(this.#topicsListPath(spaceId, channelId));
    const topics = await this.#resolveItems(itemPaths);
    const withActivity = await Promise.all(topics.map(async (topic) => {
      const { messages } = await this.messages.listMessages(spaceId, topic._id, { order: 'desc' });
      const last = messages[0];
      return {
        ...topic,
        replyCount: messages.length,
        lastActivityAt: last?.ts ?? topic.createdAt,
        lastAuthor: last?.author ?? topic.author,
      };
    }));
    return withActivity.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** Grows BOTH `writers` and `readers` on a topic's thread config in one write - see class doc comment on why not `MessageService.addReader()` alone. */
  async #growTopicMembership(spaceId, topicId, actorPub) {
    const config = await this.messages.getConfig(spaceId, topicId);
    if (!config || !Array.isArray(config.writers)) return; // a public thread ('*') or a missing one - nothing to grow
    const writers = config.writers.includes(actorPub) ? config.writers : [...config.writers, actorPub];
    const readers = Array.isArray(config.readers) && !config.readers.includes(actorPub) ? [...config.readers, actorPub] : config.readers;
    if (writers === config.writers && readers === config.readers) return; // already a member of this topic
    const updated = { ...config, writers, readers };
    const mainKey = await this.identity.getMainKey();
    await this.qu.put(threadMetaPath(spaceId, topicId), updated, { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey });
    await this.access.protect(spaceId, 'threads', topicId, { writers: updated.writers, readers: updated.readers }, { includeSelfAsWriter: false });
  }

  /**
   * Adds `actorPub` to a restricted channel's membership - grows the
   * channel document's own writer ACL, then every one of its EXISTING
   * topics' thread membership (new topics created after this call already
   * pick up the grown `channel.memberPubs` automatically via
   * `createTopic()`). A no-op for an already-open channel (nothing to grow
   * - every topic's thread is already public) or an already-present member.
   * @param {string|number} spaceId @param {string} channelId @param {string} actorPub
   * @returns {Promise<object>} The (possibly updated) channel.
   */
  async addChannelMember(spaceId, channelId, actorPub) {
    const channel = await this.getChannel(spaceId, channelId);
    if (!channel) throw new Error(`ChannelService.addChannelMember: no channel "${channelId}" in space "${spaceId}"`);
    if (!channel.restricted || channel.memberPubs.includes(actorPub)) return channel;

    await this.access.addWriter(spaceId, 'docs', channelId, actorPub);
    const writeOptions = await this.access.writeOptionsFor(spaceId, 'docs', channelId);
    const updated = { ...channel, memberPubs: [...channel.memberPubs, actorPub] };
    await this.qu.put(documentPath(spaceId, channelId), updated, writeOptions);

    const topics = await this.listTopics(spaceId, channelId);
    for (const topic of topics) await this.#growTopicMembership(spaceId, topic._id, actorPub);
    return updated;
  }
}
