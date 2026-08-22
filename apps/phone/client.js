/**
 * PHONE — the pilot app for real WebRTC audio/video calling (see
 * `src/call.js`'s own top doc comment for the architecture). Deliberately
 * minimal UI, per the plan: a call-starter (pick a contact, call them) and
 * an active-call view (mute/video toggle, hang up, own video small in the
 * corner, remote video large - standard messenger layout).
 *
 * Routes:
 *   `#/phone` - call-starter, pick a contact to call.
 *   `#/phone/<remotePub>` - CALLER's active-call view, AUDIO-ONLY by
 *     default (this session STARTS the call, `initiator: true`) - what the
 *     contact-list "Anrufen" icon and this app's own call-starter link to.
 *     Video is opt-in, not the default - see `/video` below and
 *     `src/call.js`'s own `upgradeToVideo()` doc comment for turning it on
 *     mid-call instead.
 *   `#/phone/<remotePub>/video` - CALLER's active-call view, starting WITH
 *     video from the outset (skips the extra `upgradeToVideo()` round trip)
 *     - what this app's own `content.chatRoomMenu` contribution's
 *     "Video-Call" item links to (`renderCallMenuItems()`, below).
 *   `#/phone/<remotePub>/accept` - CALLEE's active-call view, joining a call
 *     already in progress (`initiator: false`) - what an incoming-call
 *     notification's "Annehmen" action links to. Same URL space otherwise,
 *     an extra trailing segment (this router has no query-string support -
 *     see `apps/shell/src/router.js`'s `parseHash()`) is what distinguishes
 *     the two roles, mirroring how `apps/chat` uses trailing segments for
 *     message permalinks (`/m/<id>`). ALSO audio-only by default, same as
 *     the caller's bare route - the two sides don't need to agree; either
 *     can independently upgrade to video whenever they want, same as any
 *     real video-calling app allows one side to have their camera off.
 *   `#/phone/<remotePub>/decline` - declines without ever requesting
 *     camera/mic access or mounting the active-call view - what the OS-level
 *     Web Push notification's "Ablehnen" action links to (a service worker
 *     can only ever open a URL - see `apps/shell/sw.js`'s own
 *     `notificationclick` handler). The IN-APP toast's own "Ablehnen" button
 *     does NOT use this route - see `handleNotificationAction()` below.
 *   `#/phone/<remotePub>/ended` - a MARKER, not a real destination - never
 *     linked to or navigated to directly. `showEndScreen()` (below)
 *     `history.replaceState()`s the URL to this the moment a call ends,
 *     silently (no `hashchange`, no remount - see that function's own doc
 *     comment) so it never actually renders anything of its own; landing on
 *     it directly (e.g. a page reload while looking at a call summary) falls
 *     back to the call-starter, same as any other route this router
 *     doesn't recognize - see `mount()`'s own dispatch below.
 */
import { createI18n } from '@qu/i18n';
import { formatActorLabel } from '@qu/services';
import { injectStyle, ensureTheme, mountAppTemplate } from '@qu/ui';
import { createLogger } from '@qu/log';
import { createPhoneCall, declinePhoneCall } from './src/call.js';

const log = createLogger('phone:client');

