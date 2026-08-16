/**
 * GEO CHASE — a chased player starts a game, invites chasers (by alias from
 * their own Contacts - `@qu/ui`'s `mountActorPicker()`, the same widget
 * apps/todo's/apps/calendar's own share pages use), and both sides' live
 * positions render on a map once the game is active, with the chased
 * player's own speed-based "could be anywhere in here" radius circle drawn
 * around them.
 *
 * ARCHITECTURE — three independently testable layers (see each module's
 * own top doc comment):
 *   - `src/game-service.js` - game lifecycle/roles/invites/settings, on the
 *     RELAY-backed `qu`/`services` (a Thread's own meta document, reusing
 *     `services.sharing`'s existing "starred private list" +
 *     `discoverPendingInvites()` machinery unchanged).
 *   - `src/mesh.js` - this app's own pre-existing WebRTC-mesh pilot
 *     (unchanged): live positions ride a SEPARATE, ephemeral p2p `QuStore`,
 *     never the relay - see that file's own doc comment for why. Reused
 *     here as-is, just pointed at the game's own thread id for signaling
 *     (safe - see `setupLiveMesh()`'s own doc comment) instead of the
 *     pilot's hardcoded 'lobby'.
 *   - `src/geometry.js`/`src/map-canvas.js`/`src/map-leaflet.js` - pure math
 *     + an abstract canvas renderer (`mapMode: 'plane'`) + a real
 *     interactive Leaflet/OpenStreetMap-tiles map (`mapMode: 'osm'`).
 *
 * ROUTES: `#/geochase` (my games - chased or invited-as-chaser), `#/geochase/new`
 * (creates a fresh game, redirects straight into it - no form, see
 * `renderHeaderNavPoints()`'s own doc comment for why), `#/geochase/<gameId>`
 * (the game itself - role- and status-aware, see `renderGameView()`).
 */
import { createI18n } from '@qu/i18n';
import { watch } from '@qu/reactive';
import { paths, matchesActorQuery, formatActorLabel } from '@qu/services';
import { injectStyle, ensureTheme, renderSubpage, mountAppHeaderAction, renderNavPointsMenu, mountActorPicker, mountWakeLock } from '@qu/ui';
import { copyToClipboard } from '@qu/thread-ui';
import { createGeochaseMesh } from './src/mesh.js';
import { startLocationSharing } from './src/location.js';
import {
  createGame, readGame, inviteChaser, updateGame, listMyGames, discoverInvites, gameThreadId,
} from './src/game-service.js';
import { possibleRadiusMeters, haversineMeters, bearingDegrees } from './src/geometry.js';
import { renderPlaneMap } from './src/map-canvas.js';
import { mountLeafletMap } from './src/map-leaflet.js';

