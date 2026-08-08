import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker } from '../src/presence-tracker.js';

test('an actor never seen is not recently online', () => {
  const presence = new PresenceTracker();
  assert.equal(presence.isRecentlyOnline('never-seen'), false);
});

test('recordSeen()/isRecentlyOnline() - a just-recorded actor is recently online', () => {
  const presence = new PresenceTracker();
  presence.recordSeen('alice');
  assert.equal(presence.isRecentlyOnline('alice'), true);
});

test('an actor seen longer ago than freshMs is no longer recently online', async () => {
  const presence = new PresenceTracker({ freshMs: 10 });
  presence.recordSeen('alice');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(presence.isRecentlyOnline('alice'), false);
});

test('different actors are tracked independently', () => {
  const presence = new PresenceTracker();
  presence.recordSeen('alice');
  assert.equal(presence.isRecentlyOnline('alice'), true);
  assert.equal(presence.isRecentlyOnline('bob'), false);
});

test('re-recording an actor refreshes their staleness window', async () => {
  const presence = new PresenceTracker({ freshMs: 30 });
  presence.recordSeen('alice');
  await new Promise((resolve) => setTimeout(resolve, 20));
  presence.recordSeen('alice'); // refresh before it would have gone stale
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(presence.isRecentlyOnline('alice'), true); // 20ms since the refresh, well under 30ms
});

test('REGRESSION: the map is bounded by maxEntries - oldest entries are evicted, not grown forever', () => {
  const presence = new PresenceTracker({ maxEntries: 3 });
  presence.recordSeen('a');
  presence.recordSeen('b');
  presence.recordSeen('c');
  presence.recordSeen('d'); // pushes 'a' out

  assert.equal(presence.isRecentlyOnline('a'), false);
  assert.equal(presence.isRecentlyOnline('b'), true);
  assert.equal(presence.isRecentlyOnline('c'), true);
  assert.equal(presence.isRecentlyOnline('d'), true);
});
