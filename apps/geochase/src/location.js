import { createLogger } from '@qu/log';

const log = createLogger('geochase:location');

/**
 * LOCATION SHARING — drives `onPosition()` from the browser's
 * `navigator.geolocation.watchPosition()`, throttled. Mirrors
 * `PresenceService.startHeartbeat()`'s start/stop-function shape (this
 * file's closest existing precedent: a periodic self-published signal,
 * stopped by calling the function `start...()` itself returns) - except
 * driven by real position CHANGES from the browser, not a fixed interval.
 *
 * No longer takes a `mesh` - see `track-service.js`'s own top doc comment
 * for why Geo Chase's live position channel moved off the WebRTC mesh onto
 * the relay-backed store: `client.js`'s own `onPosition` callback now calls
 * `track-service.js`'s `recordTrackPoint()` directly, which is BOTH the
 * persisted-history write AND (via `watchLatestPositions()`) the live one -
 * one write, one reliable channel, instead of two independently-throttled
 * ones racing each other.
 *
 * @param {{minIntervalMs?: number, onPosition: (position: {lat: number, lng: number, heading?: number, speed?: number}) => void}} options -
 *   `minIntervalMs`: skips a `watchPosition()` update that arrives less than
 *   this long after the previous one - the browser can fire far more often
 *   than this game's position sync actually needs, and every update is a
 *   signed, encrypted write.
 * @returns {() => void} Stop function.
 */
export function startLocationSharing({ minIntervalMs = 1_000, onPosition }) {
  let lastSentAt = 0;
  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      const now = Date.now();
      if (now - lastSentAt < minIntervalMs) return;
      lastSentAt = now;
      onPosition({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        heading: position.coords.heading ?? undefined,
        speed: position.coords.speed ?? undefined,
      });
    },
    (err) => log.warn('geolocation watchPosition() error:', err.message),
    { enableHighAccuracy: true }
  );
  return () => navigator.geolocation.clearWatch(watchId);
}