const DICT = {
  en: {
    title: 'Geo Chase',
    startGame: 'Start a game',
    myGames: 'My games',
    noGames: 'No games yet - start one, or wait for an invite.',
    chasedBadge: 'Chased', chaserBadge: 'Chaser',
    status_pending: 'Pending', status_active: 'Active', status_ended: 'Ended',
    invalidLink: 'This game link is invalid, or the game isn’t reachable right now.',
    noAccessTitle: 'No access', noAccessBody: 'You don’t have access to this game.',
    copyLink: 'Copy link', linkCopied: 'Link copied',
    settingsHeading: 'Settings', chasedInterval: 'Chased update interval (min)', chaserInterval: 'Chaser update interval (min)',
    mapMode: 'Map style', mapModePlane: 'Abstract (plane)', mapModeOsm: 'Abstract + OpenStreetMap',
    showRadius: 'Show the chased player’s possible-radius circle',
    saveSettings: 'Save settings',
    people: 'People', invite: 'Invite a chaser', invitePlaceholder: 'Search your contacts…', noMatches: 'No matching contacts.',
    inviteFailed: 'Could not invite {name}: {message}',
    startGameBtn: 'Start the chase', endGameBtn: 'End the game',
    waitingForStart: 'Waiting for the chased player to start the game…',
    waitingAsChased: 'Invite chasers, tune the settings below, then start the chase when you’re ready.',
    participants: 'Participants',
    you: 'you', unknownPerson: '~{pub}…',
    noPositionYet: 'no position yet', distanceAway: '{distance} away, {bearing}',
    gameEnded: 'This game has ended.',
    m: 'm', km: 'km',
  },
  de: {
    title: 'Geo Chase',
    startGame: 'Spiel starten',
    myGames: 'Meine Spiele',
    noGames: 'Noch keine Spiele — eines starten oder auf eine Einladung warten.',
    chasedBadge: 'Gejagter', chaserBadge: 'Fänger',
    status_pending: 'Ausstehend', status_active: 'Aktiv', status_ended: 'Beendet',
    invalidLink: 'Dieser Spiellink ist ungültig oder das Spiel ist gerade nicht erreichbar.',
    noAccessTitle: 'Kein Zugriff', noAccessBody: 'Du hast keinen Zugriff auf dieses Spiel.',
    copyLink: 'Link kopieren', linkCopied: 'Link kopiert',
    settingsHeading: 'Einstellungen', chasedInterval: 'Update-Intervall Gejagter (min)', chaserInterval: 'Update-Intervall Fänger (min)',
    mapMode: 'Kartenstil', mapModePlane: 'Abstrakt (Ebene)', mapModeOsm: 'Abstrakt + OpenStreetMap',
    showRadius: 'Möglichen Radius des Gejagten anzeigen',
    saveSettings: 'Einstellungen speichern',
    people: 'Personen', invite: 'Fänger einladen', invitePlaceholder: 'Kontakte durchsuchen…', noMatches: 'Keine passenden Kontakte.',
    inviteFailed: '{name} konnte nicht eingeladen werden: {message}',
    startGameBtn: 'Jagd starten', endGameBtn: 'Spiel beenden',
    waitingForStart: 'Warte, bis der Gejagte das Spiel startet…',
    waitingAsChased: 'Lade Fänger ein, passe unten die Einstellungen an und starte die Jagd, wenn du bereit bist.',
    participants: 'Teilnehmer',
    you: 'du', unknownPerson: '~{pub}…',
    noPositionYet: 'noch keine Position', distanceAway: '{distance} entfernt, {bearing}',
    gameEnded: 'Dieses Spiel ist beendet.',
    m: 'm', km: 'km',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-geochase-style';
const STYLE = `
  .qu-geochase-page { max-width: 40rem; padding-bottom: 3rem; }
  .qu-geochase-empty { opacity: 0.7; }
  .qu-geochase-games { list-style: none; margin: 0 0 1rem; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-geochase-games li { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-geochase-row-title { flex: 1; text-decoration: none; color: inherit; }
  .qu-geochase-badge { font-size: 0.75em; opacity: 0.75; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; padding: 0.1rem 0.55rem; }
  .qu-geochase-badge-chased { color: #e5484d; border-color: #e5484d; }
  .qu-geochase-badge-chaser { color: #5b5bd6; border-color: #5b5bd6; }
  .qu-geochase-actions { display: flex; gap: 0.6rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .qu-geochase-actions a, .qu-geochase-actions button { padding: 0.4rem 0.8rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: none; cursor: pointer; font: inherit; text-decoration: none; color: inherit; }
  .qu-geochase-btn-primary { border: none !important; background: var(--qu-color-accent, #5b5bd6) !important; color: #fff !important; }
  .qu-geochase-form { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; max-width: 24rem; }
  .qu-geochase-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9em; }
  .qu-geochase-form input, .qu-geochase-form select { padding: 0.45rem; font: inherit; box-sizing: border-box; border-radius: var(--qu-radius-sm, 0.3rem); border: 1px solid var(--qu-color-border, #8884); }
  .qu-geochase-form-checkbox { flex-direction: row !important; align-items: center; gap: 0.5rem !important; }
  .qu-geochase-map-canvas { width: 100%; max-width: 32rem; height: 20rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); display: block; }
  .qu-geochase-leaflet-map { width: 100%; max-width: 32rem; height: 20rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); margin-bottom: 0.6rem; }
  .qu-geochase-players { list-style: none; margin: 0.6rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-geochase-players li { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-geochase-player-name { flex: 1; }
  .qu-geochase-player-meta { font-size: 0.8em; opacity: 0.7; white-space: nowrap; }
  .qu-geochase-copy-link { background: none; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.4rem 0.8rem; cursor: pointer; font: inherit; color: inherit; }
  .qu-geochase-status { font-size: 0.85em; opacity: 0.75; min-height: 1.2em; }
`;

function gameHash(gameId) { return `#/geochase/${gameId}`; }
function absoluteHash(hash) { return new URL(hash, window.location.href).href; }
function shortPerson(actorPub, profile) { return formatActorLabel(actorPub, profile) || t('unknownPerson', { pub: actorPub.slice(0, 10) }); }
function formatDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}${t('km')}` : `${Math.round(meters)}${t('m')}`;
}
const BEARING_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearingLabel(deg) { return BEARING_LABELS[Math.round(deg / 45) % 8]; }

// ===========================================================================
// Header nav points - "Start a game" (see docs/app-navigation-standard.md
// Rule 2). Routes to #/geochase/new, which creates the game itself and
// redirects - unlike Forum's/ToDo's own "new X" pages, starting a game
// needs no upfront input (settings/invites happen on the pending game's own
// page afterward), so a plain link straight into that flow is simpler than
// a form page that would just have a single "Create" button on it.
// ===========================================================================
export function renderHeaderNavPoints(container, { getContext, onContextChange }) {
  mountAppHeaderAction(container, {
    appId: 'geochase', getContext, onContextChange,
    render: (wrap) => {
      renderNavPointsMenu(wrap, { items: [{ label: t('startGame'), href: '#/geochase/new' }] });
      return () => {};
    },
  });
}

// ===========================================================================
// mount()
// ===========================================================================
export function mount(container, ctx) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  const { qu, identity, services, apps, segments = [], iceServers, subscribe, syncFetch } = ctx;
  const SPACE_ID = apps?.find((a) => a.name === 'geochase')?.spaceId;
  if (!SPACE_ID) throw new Error('[geochase] no "spaceId" found in the apps catalog for "geochase" - check manifest.quapp');

  const seg1 = segments[1] ?? null; // gameId | 'new' | null

  let stopped = false;
  let myPub = null;
  let unwatches = [];
  let pickerCleanups = [];
  let mesh = null;
  let stopLocation = null;
  let stopWatchPlayers = null;
  let meshStarted = false; // guards setupLiveMesh() against re-running on every meta-triggered re-render
  let releaseWakeLock = null; // see setupLiveMesh()'s own doc comment - held for as long as a game is actively being tracked
  let leafletMap = null; // mapMode: 'osm' only - see updateLiveView()'s own doc comment
  let leafletMapContainer = null;

  function clearWatches() {
    for (const u of unwatches) u();
    unwatches = [];
    for (const c of pickerCleanups) c();
    pickerCleanups = [];
  }

  (async () => {
    myPub = await services.actors.whoAmI();
    if (stopped) return;
    if (seg1 === 'new') { await createAndRedirect(); return; }
    if (!seg1) { await renderGameListPage(); return; }
    await renderGameView(seg1);
  })();

  async function createAndRedirect() {
    const gameId = crypto.randomUUID();
    await createGame(services, SPACE_ID, gameId);
    if (stopped) return;
    window.location.hash = gameHash(gameId);
  }

  // ---------------------------------------------------------------------
  // Game list - #/geochase
  // ---------------------------------------------------------------------
  async function renderGameListPage() {
    if (stopped) return;
    subscribe?.(paths.spacePath(SPACE_ID));
    await discoverInvites(services, SPACE_ID);
    if (stopped) return;
    const mine = await listMyGames(services);
    if (stopped) return;

    const infos = [];
    for (const g of mine) {
      const meta = await readGame(services, SPACE_ID, g.id);
      if (meta) infos.push({ id: g.id, meta });
    }
    if (stopped) return;

    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-geochase-page';
        const h1 = document.createElement('h1');
        h1.textContent = t('title');
        page.appendChild(h1);

        const actions = document.createElement('div');
        actions.className = 'qu-geochase-actions';
        const startLink = document.createElement('a');
        startLink.className = 'qu-geochase-btn-primary';
        startLink.href = '#/geochase/new';
        startLink.textContent = t('startGame');
        actions.appendChild(startLink);
        page.appendChild(actions);

        if (infos.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'qu-geochase-empty';
          empty.textContent = t('noGames');
          page.appendChild(empty);
        } else {
          const h2 = document.createElement('h2');
          h2.textContent = t('myGames');
          page.appendChild(h2);
          const ul = document.createElement('ul');
          ul.className = 'qu-geochase-games';
          for (const info of infos) {
            const isChased = info.meta.chasedPub === myPub;
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.className = 'qu-geochase-row-title';
            a.href = gameHash(info.id);
            a.textContent = `${t('title')} — ${t(`status_${info.meta.status}`)}`;
            li.appendChild(a);
            const roleBadge = document.createElement('span');
            roleBadge.className = isChased ? 'qu-geochase-badge qu-geochase-badge-chased' : 'qu-geochase-badge qu-geochase-badge-chaser';
            roleBadge.textContent = isChased ? t('chasedBadge') : t('chaserBadge');
            li.appendChild(roleBadge);
            ul.appendChild(li);
          }
          page.appendChild(ul);
        }
        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // Game view - #/geochase/<gameId>
  // ---------------------------------------------------------------------
  async function renderGameView(gameId) {
    if (stopped) return;
    clearWatches();
    subscribe?.(paths.spacePath(SPACE_ID));
    unwatches.push(watch(qu, paths.threadMetaPath(SPACE_ID, gameThreadId(gameId)), () => renderGameView(gameId), { initial: false, syncFetch }));

    const meta = await readGame(services, SPACE_ID, gameId);
    if (stopped) return;
    if (!meta) {
      container.textContent = '';
      const p = document.createElement('p');
      p.textContent = t('invalidLink');
      container.appendChild(p);
      return;
    }
    await services.sharing.starIfMember('geochase', 'game', gameId, meta); // no-op once already starred - handles a fresh invite click-through, same as apps/todo's own renderListPage()

    const role = services.sharing.roleOf(meta, myPub);
    if (!role) {
      container.textContent = '';
      const wrap = document.createElement('div');
      const h = document.createElement('h1');
      h.textContent = t('noAccessTitle');
      const p = document.createElement('p');
      p.textContent = t('noAccessBody');
      wrap.append(h, p);
      container.appendChild(wrap);
      return;
    }
    const isChased = role === 'chased';

    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-geochase-page';

        const h1 = document.createElement('h1');
        h1.textContent = `${t('title')} — ${t(`status_${meta.status}`)}`;
        page.appendChild(h1);

        const roleBadge = document.createElement('span');
        roleBadge.className = isChased ? 'qu-geochase-badge qu-geochase-badge-chased' : 'qu-geochase-badge qu-geochase-badge-chaser';
        roleBadge.textContent = isChased ? t('chasedBadge') : t('chaserBadge');
        page.appendChild(roleBadge);

        const actions = document.createElement('div');
        actions.className = 'qu-geochase-actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'qu-geochase-copy-link';
        const copyDefault = `🔗 ${t('copyLink')}`;
        copyBtn.textContent = copyDefault;
        copyBtn.addEventListener('click', async () => {
          await copyToClipboard(absoluteHash(gameHash(gameId)));
          copyBtn.textContent = `✓ ${t('linkCopied')}`;
          setTimeout(() => { copyBtn.textContent = copyDefault; }, 1500);
        });
        actions.appendChild(copyBtn);
        page.appendChild(actions);

        if (meta.status === 'pending') {
          const info = document.createElement('p');
          info.textContent = isChased ? t('waitingAsChased') : t('waitingForStart');
          page.appendChild(info);

          if (isChased) {
            page.appendChild(buildSettingsForm(gameId, meta));
            page.appendChild(buildInvitePanel(gameId, meta));

            const startBtn = document.createElement('button');
            startBtn.type = 'button';
            startBtn.className = 'qu-geochase-btn-primary';
            startBtn.textContent = t('startGameBtn');
            startBtn.addEventListener('click', async () => {
              startBtn.disabled = true;
              await updateGame(qu, identity, services, SPACE_ID, gameId, { status: 'active' });
            });
            page.appendChild(startBtn);
          }

          const h3 = document.createElement('h3');
          h3.textContent = t('participants');
          page.appendChild(h3);
          page.appendChild(buildParticipantList(meta));
        } else {
          if (meta.status === 'ended') {
            const p = document.createElement('p');
            p.textContent = t('gameEnded');
            page.appendChild(p);
          }

          if (meta.settings.mapMode === 'osm') {
            // A real Leaflet map, mounted/updated by setupLiveMesh()'s own
            // updateLiveView() the moment at least one position is known -
            // see that function's own doc comment for why the map INSTANCE
            // (not just its markers) is recreated whenever this container
            // itself is (a meta-triggered renderGameView() rebuild).
            const mapContainer = document.createElement('div');
            mapContainer.className = 'qu-geochase-leaflet-map';
            page.appendChild(mapContainer);
          } else {
            const canvas = document.createElement('canvas');
            canvas.className = 'qu-geochase-map-canvas';
            canvas.width = 640;
            canvas.height = 400;
            page.appendChild(canvas);
          }

          const playersList = document.createElement('ul');
          playersList.className = 'qu-geochase-players';
          page.appendChild(playersList);

          if (isChased && meta.status === 'active') {
            const endBtn = document.createElement('button');
            endBtn.type = 'button';
            endBtn.textContent = t('endGameBtn');
            endBtn.addEventListener('click', async () => {
              endBtn.disabled = true;
              await updateGame(qu, identity, services, SPACE_ID, gameId, { status: 'ended' });
            });
            page.appendChild(endBtn);
          }
        }

        content.appendChild(page);
      },
    });

    if (meta.status === 'active' && !meshStarted) {
      meshStarted = true;
      setupLiveMesh(gameId, meta, isChased);
    }
  }

  /**
   * Builds the game's own live mesh + location sharing exactly ONCE per
   * mount (guarded by `meshStarted` in the caller) - `renderGameView()`
   * re-runs on every meta change (an invite, a setting, status itself), but
   * a live WebRTC mesh/geolocation watch must NOT be torn down and rebuilt
   * on each of those, only ever started once the game is first seen active
   * and kept running until this app unmounts (or the game ends - see the
   * status watch below). `updateLiveView()` queries the CURRENT map
   * canvas/player-list DOM fresh on every position tick instead of holding
   * a stale reference across `renderGameView()`'s own DOM rebuilds.
   *
   * Also where the Wake Lock (`@qu/ui`'s `mountWakeLock()`) gets acquired -
   * a chase is worthless if the phone's screen locks mid-run (geolocation
   * watches and the WebRTC mesh both keep running in the background for a
   * while on most platforms, but the live map/radius circle a chaser
   * actually needs to LOOK AT obviously can't render on a locked screen).
   * Held for as long as this mount's own live view is - released in the
   * mount's own teardown (`return () => {...}` below), never per-render.
   */
  async function setupLiveMesh(gameId, meta, isChased) {
    releaseWakeLock = mountWakeLock();
    const readyMesh = await createGeochaseMesh({
      qu, identity, services, spaceId: SPACE_ID, threadId: gameThreadId(gameId), gameId, iceServers, subscribe, syncFetch,
    });
    if (stopped) { readyMesh.close(); return; }
    mesh = readyMesh;

    const memberPubs = meta.members.map((m) => m.actorPub);
    for (const pub of memberPubs) {
      if (pub === myPub) continue;
      mesh.connectToPeer(pub, memberPubs).catch((err) => console.error('[geochase] connectToPeer() failed:', err));
    }

    const intervalMs = isChased ? meta.settings.chasedIntervalMs : meta.settings.chaserIntervalMs;
    stopLocation = startLocationSharing(mesh, { minIntervalMs: intervalMs });

    function updateLiveView(players) {
      if (stopped) return;
      const canvas = container.querySelector('.qu-geochase-map-canvas');
      const leafletContainer = container.querySelector('.qu-geochase-leaflet-map');
      const playersList = container.querySelector('.qu-geochase-players');
      if (!canvas && !leafletContainer && !playersList) return; // navigated away from the live view

      const chasedPlayer = players.find((p) => p.actorPub === meta.chasedPub);
      const radiusMeters = meta.settings.showRadius && chasedPlayer
        ? possibleRadiusMeters({
            speedMps: chasedPlayer.position.speed,
            elapsedMs: Date.now() - chasedPlayer.position.ts,
            minSpeedMps: meta.settings.assumedMinSpeedMps,
          })
        : 0;
      const labelFor = (pub) => (pub === myPub ? t('you') : pub.slice(0, 6));

      if (canvas) {
        renderPlaneMap(canvas, { players, chasedPub: meta.chasedPub, selfPub: myPub, radiusMeters, labelFor });
      }
      if (leafletContainer) {
        // renderGameView() rebuilding the page (a meta change) replaces this
        // container element - detected here by identity, not just presence,
        // so a stale Leaflet instance bound to a now-detached container gets
        // torn down and a fresh one mounted, rather than silently doing
        // nothing (or throwing) against DOM that's no longer on screen.
        if (leafletMapContainer !== leafletContainer) {
          leafletMap?.destroy();
          leafletMapContainer = leafletContainer;
          try {
            leafletMap = mountLeafletMap(leafletContainer);
          } catch (err) {
            console.error('[geochase] mountLeafletMap() failed:', err);
            leafletMap = null;
          }
        }
        try {
          leafletMap?.update({ players, chasedPub: meta.chasedPub, selfPub: myPub, radiusMeters, labelFor });
        } catch (err) {
          console.error('[geochase] Leaflet map update() failed:', err);
        }
      } else if (leafletMap) {
        // Switched to 'plane' mode, or navigated away - nothing left to update.
        leafletMap.destroy();
        leafletMap = null;
        leafletMapContainer = null;
      }

      if (playersList) {
        playersList.textContent = '';
        for (const member of meta.members) {
          const player = players.find((p) => p.actorPub === member.actorPub);
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.className = 'qu-geochase-player-name';
          const roleLabel = member.role === 'chased' ? t('chasedBadge') : t('chaserBadge');
          name.textContent = member.actorPub === myPub ? `${t('you')} (${roleLabel})` : `${member.actorPub.slice(0, 8)}… (${roleLabel})`;
          li.appendChild(name);

          const metaEl = document.createElement('span');
          metaEl.className = 'qu-geochase-player-meta';
          if (!player) {
            metaEl.textContent = t('noPositionYet');
          } else if (member.actorPub !== myPub) {
            const self = players.find((p) => p.actorPub === myPub);
            if (self) {
              const distance = haversineMeters(self.position, player.position);
              const bearing = bearingDegrees(self.position, player.position);
              metaEl.textContent = t('distanceAway', { distance: formatDistance(distance), bearing: bearingLabel(bearing) });
            }
          }
          li.appendChild(metaEl);
          playersList.appendChild(li);
        }
      }
    }

    stopWatchPlayers = mesh.watchPlayers(updateLiveView);
    updateLiveView(await mesh.listPlayers());
  }

  // ---------------------------------------------------------------------
  // Settings form (chased-only, pending-only)
  // ---------------------------------------------------------------------
  function buildSettingsForm(gameId, meta) {
    const form = document.createElement('form');
    form.className = 'qu-geochase-form';
    const h3 = document.createElement('h3');
    h3.textContent = t('settingsHeading');
    form.appendChild(h3);

    const chasedIntervalInput = document.createElement('input');
    chasedIntervalInput.type = 'number';
    chasedIntervalInput.min = '0.5';
    chasedIntervalInput.step = '0.5';
    chasedIntervalInput.value = String(meta.settings.chasedIntervalMs / 60_000);
    const chasedIntervalLabel = document.createElement('label');
    chasedIntervalLabel.append(t('chasedInterval'), chasedIntervalInput);

    const chaserIntervalInput = document.createElement('input');
    chaserIntervalInput.type = 'number';
    chaserIntervalInput.min = '0.5';
    chaserIntervalInput.step = '0.5';
    chaserIntervalInput.value = String(meta.settings.chaserIntervalMs / 60_000);
    const chaserIntervalLabel = document.createElement('label');
    chaserIntervalLabel.append(t('chaserInterval'), chaserIntervalInput);

    const mapModeSelect = document.createElement('select');
    for (const [value, label] of [['plane', t('mapModePlane')], ['osm', t('mapModeOsm')]]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = value === meta.settings.mapMode;
      mapModeSelect.appendChild(opt);
    }
    const mapModeLabel = document.createElement('label');
    mapModeLabel.append(t('mapMode'), mapModeSelect);

    const showRadiusInput = document.createElement('input');
    showRadiusInput.type = 'checkbox';
    showRadiusInput.checked = meta.settings.showRadius;
    const showRadiusLabel = document.createElement('label');
    showRadiusLabel.className = 'qu-geochase-form-checkbox';
    showRadiusLabel.append(showRadiusInput, t('showRadius'));

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = t('saveSettings');

    form.append(chasedIntervalLabel, chaserIntervalLabel, mapModeLabel, showRadiusLabel, saveBtn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;
      try {
        await updateGame(qu, identity, services, SPACE_ID, gameId, {
          settings: {
            chasedIntervalMs: Math.max(0.5, Number(chasedIntervalInput.value) || 0.5) * 60_000,
            chaserIntervalMs: Math.max(0.5, Number(chaserIntervalInput.value) || 0.5) * 60_000,
            mapMode: mapModeSelect.value,
            showRadius: showRadiusInput.checked,
          },
        });
      } finally {
        saveBtn.disabled = false;
      }
    });
    return form;
  }

  // ---------------------------------------------------------------------
  // Invite panel (chased-only, pending-only)
  // ---------------------------------------------------------------------
  function buildInvitePanel(gameId, meta) {
    const wrap = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = t('people');
    wrap.appendChild(h3);

    const pickerHost = document.createElement('div');
    wrap.appendChild(pickerHost);
    const status = document.createElement('p');
    status.className = 'qu-geochase-status';
    wrap.appendChild(status);

    const cleanup = mountActorPicker(pickerHost, {
      loadPool: () => services.contacts.listContacts(),
      matchesQuery: matchesActorQuery,
      formatLabel: shortPerson,
      excludePubs: new Set(meta.members.map((m) => m.actorPub)),
      allowPastedPub: false,
      labels: { placeholder: t('invitePlaceholder'), noMatches: t('noMatches'), pasteAsIs: () => '' },
      onPick: async (actorPub, label) => {
        status.textContent = '';
        try {
          await inviteChaser(qu, identity, services, SPACE_ID, gameId, actorPub);
        } catch (err) {
          status.textContent = t('inviteFailed', { name: label, message: err.message });
        }
      },
    });
    pickerCleanups.push(cleanup);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Participant list (pending status - no positions yet, just who's in)
  // ---------------------------------------------------------------------
  function buildParticipantList(meta) {
    const ul = document.createElement('ul');
    ul.className = 'qu-geochase-players';
    for (const member of meta.members) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'qu-geochase-player-name';
      const roleLabel = member.role === 'chased' ? t('chasedBadge') : t('chaserBadge');
      name.textContent = member.actorPub === myPub ? `${t('you')} (${roleLabel})` : `${member.actorPub.slice(0, 8)}… (${roleLabel})`;
      li.appendChild(name);
      ul.appendChild(li);
    }
    return ul;
  }

  return () => {
    stopped = true;
    clearWatches();
    stopLocation?.();
    stopWatchPlayers?.();
    mesh?.close();
    releaseWakeLock?.();
    leafletMap?.destroy();
  };
}