const DICT = {
  en: {
    title: 'Phone',
    call: 'Call',
    videoCall: 'Video Call',
    audioCall: 'Audio Call',
    noContacts: 'No contacts yet - add some in Contacts first.',
    calling: 'Calling…',
    ringing: 'Ringing…',
    connected: 'Connected',
    declined: 'Call declined',
    callTimeout: 'Call could not connect - the other side may be behind a restrictive network.',
    mediaUnsupported: 'This browser cannot access camera/microphone.',
    mediaDenied: 'Camera/microphone access was denied.',
    mute: 'Mute',
    unmute: 'Unmute',
    videoOff: 'Turn video off',
    videoOn: 'Turn video on',
    hangUp: 'Hang up',
    you: 'You',
    callEnded: 'Call ended',
    duration: 'Duration',
    back: 'Back',
  },
  de: {
    title: 'Telefon',
    call: 'Anrufen',
    videoCall: 'Video-Anruf',
    audioCall: 'Audio-Anruf',
    noContacts: 'Noch keine Kontakte - zuerst welche in Kontakte hinzufügen.',
    calling: 'Rufe an…',
    ringing: 'Klingelt…',
    connected: 'Verbunden',
    declined: 'Anruf abgelehnt',
    callTimeout: 'Anruf konnte nicht verbunden werden - die Gegenseite ist evtl. hinter einem restriktiven Netzwerk.',
    mediaUnsupported: 'Dieser Browser kann nicht auf Kamera/Mikrofon zugreifen.',
    mediaDenied: 'Zugriff auf Kamera/Mikrofon wurde verweigert.',
    mute: 'Stummschalten',
    unmute: 'Stummschaltung aufheben',
    videoOff: 'Video ausschalten',
    videoOn: 'Video einschalten',
    hangUp: 'Auflegen',
    you: 'Du',
    callEnded: 'Anruf beendet',
    duration: 'Dauer',
    back: 'Zurück',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-phone-style';
const STYLE = `
  .qu-phone-contacts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-phone-contacts li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-phone-contacts .qu-phone-contact-name { flex: 1; font-family: var(--qu-font-mono, ui-monospace, monospace); }
  .qu-phone-contacts button { padding: 0.35rem 0.7rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: var(--qu-color-accent, #5b5bd6); color: #fff; cursor: pointer; font: inherit; }
  .qu-phone-empty { opacity: 0.7; }

  .qu-phone-call-view { position: fixed; top: 3.25rem; right: 0; bottom: 0; left: 0; display: flex; flex-direction: column; background: #000; z-index: 10; }
  .qu-phone-remote-video { flex: 1; width: 100%; height: 100%; object-fit: cover; background: #111; }
  .qu-phone-local-video { position: absolute; top: 0.75rem; right: 0.75rem; width: 28vw; max-width: 9rem; aspect-ratio: 3 / 4; object-fit: cover; border-radius: var(--qu-radius-md, 0.4rem); border: 2px solid #fff4; background: #222; }
  .qu-phone-peer-name { position: absolute; top: 0.75rem; left: 0.75rem; color: #fff; font-weight: 700; font-size: 1.05em; text-shadow: 0 1px 3px #000a; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-phone-status { position: absolute; top: 2.15rem; left: 0.75rem; color: #fff; background: #0007; padding: 0.3rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); font-size: 0.9em; }
  .qu-phone-error { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; background: #0009; padding: 0.8rem 1.2rem; border-radius: var(--qu-radius-md, 0.4rem); text-align: center; max-width: 80%; }
  .qu-phone-controls { position: absolute; bottom: 1.25rem; left: 50%; transform: translateX(-50%); display: flex; gap: 1rem; }
  .qu-phone-controls button { width: 3.2rem; height: 3.2rem; border-radius: 50%; border: none; font-size: 1.3em; cursor: pointer; background: #333c; color: #fff; }
  .qu-phone-controls button[data-active="false"] { background: #fff3; }
  .qu-phone-controls .qu-phone-hangup { background: #d32f2f; }
  .qu-phone-summary { margin: auto; text-align: center; color: #fff; display: flex; flex-direction: column; align-items: center; gap: 0.6rem; padding: 1.5rem; }
  .qu-phone-summary-title { font-size: 1.2em; opacity: 0.75; }
  .qu-phone-summary-name { font-size: 1.6em; font-weight: 700; color: inherit; text-decoration: none; }
  .qu-phone-summary-name:hover { text-decoration: underline; }
  .qu-phone-summary-pub { font-family: var(--qu-font-mono, ui-monospace, monospace); font-size: 0.8em; opacity: 0.65; color: inherit; text-decoration: none; word-break: break-all; max-width: 90vw; }
  .qu-phone-summary-pub:hover { text-decoration: underline; opacity: 0.9; }
  .qu-phone-summary-meta { opacity: 0.8; }
  .qu-phone-summary-back { margin-top: 0.8rem; padding: 0.5rem 1.4rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid #fff4; background: transparent; color: #fff; cursor: pointer; font: inherit; }
`;

export function mount(container, ctx) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  const { apps, segments = [] } = ctx;
  const SPACE_ID = apps?.find((a) => a.name === 'phone')?.spaceId;
  if (!SPACE_ID) throw new Error('[phone] no "spaceId" found in the apps catalog for "phone" - check manifest.quapp');

  const [, remotePub, mode] = segments;

  if (!remotePub) return mountCallStarter(container, ctx);
  if (mode === 'decline') return mountDecline(container, ctx, SPACE_ID, remotePub);
  // A marker hash only (see this file's own top doc comment's "Routes"
  // section) - landing on it directly (e.g. a reload) must never fall
  // through to the "else" below, which would silently PLACE a new outgoing
  // call to remotePub (initiator: true).
  if (mode === 'ended') return mountCallStarter(container, ctx);
  // Audio is the default for BOTH roles - only an explicit `/video` segment
  // (the caller's own choice) starts with a video track already attached.
  // See this file's own top doc comment's "Routes" section.
  return mountActiveCall(container, ctx, SPACE_ID, remotePub, { initiator: mode !== 'accept', callMode: mode === 'video' ? 'video' : 'audio' });
}

// ===========================================================================
// Call-starter - #/phone
// ===========================================================================
function mountCallStarter(container, { services }) {
  let stopped = false;
  const stopTemplate = mountAppTemplate(container, {
    render: (content) => {
      const h1 = document.createElement('h1');
      h1.textContent = t('title');

      const list = document.createElement('ul');
      list.className = 'qu-phone-contacts';
      content.append(h1, list);

      (async () => {
        const contacts = await services.contacts.listContacts();
        if (stopped) return;
        if (contacts.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'qu-phone-empty';
          empty.textContent = t('noContacts');
          list.appendChild(empty);
          return;
        }
        for (const { actorPub, profile } of contacts) {
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.className = 'qu-phone-contact-name';
          name.textContent = formatActorLabel(actorPub, profile); // same alias-or-truncated-pubkey convention apps/contact-list/apps/user-list already use
          const callBtn = document.createElement('button');
          callBtn.type = 'button';
          callBtn.textContent = t('call');
          callBtn.addEventListener('click', () => { window.location.hash = `#/phone/${actorPub}`; });
          li.append(name, callBtn);
          list.appendChild(li);
        }
      })();
    },
  });
  return () => {
    stopped = true;
    stopTemplate();
  };
}

// ===========================================================================
// Decline - #/phone/<remotePub>/decline - no camera/mic, no active-call UI.
// ===========================================================================
function mountDecline(container, { qu, identity, services, iceServers }, spaceId, remotePub) {
  const view = document.createElement('div');
  view.className = 'qu-phone-call-view';
  const status = document.createElement('div');
  status.className = 'qu-phone-error';
  status.textContent = '…';
  view.appendChild(status);
  mountAppTemplate(container, { render: (content) => content.appendChild(view) });

  // Alias-first, same as mountActiveCall()'s own peerName - "declined" alone
  // doesn't say WHO was declined, and a raw pub is unhelpful. Resolved
  // alongside (not after) declinePhoneCall() itself - neither should wait
  // on the other.
  const peerLabelPromise = services.profile?.getPublicProfile(remotePub)
    .then((profile) => formatActorLabel(remotePub, profile))
    .catch(() => formatActorLabel(remotePub, null)) ?? Promise.resolve(formatActorLabel(remotePub, null));

  Promise.all([declinePhoneCall({ qu, identity, spaceId, remotePub, iceServers }), peerLabelPromise])
    .then(([, peerLabel]) => { status.textContent = `${t('declined')} (${peerLabel})`; })
    .catch((err) => { status.textContent = err.message; });

  return () => {};
}

// ===========================================================================
// Active call - #/phone/<remotePub> (caller) or #/phone/<remotePub>/accept (callee)
// ===========================================================================
function mountActiveCall(container, ctx, spaceId, remotePub, { initiator, callMode = 'audio' }) {
  // `negotiationTimeoutMs` is test-only (real ctx never sets it - see
  // createPhoneCall()'s own doc comment on why the override exists at all)
  // - undefined here just means createPhoneCall()'s own default parameter
  // (the realistic 45s ring duration) applies, unchanged from before.
  // `subscribe`/`syncFetch` are the ordinary ones every app gets - without
  // threading them through to createPhoneCall(), no signal this call sends
  // ever actually reaches the other side (see WebRtcSignalService's own
  // constructor doc comment for the full incident this fixes).
  // `goBack` is the shell's own ctx.goBack (see apps/shell/client.js's own
  // doc comment) - real browser history back to wherever the user actually
  // came from (a Forum thread, a Chat room, wherever a toast's "Annehmen"
  // was clicked from) when there is one, `#/phone` otherwise. Falls back to
  // a plain hash assignment if an older/test ctx doesn't provide it.
  const { qu, identity, services, iceServers, negotiationTimeoutMs, subscribe, syncFetch, goBack: ctxGoBack } = ctx;

  const view = document.createElement('div');
  view.className = 'qu-phone-call-view';

  const remoteVideo = document.createElement('video');
  remoteVideo.className = 'qu-phone-remote-video';
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;

  const localVideo = document.createElement('video');
  localVideo.className = 'qu-phone-local-video';
  localVideo.autoplay = true;
  localVideo.playsInline = true;
  localVideo.muted = true; // never play back our own mic through our own speakers

  // Alias-first, same convention formatActorLabel() already gives every
  // other place in the app (mountCallStarter()'s own contact list, apps/chat)
  // - shows the truncated pub immediately (formatActorLabel()'s own no-
  // profile-yet fallback), then upgrades to the real alias once
  // services.profile.getPublicProfile() resolves, below.
  const peerName = document.createElement('div');
  peerName.className = 'qu-phone-peer-name';
  peerName.textContent = formatActorLabel(remotePub, null);

  const status = document.createElement('div');
  status.className = 'qu-phone-status';
  status.textContent = initiator ? t('calling') : t('ringing');

  const controls = document.createElement('div');
  controls.className = 'qu-phone-controls';
  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.textContent = '🎤';
  muteBtn.title = t('mute');
  muteBtn.setAttribute('aria-label', t('mute'));
  muteBtn.dataset.active = 'true';
  // Reflects whether a video track exists YET, not just whether it's
  // enabled - an audio-only call (the default) starts with `false` here,
  // and the button's own click handler below is what turns it into a real
  // `upgradeToVideo()` call the first time, vs. a plain on/off toggle once
  // a track already exists (from `/video` at call start, or an earlier
  // upgrade). See `call.js`'s own `upgradeToVideo()` doc comment.
  const videoBtn = document.createElement('button');
  videoBtn.type = 'button';
  videoBtn.textContent = '📹';
  videoBtn.title = callMode === 'video' ? t('videoOff') : t('videoOn');
  videoBtn.setAttribute('aria-label', videoBtn.title);
  videoBtn.dataset.active = String(callMode === 'video');
  const hangupBtn = document.createElement('button');
  hangupBtn.type = 'button';
  hangupBtn.className = 'qu-phone-hangup';
  hangupBtn.textContent = '📞';
  hangupBtn.title = t('hangUp');
  hangupBtn.setAttribute('aria-label', t('hangUp'));
  controls.append(muteBtn, videoBtn, hangupBtn);

  // The local PiP only makes sense once there's actually a video track to
  // show (would just be a black box otherwise) - shown from the start for
  // a `/video` call, or once the video button's own upgrade succeeds (see
  // its click handler below). The video toggle button itself stays
  // visible either way now - unlike before, hiding it entirely stopped
  // audio-only calls (the default) from ever being able to add video at all.
  localVideo.hidden = callMode !== 'video';

  view.append(remoteVideo, localVideo, peerName, status, controls);
  mountAppTemplate(container, { render: (content) => content.appendChild(view) });

  let call = null;
  let stopped = false;

  // Fired in parallel with the call setup below, not awaited before it -
  // resolving a profile must never delay actually placing the call.
  services.profile?.getPublicProfile(remotePub).then((profile) => {
    if (!stopped) peerName.textContent = formatActorLabel(remotePub, profile);
  }).catch(() => { /* stays on the truncated-pub fallback already showing */ });
  let audioEnabled = true;
  let videoEnabled = callMode === 'video';

  function goBack() {
    if (typeof ctxGoBack === 'function') ctxGoBack('#/phone');
    else window.location.hash = '#/phone'; // defensive fallback - real ctx always has goBack, see apps/shell/client.js
  }

  /**
   * `m:ss`, matching this app's own already-terse UI language (no i18n
   * needed - digits/colons read the same in every locale, same reasoning
   * `formatTs()`-style helpers elsewhere in this codebase use raw digits).
   * @param {number} ms
   */
  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  /**
   * Replaces the call view's own content with an end-of-call screen -
   * contact (alias + full pub, both linking to their profile), a reason
   * line, and a "Zurück" link. Covers every terminal state that's worth
   * showing something for:
   *   - `connectedAt` given (this side hung up, OR the other side did - see
   *     `onHungUp` below) → `title` is `t('callEnded')`, meta is date/time
   *     + duration.
   *   - `connectedAt` omitted (declined, or timed out/never connected) →
   *     `title` is the reason (`t('declined')`/`t('callTimeout')`), no meta
   *     line (there's no duration to show).
   * Never shown for a call hung up while still "Rufe an…"/"Klingelt…" by
   * THIS side - see the hangupBtn handler below, which goes straight back
   * instead (nothing connected, nothing worth summarizing).
   *
   * `history.replaceState()`s the URL to `#/phone/<remotePub>/ended` FIRST -
   * this view never otherwise navigates away on its own (the summary just
   * replaces the current view's DOM in place), so without this, the URL
   * stays exactly where the ORIGINAL call left it (`#/phone/<remotePub>`
   * or `.../accept`). A real, reported bug: the same peer calling again
   * while the callee is still looking at THIS exact summary screen made the
   * new call's "Annehmen" toast link (targeting that SAME, unchanged
   * `.../accept` URL) a no-op - assigning `location.hash` to its own CURRENT
   * value never fires `hashchange` in any browser, so nothing renders the
   * new call at all. `replaceState()`, unlike a `location.hash` assignment,
   * never fires `hashchange`/`popstate` itself and doesn't push a new
   * history entry - it silently gives this screen its OWN distinct hash so
   * a LATER, real accept navigation is guaranteed to differ from whatever
   * is currently in the address bar, without disturbing this already-
   * rendered summary or `goBack()`'s own history-entry-count assumption.
   * @param {{title: string, connectedAt?: number|null}} options
   */
  function showEndScreen({ title, connectedAt = null }) {
    window.history.replaceState(null, '', `#/phone/${remotePub}/ended`);
    view.textContent = '';
    const summary = document.createElement('div');
    summary.className = 'qu-phone-summary';
    const titleEl = document.createElement('div');
    titleEl.className = 'qu-phone-summary-title';
    titleEl.textContent = title;
    // Alias/pub both link to the profile (#/~<pub>, the shell's own reserved
    // profile-link sigil - see apps/shell/client.js's own doc comment on it).
    const nameLink = document.createElement('a');
    nameLink.className = 'qu-phone-summary-name';
    nameLink.href = `#/~${remotePub}`;
    nameLink.textContent = peerName.textContent; // already alias-resolved, see the profile lookup above
    const pubLink = document.createElement('a');
    pubLink.className = 'qu-phone-summary-pub';
    pubLink.href = `#/~${remotePub}`;
    pubLink.textContent = remotePub;
    summary.append(titleEl, nameLink, pubLink);
    if (connectedAt != null) {
      const meta = document.createElement('div');
      meta.className = 'qu-phone-summary-meta';
      const connectedDate = new Date(connectedAt);
      meta.textContent = `${connectedDate.toLocaleDateString()} ${connectedDate.toLocaleTimeString()} · ${t('duration')}: ${formatDuration(Date.now() - connectedAt)}`;
      summary.appendChild(meta);
    }
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'qu-phone-summary-back';
    backBtn.textContent = t('back');
    backBtn.addEventListener('click', goBack);
    summary.appendChild(backBtn);
    view.appendChild(summary);
  }

  hangupBtn.addEventListener('click', () => {
    const connectedAt = call?.getConnectedAt() ?? null;
    call?.hangUp();
    call = null; // already hung up - the view's own teardown (fires once the summary's "Zurück" navigates away) must not call hangUp() a second time
    if (connectedAt == null) { goBack(); return; }
    showEndScreen({ title: t('callEnded'), connectedAt });
  });
  muteBtn.addEventListener('click', () => {
    if (!call) return;
    audioEnabled = !audioEnabled;
    call.toggleAudio(audioEnabled);
    muteBtn.dataset.active = String(audioEnabled);
    muteBtn.title = audioEnabled ? t('mute') : t('unmute');
    muteBtn.setAttribute('aria-label', muteBtn.title);
  });
  videoBtn.addEventListener('click', async () => {
    if (!call) return;
    if (call.localStream.getVideoTracks().length === 0) {
      // No video track yet (an audio-only call, the default) - a real
      // renegotiation, not a plain toggle. See upgradeToVideo()'s own doc
      // comment. Disabled during the async round trip so a second click
      // can't start a second, redundant upgrade.
      videoBtn.disabled = true;
      try {
        await call.upgradeToVideo();
      } catch (err) {
        log.warn('upgradeToVideo() failed:', err.message);
        videoBtn.disabled = false;
        return;
      }
      videoBtn.disabled = false;
      videoEnabled = true;
      localVideo.hidden = false;
      localVideo.srcObject = call.localStream; // re-bind - the element may already show this same object, but this guarantees the freshly-added track is picked up
      videoBtn.dataset.active = 'true';
      videoBtn.title = t('videoOff');
      videoBtn.setAttribute('aria-label', videoBtn.title);
      return;
    }
    videoEnabled = !videoEnabled;
    call.toggleVideo(videoEnabled);
    videoBtn.dataset.active = String(videoEnabled);
    videoBtn.title = videoEnabled ? t('videoOff') : t('videoOn');
    videoBtn.setAttribute('aria-label', videoBtn.title);
  });

  function showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'qu-phone-error';
    errorEl.textContent = message;
    view.appendChild(errorEl);
    controls.hidden = true;
  }

  (async () => {
    let phoneCall;
    try {
      phoneCall = await createPhoneCall({
        qu, identity, services, spaceId, remotePub, iceServers, initiator, mode: callMode, negotiationTimeoutMs, subscribe, syncFetch,
        onTrack: (stream) => { remoteVideo.srcObject = stream; },
        onPeerConnected: () => { status.textContent = t('connected'); },
        // Local resources (mic/camera) are already torn down by the time
        // this fires - see call.js's own cleanupLocal() doc comment. Shows
        // the SAME end-of-call screen a self-initiated hangup does, minus a
        // duration (this call never connected) - no auto-navigate timeout
        // anymore, so the user actually has time to read it before "Zurück".
        onDeclined: () => {
          call = null;
          showEndScreen({ title: t('declined') });
        },
        // See WebRtcSignalService.onTimeout()'s own doc comment - fires
        // when the connection never establishes at all (classic symmetric-
        // NAT/no-TURN failure, see this plan's own "Bugfix: Keine WebRTC-
        // Verbindung..." section). Without this, "Calling…"/"Ringing…"
        // used to hang forever with no feedback.
        onTimeout: () => {
          call = null;
          showEndScreen({ title: t('callTimeout') });
        },
        // The OTHER side explicitly hung up an ALREADY-connected call - the
        // reliable notice `WebRtcSignalService.hangupCall()` exists for (a
        // plain RTCPeerConnection close doesn't tell this side anything
        // promptly - see that method's own doc comment). Without this, a
        // call the other party ended stayed looking "Connected" forever on
        // THIS side - a real, reported gap. Treated exactly like this side
        // hanging up itself: same end screen, with the real duration.
        onHungUp: () => {
          const connectedAt = call?.getConnectedAt() ?? null;
          call?.hangUp(); // local cleanup only - the OTHER side already knows the call ended, that's what triggered this
          call = null;
          showEndScreen({ title: t('callEnded'), connectedAt });
        },
      });
    } catch (err) {
      if (stopped) return;
      showError(err.code === 'unsupported' ? t('mediaUnsupported') : t('mediaDenied'));
      return;
    }
    if (stopped) {
      phoneCall.hangUp();
      return;
    }
    call = phoneCall;
    localVideo.srcObject = call.localStream;
  })();

  return () => {
    stopped = true;
    call?.hangUp();
  };
}

