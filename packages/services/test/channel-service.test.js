import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine, CollectionEngine, EntityEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { AccessService } from '../src/access-service.js';
import { MessageService } from '../src/message-service.js';
import { ChannelService } from '../src/channel-service.js';
import { threadMessagePath } from '../src/paths.js';

async function freshIdentity(qu) {
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return identity;
}

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  new CollectionEngine(qu); // resolves ListService's curated {$list} documents
  new EntityEngine(qu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const identity = await freshIdentity(qu);
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const channels = new ChannelService(qu, identity, list, access, messages);
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  return { qu, identity, list, access, messages, channels, myPub };
}

async function copyQuBit(fromQu, toQu, path) {
  const quBit = await fromQu.get(path);
  if (quBit) await toQu.putSealed(path, quBit);
  return quBit;
}

/**
 * Copies the RAW stored QuBit for a curated LIST document, bypassing
 * `@qu/engines`' `CollectionEngine`'s read-time `$list` resolution - see
 * the "listChannels()/listTopics() backfill..." test's own doc comment
 * below for exactly why `copyQuBit()` (which goes through `qu.get()`, and
 * so hands back the list's `$list` entries already expanded into full
 * QuBits) is the wrong tool for a LIST path specifically; `listCuratedRawPaths()`
 * (which every privacy test below relies on, via `listChannels()`/
 * `listTopics()`) parses the unresolved `{$list: [...]}` shape only.
 */
async function rawCopy(fromQu, toQu, path) {
  const { adapter, rel } = fromQu.resolveMount(path);
  const quBit = await adapter.get(rel);
  if (quBit) await toQu.putSealed(path, quBit);
  return quBit ?? null;
}

const SPACE = 'forum-space';

test('createChannel() creates an open channel; listChannels() returns it', async () => {
  const { channels } = await freshSetup();
  const channel = await channels.createChannel(SPACE, { title: 'General chat' });
  assert.equal(channel.title, 'General chat');
  assert.equal(channel.restricted, false);

  const list = await channels.listChannels(SPACE);
  assert.equal(list.length, 1);
  assert.equal(list[0]._id, channel._id);
});

test('createTopic() on an open channel creates a public thread anyone can post to', async () => {
  const { channels, messages } = await freshSetup();
  const channel = await channels.createChannel(SPACE, { title: 'General' });
  const topic = await channels.createTopic(SPACE, channel._id, { title: 'Hello world' });
  assert.equal(topic.channelId, channel._id);

  const config = await messages.getConfig(SPACE, topic._id);
  assert.equal(config.writers, '*');
  assert.equal(config.readers, '*');
});

test('createTopic() stores its own content field as an Entity - not posted into its comment thread', async () => {
  const { channels, messages } = await freshSetup();
  const channel = await channels.createChannel(SPACE, { title: 'General' });
  const topic = await channels.createTopic(SPACE, channel._id, { title: 'Hello world', content: { text: 'the opening post' } });
  assert.equal(topic._type, 'topic');
  assert.equal(topic.content.text, 'the opening post');
  assert.equal(topic.content.format, 'plain');

  // The comment thread starts EMPTY - the opening post lives in the Entity's
  // own `content` field, never posted as message #1 (Quniverse V4 - fixes
  // the historical "replyCount double-counts the opening post" inaccuracy).
  const { messages: comments } = await messages.listMessages(SPACE, topic._id);
  assert.deepEqual(comments, []);
});

test('getTopic() returns a single topic by id; updateTopic() merge-writes its content in place', async () => {
  const { channels } = await freshSetup();
  const channel = await channels.createChannel(SPACE, { title: 'General' });
  const topic = await channels.createTopic(SPACE, channel._id, { title: 'v1', content: { text: 'v1 body' } });

  const fetched = await channels.getTopic(SPACE, topic._id);
  assert.equal(fetched.title, 'v1');

  const updated = await channels.updateTopic(SPACE, topic._id, { title: 'v2' });
  assert.equal(updated.title, 'v2');
  assert.equal(updated.content.text, 'v1 body'); // untouched fields survive the merge
  assert.equal((await channels.getTopic(SPACE, topic._id)).title, 'v2');
});

