import { boundingBox } from './geometry.js';

/**
 * OSM EMBED — `mapMode: 'osm'`'s real-map-tile half (see game-service.js's
 * own `DEFAULT_SETTINGS` doc comment): an `<iframe src="...">` pointing at
 * OpenStreetMap's own official lightweight embed endpoint
 * (`/export/embed.html`), NOT a self-hosted slippy-tile renderer.
 *
 * Deliberately NOT a custom `tile.openstreetmap.org/{z}/{x}/{y}.png` fetch
 * pipeline: OSM's own tile usage policy
 * (operations.osmfoundation.org/policies/tiles/) explicitly asks that
 * production apps NOT hotlink its raw tile server without caching/a
 * registered User-Agent - exactly what a bespoke tile fetcher here would
 * do. The `/export/embed.html` endpoint is the sanctioned "just embed a
 * map" mechanism for this use case instead.
 *
 * TRADE-OFF this embed accepts: it supports exactly ONE marker, so it shows
 * the CHASED player's position (the one everyone actually cares about
 * seeing on a real map) - every chaser's own position, and the speed-based
 * radius circle, still render on `map-canvas.js`'s own canvas, shown
 * alongside this iframe rather than pixel-overlaid onto it (a cross-origin
 * iframe's internal tile rendering can't be drawn on top of reliably - see
 * client.js's own `mapMode: 'osm'` rendering for how the two are combined).
 */

/**
 * @param {Array<{lat: number, lng: number}>} points - Every currently known player's position.
 * @param {{lat: number, lng: number}|null} markerLatLng - The chased player's position, or null if not yet known.
 * @returns {string} A full `https://www.openstreetmap.org/export/embed.html?...` URL.
 */
export function osmEmbedSrc(points, markerLatLng) {
  const bbox = boundingBox(points.length ? points : [markerLatLng].filter(Boolean));
  const params = new URLSearchParams({
    bbox: `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`,
    layer: 'mapnik',
  });
  if (markerLatLng) params.set('marker', `${markerLatLng.lat},${markerLatLng.lng}`);
  return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
}
