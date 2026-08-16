import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { ListService, AccessService, MessageService, THREAD_PRESETS, NotificationPrefsService, PushSubscriptionService, paths } from '@qu/services';
import { Registry } from '@qu/foundation';
import { PresenceTracker } from '../src/presence-tracker.js';
import { PushDeliveryService, createManifestNotificationResolver } from '../src/push-delivery.js';

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
    registry: overrides.registry ?? null,
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

/**
 * Reads a recipient's own notification thread DECRYPTED, for tests that
 * need to inspect `ref`/`title`/etc, not just count entries (see
 * `inAppNotificationCount()`'s own doc comment on why the RELAY's own
 * `env.messages` can't decrypt these). Mirrors each QuBit from `env.qu`
 * (where the relay physically wrote it) into the recipient's OWN store via
 * `putSealed()` - the same "as if sync had already delivered it" technique
 * `apps/forum/test/client.test.js`'s own `mirrorThreadInto()` uses - then
 * reads it back through a `MessageService` bound to the recipient's own
 * identity, exactly like a real client would after a real sync. Also
 * mirrors the SENDER's (the relay's own `env.identity`) published profile
 * into the recipient's store - `#writeInAppNotification()` signs/encrypts
 * as `env.identity`, so decrypting needs the sender's X25519 key resolvable
 * too, same as any other private-thread read (see `message-service.test.js`'s
 * own reader-restricted-thread tests for the identical requirement).
 */
async function readOwnNotifications(env, recipient) {
  const spaceId = `notifications-${recipient.pub}`;
  const senderPub = QuCrypto.toBase64Url((await env.identity.getMainKey()).publicKey);
  const senderProfile = await env.qu.get(actorPath(senderPub, 'profile'));
  if (senderProfile) await recipient.qu.putSealed(actorPath(senderPub, 'profile'), senderProfile);

  const entries = await env.qu.getChildren(paths.threadMessagesParentPath(spaceId, 'notifications'));
  for (const { path, quBit } of entries) await recipient.qu.putSealed(path, quBit);
  const messages = new MessageService(recipient.qu, recipient.identity, new ListService(recipient.qu), new AccessService(recipient.qu, recipient.identity));
  const { messages: msgs } = await messages.listMessages(spaceId, 'notifications');
  return msgs;
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

test('a delivered notification carries a live {spaceId, threadId, messageId} ref, matching the real message', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const delivery = pushDeliveryFor(env, recipient);

  const posted = await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  const [notification] = await readOwnNotifications(env, recipient);
  assert.deepEqual(notification.ref, { spaceId: 'board', threadId: 'general', messageId: posted.id });
});

test('the Web Push payload never includes ref, only the in-app copy does', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });

  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(send.calls.length, 1);
  assert.equal('ref' in send.calls[0].payload, false);
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

test('NotificationPrefsService gating: a candidate who muted THIS thread gets neither in-app nor push, but is unaffected on a different thread of the same app', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.notificationPrefs.savePrefs({ apps: { board: { mutedThreads: ['general'] } } });
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });

  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());
  await env.messages.createThread('board', 'other', THREAD_PRESETS.forum());

  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });
  assert.equal(await inAppNotificationCount(env, recipient.pub), 0);
  assert.equal(send.calls.length, 0);

  await postAndDeliver(env, delivery, 'board', 'other', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });
  assert.equal(await inAppNotificationCount(env, recipient.pub), 1); // the OTHER thread is unaffected
  assert.equal(send.calls.length, 1);
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

/** A stub `@qu/loader` QuLoader - only `listManifests()` is ever called by createManifestNotificationResolver(). */
function fakeLoader(manifests) {
  return { listManifests: () => manifests.map((manifest) => ({ manifest, originUrl: null })) };
}

const FORUM_MANIFEST = {
  name: 'forum',
  label: 'Forum',
  spaceId: 'forum-space-uuid',
  pushActions: [
    { id: 'newMessage', label: 'New posts', type: 'create' },
    { id: 'mention', label: 'Mentions', type: 'mention' },
  ],
};

test('createManifestNotificationResolver(): matches a loaded app by spaceId and picks the "mention" pushAction', () => {
  const resolve = createManifestNotificationResolver(fakeLoader([FORUM_MANIFEST]));
  const result = resolve('forum-space-uuid', 'general', { authorPub: 'AliceAliceAliceAliceAlice', mention: true, mentions: [] });

  assert.equal(result.appId, 'forum');
  assert.equal(result.functionName, 'mention');
  assert.equal(result.title, 'Mentions — Forum');
  // Real, routable app name, NOT the (possibly UUID) spaceId - the exact
  // bug #genericNotification()'s own url: `#/${spaceId}` fallback has for
  // any app whose spaceId differs from its name (forum is exactly that).
  assert.equal(result.url, '#/forum');
  assert.ok(result.body.includes('AliceAlice'));
});

test('createManifestNotificationResolver(): picks the "create" pushAction for a non-mention', () => {
  const resolve = createManifestNotificationResolver(fakeLoader([FORUM_MANIFEST]));
  const result = resolve('forum-space-uuid', 'general', { authorPub: 'Alice', mention: false, mentions: [] });

  assert.equal(result.functionName, 'newMessage');
  assert.equal(result.title, 'New posts — Forum');
});