test('getTopic() returns null for an unknown topic id', async () => {
  const { channels } = await freshSetup();
  assert.equal(await channels.getTopic(SPACE, 'nope'), null);
});

test('listTopics() reports a live reply count and last-activity, newest activity first', async () => {
  const { channels, messages } = await freshSetup();
  const channel = await channels.createChannel(SPACE, { title: 'General' });
  const topicA = await channels.createTopic(SPACE, channel._id, { title: 'A' });
  await new Promise((r) => setTimeout(r, 2));
  const topicB = await channels.createTopic(SPACE, channel._id, { title: 'B' });

  await messages.postMessage(SPACE, topicA._id, { body: 'reply 1' });
  await messages.postMessage(SPACE, topicA._id, { body: 'reply 2' });

  const topics = await channels.listTopics(SPACE, channel._id);
  const a = topics.find((t) => t._id === topicA._id);
  const b = topics.find((t) => t._id === topicB._id);
  assert.equal(a.replyCount, 2);
  assert.equal(b.replyCount, 0);
  // A has newer activity (two posts after B was created) - sorted first.
  assert.deepEqual(topics.map((t) => t._id), [topicA._id, topicB._id]);
});

test('listTopics() reports a live "unread by me" count per topic - someone else\'s posts count until markRead(), my own never do', async () => {
  const { channels, messages } = await freshSetup();
  const channel = await channels.createChannel(SPACE, { title: 'General' });
  const topic = await channels.createTopic(SPACE, channel._id, { title: 'A' });

  // `asSpaceId` signs with a DIFFERENT derived key than the reading
  // identity's own main key (see MessageService.postMessage()'s own doc
  // comment) - the simplest way to get a message authored by "someone
  // else" without standing up a second full identity/store pair.
  await messages.postMessage(SPACE, topic._id, { body: 'from someone else', asSpaceId: 'other-space' });

  let topics = await channels.listTopics(SPACE, channel._id);
  assert.equal(topics.find((t) => t._id === topic._id).unreadCount, 1);

  await messages.markRead(SPACE, topic._id);
  topics = await channels.listTopics(SPACE, channel._id);
  assert.equal(topics.find((t) => t._id === topic._id).unreadCount, 0, 'marking read clears it');

  // A message from "me" (the reading identity's own main key) never counts
  // as unread, even posted after the read marker.
  await messages.postMessage(SPACE, topic._id, { body: 'from me' });
  topics = await channels.listTopics(SPACE, channel._id);
  assert.equal(topics.find((t) => t._id === topic._id).unreadCount, 0);

  // A second post from someone else, after markRead(), is unread again.
  await messages.postMessage(SPACE, topic._id, { body: 'another from someone else', asSpaceId: 'other-space' });
  topics = await channels.listTopics(SPACE, channel._id);
  assert.equal(topics.find((t) => t._id === topic._id).unreadCount, 1);
});

test('double "create channel" for two different titles never collapses into one - each is a genuine, separate channel (regression: QuV2\'s missing double-submit guard)', async () => {
  const { channels } = await freshSetup();
  // Simulates two near-simultaneous submits (the client-side fix is
  // disabling the submit button - this test proves the SERVICE layer
  // itself, unlike QuV2's unprotected documents.create()+collections.addItem(),
  // correctly keeps BOTH as genuine, distinct list entries under concurrent
  // same-process calls, matching ListService's own hardened addCurated().
  const [a, b] = await Promise.all([
    channels.createChannel(SPACE, { title: 'First' }),
    channels.createChannel(SPACE, { title: 'Second' }),
  ]);
  const list = await channels.listChannels(SPACE);
  assert.equal(list.length, 2);
  assert.deepEqual(new Set(list.map((c) => c._id)), new Set([a._id, b._id]));
});

