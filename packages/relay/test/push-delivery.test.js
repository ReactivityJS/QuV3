import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { ListService, AccessService, MessageService, THREAD_PRESETS, NotificationPrefsService, PushSubscriptionService, paths } from '@qu/services';
import { PresenceTracker } from '../src/presence-tracker.js';
import { PushDeliveryService } from '../src/push-delivery.js';

const VAPID_KEYS = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.com' };

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({}); // needed whenever this identity is itself a reader of a private thread it posts to (own X key must be resolvable)
  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const notificationPrefs = new NotificationPrefsService(qu, identity);
  const pushSubscriptions = new PushSubscriptionService(qu, identity, list);
  return { qu, identity, messages, notificationPrefs, pushSubscriptions };
}

/**
 * A second, independent identity/store standing in for a notification
 * RECIPIENT (needs its own store to sign its own prefs/subscriptions -
 * one-seed-per-store). Publishes its profile and copies it into `env.qu`
 * (simulating an already-synced profile) - `#writeInAppNotification()`
 * posts into a READER-RESTRICTED notifications thread (see
 * `THREAD_PRESETS.notifications()`), which needs to resolve the
 * recipient's X25519 key to encrypt for them, the same as any other
 * private-thread `postMessage()` - see `message-service.test.js`'s own
 * "reader-restricted thread" tests for the identical requirement.
 */
async function freshRecipient(env) {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({});
  const pub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const profileQuBit = await qu.get(`/store/actors/~${pub}/profile`);
  await env.qu.putSealed(`/store/actors/~${pub}/profile`, profileQuBit);

  const list = new ListService(qu);
  return {
    qu,
    identity,
    pub,
    notificationPrefs: new NotificationPrefsService(qu, identity),
    pushSubscriptions: new PushSubscriptionService(qu, identity, list),
  };
}

function fakeSendWebPush(results = []) {
  const calls = [];
  const fn = async (subscription, payload, vapid) => {
    calls.push({ subscription, payload, vapid });
    return results.shift() ?? { ok: true, status: 201, expired: false };
  };
  fn.calls = calls;
  return fn;
}

/** Builds a PushDeliveryService reading prefs/subscriptions from `recipient`'s OWN store (relay's own qu never holds a recipient's data - see push-delivery.js's constructor doc comment: it reads through the injected Services, which here are bound to the recipient's own store to simulate "already synced to the relay"). */
function pushDeliveryFor(env, recipient, overrides = {}) {
  return new PushDeliveryService({
    messages: env.messages,
    notificationPrefs: recipient?.notificationPrefs ?? env.notificationPrefs,
    pushSubscriptions: recipient?.pushSubscriptions ?? env.pushSubscriptions,
    presence: overrides.presence ?? new PresenceTracker(),
    vapidKeys: 'vapidKeys' in overrides ? overrides.vapidKeys : VAPID_KEYS,
    resolveNotification: overrides.resolveNotification ?? null,
    sendWebPush: overrides.sendWebPush ?? fakeSendWebPush(),
  });
}

/** Posts a message via MessageService, then re-reads its RAW QuBit (deliverThreadMessage() expects the actual on-wire {val,ts,pub,...} shape, not postMessage()'s own plain return value) and runs delivery on it. */
async function postAndDeliver(env, delivery, spaceId, threadId, params) {
  const message = await env.messages.postMessage(spaceId, threadId, params);
  const raw = await env.qu.get(`/store/${spaceId}/threads/${threadId}/msgs/${message.id}`);
  await delivery.deliverThreadMessage(spaceId, threadId, raw);
  return message;
}

/**
 * Counts a recipient's in-app notifications WITHOUT decrypting them - a
 * notifications Thread is reader-restricted to its owner (see
 * `THREAD_PRESETS.notifications()`), so `env.messages.listMessages()`
 * (bound to the RELAY's own identity, never a listed reader of a
 * recipient's private inbox) can't decrypt what it wrote and would silently
 * filter it back out - see `MessageService.listMessages()`'s own doc
 * comment on `#decryptMessage()` returning `null` for a non-reader. Reading
 * the raw QuBit count directly confirms the WRITE happened, which is what
 * these tests actually care about.
 */
async function inAppNotificationCount(env, actorPub) {
  const entries = await env.qu.getChildren(paths.threadMessagesParentPath(`notifications-${actorPub}`, 'notifications'));
  return entries.filter((e) => e.quBit.val).length;
}

test('a mention on a PUBLIC thread notifies the mentioned actor', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const delivery = pushDeliveryFor(env, recipient);

  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 1);
});

test('a NON-mentioning message on a PUBLIC thread notifies nobody', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const delivery = pushDeliveryFor(env, recipient);

  await postAndDeliver(env, delivery, 'board', 'general', { body: 'no mentions here' });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 0);
});

