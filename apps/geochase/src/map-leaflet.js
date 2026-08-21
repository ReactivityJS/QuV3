import * as L from 'leaflet';
import { injectStyle } from '@qu/ui';
import { LEAFLET_CSS } from './map-leaflet-css.js';
import { colorFor } from './map-canvas.js';

/**
 * REAL MAP — `mapMode: 'osm'`'s renderer: an actual interactive, pannable/
 * zoomable Leaflet map over real OpenStreetMap tiles, replacing this app's
 * earlier static `/export/embed.html` iframe (map-embed.js, now removed) -
 * that embed only ever supported ONE marker and couldn't draw the radius
 * circle on top of it at all (see this app's own git history for the
 * "I don't see the OpenStreetMap" bug report that iframe's degenerate
 * bounding box - `boundingBox([])` on an empty players list - produced on
 * first paint). Leaflet draws every player as a real, positioned marker AND
 * the chased player's speed-based radius as a real `L.circle` in actual
 * meters, both genuinely on the map, not layered awkwardly beside it.
 *
 * TILE SOURCE: still `tile.openstreetmap.org`, still subject to OSM's own
 * tile usage policy (operations.osmfoundation.org/policies/tiles/) - a
 * single self-hosted relay's own player base is exactly the "light,
 * personal use" case that policy is fine with; heavy/commercial traffic
 * would need a dedicated tile provider instead, a deployment-time decision
 * for whoever runs this relay, not something this app can decide for them.
 *
 * CSS: Leaflet's own stylesheet is required for correct rendering (pane
 * positioning, marker/tooltip layout, zoom control) - vendored verbatim as
 * a JS string (`map-leaflet-css.js`) and injected the same `@qu/ui`
 * `injectStyle()` way every other app's own CSS already is. NOT loaded via
 * a CDN `<link>` (this file's own git history's first attempt) - that
 * silently breaks the map's entire layout offline or on any network that
 * can't reach the CDN, confirmed live (see `map-leaflet-css.js`'s own doc
 * comment for the concrete repro) - unacceptable for an app whose other
 * half (WebRTC-as-app-feature) deliberately avoids exactly that kind of
 * external dependency.
 *
 * NOT TESTABLE IN THIS REPO'S jsdom-BASED TEST SUITE - confirmed live,
 * Leaflet's own vector-layer renderer throws in jsdom (no real layout
 * engine). `client.js`'s own call site wraps every use of this module in
 * try/catch for exactly that reason (and, incidentally, so a real browser
 * without WebGL/Canvas quirks never turns a map hiccup into a dead app
 * either) - see that file's own doc comment. Verified instead by manual/
 * `/run`-driven browser checks, same as `map-canvas.js`'s own pixel output.
 */

const CSS_ID = 'qu-geochase-leaflet-style';

const PLAYER_COLORS = { chased: '#e5484d', self: '#12a594', chaser: '#5b5bd6' };

/**
 * @param {HTMLElement} container - Gets Leaflet's own map DOM mounted directly into it.
 * @returns {{
 *   update: (state: {players: Array<{actorPub: string, position: {lat: number, lng: number}}>, chasedPub: string, selfPub: string, radiusMeters?: number, labelFor?: (actorPub: string) => string, trails?: Map<string, Array<{lat: number, lng: number}>>}) => void,
 *   centerOn: (target: 'chased'|'self') => void,
 *   destroy: () => void,
 * }}
 */