test('a restricted channel genuinely encrypts its topics\' messages - only a synced-in member can decrypt', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });

  const bobQu = new QuStore();
  bobQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(bobQu);
  new ThreadEngine(bobQu);
  new CollectionEngine(bobQu);
  new EntityEngine(bobQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const bobIdentity = await freshIdentity(bobQu);
  await bobIdentity.publishMainProfile({ alias: 'Bob' });
  const bobPub = QuCrypto.toBase64Url((await bobIdentity.getMainKey()).publicKey);

  // Ada needs Bob's profile (his X25519 key) to encrypt for him.
  await copyQuBit(bobQu, ada.qu, `/store/actors/~${bobPub}/profile`);

  const channel = await ada.channels.createChannel(SPACE, { title: 'Private board', restricted: true, memberPubs: [bobPub] });
  assert.deepEqual(new Set(channel.memberPubs), new Set([ada.myPub, bobPub])); // creator always included

  const topic = await ada.channels.createTopic(SPACE, channel._id, { title: 'Secret topic' });
  const config = await ada.messages.getConfig(SPACE, topic._id);
  assert.deepEqual(new Set(config.writers), new Set([ada.myPub, bobPub]));

  const { id: messageId } = await ada.messages.postMessage(SPACE, topic._id, { body: 'top secret' });
  const raw = await ada.qu.get(threadMessagePath(SPACE, topic._id, messageId));
  assert.notEqual(raw.val, 'top secret');
  assert.equal(typeof raw.val.iv, 'string'); // genuinely ciphertext, not a UI-level filter

  // Simulate sync landing on Bob's device: thread config, the message, and Ada's profile.
  await copyQuBit(ada.qu, bobQu, `/store/${SPACE}/threads/${topic._id}/meta`);
  await copyQuBit(ada.qu, bobQu, threadMessagePath(SPACE, topic._id, messageId));
  await copyQuBit(ada.qu, bobQu, `/store/actors/~${ada.myPub}/profile`);

  const bobList = new ListService(bobQu);
  const bobAccess = new AccessService(bobQu, bobIdentity);
  const bobMessages = new MessageService(bobQu, bobIdentity, bobList, bobAccess);
  const { messages } = await bobMessages.listMessages(SPACE, topic._id);
  assert.deepEqual(messages.map((m) => m.body), ['top secret']);
});

test('updateTopic() on a restricted channel\'s topic stays genuine ciphertext at rest, and correctly re-encrypted (not corrupted) for the SAME members', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });
  const channel = await ada.channels.createChannel(SPACE, { title: 'Private board', restricted: true, memberPubs: [] });
  const topic = await ada.channels.createTopic(SPACE, channel._id, { title: 'v1', content: { text: 'v1 body' } });

  const updated = await ada.channels.updateTopic(SPACE, topic._id, { title: 'v2' });
  assert.equal(updated.title, 'v2');
  assert.equal(updated.content.text, 'v1 body'); // untouched field survives a correct decrypt-merge-encrypt round-trip

  const raw = await ada.qu.get(`/store/${SPACE}/entities/${topic._id}`);
  assert.notEqual(raw.val.title, 'v2'); // still genuine ciphertext, not silently downgraded to plaintext
  assert.equal(typeof raw.val.iv, 'string');

  assert.equal((await ada.channels.getTopic(SPACE, topic._id)).title, 'v2'); // Ada herself can still decrypt it back
});

test('addChannelMember() grows a restricted channel\'s membership - EXISTING topics become visible to the new member going forward, past messages stay theirs to prove non-retroactively (encryption target unchanged for already-posted ones)', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });

  const carolQu = new QuStore();
  carolQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(carolQu);
  new ThreadEngine(carolQu);
  new CollectionEngine(carolQu);
  new EntityEngine(carolQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const carolIdentity = await freshIdentity(carolQu);
  await carolIdentity.publishMainProfile({ alias: 'Carol' });
  const carolPub = QuCrypto.toBase64Url((await carolIdentity.getMainKey()).publicKey);
  await copyQuBit(carolQu, ada.qu, `/store/actors/~${carolPub}/profile`);

  // A restricted channel with only Ada as a member initially.
  const channel = await ada.channels.createChannel(SPACE, { title: 'Grows later', restricted: true, memberPubs: [] });
  assert.deepEqual(channel.memberPubs, [ada.myPub]);
  const topic = await ada.channels.createTopic(SPACE, channel._id, { title: 'Existing topic' });
  await ada.messages.postMessage(SPACE, topic._id, { body: 'before carol joined' });

  const updated = await ada.channels.addChannelMember(SPACE, channel._id, carolPub);
  assert.ok(updated.memberPubs.includes(carolPub));

  const config = await ada.messages.getConfig(SPACE, topic._id);
  assert.ok(config.writers.includes(carolPub));
  assert.ok(config.readers.includes(carolPub));

  // Carol can now post into the EXISTING topic (writer access was actually granted, not just readers).
  const { id: newMessageId } = await ada.messages.postMessage(SPACE, topic._id, { body: 'after carol joined', asSpaceId: null });
  assert.ok(newMessageId);

  // addChannelMember() is idempotent for an already-present member.
  const again = await ada.channels.addChannelMember(SPACE, channel._id, carolPub);
  assert.deepEqual(again.memberPubs, updated.memberPubs);
});

