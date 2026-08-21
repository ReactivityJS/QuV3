import { haversineMeters } from './geometry.js';

/**
 * PROXIMITY — pure, DOM-free edge-detection for req. 8's two granular
 * alerts: "critical proximity to the chased player reached"
 * (`proximityAlertMeters`) and "catch range reached" (`catchRangeMeters`,
 * strictly the tighter of the two - see `game-service.js`'s own
 * `DEFAULT_SETTINGS` doc comment). Both thresholds are evaluated against the
 * SAME single distance - "me" to "the chased player" if I'm a chaser, or "me"
 * (the chased) to the NEAREST chaser if I'm the one being chased - so both
 * sides of a chase get a relevant, symmetric alert, not just the chaser's own
 * "I'm close" one.
 *
 * EDGE-TRIGGERED, not level-triggered: `evaluate()` only ever calls `onAlert`
 * on a threshold being CROSSED (from outside to inside), never on every tick
 * a player already inside it - otherwise every position update (every few
 * minutes, per this app's own configurable interval) would re-fire the same
 * alert for as long as two players happen to stay close, which is exactly
 * the "not spammy" requirement req. 8 implies. Crossing back out and back in
 * again DOES re-fire - this is a live proximity alarm, not a one-shot.
 *
 * `catch` and `proximity` are mutually exclusive on any one tick (being
 * inside the smaller catch radius trivially means being inside the larger
 * proximity radius too) - only the more urgent one ever fires for the same
 * crossing, so a player never gets both notifications back to back for the
 * same approach.
 */

/**
 * @param {{selfPub: string, chasedPub: string, proximityAlertMeters: number, catchRangeMeters: number}} config
 * @returns {{evaluate: (players: Array<{actorPub: string, position: {lat: number, lng: number}}>) => {level: 'catch'|'proximity', meters: number, otherPub: string}|null}}
 */
export function createProximityWatcher({ selfPub, chasedPub, proximityAlertMeters, catchRangeMeters }) {
  let wasCatch = false;
  let wasProximity = false;

  function nearestDistance(players) {
    const self = players.find((p) => p.actorPub === selfPub);
    if (!self) return null;
    if (selfPub === chasedPub) {
      let best = null;
      for (const p of players) {
        if (p.actorPub === selfPub) continue;
        const d = haversineMeters(self.position, p.position);
        if (best === null || d < best.meters) best = { meters: d, otherPub: p.actorPub };
      }
      return best;
    }
    const chased = players.find((p) => p.actorPub === chasedPub);
    if (!chased) return null;
    return { meters: haversineMeters(self.position, chased.position), otherPub: chasedPub };
  }

  /**
   * @param {Array<{actorPub: string, position: {lat: number, lng: number}}>} players
   * @returns {{level: 'catch'|'proximity', meters: number, otherPub: string}|null} A
   *   newly-crossed threshold, or `null` if nothing changed (or too little is known yet).
   */
  function evaluate(players) {
    const nearest = nearestDistance(players);
    if (!nearest) return null;
    const isCatch = nearest.meters <= catchRangeMeters;
    const isProximity = nearest.meters <= proximityAlertMeters;

    let fired = null;
    if (isCatch && !wasCatch) fired = { level: 'catch', meters: nearest.meters, otherPub: nearest.otherPub };
    else if (!isCatch && isProximity && !wasProximity) fired = { level: 'proximity', meters: nearest.meters, otherPub: nearest.otherPub };

    wasCatch = isCatch;
    wasProximity = isProximity;
    return fired;
  }

  return { evaluate };
}
