import { projectLocal, fitScaleMetersPerPixel } from './geometry.js';

/** Shared chased/self/chaser color scheme - kept here so both renderers, the live player list, and the legend all agree on one palette (`client.js`/`map-leaflet.js` reuse these directly, not a re-declared copy). */
export const PLAYER_COLORS = { chased: '#e5484d', self: '#12a594', chaser: '#5b5bd6' };

/** @param {string} actorPub @param {string} chasedPub @param {string} selfPub @returns {string} */
export function colorFor(actorPub, chasedPub, selfPub) {
  return actorPub === chasedPub ? PLAYER_COLORS.chased : (actorPub === selfPub ? PLAYER_COLORS.self : PLAYER_COLORS.chaser);
}

/**
 * PLANE MAP — the abstract "everyone relative to a chosen reference player"
 * canvas renderer (`mapMode: 'plane'`, see game-service.js's own
 * `DEFAULT_SETTINGS` doc comment). Centers on `centerOn`'s own latest known
 * position (falling back to whichever player IS known, for a view before
 * that specific target has ever reported in), auto-zooms to fit every
 * player, the radius circle(s), and any track history, and draws each
 * player as a colored dot (chased/self/other distinguished by color, see
 * `PLAYER_COLORS` above) with their label.
 *
 * jsdom (this repo's test DOM) has no real Canvas 2D implementation -
 * `canvas.getContext('2d')` returns `null` there, so this bails out (a
 * no-op, not a throw) whenever that happens - tests can still mount a page
 * containing this canvas and assert on everything AROUND it (the player
 * list, settings form, ...) without needing a real canvas backend. The
 * actual pixel output is exercised via `/run`-driven manual verification,
 * same as every other canvas consumer in this codebase (see
 * apps/chat/client.js's own emoji-picker canvas).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{
 *   players: Array<{actorPub: string, position: {lat: number, lng: number}}>,
 *   chasedPub: string,
 *   selfPub: string,
 *   radiusMeters?: number,
 *   labelFor?: (actorPub: string) => string,
 *   centerOn?: 'chased'|'self',
 *   extraCircles?: Array<{radiusMeters: number, color: string}>,
 *   tracks?: Map<string, Array<{lat: number, lng: number}>>,
 * }} options - `extraCircles` (req. 8) draws additional dashed rings around
 *   the chased player (e.g. the proximity-alert/catch-range thresholds),
 *   alongside the existing speed-based "possible radius" one. `tracks`
 *   (req. 5/6) draws each player's own persisted route history
 *   (`track-service.js`'s `listTrackPoints()`) as a faint trailing line.
 */
export function renderPlaneMap(canvas, { players, chasedPub, selfPub, radiusMeters = 0, labelFor = (pub) => pub.slice(0, 6), centerOn = 'chased', extraCircles = [], tracks = null }) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // `centerOn` picks WHICH player's position anchors the whole relative view
  // (see client.js's own "center map" controls) - falls back to whichever
  // player IS known if the requested target hasn't reported in yet, same
  // "never just show a blank canvas" reasoning the original chased-only
  // fallback already had.
  const targetPub = centerOn === 'self' ? selfPub : chasedPub;
  const target = players.find((p) => p.actorPub === targetPub);
  const ref = (target ?? players[0])?.position;
  if (!ref) return; // nothing known yet - an empty canvas is the correct state

  const offsets = players.map((p) => ({ ...projectLocal(p.position, ref), player: p }));
  const allRadii = [radiusMeters, ...extraCircles.map((c) => c.radiusMeters)].filter((r) => r > 0);
  const maxRadius = allRadii.length ? Math.max(...allRadii) : 0;
  const radiusExtent = maxRadius > 0
    ? [{ xMeters: maxRadius, yMeters: 0 }, { xMeters: -maxRadius, yMeters: 0 }, { xMeters: 0, yMeters: maxRadius }, { xMeters: 0, yMeters: -maxRadius }]
    : [];
  const trackOffsets = tracks
    ? [...tracks.values()].flat().map((pt) => projectLocal(pt, ref))
    : [];
  const scale = fitScaleMetersPerPixel([...offsets, ...radiusExtent, ...trackOffsets], Math.min(w, h));
  const toPx = (m) => ({ x: w / 2 + m.xMeters / scale, y: h / 2 + m.yMeters / scale });

  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(0, 0, w, h);

  if (tracks) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 3]);
    ctx.globalAlpha = 0.45;
    for (const [actorPub, points] of tracks) {
      if (points.length < 2) continue;
      ctx.strokeStyle = colorFor(actorPub, chasedPub, selfPub);
      ctx.beginPath();
      points.forEach((pt, i) => {
        const { x, y } = toPx(projectLocal(pt, ref));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  const circles = [...extraCircles, ...(radiusMeters > 0 ? [{ radiusMeters, color: PLAYER_COLORS.chased }] : [])];
  for (const circle of circles) {
    if (!(circle.radiusMeters > 0)) continue;
    const center = toPx({ xMeters: 0, yMeters: 0 });
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, circle.radiusMeters / scale, 0, Math.PI * 2);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = circle.color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = circle.color;
    ctx.globalAlpha = 0.08;
    ctx.fill();
    ctx.restore();
  }

  for (const { xMeters, yMeters, player } of offsets) {
    const { x, y } = toPx({ xMeters, yMeters });
    const isChased = player.actorPub === chasedPub;
    ctx.beginPath();
    ctx.arc(x, y, isChased ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = colorFor(player.actorPub, chasedPub, selfPub);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#111111';
    ctx.font = '11px sans-serif';
    ctx.fillText(labelFor(player.actorPub), x + 10, y + 4);
  }
}
