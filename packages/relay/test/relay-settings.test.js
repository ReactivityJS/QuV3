import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { getSettings, saveSettings, DEFAULT_RELAY_SETTINGS, RELAY_SETTINGS_PATH } from '../src/relay-settings.js';

function freshQu() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return qu;
}

test('getSettings() of a fresh relay returns full defaults', async () => {
  const qu = freshQu();
  assert.deepEqual(await getSettings(qu), DEFAULT_RELAY_SETTINGS);
});

test('saveSettings()/getSettings() round-trip', async () => {
  const qu = freshQu();
  await saveSettings(qu, { defaultLocale: 'de' });
  const result = await getSettings(qu);
  assert.equal(result.defaultLocale, 'de');
});

test('saveSettings() merges - an omitted top-level field keeps its default', async () => {
  const qu = freshQu();
  await saveSettings(qu, { disabledApps: ['forum'] });
  const result = await getSettings(qu);
  assert.deepEqual(result.disabledApps, ['forum']);
  assert.equal(result.defaultLocale, 'en'); // untouched
});

test('saveSettings() with a rateLimits patch merges it into the default rateLimits sub-object', async () => {
  const qu = freshQu();
  await saveSettings(qu, { rateLimits: { maxMessagesPerMinute: 30 } });
  const result = await getSettings(qu);
  assert.deepEqual(result.rateLimits, { maxMessagesPerMinute: 30 });
});

test('saveSettings() can turn link previews off - an admin kill switch for link-preview.js\'s outbound fetches', async () => {
  const qu = freshQu();
  await saveSettings(qu, { linkPreviews: { enabled: false } });
  const result = await getSettings(qu);
  assert.deepEqual(result.linkPreviews, { enabled: false });
});

test('a second saveSettings() call merges onto the FIRST persisted state, not the hardcoded defaults', async () => {
  const qu = freshQu();
  await saveSettings(qu, { defaultLocale: 'de' });
  await saveSettings(qu, { disabledApps: ['chat'] });
  const result = await getSettings(qu);
  assert.equal(result.defaultLocale, 'de'); // survived the second call
  assert.deepEqual(result.disabledApps, ['chat']);
});

test('settings are stored under the local-only prefix', async () => {
  assert.equal(RELAY_SETTINGS_PATH.startsWith('/store/secure/'), true);
});

test('saveSettings() with a channels patch merges it into the default channels sub-object', async () => {
  const qu = freshQu();
  await saveSettings(qu, { channels: { allowMemberCreate: false } });
  const result = await getSettings(qu);
  assert.deepEqual(result.channels, { allowMemberCreate: false, allowMemberRestricted: false }); // allowMemberRestricted kept its default
});

test('saveSettings() with a chat patch merges it into the default chat sub-object', async () => {
  const qu = freshQu();
  await saveSettings(qu, { chat: { allowMemberCreateGroup: false } });
  const result = await getSettings(qu);
  assert.deepEqual(result.chat, { allowMemberCreateGroup: false });
});

test('saveSettings() with an extensionOrder patch round-trips a {point: [id,...]} map', async () => {
  const qu = freshQu();
  await saveSettings(qu, { extensionOrder: { 'content.messageFooter': ['reactions', 'core.timestamp'] } });
  const result = await getSettings(qu);
  assert.deepEqual(result.extensionOrder, { 'content.messageFooter': ['reactions', 'core.timestamp'] });
});

test('saveSettings() with an extensionOrder patch replaces the WHOLE map, same "send the full sub-object" contract as channels/rateLimits - a caller must include every point it wants to keep', async () => {
  const qu = freshQu();
  await saveSettings(qu, { extensionOrder: { 'content.messageFooter': ['reactions'] } });
  await saveSettings(qu, { extensionOrder: { 'content.messageMenu': ['core.edit'] } });
  const result = await getSettings(qu);
  assert.deepEqual(result.extensionOrder, { 'content.messageMenu': ['core.edit'] }); // messageFooter's own entry did NOT survive - not merged by point key
});