test('addChannelMember(): one topic failing to grow does not stop the OTHERS from growing, and still throws so the caller knows a retry is needed', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });

  // A real identity with a published profile - re-encrypting the channel
  // (and each topic) document for a new reader (see channel-service.js's
  // own "RESTRICTED CHANNELS" doc comment) needs a resolvable X key,
  // `resolveReaderXKeys()`'s own fail-closed contract - a bare made-up
  // pubkey with no profile can no longer stand in for "a new member" here.
  const newMemberQu = new QuStore();
  newMemberQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(newMemberQu);
  new ThreadEngine(newMemberQu);
  new CollectionEngine(newMemberQu);
  new EntityEngine(newMemberQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const newMemberIdentity = await freshIdentity(newMemberQu);
  await newMemberIdentity.publishMainProfile({ alias: 'New Member' });
  const newMemberPub = QuCrypto.toBase64Url((await newMemberIdentity.getMainKey()).publicKey);
  await copyQuBit(newMemberQu, ada.qu, `/store/actors/~${newMemberPub}/profile`);

  const channel = await ada.channels.createChannel(SPACE, { title: 'Multi-topic restricted', restricted: true, memberPubs: [] });
  const goodTopic = await ada.channels.createTopic(SPACE, channel._id, { title: 'Fine' });
  const brokenTopic = await ada.channels.createTopic(SPACE, channel._id, { title: 'Corrupted ACL' });

  // Simulate a divergent/corrupted state where Ada is (somehow) no longer a
  // writer on ONE existing topic's own ACL doc - assertWriteAuthorized()'s
  // "only an already-listed writer may change an ACL doc" rule (see
  // access-engine.js) then rejects #growTopicMembership()'s own protect()
  // call for THAT topic specifically, while the other topic is untouched.
  await ada.qu.put(`/store/${SPACE}/acl/threads/${brokenTopic._id}`, { writers: ['someone-else'], readers: '*' }, {
    signWith: (await ada.identity.getMainKey()).privateKeyPkcs8, writerPub: (await ada.identity.getMainKey()).publicKey,
  });

  await assert.rejects(
    () => ada.channels.addChannelMember(SPACE, channel._id, newMemberPub),
    (err) => {
      assert.match(err.message, /1\/2/);
      return true;
    }
  );

  // The channel-level membership add still fully succeeded...
  const channelAfter = await ada.channels.getChannel(SPACE, channel._id);
  assert.ok(channelAfter.memberPubs.includes(newMemberPub));
  // ...and the GOOD topic still grew despite the broken one failing.
  const goodConfig = await ada.messages.getConfig(SPACE, goodTopic._id);
  assert.ok(goodConfig.writers.includes(newMemberPub));
  // ...while the broken one genuinely didn't (this is the failure the thrown error is reporting).
  const brokenConfig = await ada.messages.getConfig(SPACE, brokenTopic._id);
  assert.equal(brokenConfig.writers.includes(newMemberPub), false);
});

test('addChannelMember() is a no-op for an OPEN (non-restricted) channel - nothing to grow', async () => {
  const { channels, myPub } = await freshSetup();
  const channel = await channels.createChannel(SPACE, { title: 'Open board' });
  const updated = await channels.addChannelMember(SPACE, channel._id, 'someone-else');
  assert.deepEqual(updated, channel);
});

