/**
 * GEO CHASE — the pilot app validating the WebRTC-as-app-feature foundation
 * end to end (see `src/mesh.js`'s own top doc comment for the architecture).
 * Deliberately minimal UI: a share/stop toggle (drives
 * `src/location.js`'s `startLocationSharing()`), a "connect to player"
 * input (there is no invite/discovery UI here - a real game would grow one,
 * this pilot's job is to prove the mesh/signaling/state-replication
 * foundation works, not to be a polished game), and a live player list
 * (`mesh.watchPlayers()`).
 *
 * Routes: `#/geochase` (game id `default`), `#/geochase/<gameId>` (a named
 * game - anyone entering the same gameId + connecting to each other's
 * pubkey joins the same mesh).
 */
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderSubpage } from '@qu/ui';
import { createGeochaseMesh } from './src/mesh.js';
import { startLocationSharing } from './src/location.js';

const DICT = {
  en: {
    title: 'Geo Chase',
    start: 'Start sharing my location',
    stop: 'Stop sharing',
    connectTo: 'Connect to player (pubkey)',
    connect: 'Connect',
    players: 'Players',
    noPlayers: 'No players yet - share this game and connect to someone.',
    you: 'you',
  },
  de: {
    title: 'Geo Chase',
    start: 'Standort teilen starten',
    stop: 'Teilen stoppen',
    connectTo: 'Mit Spieler verbinden (Pubkey)',
    connect: 'Verbinden',
    players: 'Spieler',
    noPlayers: 'Noch keine Spieler - Spiel teilen und mit jemandem verbinden.',
    you: 'du',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-geochase-style';
const STYLE = `
  .qu-geochase-controls { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; }
  .qu-geochase-connect { display: flex; gap: 0.4rem; }
  .qu-geochase-connect input { flex: 1; padding: 0.4rem; font: inherit; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); box-sizing: border-box; }
  .qu-geochase-btn { padding: 0.45rem 0.9rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: none; cursor: pointer; font: inherit; align-self: flex-start; }
  .qu-geochase-btn[data-active="true"] { border: none; background: var(--qu-color-accent, #5b5bd6); color: #fff; }
  .qu-geochase-players { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-geochase-players li { padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); font-variant-numeric: tabular-nums; }
  .qu-geochase-empty { opacity: 0.7; }
`;

const DEFAULT_GAME_ID = 'default';
const THREAD_ID = 'lobby';

export function mount(container, ctx) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  const { qu, identity, services, apps, segments = [], iceServers, subscribe, syncFetch } = ctx;
  const SPACE_ID = apps?.find((a) => a.name === 'geochase')?.spaceId;
  if (!SPACE_ID) throw new Error('[geochase] no "spaceId" found in the apps catalog for "geochase" - check manifest.quapp');
  const gameId = segments[1] || DEFAULT_GAME_ID;

  let stopped = false;
  let mesh = null;
  let stopLocation = null;
  let stopWatch = null;
  const knownMembers = new Set();

  renderSubpage(container, {
    showBackLink: false,
    render: (content) => {
      const h1 = document.createElement('h1');
      h1.textContent = `${t('title')} — ${gameId}`;

      const controls = document.createElement('div');
      controls.className = 'qu-geochase-controls';

      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'qu-geochase-btn';
      shareBtn.textContent = t('start');
      shareBtn.disabled = true;

      const connectRow = document.createElement('div');
      connectRow.className = 'qu-geochase-connect';
      const connectInput = document.createElement('input');
      connectInput.type = 'text';
      connectInput.placeholder = t('connectTo');
      const connectBtn = document.createElement('button');
      connectBtn.type = 'button';
      connectBtn.className = 'qu-geochase-btn';
      connectBtn.textContent = t('connect');
      connectRow.append(connectInput, connectBtn);

      controls.append(shareBtn, connectRow);

      const playersHeading = document.createElement('h2');
      playersHeading.textContent = t('players');
      const playersList = document.createElement('ul');
      playersList.className = 'qu-geochase-players';

      content.append(h1, controls, playersHeading, playersList);

      function renderPlayers(players) {
        playersList.textContent = '';
        if (players.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'qu-geochase-empty';
          empty.textContent = t('noPlayers');
          playersList.appendChild(empty);
          return;
        }
        for (const { actorPub, position } of players) {
          const li = document.createElement('li');
          const who = actorPub === mesh?.selfPub ? `${t('you')} (${actorPub.slice(0, 8)}…)` : `${actorPub.slice(0, 8)}…`;
          li.textContent = `${who}: ${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
          playersList.appendChild(li);
        }
      }

      shareBtn.addEventListener('click', () => {
        if (stopLocation) {
          stopLocation();
          stopLocation = null;
          shareBtn.textContent = t('start');
          shareBtn.dataset.active = 'false';
        } else if (mesh) {
          stopLocation = startLocationSharing(mesh);
          shareBtn.textContent = t('stop');
          shareBtn.dataset.active = 'true';
        }
      });

      connectBtn.addEventListener('click', () => {
        const remotePub = connectInput.value.trim();
        if (!remotePub || !mesh) return;
        knownMembers.add(remotePub);
        mesh.connectToPeer(remotePub, [...knownMembers]).catch((err) => console.error('[geochase] connectToPeer() failed:', err));
        connectInput.value = '';
      });

      (async () => {
        const readyMesh = await createGeochaseMesh({ qu, identity, services, spaceId: SPACE_ID, threadId: THREAD_ID, gameId, iceServers, subscribe, syncFetch });
        if (stopped) {
          readyMesh.close();
          return;
        }
        mesh = readyMesh;
        knownMembers.add(mesh.selfPub);
        shareBtn.disabled = false;
        stopWatch = mesh.watchPlayers(renderPlayers);
      })();
    },
  });

  return () => {
    stopped = true;
    stopLocation?.();
    stopWatch?.();
    mesh?.close();
  };
}