export function mountLeafletMap(container) {
  injectStyle(CSS_ID, LEAFLET_CSS);
  const map = L.map(container, { attributionControl: true });
  map.setView([0, 0], 2); // a sane default before any real position is known - update()'s own fitBounds() takes over the moment one arrives
  L.tileLayer(`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const markers = new Map(); // actorPub -> L.CircleMarker
  const trailLines = new Map(); // actorPub -> L.Polyline
  let radiusCircle = null;
  let hasFitOnce = false; // auto-center/zoom ONCE, on the first real position - never again, so it never yanks the view out from under someone who's since panned/zoomed to look at something specific (same "initial center, then hands-off" convention most map apps use)
  let lastChasedPub = null;
  let lastSelfPub = null;

  function update({ players, chasedPub, selfPub, radiusMeters = 0, labelFor = (pub) => pub.slice(0, 6), trails = new Map() }) {
    lastChasedPub = chasedPub;
    lastSelfPub = selfPub;
    const seen = new Set();
    for (const player of players) {
      seen.add(player.actorPub);
      const latlng = [player.position.lat, player.position.lng];
      const isChased = player.actorPub === chasedPub;
      const color = colorFor(player.actorPub, chasedPub, selfPub);
      let marker = markers.get(player.actorPub);
      if (!marker) {
        marker = L.circleMarker(latlng, { radius: isChased ? 9 : 7, color: '#ffffff', weight: 2, fillColor: color, fillOpacity: 1 })
          .bindTooltip(labelFor(player.actorPub), { permanent: true, direction: 'right', offset: [8, 0] })
          .addTo(map);
        markers.set(player.actorPub, marker);
      } else {
        marker.setLatLng(latlng);
        marker.setStyle({ fillColor: color });
      }
    }
    for (const [actorPub, marker] of markers) {
      if (seen.has(actorPub)) continue;
      marker.remove();
      markers.delete(actorPub);
    }

    // Trails - one faint polyline per player, same color as their marker.
    // `client.js` owns accumulating/capping the point history; this only
    // ever renders whatever it's handed.
    const seenTrails = new Set();
    for (const [actorPub, points] of trails) {
      if (points.length < 2) continue;
      seenTrails.add(actorPub);
      const latlngs = points.map((p) => [p.lat, p.lng]);
      let line = trailLines.get(actorPub);
      if (!line) {
        line = L.polyline(latlngs, { color: colorFor(actorPub, chasedPub, selfPub), weight: 3, opacity: 0.4 }).addTo(map);
        trailLines.set(actorPub, line);
      } else {
        line.setLatLngs(latlngs);
        line.setStyle({ color: colorFor(actorPub, chasedPub, selfPub) });
      }
    }
    for (const [actorPub, line] of trailLines) {
      if (seenTrails.has(actorPub)) continue;
      line.remove();
      trailLines.delete(actorPub);
    }

    const chased = players.find((p) => p.actorPub === chasedPub);
    if (chased && radiusMeters > 0) {
      const center = [chased.position.lat, chased.position.lng];
      if (!radiusCircle) {
        radiusCircle = L.circle(center, { radius: radiusMeters, color: PLAYER_COLORS.chased, weight: 2, dashArray: '6,4', fillOpacity: 0.08 }).addTo(map);
      } else {
        radiusCircle.setLatLng(center);
        radiusCircle.setRadius(radiusMeters);
      }
    } else if (radiusCircle) {
      radiusCircle.remove();
      radiusCircle = null;
    }

    if (!hasFitOnce && players.length > 0) {
      hasFitOnce = true;
      map.fitBounds(L.latLngBounds(players.map((p) => [p.position.lat, p.position.lng])).pad(0.3), { maxZoom: 17 });
    }
  }

  /**
   * A one-shot pan/zoom to `target`'s CURRENT known position (the last
   * `update()` call's own `players`/`chasedPub`/`selfPub`) - unlike
   * `hasFitOnce`'s automatic, only-ever-once fit above, this is an explicit
   * user action (client.js's own "center map" buttons) and can be invoked
   * repeatedly. A no-op if that target's position isn't known yet.
   * @param {'chased'|'self'} target
   */
  function centerOn(target) {
    const targetPub = target === 'self' ? lastSelfPub : lastChasedPub;
    const marker = targetPub ? markers.get(targetPub) : null;
    if (!marker) return;
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
  }

  function destroy() {
    map.remove();
  }

  return { update, centerOn, destroy };
}
