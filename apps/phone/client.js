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
 *     camera/mic access or mounting the active-call view - what a
 *     notification's "Ablehnen" action links to.
 */
import { createI18n } from '@qu/i18n';
import { formatActorLabel } from '@qu/services';
import { injectStyle, ensureTheme, renderSubpage } from '@qu/ui';
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
  .qu-phone-status { position: absolute; top: 0.75rem; left: 0.75rem; color: #fff; background: #0007; padding: 0.3rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); font-size: 0.9em; }
  .qu-phone-error { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; background: #0009; padding: 0.8rem 1.2rem; border-radius: var(--qu-radius-md, 0.4rem); text-align: center; max-width: 80%; }
  .qu-phone-controls { position: absolute; bottom: 1.25rem; left: 50%; transform: translateX(-50%); display: flex; gap: 1rem; }
  .qu-phone-controls button { width: 3.2rem; height: 3.2rem; border-radius: 50%; border: none; font-size: 1.3em; cursor: pointer; background: #333c; color: #fff; }
  .qu-phone-controls button[data-active="false"] { background: #fff3; }
  .qu-phone-controls .qu-phone-hangup { background: #d32f2f; }
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
  const stop = renderSubpage(container, {
    showBackLink: false,
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
    stop?.();
  };
}

// ===========================================================================
// Decline - #/phone/<remotePub>/decline - no camera/mic, no active-call UI.
// ===========================================================================
function mountDecline(container, { qu, identity, iceServers }, spaceId, remotePub) {
  const view = document.createElement('div');
  view.className = 'qu-phone-call-view';
  const status = document.createElement('div');
  status.className = 'qu-phone-error';
  status.textContent = '…';
  view.appendChild(status);
  container.appendChild(view);

  declinePhoneCall({ qu, identity, spaceId, remotePub, iceServers })
    .then(() => { status.textContent = t('declined'); })
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
  const { qu, identity, services, iceServers, negotiationTimeoutMs, subscribe, syncFetch } = ctx;

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

  view.append(remoteVideo, localVideo, status, controls);
  container.appendChild(view);

  let call = null;
  let stopped = false;
  let audioEnabled = true;
  let videoEnabled = callMode === 'video';

  function goBack() {
    window.location.hash = '#/phone';
  }

  hangupBtn.addEventListener('click', () => {
    call?.hangUp();
    goBack();
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
        onDeclined: () => {
          status.textContent = t('declined');
          setTimeout(goBack, 1500);
        },
        // See WebRtcSignalService.onTimeout()'s own doc comment - fires
        // when the connection never establishes at all (classic symmetric-
        // NAT/no-TURN failure, see this plan's own "Bugfix: Keine WebRTC-
        // Verbindung..." section). Without this, "Calling…"/"Ringing…"
        // used to hang forever with no feedback - unmounting via goBack()
        // still runs this view's own cleanup (call?.hangUp()), same as the
        // onDeclined() case above.
        onTimeout: () => {
          status.textContent = t('callTimeout');
          setTimeout(goBack, 2500);
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
