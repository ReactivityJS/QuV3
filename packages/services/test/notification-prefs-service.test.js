import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { NotificationPrefsService } from '../src/notification-prefs-service.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity, prefs: new NotificationPrefsService(qu, identity) };
}

test('getOwnPrefs() of a never-saved identity returns full defaults', async () => {
  const { prefs } = await freshSetup();
  assert.deepEqual(await prefs.getOwnPrefs(), { enabled: true, mentions: true, apps: {} });
});

test('savePrefs()/getOwnPrefs() round-trip', async () => {
  const { prefs } = await freshSetup();
  await prefs.savePrefs({ enabled: false, mentions: false });
  assert.deepEqual(await prefs.getOwnPrefs(), { enabled: false, mentions: false, apps: {} });
});

test('savePrefs() merges with defaults - an omitted field falls back, not to undefined', async () => {
  const { prefs } = await freshSetup();
  await prefs.savePrefs({ mentions: false });
  const result = await prefs.getOwnPrefs();
  assert.equal(result.enabled, true);
  assert.equal(result.mentions, false);
});

test('savePrefs() persists per-app overrides', async () => {
  const { prefs } = await freshSetup();
  await prefs.savePrefs({ apps: { chat: { enabled: false }, forum: { functions: { newMessage: false } } } });
  const result = await prefs.getOwnPrefs();
  assert.deepEqual(result.apps, { chat: { enabled: false }, forum: { functions: { newMessage: false } } });
});

test('getPrefsFor() reads ANY identity\'s public prefs, not just the caller\'s own', async () => {
  const { qu, identity, prefs } = await freshSetup();
  await prefs.savePrefs({ enabled: false });
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  const otherViewer = new NotificationPrefsService(qu, { getMainKey: async () => QuCrypto.generateKeypair() });
  assert.deepEqual(await otherViewer.getPrefsFor(myPub), { enabled: false, mentions: true, apps: {} });
});

test('getPrefsFor() of an identity that never saved prefs returns defaults', async () => {
  const { prefs } = await freshSetup();
  assert.deepEqual(await prefs.getPrefsFor('never-saved-anything'), { enabled: true, mentions: true, apps: {} });
});

test('a tampered (unsigned-match) prefs record falls back to defaults rather than trusting it', async () => {
  const { qu, identity, prefs } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);

  // Write a record with mismatched prefs/signature directly (bypassing savePrefs()'s own signing).
  const mainKey = await identity.getMainKey();
  const realSignature = await QuCrypto.sign(new TextEncoder().encode(JSON.stringify({ enabled: true })), mainKey.privateKeyPkcs8);
  await qu.put(
    `/store/actors/~${myPub}/notification-prefs`,
    { prefs: { enabled: false }, signature: QuCrypto.toBase64Url(realSignature) }, // signature covers {enabled:true}, not {enabled:false}
    { signWith: mainKey.privateKeyPkcs8, writerPub: mainKey.publicKey }
  );

  assert.deepEqual(await prefs.getPrefsFor(myPub), { enabled: true, mentions: true, apps: {} });
});

// ===== shouldNotify() - pure decision logic =========================================

test('shouldNotify() is true by default for an unrestricted app/event', () => {
  const prefs = { enabled: true, mentions: true, apps: {} };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'forum' }), true);
});

test('shouldNotify() is false when the global switch is off, regardless of anything else', () => {
  const prefs = { enabled: false, mentions: true, apps: {} };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'forum' }), false);
});

test('shouldNotify() is false for a mention when the global mentions switch is off', () => {
  const prefs = { enabled: true, mentions: false, apps: {} };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'forum', mention: true }), false);
});

test('shouldNotify() ignores the mentions switch for a non-mention event', () => {
  const prefs = { enabled: true, mentions: false, apps: {} };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'forum', mention: false }), true);
});

test('shouldNotify() is false when a specific app is disabled', () => {
  const prefs = { enabled: true, mentions: true, apps: { chat: { enabled: false } } };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'chat' }), false);
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'forum' }), true); // other apps unaffected
});

test('shouldNotify() is false when a specific function within an app is disabled', () => {
  const prefs = { enabled: true, mentions: true, apps: { chat: { functions: { newMessage: false } } } };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'chat', functionName: 'newMessage' }), false);
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'chat', functionName: 'mention' }), true);
});

