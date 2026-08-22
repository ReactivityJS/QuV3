import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { MentionService } from '../src/mention-service.js';
import { extractMentions } from '../src/thread-formatting.js';

async function freshMentions() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return new MentionService(qu, identity, new ListService(qu));
}

function fakeActorId() {
  return QuCrypto.toBase64Url(new Uint8Array(32).fill(7)); // 32 bytes -> a base64url token long enough for MENTION_RE
}

test('mentionsOf() is a stateless passthrough to extractMentions()', async () => {
  const mentions = await freshMentions();
  const actorId = fakeActorId();
  const text = `hey @${actorId} check this out`;
  assert.deepEqual(mentions.mentionsOf(text), extractMentions(text));
});

test('indexMentions() writes an entry into each mentioned actor\'s global index, and mentionedIn() finds it', async () => {
  const mentions = await freshMentions();
  const actorId = fakeActorId();

  const mentioned = await mentions.indexMentions('space1', 'article', 'a1', `hi @${actorId}`);
  assert.deepEqual(mentioned, [actorId]);

  const found = await mentions.mentionedIn(actorId);
  assert.equal(found.length, 1);
  assert.equal(found[0].spaceId, 'space1');
  assert.equal(found[0].entityKind, 'article');
  assert.equal(found[0].entityId, 'a1');
  assert.equal(typeof found[0].mentionedAt, 'number');
});

test('indexMentions() with no mentions is a no-op', async () => {
  const mentions = await freshMentions();
  const mentioned = await mentions.indexMentions('space1', 'article', 'a1', 'no mentions here');
  assert.deepEqual(mentioned, []);
});

test('mentionedIn() aggregates across multiple spaces/entity kinds for one actor', async () => {
  const mentions = await freshMentions();
  const actorId = fakeActorId();

  await mentions.indexMentions('space1', 'article', 'a1', `@${actorId}`);
  await mentions.indexMentions('space2', 'message', 'm1', `@${actorId}`);

  const found = await mentions.mentionedIn(actorId);
  assert.equal(found.length, 2);
  const kinds = found.map((f) => f.entityKind).sort();
  assert.deepEqual(kinds, ['article', 'message']);
});

test('an actor mentioned nowhere has an empty mentionedIn() list', async () => {
  const mentions = await freshMentions();
  assert.deepEqual(await mentions.mentionedIn(fakeActorId()), []);
});

test('indexMentions() can mention multiple different actors in one text', async () => {
  const mentions = await freshMentions();
  const a = QuCrypto.toBase64Url(new Uint8Array(32).fill(1));
  const b = QuCrypto.toBase64Url(new Uint8Array(32).fill(2));

  const mentioned = await mentions.indexMentions('space1', 'article', 'a1', `hey @${a} and @${b}`);
  assert.deepEqual([...mentioned].sort(), [a, b].sort());
  assert.equal((await mentions.mentionedIn(a)).length, 1);
  assert.equal((await mentions.mentionedIn(b)).length, 1);
});