test('createManifestNotificationResolver(): returns null (falls through to the generic default) when no loaded app declares this spaceId', () => {
  const resolve = createManifestNotificationResolver(fakeLoader([FORUM_MANIFEST]));
  assert.equal(resolve('some-other-space', 'general', { authorPub: 'Alice', mention: true, mentions: [] }), null);
});

test('createManifestNotificationResolver(): returns null when the matching app has no pushActions entry of the needed type', () => {
  const noMentionAction = { name: 'diary', spaceId: 'diary-space', pushActions: [{ id: 'newEntry', label: 'New entry', type: 'create' }] };
  const resolve = createManifestNotificationResolver(fakeLoader([noMentionAction]));
  assert.equal(resolve('diary-space', 'general', { authorPub: 'Alice', mention: true, mentions: [] }), null);
});

test('createManifestNotificationResolver(): sees apps loaded AFTER the resolver function was created (reads loader.listManifests() at call time, not creation time)', () => {
  const manifests = [];
  const resolve = createManifestNotificationResolver(fakeLoader(manifests));
  assert.equal(resolve('forum-space-uuid', 'general', { authorPub: 'Alice', mention: true, mentions: [] }), null);

  manifests.push(FORUM_MANIFEST);
  const result = resolve('forum-space-uuid', 'general', { authorPub: 'Alice', mention: true, mentions: [] });
  assert.equal(result.functionName, 'mention');
});

test('INTEGRATION: PushDeliveryService, with the manifest-driven resolver as its resolveNotification, sends a push using the app\'s OWN pushActions wording (not the generic fallback)', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const send = fakeSendWebPush();
  const resolveNotification = createManifestNotificationResolver(fakeLoader([FORUM_MANIFEST]));
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send, resolveNotification });
  await env.messages.createThread('forum-space-uuid', 'general', THREAD_PRESETS.forum());
  const authorPub = QuCrypto.toBase64Url((await env.identity.getMainKey()).publicKey);

  await postAndDeliver(env, delivery, 'forum-space-uuid', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.deepEqual(send.calls[0].payload, {
    title: 'Mentions — Forum',
    body: `~${authorPub.slice(0, 10)}… sent a message`,
    appId: 'forum',
    url: '#/forum',
  });
  // Also confirms the write itself happened (see inAppNotificationCount()'s
  // own doc comment for why its content can't be decrypted from here).
  assert.equal(await inAppNotificationCount(env, recipient.pub), 1);
});

// ===== registry.hooks.collect('notify.threadCandidates', ...) - the extensible trigger mechanism =====

test('a registry with NO handler registered for notify.threadCandidates changes nothing (backward compatible)', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  const registry = new Registry(); // real Registry, real HookBus, zero handlers - see push-delivery.js's own doc comment
  const delivery = pushDeliveryFor(env, recipient, { registry });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());

  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal(await inAppNotificationCount(env, recipient.pub), 1); // exactly the plain mention behavior, unaffected
});

test('a notify.threadCandidates hook can ADD a candidate the generic readers/mentions logic would never include', async () => {
  const env = await freshEnv();
  const watcher = await freshRecipient(env);
  const registry = new Registry();
  registry.hooks.on('notify.threadCandidates', () => [{ actorPub: watcher.pub, functionName: 'watched' }]);
  const delivery = pushDeliveryFor(env, watcher, { registry });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum()); // public thread, watcher never mentioned

  await postAndDeliver(env, delivery, 'board', 'general', { body: 'no mention, but someone is watching this board' });

  assert.equal(await inAppNotificationCount(env, watcher.pub), 1);
});

test('a notify.threadCandidates hook\'s functionName overrides the generic default for an EXISTING candidate, passed through to resolveNotification', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  const registry = new Registry();
  registry.hooks.on('notify.threadCandidates', () => [{ actorPub: recipient.pub, functionName: 'reply-own-topic' }]);
  const seenFunctionNames = [];
  const resolveNotification = (spaceId, threadId, ctx) => {
    seenFunctionNames.push(ctx.functionName);
    return null; // fall through to the generic default - this test only cares what CONTEXT resolveNotification was called with
  };
  const delivery = pushDeliveryFor(env, recipient, { registry, resolveNotification });
  // A private thread so the generic logic ALSO produces this same actorPub as a candidate (mention: false) - the hook's functionName must win over that generic default, not just get appended as a duplicate.
  const myPub = QuCrypto.toBase64Url((await env.identity.getMainKey()).publicKey);
  await env.messages.createThread('board', 'dm', { writers: '*', readers: [myPub, recipient.pub] });

  await postAndDeliver(env, delivery, 'board', 'dm', { body: 'just for us' });

  assert.deepEqual(seenFunctionNames, ['reply-own-topic']);
  assert.equal(await inAppNotificationCount(env, recipient.pub), 1); // exactly one notification, not a duplicate
});

