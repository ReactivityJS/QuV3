import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProximityWatcher } from '../src/proximity.js';

// ~0.001 degrees of latitude is ~111m - used below to place players a known
// rough distance apart without pulling in haversineMeters() itself (this
// suite exercises the WATCHER's edge-triggering, not the distance math,
// already covered by geometry.test.js).
function playerAt(actorPub, lat, lng = 0) {
  return { actorPub, position: { lat, lng } };
}

test('evaluate(): a chaser crossing INTO proximity range fires once, not on every subsequent tick while still inside', () => {
  const watcher = createProximityWatcher({ selfPub: 'chaser', chasedPub: 'chased', proximityAlertMeters: 200, catchRangeMeters: 20 });
  const far = [playerAt('chaser', 0, 0), playerAt('chased', 0.01, 0)]; // ~1.1km apart
  const close = [playerAt('chaser', 0, 0), playerAt('chased', 0.001, 0)]; // ~111m apart - inside proximity, outside catch

  assert.equal(watcher.evaluate(far), null);
  const first = watcher.evaluate(close);
  assert.equal(first.level, 'proximity');
  assert.equal(first.otherPub, 'chased');
  assert.equal(watcher.evaluate(close), null); // still inside - no re-fire
  assert.equal(watcher.evaluate(close), null);
});

test('evaluate(): crossing into catch range fires "catch", not "proximity", even though both thresholds are crossed at once', () => {
  const watcher = createProximityWatcher({ selfPub: 'chaser', chasedPub: 'chased', proximityAlertMeters: 200, catchRangeMeters: 20 });
  const far = [playerAt('chaser', 0, 0), playerAt('chased', 0.01, 0)];
  const veryClose = [playerAt('chaser', 0, 0), playerAt('chased', 0.00005, 0)]; // ~5.5m - inside catch range too

  assert.equal(watcher.evaluate(far), null);
  const fired = watcher.evaluate(veryClose);
  assert.equal(fired.level, 'catch');
});

test('evaluate(): leaving and re-entering the same threshold fires again', () => {
  const watcher = createProximityWatcher({ selfPub: 'chaser', chasedPub: 'chased', proximityAlertMeters: 200, catchRangeMeters: 20 });
  const far = [playerAt('chaser', 0, 0), playerAt('chased', 0.01, 0)];
  const close = [playerAt('chaser', 0, 0), playerAt('chased', 0.001, 0)];

  assert.equal(watcher.evaluate(far), null);
  assert.ok(watcher.evaluate(close));
  assert.equal(watcher.evaluate(far), null); // leaving fires nothing itself
  assert.ok(watcher.evaluate(close)); // re-entering fires again
});

test('evaluate(): from the CHASED player\'s own perspective, the nearest chaser drives the alert', () => {
  const watcher = createProximityWatcher({ selfPub: 'chased', chasedPub: 'chased', proximityAlertMeters: 200, catchRangeMeters: 20 });
  const players = [
    playerAt('chased', 0, 0),
    playerAt('chaser-far', 0.01, 0),
    playerAt('chaser-near', 0.001, 0),
  ];
  const fired = watcher.evaluate(players);
  assert.equal(fired.level, 'proximity');
  assert.equal(fired.otherPub, 'chaser-near');
});

test('evaluate(): returns null when the relevant other player is not yet known', () => {
  const asChaser = createProximityWatcher({ selfPub: 'chaser', chasedPub: 'chased', proximityAlertMeters: 200, catchRangeMeters: 20 });
  assert.equal(asChaser.evaluate([playerAt('chaser', 0, 0)]), null); // chased unknown yet
  const asChased = createProximityWatcher({ selfPub: 'chased', chasedPub: 'chased', proximityAlertMeters: 200, catchRangeMeters: 20 });
  assert.equal(asChased.evaluate([playerAt('chased', 0, 0)]), null); // no chasers yet
  assert.equal(asChased.evaluate([]), null); // self unknown yet
});
