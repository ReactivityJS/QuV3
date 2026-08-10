import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine, CollectionEngine } from '@qu/engines';
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

test('addChannelMember() grows a restricted channel\'s membership - EXISTING topics become visible to the new member going forward, past messages stay theirs to prove non-retroactively (encryption target unchanged for already-posted ones)', async () => {
  const ada = await freshSetup();
  await ada.identity.publishMainProfile({ alias: 'Ada' });

  const carolQu = new QuStore();
  carolQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(carolQu);
  new ThreadEngine(carolQu);
  new CollectionEngine(carolQu);
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
    () => ada.channels.addChannelMember(SPACE, channel._id, 'new-member-pub'),
    (err) => {
      assert.match(err.message, /1\/2/);
      return true;
    }
  );

  // The channel-level membership add still fully succeeded...
  const channelAfter = await ada.channels.getChannel(SPACE, channel._id);
  assert.ok(channelAfter.memberPubs.includes('new-member-pub'));
  // ...and the GOOD topic still grew despite the broken one failing.
  const goodConfig = await ada.messages.getConfig(SPACE, goodTopic._id);
  assert.ok(goodConfig.writers.includes('new-member-pub'));
  // ...while the broken one genuinely didn't (this is the failure the thrown error is reporting).
  const brokenConfig = await ada.messages.getConfig(SPACE, brokenTopic._id);
  assert.equal(brokenConfig.writers.includes('new-member-pub'), false);
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
  const bIdentity = await freshIdentity(bQu);
  const bList = new ListService(bQu);
  const bAccess = new AccessService(bQu, bIdentity);
  const bMessages = new MessageService(bQu, bIdentity, bList, bAccess);

  // Copies the RAW stored QuBit (bypassing @qu/engines' CollectionEngine's
  // read-time $list resolution) - matching exactly what the real
  // SyncEngine transmits (`packages/sync/src/sync-engine.js`'s own
  // `#handleRequest()` reads via `adapter.get(rel)` directly, never
  // `qu.get()`). Using `qu.get()` here instead would already hand back a
  // list document with its `$list` entries pre-resolved into full QuBits by
  // A's own CollectionEngine - a shape real sync never actually produces,
  // and different from what `listCuratedRawPaths()` (which THIS fix relies
  // on) expects to parse.
  async function rawCopy(fromQu, toQu, path) {
    const { adapter, rel } = fromQu.resolveMount(path);
    const quBit = await adapter.get(rel);
    if (quBit) await toQu.putSealed(path, quBit);
    return quBit ?? null;
  }

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
