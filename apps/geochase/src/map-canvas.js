import { projectLocal, fitScaleMetersPerPixel } from './geometry.js';

/**
 * PLANE MAP — the abstract "everyone relative to the chased player" canvas
 * renderer (`mapMode: 'plane'`, see game-service.js's own `DEFAULT_SETTINGS`
 * doc comment). Centers on the chased player's own latest known position
 * (falling back to whichever player IS known, for a chaser-only view before
 * the chased has ever reported in), auto-zooms to fit every player plus the
 * radius circle, and draws each player as a colored dot (chased/self/other
 * distinguished by color) with their label.
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
 * }} options
 */
export function renderPlaneMap(canvas, { players, chasedPub, selfPub, radiusMeters = 0, labelFor = (pub) => pub.slice(0, 6) }) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const chased = players.find((p) => p.actorPub === chasedPub);
  const ref = (chased ?? players[0])?.position;
  if (!ref) return; // nothing known yet - an empty canvas is the correct state

  const offsets = players.map((p) => ({ ...projectLocal(p.position, ref), player: p }));
  const radiusExtent = radiusMeters > 0
    ? [{ xMeters: radiusMeters, yMeters: 0 }, { xMeters: -radiusMeters, yMeters: 0 }, { xMeters: 0, yMeters: radiusMeters }, { xMeters: 0, yMeters: -radiusMeters }]
    : [];
  const scale = fitScaleMetersPerPixel([...offsets, ...radiusExtent], Math.min(w, h));
  const toPx = (m) => ({ x: w / 2 + m.xMeters / scale, y: h / 2 + m.yMeters / scale });

  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(0, 0, w, h);

  if (radiusMeters > 0) {
    const center = toPx({ xMeters: 0, yMeters: 0 });
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, radiusMeters / scale, 0, Math.PI * 2);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#e5484d';
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#e5484d';
    ctx.globalAlpha = 0.08;
    ctx.fill();
    ctx.restore();
  }

  for (const { xMeters, yMeters, player } of offsets) {
    const { x, y } = toPx({ xMeters, yMeters });
    const isChased = player.actorPub === chasedPub;
    const isSelf = player.actorPub === selfPub;
    ctx.beginPath();
    ctx.arc(x, y, isChased ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = isChased ? '#e5484d' : (isSelf ? '#12a594' : '#5b5bd6');
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#111111';
    ctx.font = '11px sans-serif';
    ctx.fillText(labelFor(player.actorPub), x + 10, y + 4);
  }
}