const PHONE_MANIFEST = {
  name: 'phone',
  label: 'Phone',
  spaceId: 'phone-space-uuid',
  pushActions: [
    {
      id: 'incomingCall',
      label: 'Eingehende Anrufe',
      type: 'create',
      urlTemplate: '#/phone/{pub}/accept',
      bypassPresence: true,
      actions: [
        { action: 'accept', title: 'Annehmen', hrefTemplate: '#/phone/{pub}/accept' },
        { action: 'decline', title: 'Ablehnen', hrefTemplate: '#/phone/{pub}/decline' },
      ],
    },
  ],
};

test('createManifestNotificationResolver(): a pushAction\'s own urlTemplate/actions/bypassPresence are used verbatim, with {pub} substituted for the authorPub (Phone\'s incoming-call action)', () => {
  const resolve = createManifestNotificationResolver(fakeLoader([PHONE_MANIFEST]));
  const result = resolve('phone-space-uuid', 'sometid', { authorPub: 'CallerPubCallerPub', mention: false, mentions: [] });

  assert.equal(result.url, '#/phone/CallerPubCallerPub/accept');
  assert.equal(result.bypassPresence, true);
  assert.deepEqual(result.actions, [
    { action: 'accept', title: 'Annehmen', url: '#/phone/CallerPubCallerPub/accept' },
    { action: 'decline', title: 'Ablehnen', url: '#/phone/CallerPubCallerPub/decline' },
  ]);
});

test('createManifestNotificationResolver(): a pushAction with no urlTemplate/actions/bypassPresence (every existing app) omits those keys entirely, not undefined-valued ones', () => {
  const resolve = createManifestNotificationResolver(fakeLoader([FORUM_MANIFEST]));
  const result = resolve('forum-space-uuid', 'general', { authorPub: 'Alice', mention: true, mentions: [] });

  assert.equal('actions' in result, false);
  assert.equal('bypassPresence' in result, false);
  assert.equal(result.url, '#/forum');
});

test('INTEGRATION: an incomingCall notification bypasses presence suppression and carries Accept/Decline actions through to BOTH the in-app notification and the Web Push payload', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const presence = new PresenceTracker();
  presence.recordSeen(recipient.pub); // recently online - would normally suppress push
  const send = fakeSendWebPush();
  const resolveNotification = createManifestNotificationResolver(fakeLoader([PHONE_MANIFEST]));
  const delivery = pushDeliveryFor(env, recipient, { presence, sendWebPush: send, resolveNotification });
  const callerPub = QuCrypto.toBase64Url((await env.identity.getMainKey()).publicKey);
  await env.messages.createThread('phone-space-uuid', 'call-thread', { writers: '*', readers: [callerPub, recipient.pub] });

  await postAndDeliver(env, delivery, 'phone-space-uuid', 'call-thread', { body: '📞' });

  // Presence bypass: a push was sent DESPITE recipient.pub being recently online.
  assert.equal(send.calls.length, 1);
  assert.deepEqual(send.calls[0].payload.actions, [
    { action: 'accept', title: 'Annehmen', url: `#/phone/${callerPub}/accept` },
    { action: 'decline', title: 'Ablehnen', url: `#/phone/${callerPub}/decline` },
  ]);

  const [notification] = await readOwnNotifications(env, recipient);
  assert.deepEqual(notification.actions, [
    { action: 'accept', title: 'Annehmen', url: `#/phone/${callerPub}/accept` },
    { action: 'decline', title: 'Ablehnen', url: `#/phone/${callerPub}/decline` },
  ]);
});

test('a notification with no resolved actions omits "actions" from both the Web Push payload and the in-app record (unaffected apps)', async () => {
  const env = await freshEnv();
  const recipient = await freshRecipient(env);
  await recipient.pushSubscriptions.subscribe({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } });
  const send = fakeSendWebPush();
  const delivery = pushDeliveryFor(env, recipient, { sendWebPush: send });
  await env.messages.createThread('board', 'general', THREAD_PRESETS.forum());

  await postAndDeliver(env, delivery, 'board', 'general', { body: `hi @${recipient.pub}`, extra: { mentions: [recipient.pub] } });

  assert.equal('actions' in send.calls[0].payload, false);
  const [notification] = await readOwnNotifications(env, recipient);
  assert.equal('actions' in notification, false);
});

test('createManifestNotificationResolver(): an explicit functionName matches pushActions by id, not the coarse mention/create type', () => {
  const manifest = {
    name: 'forum', spaceId: 'forum-space-uuid', label: 'Forum',
    pushActions: [
      { id: 'mention', label: 'Mentions', type: 'mention' },
      { id: 'reply-own-topic', label: 'Replies to your topics', type: 'custom' },
    ],
  };
  const resolve = createManifestNotificationResolver(fakeLoader([manifest]));

  // mention: false would normally pick "create" (no match here) - but an explicit functionName bypasses that entirely.
  const result = resolve('forum-space-uuid', 'general', { authorPub: 'Alice', mention: false, mentions: [], functionName: 'reply-own-topic' });
  assert.equal(result.functionName, 'reply-own-topic');
  assert.equal(result.title, 'Replies to your topics — Forum');
});
