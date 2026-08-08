import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { ListService } from '../src/list-service.js';
import { PushSubscriptionService } from '../src/push-subscription-service.js';

function fakeSubscription(suffix) {
  return { endpoint: `https://push.example.com/${suffix}`, keys: { p256dh: `p256dh-${suffix}`, auth: `auth-${suffix}` } };
}

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity, subs: new PushSubscriptionService(qu, identity, new ListService(qu)) };
}

test('subscribe()/listOwnSubscriptions() round-trip', async () => {
  const { subs } = await freshSetup();
  await subs.subscribe(fakeSubscription('a'));
  const list = await subs.listOwnSubscriptions();
  assert.equal(list.length, 1);
  assert.equal(list[0].endpoint, 'https://push.example.com/a');
});

test('subscribe() supports multiple subscriptions per identity (one per device)', async () => {
  const { subs } = await freshSetup();
  await subs.subscribe(fakeSubscription('device1'));
  await subs.subscribe(fakeSubscription('device2'));
  const list = await subs.listOwnSubscriptions();
  assert.deepEqual([...list.map((s) => s.endpoint)].sort(), ['https://push.example.com/device1', 'https://push.example.com/device2']);
});

test('subscribe() with the SAME endpoint twice does not duplicate - it is the same subscriptionId path', async () => {
  const { subs } = await freshSetup();
  await subs.subscribe(fakeSubscription('a'));
  await subs.subscribe(fakeSubscription('a'));
  assert.equal((await subs.listOwnSubscriptions()).length, 1);
});

test('unsubscribe() removes exactly the given endpoint, leaving the rest', async () => {
  const { subs } = await freshSetup();
  await subs.subscribe(fakeSubscription('a'));
  await subs.subscribe(fakeSubscription('b'));
  await subs.unsubscribe('https://push.example.com/a');
  const list = await subs.listOwnSubscriptions();
  assert.deepEqual(list.map((s) => s.endpoint), ['https://push.example.com/b']);
});

test('unsubscribe() of a never-subscribed endpoint is a harmless no-op', async () => {
  const { subs } = await freshSetup();
  await subs.subscribe(fakeSubscription('a'));
  await assert.doesNotReject(() => subs.unsubscribe('https://push.example.com/never-subscribed'));
  assert.equal((await subs.listOwnSubscriptions()).length, 1);
});

test('listOwnSubscriptions() of an identity with none returns an empty array', async () => {
  const { subs } = await freshSetup();
  assert.deepEqual(await subs.listOwnSubscriptions(), []);
});

test('listSubscriptionsFor() reads ANOTHER identity\'s subscriptions - what @qu/relay\'s push delivery needs', async () => {
  const { qu, identity, subs } = await freshSetup();
  await subs.subscribe(fakeSubscription('a'));
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const relayView = new PushSubscriptionService(qu, { getMainKey: async () => { throw new Error('relay has no identity of its own'); } }, new ListService(qu));
  const list = await relayView.listSubscriptionsFor(myPub);
  assert.equal(list.length, 1);
  assert.equal(list[0].endpoint, 'https://push.example.com/a');
});

test('subscriptions are fully independent per identity', async () => {
  const aliceQu = new QuStore();
  aliceQu.mount('store', new MemoryStoreAdapter());
  const alice = new QuIdentityEngine(aliceQu);
  await alice.importMnemonic(alice.generateMnemonic());
  const aliceSubs = new PushSubscriptionService(aliceQu, alice, new ListService(aliceQu));
  await aliceSubs.subscribe(fakeSubscription('alice-device'));

  const bobQu = new QuStore();
  bobQu.mount('store', new MemoryStoreAdapter());
  const bob = new QuIdentityEngine(bobQu);
  await bob.importMnemonic(bob.generateMnemonic());
  const bobSubs = new PushSubscriptionService(bobQu, bob, new ListService(bobQu));

  assert.deepEqual(await bobSubs.listOwnSubscriptions(), []);
});