test('on a PRIVATE (reader-restricted) thread, every OTHER reader is notified regardless of mentions', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  const myPub = QuCrypto.toBase64Url((await env.identity.getMainKey()).publicKey);
  await env.messages.createThread('board', 'dm', { writers: '*', readers: [myPub, recipient.pub] });
  const delivery = pushDeliveryFor(env, recipient);

  await postAndDeliver(env, delivery, 'board', 'dm', { body: 'just for us, no @mention needed' });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 1);
});

test('the message AUTHOR is never notified about their own message', async () => {
  const env = await freshEnv();
  const myPub = QuCrypto.toBase64Url((await env.identity.getMainKey()).publicKey);
  await env.messages.createThread('board', 'dm', { writers: '*', readers: [myPub] }); // only reader is the author themself
  const delivery = pushDeliveryFor(env, null);

  await postAndDeliver(env, delivery, 'board', 'dm', { body: 'talking to myself' });

  const { messages: ownInbox } = await env.messages.listMessages(`notifications-${myPub}`, 'notifications');
  assert.equal(ownInbox.length, 0);
});

test('a message in a notifications-* space is never itself a delivery source (loop prevention)', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  const delivery = pushDeliveryFor(env, recipient);
  const spaceId = `notifications-${recipient.pub}`;
  await env.messages.createThread(spaceId, 'notifications', THREAD_PRESETS.notifications(recipient.pub));

  await postAndDeliver(env, delivery, spaceId, 'notifications', { body: 'a notice', extra: { mentions: [recipient.pub] } });

  // Only the one message we just posted - no SECOND notice about the first one.
  assert.equal(await inAppNotificationCount(env, recipient.pub), 1);
});

test('a message in a thread with no config is a silent no-op (never throws)', async () => {
  const env = await freshEnv();
  const delivery = pushDeliveryFor(env, null);
  await assert.doesNotReject(() => delivery.deliverThreadMessage('board', 'never-created', { pub: null, val: { mentions: [] }, ts: Date.now() }));
});

test('NotificationPrefsService gating: a candidate with notifications disabled gets neither in-app nor push', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.notificationPrefs.savePrefs({ enabled: false });
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });

  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 0);
  assert.equal(send.calls.length, 0);
});

test('a recipient with no push subscriptions still gets the in-app notification, just no push attempt', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 1);
  assert.equal(send.calls.length, 0);
});

test('a recently-online recipient gets the in-app notification but NOT a redundant push', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const presence = new PresenceTracker();
  presence.recordSeen(recipient.pub);
  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { presence, sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 1);
  assert.equal(send.calls.length, 0);
});

test('an offline recipient WITH a subscription gets a real push send', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].subscription.endpoint, 'https://push.example.com/x');
  assert.equal(send.calls[0].vapid, VAPID_KEYS);
  // Content-blind by design - the relay never puts the real message body in the push payload verbatim beyond the generic template.
  assert.ok(typeof send.calls[0].payload.title === 'string');
});

test('with vapidKeys: null, push is never attempted even for an offline, subscribed recipient', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { vapidKeys: null, sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(send.calls.length, 0);
  assert.equal(await inAppNotificationCount(env, recipient.pub), 1); // in-app notification is unaffected by vapidKeys
});

test('an expired push subscription (404/410) logs a warning but does not throw', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const send = fakeSendWebPush([{ ok: false, status: 410, expired: true }]);
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());

  await assert.doesNotReject(() => postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } }));
});

test('a push send that THROWS for one subscription does not stop delivery to the same recipient\'s OTHER devices', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/device1', keys: { p256dh: 'a', auth: 'b' } });
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/device2', keys: { p256dh: 'c', auth: 'd' } });

  const calls = [];
  const send = async (subscription) => {
    calls.push(subscription.endpoint);
    if (subscription.endpoint.endsWith('device1')) throw new Error('network error');
    return { ok: true, status: 201, expired: false };
  };
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(calls.length, 2); // both attempted despite the first throwing
});

// ===== resolveNotification (pluggable routing, §6.2) ================================

test('resolveNotification() overrides appId/title/body/url', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const send = fakeSendWebPush();
  const resolveNotification = () => ({ appId: 'custom-app', title: 'Custom title', body: 'Custom body', url: '#/custom' });
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send, resolveNotification });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.deepEqual(send.calls[0].payload, { title: 'Custom title', body: 'Custom body', appId: 'custom-app', url: '#/custom' });
});

test('resolveNotification() returning null falls back to the generic default', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send, resolveNotification: () => null });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(send.calls[0].payload.appId, 'board');
  assert.ok(send.calls[0].payload.title.includes('Mentioned'));
});

test('resolveNotification() can disable notifications for an appId via a custom functionName the recipient has turned off', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.notificationPrefs.savePrefs({ apps: { calendar: { functions: { invite: false } } } });
  const resolveNotification = () => ({ appId: 'calendar', functionName: 'invite', title: 'Invited', body: 'You were invited', url: '#/calendar' });
  const delivery = pushDeliveryFor(env, recipient, { resolveNotification });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 0);
});
