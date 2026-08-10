import { QuCrypto } from '@qu/core';
import { THREAD_PRESETS } from './message-service.js';

/**
 * CHAT SERVICE — group-chat creation and discovery on top of `MessageService`
 * (ported from QuV2's `packages/services/src/chat-service.js`, unchanged in
 * shape - see that file's own doc comment for the original rationale). A 1:1
 * room needs no discovery step: its id is DERIVED from both members' pubkeys
 * (`ChatService.roomId()`), so either side lands in the same room, with
 * Contacts (`@qu/services`' `ContactsService`) as the mutual-interest signal
 * `apps/chat` uses to populate its room list - see that app's own doc
 * comment. A GROUP's id is arbitrary (there's no deterministic function of
 * an open-ended member list two people would independently compute the same
 * way), so an invited member needs to be TOLD it exists.
 *
 * The delivery mechanism reuses `THREAD_PRESETS.mail` exactly as-is: every
 * identity gets its own private "chat invites" mailbox (`chat-invites-<pub>`
 * - the SAME `<namespace>-<actorPub>` ad hoc space-id convention `paths.js`'
 * `notificationsSpaceId()` already establishes for exactly this "one
 * collision-safe space per identity" shape, not this app's own
 * `manifest.spaceId`, which only anchors the room THREADS themselves -
 * readers: [that identity], anyone can write, only the owner can read).
 * Creating a group posts one invite message into each OTHER member's
 * mailbox; `listMyGroups()` reads this identity's own mailbox for the group
 * ids it's been told about. The group's actual name/membership always comes
 * from the group thread's own config (via `messages.getConfig()`), never
 * from the invite - the invite is only ever used for "which group ids do I
 * belong to", not as a second source of truth for the group's metadata.
 *
 * GROUP MEMBERSHIP IS FIXED AT CREATION - `THREAD_PRESETS.group()`'s own
 * doc comment already states why (re-keying every future message for a
 * different reader set is real future work, not implemented here).
 */
export class ChatService {
  static #INVITE_THREAD_ID = 'groups';

  /**
   * A deterministic 1:1/group room id both members derive independently,
   * order-independent - pure function of the member set, no identity/thread
   * state needed, hence static. An App never has to reach past its Service
   * layer for a plain hash derivation.
   * @param {string[]} memberPubs
   * @returns {Promise<string>}
   */
  static async roomId(memberPubs) {
    const sorted = [...memberPubs].sort();
    const hash = await QuCrypto.sha256(new TextEncoder().encode(sorted.join(',')));
    return `r-${QuCrypto.toHex(hash).slice(0, 32)}`;
  }

  /**
   * @param {import('./message-service.js').MessageService} messages
   * @param {import('@qu/identity').QuIdentityEngine} identityEngine
   */
  constructor(messages, identityEngine) {
    this.messages = messages;
    this.identity = identityEngine;
  }

  static #inviteSpace(actorPub) {
    return `chat-invites-${actorPub}`;
  }

  async #myActorPub() {
    const mainKey = await this.identity.getMainKey();
    return QuCrypto.toBase64Url(mainKey.publicKey);
  }

  /**
   * Ensures a 1:1 room's thread exists (idempotent - `MessageService.
   * createThread()` returns the existing config unchanged if one's already
   * there) and returns its id. Either member calling this independently
   * lands on the SAME thread, no invite/discovery step needed - see class
   * doc comment.
   * @param {string|number} spaceId - This app's own `manifest.spaceId`.
   * @param {string} theirPub
   * @returns {Promise<string>} The room's threadId.
   */
  async ensureRoom(spaceId, theirPub) {
    const myPub = await this.#myActorPub();
    const roomId = await ChatService.roomId([myPub, theirPub]);
    await this.messages.createThread(spaceId, roomId, THREAD_PRESETS.chat([myPub, theirPub]));
    return roomId;
  }

  /**
   * @param {string|number} spaceId - This app's own `manifest.spaceId`.
   * @param {{name: string, memberPubs: string[]}} params - `memberPubs` are
   *   the OTHER members; this identity is added automatically.
   * @returns {Promise<{groupId: string, name: string, memberPubs: string[]}>}
   */
  async createGroup(spaceId, { name, memberPubs }) {
    const myPub = await this.#myActorPub();
    const allMembers = [...new Set([myPub, ...memberPubs])];
    const groupId = `g-${globalThis.crypto.randomUUID()}`;

    await this.messages.createThread(spaceId, groupId, THREAD_PRESETS.group(allMembers, name));

    await Promise.all(allMembers.filter((pub) => pub !== myPub).map(async (theirPub) => {
      const inviteSpace = ChatService.#inviteSpace(theirPub);
      await this.messages.createThread(inviteSpace, ChatService.#INVITE_THREAD_ID, THREAD_PRESETS.mail(theirPub));
      await this.messages.postMessage(inviteSpace, ChatService.#INVITE_THREAD_ID, {
        body: name,
        extra: { type: 'group-invite', groupId, name, memberPubs: allMembers },
      });
    }));

    return { groupId, name, memberPubs: allMembers };
  }

  /**
   * @returns {Promise<string[]>} Every group id this identity has ever been
   *   invited to. Membership is fixed at creation (see class doc comment),
   *   so this only ever grows.
   */
  async listMyGroups() {
    const myPub = await this.#myActorPub();
    const inviteSpace = ChatService.#inviteSpace(myPub);
    await this.messages.createThread(inviteSpace, ChatService.#INVITE_THREAD_ID, THREAD_PRESETS.mail(myPub));
    const { messages: invites } = await this.messages.listMessages(inviteSpace, ChatService.#INVITE_THREAD_ID);

    const groupIds = new Set();
    for (const invite of invites) {
      if (invite.type === 'group-invite' && invite.groupId) groupIds.add(invite.groupId);
    }
    return [...groupIds];
  }

  /** @returns {Promise<string>} The space this identity's own group invites live under - for `subscribe()`. */
  async myInviteSpace() {
    return ChatService.#inviteSpace(await this.#myActorPub());
  }
}
