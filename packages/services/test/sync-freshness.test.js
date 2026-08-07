import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshnessTracker, createMissGate } from '../src/sync-freshness.js';

test('createFreshnessTracker(): is a no-op with no syncFetch/getGeneration', () => {
  const backgroundRefresh = createFreshnessTracker(null, null);
  assert.doesNotThrow(() => backgroundRefresh('/x'));
});

test('createFreshnessTracker(): calls syncFetch at most once per (path, generation)', () => {
  let generation = 1;
  const calls = [];
  const backgroundRefresh = createFreshnessTracker(
    async (path) => { calls.push(path); },
    () => generation
  );

  backgroundRefresh('/a');
  backgroundRefresh('/a'); // same generation - should NOT call again
  backgroundRefresh('/b'); // different path - calls
  assert.deepEqual(calls, ['/a', '/b']);
});

test('createFreshnessTracker(): re-fires for the SAME path after the generation advances', () => {
  let generation = 1;
  const calls = [];
  const backgroundRefresh = createFreshnessTracker(async (path) => { calls.push(path); }, () => generation);

  backgroundRefresh('/a');
  generation = 2; // simulates a reconnect
  backgroundRefresh('/a');
  assert.deepEqual(calls, ['/a', '/a']);
});

test('createFreshnessTracker(): a rejecting syncFetch never surfaces - it is fire-and-forget', async () => {
  const backgroundRefresh = createFreshnessTracker(async () => { throw new Error('offline'); }, () => 1);
  assert.doesNotThrow(() => backgroundRefresh('/a'));
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the rejection settle
});

test('createMissGate(): always returns false (never skips) with no getGeneration', () => {
  const alreadyAttemptedMiss = createMissGate(null);
  assert.equal(alreadyAttemptedMiss('/x'), false);
  assert.equal(alreadyAttemptedMiss('/x'), false);
});

test('createMissGate(): returns false the first time, true on repeats within the same generation', () => {
  const alreadyAttemptedMiss = createMissGate(() => 1);
  assert.equal(alreadyAttemptedMiss('/x'), false);
  assert.equal(alreadyAttemptedMiss('/x'), true);
  assert.equal(alreadyAttemptedMiss('/x'), true);
});

test('createMissGate(): resets to false again after the generation advances', () => {
  let generation = 1;
  const alreadyAttemptedMiss = createMissGate(() => generation);
  assert.equal(alreadyAttemptedMiss('/x'), false);
  assert.equal(alreadyAttemptedMiss('/x'), true);
  generation = 2;
  assert.equal(alreadyAttemptedMiss('/x'), false);
});

test('createMissGate(): tracks each path independently', () => {
  const alreadyAttemptedMiss = createMissGate(() => 1);
  assert.equal(alreadyAttemptedMiss('/a'), false);
  assert.equal(alreadyAttemptedMiss('/b'), false);
  assert.equal(alreadyAttemptedMiss('/a'), true);
});