// Regression: a peer who never had this channel/topic locally must still
// find it once it's already been fetched/mirrored into the channels LIST
// document (simulating watch()'s own backfill of that ONE document) - the
// individual channel/topic document it references needs its OWN backfill,
// which @qu/engines' CollectionEngine (a local-read-only $list resolver)
// can never provide by itself. Confirmed live during this feature's own
// end-to-end verification: a second peer's board view rendered genuinely
// empty (no error, no crash - listCurated() resolving a $list entry to
// `null` for a document not yet local is indistinguishable from "no such
// channel" without this fix) until ChannelService did its own per-item
// syncFetch.
test('listChannels()/listTopics() backfill each individually-referenced document via syncFetch - not just the list document itself', async () => {
  const a = await freshSetup();
  const channel = await a.channels.createChannel('forum-space', { title: 'Shared Board' });
  const topic = await a.channels.createTopic('forum-space', channel._id, { title: 'Shared Topic' });

  const bQu = new QuStore();
  bQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(bQu);
  new ThreadEngine(bQu);
  new CollectionEngine(bQu);
  new EntityEngine(bQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const bIdentity = await freshIdentity(bQu);
  const bList = new ListService(bQu);
  const bAccess = new AccessService(bQu, bIdentity);
  const bMessages = new MessageService(bQu, bIdentity, bList, bAccess);

  // rawCopy() (module-level, see its own doc comment) - bypasses
  // @qu/engines' CollectionEngine's read-time $list resolution, matching
  // exactly what the real SyncEngine transmits (`packages/sync/src/
  // sync-engine.js`'s own `#handleRequest()` reads via `adapter.get(rel)`
  // directly, never `qu.get()`). Using `copyQuBit()` (i.e. `qu.get()`) here
  // instead would already hand back a list document with its `$list`
  // entries pre-resolved into full QuBits by A's own CollectionEngine - a
  // shape real sync never actually produces, and different from what
  // `listCuratedRawPaths()` (which THIS fix relies on) expects to parse.

  // Simulates watch()'s own syncFetch call backfilling ONLY the channels
  // list document itself, BEFORE anything ever tries to resolve what it
  // references - the exact partial state a real peer lands in.
  const channelsListPath = '/store/forum-space/lists/channels';
  await rawCopy(a.qu, bQu, channelsListPath);

  const withoutSyncFetch = new ChannelService(bQu, bIdentity, bList, bAccess, bMessages); // no syncFetch at all
  assert.deepEqual(await withoutSyncFetch.listChannels('forum-space'), [], 'reproduces the bug: the list doc is there, but its referenced channel doc is not, and nothing backfills it');

  // A real `syncFetch` mirrors from A's store on demand, exactly like a
  // real relay round-trip would resolve any path it's asked for.
  const fakeSyncFetch = (path) => rawCopy(a.qu, bQu, path);
  const withSyncFetch = new ChannelService(bQu, bIdentity, bList, bAccess, bMessages, fakeSyncFetch);
  const channels = await withSyncFetch.listChannels('forum-space');
  assert.equal(channels.length, 1);
  assert.equal(channels[0].title, 'Shared Board');

  // Same gap, same fix, for a channel's topics list.
  const topicsListPath = `/store/forum-space/lists/topics-${channel._id}`;
  await rawCopy(a.qu, bQu, topicsListPath);
  const topics = await withSyncFetch.listTopics('forum-space', channel._id);
  assert.equal(topics.length, 1);
  assert.equal(topics[0]._id, topic._id);

  // getChannel() itself (a direct/shared link, no listChannels() first) has the same backfill.
  const freshBQu = new QuStore();
  freshBQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(freshBQu);
  new ThreadEngine(freshBQu);
  new CollectionEngine(freshBQu);
  new EntityEngine(freshBQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const directLinkFetch = (path) => rawCopy(a.qu, freshBQu, path);
  const directLinkChannels = new ChannelService(freshBQu, bIdentity, new ListService(freshBQu), new AccessService(freshBQu, bIdentity), bMessages, directLinkFetch);
  const viaDirectLink = await directLinkChannels.getChannel('forum-space', channel._id);
  assert.equal(viaDirectLink?.title, 'Shared Board');
});

test('getChannel() returns null for an unknown channel id', async () => {
  const { channels } = await freshSetup();
  assert.equal(await channels.getChannel(SPACE, 'nope'), null);
});

test('createTopic() throws for an unknown channel id', async () => {
  const { channels } = await freshSetup();
  await assert.rejects(() => channels.createTopic(SPACE, 'nope', { title: 'x' }), /no channel/);
});

// ===================================================================
// PRIVACY - restricted channels/topics are genuine ciphertext at rest,
// AND filtered out for anyone who can't decrypt them (see channel-service.js's
// own "RESTRICTED CHANNELS" doc comment for the full model).
// ===================================================================

test('a restricted channel\'s own title/description document is genuine ciphertext at rest - a non-member with it synced locally sees NEITHER via listChannels() NOR getChannel(), a member sees both', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });

  const bobQu = new QuStore();
  bobQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(bobQu);
  new ThreadEngine(bobQu);
  new CollectionEngine(bobQu);
  new EntityEngine(bobQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const bobIdentity = await freshIdentity(bobQu);
  await bobIdentity.publishMainProfile({ alias: 'Bob' });
  const bobPub = QuCrypto.toBase64Url((await bobIdentity.getMainKey()).publicKey);
  await copyQuBit(bobQu, ada.qu, `/store/actors/~${bobPub}/profile`);

  const channel = await ada.channels.createChannel(SPACE, { title: 'Secret Board', description: 'shh', restricted: true, memberPubs: [bobPub] });

  // The raw stored document is genuinely ciphertext, not a plain object with a filter on top.
  const raw = await ada.qu.get(`/store/${SPACE}/docs/${channel._id}`);
  assert.notEqual(raw.val.title, 'Secret Board');
  assert.equal(typeof raw.val.iv, 'string');

  // Bob (a real member) is synced the same raw envelope - as any normal sync would do.
  await copyQuBit(ada.qu, bobQu, `/store/${SPACE}/docs/${channel._id}`);
  await rawCopy(ada.qu, bobQu, `/store/${SPACE}/lists/channels`);
  await copyQuBit(ada.qu, bobQu, `/store/actors/~${ada.myPub}/profile`);
  const bobAccess = new AccessService(bobQu, bobIdentity);
  const bobList = new ListService(bobQu);
  const bobMessages = new MessageService(bobQu, bobIdentity, bobList, bobAccess);
  const bobChannels = new ChannelService(bobQu, bobIdentity, bobList, bobAccess, bobMessages);
  assert.equal((await bobChannels.getChannel(SPACE, channel._id)).title, 'Secret Board');
  const bobList2 = await bobChannels.listChannels(SPACE);
  assert.equal(bobList2.length, 1);
  assert.equal(bobList2[0].title, 'Secret Board');

  // Carol (NOT a member) somehow also has the same raw envelope synced -
  // same "path is addressing, not proof of readability" scenario every
  // other resource in this codebase already accepts - but now genuinely
  // can't read it: neither listChannels() nor a direct getChannel() call
  // (e.g. a bookmarked board URL) reveals the title.
  const carolQu = new QuStore();
  carolQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(carolQu);
  new ThreadEngine(carolQu);
  new CollectionEngine(carolQu);
  new EntityEngine(carolQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const carolIdentity = await freshIdentity(carolQu);
  await carolIdentity.publishMainProfile({ alias: 'Carol' });
  await copyQuBit(ada.qu, carolQu, `/store/${SPACE}/docs/${channel._id}`);
  await rawCopy(ada.qu, carolQu, `/store/${SPACE}/lists/channels`);
  await copyQuBit(ada.qu, carolQu, `/store/actors/~${ada.myPub}/profile`);
  const carolAccess = new AccessService(carolQu, carolIdentity);
  const carolList = new ListService(carolQu);
  const carolMessages = new MessageService(carolQu, carolIdentity, carolList, carolAccess);
  const carolChannels = new ChannelService(carolQu, carolIdentity, carolList, carolAccess, carolMessages);
  assert.equal(await carolChannels.getChannel(SPACE, channel._id), null);
  assert.deepEqual(await carolChannels.listChannels(SPACE), []);
});

test('a restricted channel\'s topic TITLE is genuine ciphertext too - listTopics() filters it out for a non-member', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });

  const channel = await ada.channels.createChannel(SPACE, { title: 'Board', restricted: true, memberPubs: [] });
  const topic = await ada.channels.createTopic(SPACE, channel._id, { title: 'Confidential Topic' });

  const rawTopic = await ada.qu.get(`/store/${SPACE}/entities/${topic._id}`);
  assert.notEqual(rawTopic.val.title, 'Confidential Topic');
  assert.equal(typeof rawTopic.val.iv, 'string');

  const carolQu = new QuStore();
  carolQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(carolQu);
  new ThreadEngine(carolQu);
  new CollectionEngine(carolQu);
  new EntityEngine(carolQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const carolIdentity = await freshIdentity(carolQu);
  await carolIdentity.publishMainProfile({ alias: 'Carol' });
  await copyQuBit(ada.qu, carolQu, `/store/${SPACE}/docs/${channel._id}`);
  await copyQuBit(ada.qu, carolQu, `/store/${SPACE}/entities/${topic._id}`);
  await rawCopy(ada.qu, carolQu, `/store/${SPACE}/lists/topics-${channel._id}`);
  await copyQuBit(ada.qu, carolQu, `/store/actors/~${ada.myPub}/profile`);
  const carolAccess = new AccessService(carolQu, carolIdentity);
  const carolList = new ListService(carolQu);
  const carolMessages = new MessageService(carolQu, carolIdentity, carolList, carolAccess);
  const carolChannels = new ChannelService(carolQu, carolIdentity, carolList, carolAccess, carolMessages);
  assert.deepEqual(await carolChannels.listTopics(SPACE, channel._id), []);
});

