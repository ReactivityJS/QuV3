import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmEmbedSrc } from '../src/map-embed.js';

test('osmEmbedSrc(): builds a bbox around every point and sets the marker to the chased position', async () => {
  const url = osmEmbedSrc(
    [{ lat: 52.5, lng: 13.4 }, { lat: 52.51, lng: 13.41 }],
    { lat: 52.5, lng: 13.4 }
  );
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://www.openstreetmap.org/export/embed.html');
  assert.equal(parsed.searchParams.get('layer'), 'mapnik');
  assert.equal(parsed.searchParams.get('marker'), '52.5,13.4');
  const bbox = parsed.searchParams.get('bbox').split(',').map(Number);
  assert.ok(bbox[0] < 13.4 && bbox[2] > 13.41, 'bbox must cover both points with padding');
});

test('osmEmbedSrc(): no marker param when the chased position is unknown yet', async () => {
  const url = osmEmbedSrc([{ lat: 10, lng: 20 }], null);
  assert.equal(new URL(url).searchParams.has('marker'), false);
});

test('osmEmbedSrc(): a single known point (no players list yet) still produces a valid, non-degenerate bbox', async () => {
  const url = osmEmbedSrc([], { lat: 10, lng: 20 });
  const bbox = new URL(url).searchParams.get('bbox').split(',').map(Number);
  assert.ok(bbox[0] < bbox[2] && bbox[1] < bbox[3]);
});
