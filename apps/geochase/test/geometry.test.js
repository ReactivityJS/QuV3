import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, bearingDegrees, possibleRadiusMeters, projectLocal, fitScaleMetersPerPixel } from '../src/geometry.js';

test('haversineMeters(): a known 1-degree-of-latitude span is ~111.2km', async () => {
  const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(d - 111_195) < 200, `expected ~111195m, got ${d}`);
});

test('haversineMeters(): the same point is 0 apart', async () => {
  assert.equal(haversineMeters({ lat: 52.5, lng: 13.4 }, { lat: 52.5, lng: 13.4 }), 0);
});

test('bearingDegrees(): due north is 0, due east is 90', async () => {
  const north = bearingDegrees({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(north - 0) < 0.5, `expected ~0deg, got ${north}`);
  const east = bearingDegrees({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.ok(Math.abs(east - 90) < 0.5, `expected ~90deg, got ${east}`);
});

test('possibleRadiusMeters(): speed * elapsed time, in meters', async () => {
  // 2 m/s for 10s = 20m.
  assert.equal(possibleRadiusMeters({ speedMps: 2, elapsedMs: 10_000 }), 20);
});

test('possibleRadiusMeters(): a missing/zero speed reading falls back to the walking-speed floor, never collapsing to 0', async () => {
  const r = possibleRadiusMeters({ speedMps: 0, elapsedMs: 10_000, minSpeedMps: 1.2 });
  assert.equal(r, 12); // 1.2 m/s floor * 10s
  const rMissing = possibleRadiusMeters({ speedMps: null, elapsedMs: 10_000, minSpeedMps: 1.2 });
  assert.equal(rMissing, 12);
});

test('possibleRadiusMeters(): a real speed above the floor is used as-is', async () => {
  assert.equal(possibleRadiusMeters({ speedMps: 5, elapsedMs: 4_000, minSpeedMps: 1.2 }), 20);
});

test('possibleRadiusMeters(): clamped to maxRadiusMeters for a very stale position', async () => {
  const r = possibleRadiusMeters({ speedMps: 5, elapsedMs: 10_000_000, maxRadiusMeters: 500 });
  assert.equal(r, 500);
});

test('possibleRadiusMeters(): never negative even for a negative elapsed (clock skew)', async () => {
  assert.equal(possibleRadiusMeters({ speedMps: 5, elapsedMs: -1000 }), 0);
});

test('projectLocal(): a point directly north of the reference has a negative yMeters (screen-up) and ~0 xMeters', async () => {
  const { xMeters, yMeters } = projectLocal({ lat: 1, lng: 0 }, { lat: 0, lng: 0 });
  assert.ok(Math.abs(xMeters) < 1);
  assert.ok(yMeters < 0, 'north of the reference must be negative y (up) in canvas space');
  assert.ok(Math.abs(Math.abs(yMeters) - 111_320) < 500);
});

test('projectLocal(): a point directly east has positive xMeters and ~0 yMeters', async () => {
  const { xMeters, yMeters } = projectLocal({ lat: 0, lng: 1 }, { lat: 0, lng: 0 });
  assert.ok(xMeters > 0);
  assert.ok(Math.abs(yMeters) < 1);
});

test('projectLocal(): the reference point projects to (0, 0)', async () => {
  const { xMeters, yMeters } = projectLocal({ lat: 52.5, lng: 13.4 }, { lat: 52.5, lng: 13.4 });
  assert.equal(xMeters, 0);
  assert.equal(yMeters, 0);
});

test('fitScaleMetersPerPixel(): scales so the furthest offset fits within the canvas with margin', async () => {
  const scale = fitScaleMetersPerPixel([{ xMeters: 100, yMeters: 0 }], 200, { margin: 1, minSpanMeters: 0 });
  // furthest point is 100m out -> span 200m -> 200m / 200px = 1 m/px
  assert.equal(scale, 1);
});

test('fitScaleMetersPerPixel(): a single stationary point (all ~0) still gets a sane, non-infinite scale via minSpanMeters', async () => {
  const scale = fitScaleMetersPerPixel([{ xMeters: 0, yMeters: 0 }], 200, { minSpanMeters: 40 });
  assert.equal(scale, 40 / 200);
});