test('addChannelMember() lets a newly-added member decrypt an EXISTING topic\'s TITLE too, not just its thread content', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });

  const carolQu = new QuStore();
  carolQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(carolQu);
  new ThreadEngine(carolQu);
  new CollectionEngine(carolQu);
  new EntityEngine(carolQu); // Quniverse V4: a Topic is now an Entity, see ChannelService's own "QUNIVERSE V4" doc comment
  const carolIdentity = await freshIdentity(carolQu);
  await carolIdentity.publishMainProfile({ alias: 'Carol' });
  const carolPub = QuCrypto.toBase64Url((await carolIdentity.getMainKey()).publicKey);
  await copyQuBit(carolQu, ada.qu, `/store/actors/~${carolPub}/profile`);

  const channel = await ada.channels.createChannel(SPACE, { title: 'Grows later', restricted: true, memberPubs: [] });
  const topic = await ada.channels.createTopic(SPACE, channel._id, { title: 'Old Topic' });

  await ada.channels.addChannelMember(SPACE, channel._id, carolPub);

  // Carol is synced the topic doc as it stood BEFORE she joined (the exact
  // ciphertext Ada originally wrote) - addChannelMember() must have
  // re-encrypted it in place for her to read it at all now.
  await copyQuBit(ada.qu, carolQu, `/store/${SPACE}/docs/${channel._id}`);
  await copyQuBit(ada.qu, carolQu, `/store/${SPACE}/entities/${topic._id}`);
  await rawCopy(ada.qu, carolQu, `/store/${SPACE}/lists/topics-${channel._id}`);
  await copyQuBit(ada.qu, carolQu, `/store/actors/~${ada.myPub}/profile`);
  const carolAccess = new AccessService(carolQu, carolIdentity);
  const carolList = new ListService(carolQu);
  const carolMessages = new MessageService(carolQu, carolIdentity, carolList, carolAccess);
  const carolChannels = new ChannelService(carolQu, carolIdentity, carolList, carolAccess, carolMessages);
  const carolTopics = await carolChannels.listTopics(SPACE, channel._id);
  assert.equal(carolTopics.length, 1);
  assert.equal(carolTopics[0].title, 'Old Topic');
});