test('shouldNotify() is false for a muted thread within an app, but does not affect other threads or the app\'s own global switches', () => {
  const prefs = { enabled: true, mentions: true, apps: { chat: { mutedThreads: ['room-a'] } } };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'chat', threadId: 'room-a' }), false);
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'chat', threadId: 'room-b' }), true);
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'chat' }), true); // no threadId given at all - mute is never consulted
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'forum', threadId: 'room-a' }), true); // mutedThreads is per-app, not global
});

test('shouldPopup() is also false for a muted thread - same reasoning as shouldNotify(), a muted conversation never pops either', () => {
  const prefs = { enabled: true, mentions: true, apps: { chat: { mutedThreads: ['room-a'] } } };
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'chat', threadId: 'room-a', defaultPopup: true }), false);
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'chat', threadId: 'room-b', defaultPopup: true }), true);
});

test('savePrefs()/getOwnPrefs() round-trips a mutedThreads array unchanged', async () => {
  const { prefs } = await freshSetup();
  await prefs.savePrefs({ apps: { chat: { mutedThreads: ['room-a', 'room-b'] } } });
  const result = await prefs.getOwnPrefs();
  assert.deepEqual(result.apps.chat.mutedThreads, ['room-a', 'room-b']);
});

test('shouldNotify() also honors the newer {enabled, popup} object form for a per-function override, not just the legacy plain boolean', () => {
  const prefs = { enabled: true, mentions: true, apps: { phone: { functions: { incomingCall: { enabled: false, popup: true } } } } };
  assert.equal(NotificationPrefsService.shouldNotify(prefs, { appId: 'phone', functionName: 'incomingCall' }), false);
});

test('savePrefs()/getOwnPrefs() round-trips the newer {enabled, popup} object form for a per-function override unchanged', async () => {
  const { prefs } = await freshSetup();
  await prefs.savePrefs({ apps: { phone: { functions: { incomingCall: { enabled: true, popup: true } } } } });
  const result = await prefs.getOwnPrefs();
  assert.deepEqual(result.apps, { phone: { functions: { incomingCall: { enabled: true, popup: true } } } });
});

// ===== shouldPopup() - the popup delivery-mode counterpart =========================================

test('shouldPopup() is false whenever shouldNotify() itself is false, regardless of any popup override', () => {
  const prefs = { enabled: false, mentions: true, apps: {} };
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'phone', functionName: 'incomingCall', defaultPopup: true }), false);
});

test('shouldPopup() falls back to the caller-supplied defaultPopup when this function was never explicitly overridden', () => {
  const prefs = { enabled: true, mentions: true, apps: {} };
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'phone', functionName: 'incomingCall', defaultPopup: true }), true);
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'chat', functionName: 'newMessage', defaultPopup: false }), false);
});

test('shouldPopup() is false for a LEGACY plain-boolean function override, even with a true defaultPopup - an old value never opted into popups', () => {
  const prefs = { enabled: true, mentions: true, apps: { phone: { functions: { incomingCall: true } } } };
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'phone', functionName: 'incomingCall', defaultPopup: true }), false);
});

test('shouldPopup() reads an explicit popup:true/false on the object form over the default', () => {
  const prefsOn = { enabled: true, mentions: true, apps: { phone: { functions: { incomingCall: { popup: true } } } } };
  assert.equal(NotificationPrefsService.shouldPopup(prefsOn, { appId: 'phone', functionName: 'incomingCall', defaultPopup: false }), true);

  const prefsOff = { enabled: true, mentions: true, apps: { chat: { functions: { newMessage: { popup: false } } } } };
  assert.equal(NotificationPrefsService.shouldPopup(prefsOff, { appId: 'chat', functionName: 'newMessage', defaultPopup: true }), false);
});

test('shouldPopup() with no functionName has no per-function override to read, so it falls back to defaultPopup exactly like the "never overridden" case', () => {
  const prefs = { enabled: true, mentions: true, apps: {} };
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'phone', defaultPopup: true }), true);
  assert.equal(NotificationPrefsService.shouldPopup(prefs, { appId: 'phone', defaultPopup: false }), false);
});