/**
 * The `content.chatRoomMenu` contributor (`apps/chat`'s room header "⋮"
 * menu, see that app's own `mountRoomView()` doc comment) - "Video Call"/
 * "Audio Call" entries, 1:1 rooms only. `payload.contactPub` is `null` for
 * a group room (Phone has no notion of a group call) - returning `[]` in
 * that case is what makes this contributor simply not show up there, same
 * convention `extensionPoints.collect()` already documents for "an app
 * doesn't apply here".
 * @param {{contactPub: string|null}} payload
 * @returns {Array<{id: string, label: string, icon: string, onClick: () => void}>}
 */
export function renderCallMenuItems({ contactPub }) {
  if (!contactPub) return [];
  return [
    // Audio first/default - see this file's own top doc comment's "Routes"
    // section on why the bare route (no `/video` segment) is audio-only.
    { id: 'audioCall', label: t('audioCall'), icon: '🎤', onClick: () => { window.location.hash = `#/phone/${contactPub}`; } },
    { id: 'videoCall', label: t('videoCall'), icon: '📹', onClick: () => { window.location.hash = `#/phone/${contactPub}/video`; } },
  ];
}

/**
 * The `content.notificationAction` contributor (see
 * `apps/shell/src/notification-popups.js`'s own doc comment) - lets the
 * IN-APP toast's "Ablehnen" button signal a decline directly, WITHOUT
 * navigating to the `/decline` route (unlike the OS Web Push notification's
 * own decline action, which has no choice but to open a URL - see this
 * file's own top doc comment's "Routes" section). "Annehmen" needs no
 * contributor here at all - it stays a plain `href` to `#/phone/<pub>/accept`
 * in the toast, since switching into the call UI is exactly what accepting
 * should do.
 *
 * A no-op for any `actionId` other than `'decline'`, or a `url` that doesn't
 * match this app's own `/decline` route shape - `notification-popups.js`
 * calls EVERY app's contributor for EVERY action id via `collect()`, so this
 * must ignore whatever isn't its own (same "return early if this payload
 * isn't for me" discipline `renderCallMenuItems()` above already follows for
 * `contactPub`).
 * @param {{actionId: string, url: string, qu: import('@qu/core').QuStore, identity: import('@qu/identity').QuIdentityEngine, apps: Array<object>, iceServers?: Array<object>}} payload
 */
export async function handleNotificationAction({ actionId, url, qu, identity, apps, iceServers }) {
  if (actionId !== 'decline') return;
  const match = /^#\/phone\/([^/]+)\/decline$/.exec(url ?? '');
  if (!match) return;
  const remotePub = match[1];
  const spaceId = apps?.find((a) => a.name === 'phone')?.spaceId;
  if (!spaceId) return;
  try {
    await declinePhoneCall({ qu, identity, spaceId, remotePub, iceServers });
  } catch (err) {
    log.warn('handleNotificationAction(): declinePhoneCall() failed:', err.message);
  }
}
