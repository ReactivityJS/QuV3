import { createLogger } from '@qu/log';

const log = createLogger('geochase:location');

/**
 * LOCATION SHARING — drives `mesh.putPosition()` from the browser's
 * `navigator.geolocation.watchPosition()`. Mirrors
 * `PresenceService.startHeartbeat()`'s start/stop-function shape (this
 * file's closest existing precedent: a periodic self-published signal,
 * stopped by calling the function `start...()` itself returns) - except
 * driven by real position CHANGES from the browser, not a fixed interval.
 *
 * @param {Awaited<ReturnType<typeof import('./mesh.js').createGeochaseMesh>>} mesh
 * @param {{minIntervalMs?: number}} [options] - `minIntervalMs`: skips a
 *   `watchPosition()` update that arrives less than this long after the
 *   previous one - the browser can fire far more often than this game's
 *   position sync actually needs, and every update is a signed write plus a
 *   network send to every connected peer.
 * @returns {() => void} Stop function.
 */
export function startLocationSharing(mesh, { minIntervalMs = 1_000 } = {}) {
  let lastSentAt = 0;
  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      const now = Date.now();
      if (now - lastSentAt < minIntervalMs) return;
      lastSentAt = now;
      mesh
        .putPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          heading: position.coords.heading ?? undefined,
          speed: position.coords.speed ?? undefined,
        })
        .catch((err) => log.warn('putPosition() failed:', err.message));
    },
    (err) => log.warn('geolocation watchPosition() error:', err.message),
    { enableHighAccuracy: true }
  );
  return () => navigator.geolocation.clearWatch(watchId);
}
