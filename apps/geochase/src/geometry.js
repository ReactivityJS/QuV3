/**
 * GEOMETRY — pure math for Geo Chase's map: no DOM, no network, fully unit
 * testable. Three independent concerns live here:
 *   1. `possibleRadiusMeters()` - the "how far could the chased player have
 *      gotten since their last known position" circle (per this app's own
 *      design: speed × time-since-last-update, with a walking-speed floor
 *      so a momentarily-zero GPS speed reading - common even while actually
 *      moving - never collapses the circle to a point).
 *   2. `haversineMeters()`/`bearingDegrees()` - great-circle distance/
 *      bearing between two lat/lng points, used for the player list's own
 *      "230m away, NE" readout.
 *   3. Local equirectangular projection (`projectLocal()`) - the "plane"
 *      map mode's own lat/lng -> canvas-pixel pipeline, centered on a
 *      reference point (the chased player, so they always sit at the
 *      canvas center) and scaled to fit every known player + the radius
 *      circle on screen (`fitScaleMetersPerPixel()`).
 *
 * Deliberately NOT Web-Mercator/slippy-map math (that's a `mapMode: 'osm'`
 * concern, real tile georeferencing) - the plane mode is an abstract,
 * locally-flat "everyone relative to the chased player" view, exactly what
 * the equirectangular approximation is for at these short (village/city,
 * never continental) distances.
 */

const EARTH_RADIUS_M = 6_371_000;
const METERS_PER_DEG_LAT = 111_320; // constant: a degree of latitude is ~the same distance everywhere

/**
 * @param {{lat: number, lng: number}} a @param {{lat: number, lng: number}} b
 * @returns {number} Great-circle distance in meters.
 */
export function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @param {{lat: number, lng: number}} from @param {{lat: number, lng: number}} to
 * @returns {number} Compass bearing in degrees [0, 360) from `from` to `to`.
 */
export function bearingDegrees(from, to) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const y = Math.sin(toRad(to.lng - from.lng)) * Math.cos(toRad(to.lat));
  const x = Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) - Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(toRad(to.lng - from.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * @param {{speedMps?: number|null, elapsedMs: number, minSpeedMps?: number, maxRadiusMeters?: number}} options
 *   `minSpeedMps` (default 1.2 - average adult walking speed): the floor
 *   applied to a missing/zero/noisy GPS speed reading, per this file's own
 *   top doc comment. `maxRadiusMeters` (default Infinity): an optional cap
 *   for when "however far they could theoretically have gone" would
 *   otherwise dwarf the map (e.g. a stale position from hours ago).
 * @returns {number} Meters - never negative.
 */
export function possibleRadiusMeters({ speedMps, elapsedMs, minSpeedMps = 1.2, maxRadiusMeters = Infinity }) {
  const effectiveSpeed = Math.max(speedMps ?? 0, minSpeedMps);
  const elapsedSeconds = Math.max(0, elapsedMs) / 1000;
  return Math.min(effectiveSpeed * elapsedSeconds, maxRadiusMeters);
}

/**
 * Local, flat-earth approximation - accurate enough at the scale a chase
 * ever plays out over (meters to a few km), never meant for long distances.
 * @param {{lat: number, lng: number}} point @param {{lat: number, lng: number}} ref
 * @returns {{xMeters: number, yMeters: number}} Offset of `point` from `ref`
 *   - `xMeters` positive = east, `yMeters` positive = SOUTH (screen-space
 *   "down", matching canvas's own y-axis - the caller never has to flip it).
 */
export function projectLocal(point, ref) {
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
  return {
    xMeters: (point.lng - ref.lng) * metersPerDegLng,
    yMeters: (ref.lat - point.lat) * METERS_PER_DEG_LAT,
  };
}

/**
 * The scale (meters per canvas pixel) that fits every given offset (already
 * projected via `projectLocal()`) inside a `canvasPx`-sized square, with a
 * margin so points never sit flush against the edge.
 * @param {Array<{xMeters: number, yMeters: number}>} offsets - Include the
 *   radius circle's own extent (see this module's own `possibleRadiusMeters()`)
 *   by passing offsets that already account for it - see geochase's own map
 *   renderer for how it builds this list.
 * @param {number} canvasPx @param {{margin?: number, minSpanMeters?: number}} [options]
 *   `minSpanMeters` (default 40) - a floor on the fitted span so a single
 *   stationary player (offsets all ~0) doesn't zoom in to a meaningless,
 *   effectively-infinite scale.
 * @returns {number} Meters per pixel.
 */
export function fitScaleMetersPerPixel(offsets, canvasPx, { margin = 1.3, minSpanMeters = 40 } = {}) {
  let maxAbs = 0;
  for (const { xMeters, yMeters } of offsets) {
    maxAbs = Math.max(maxAbs, Math.abs(xMeters), Math.abs(yMeters));
  }
  const spanMeters = Math.max(maxAbs * 2 * margin, minSpanMeters);
  return spanMeters / canvasPx;
}
