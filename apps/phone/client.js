/**
 * PHONE — the pilot app for real WebRTC audio/video calling (see
 * `src/call.js`'s own top doc comment for the architecture). Deliberately
 * minimal UI, per the plan: a call-starter (pick a contact, call them) and
 * an active-call view (mute/video toggle, hang up, own video small in the
 * corner, remote video large - standard messenger layout).
 *
 * Routes:
 *   `#/phone` - call-starter, pick a contact to call.
 *   `#/phone/<remotePub>` - CALLER's active-call view (this session STARTS
 *     the call, `initiator: true`) - what the contact-list "Anrufen" icon
 *     and this app's own call-starter link to.
 *   `#/phone/<remotePub>/accept` - CALLEE's active-call view, joining a call
 *     already in progress (`initiator: false`) - what an incoming-call
 *     notification's "Annehmen" action links to. Same URL space otherwise,
 *     an extra trailing segment (this router has no query-string support -
 *     see `apps/shell/src/router.js`'s `parseHash()`) is what distinguishes
 *     the two roles, mirroring how `apps/chat` uses trailing segments for
 *     message permalinks (`/m/<id>`).
 *   `#/phone/<remotePub>/decline` - declines without ever requesting
 *     camera/mic access or mounting the active-call view - what a
 *     notification's "Ablehnen" action links to.
 */
import { createI18n } from '@qu/i18n';
import { formatActorLabel } from '@qu/services';
import { injectStyle, ensureTheme, renderSubpage } from '@qu/ui';
import { createPhoneCall, declinePhoneCall } from './src/call.js';

const DICT = {
  en: {
    title: 'Phone',
    call: 'Call',
    noContacts: 'No contacts yet - add some in Contacts first.',
    calling: 'Calling…',
    ringing: 'Ringing…',
    connected: 'Connected',
    declined: 'Call declined',
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
    noContacts: 'Noch keine Kontakte - zuerst welche in Kontakte hinzufügen.',
    calling: 'Rufe an…',
    ringing: 'Klingelt…',
    connected: 'Verbunden',
    declined: 'Anruf abgelehnt',
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
  return mountActiveCall(container, ctx, SPACE_ID, remotePub, { initiator: mode !== 'accept' });
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
function mountActiveCall(container, ctx, spaceId, remotePub, { initiator }) {
  const { qu, identity, services, iceServers } = ctx;

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
  const videoBtn = document.createElement('button');
  videoBtn.type = 'button';
  videoBtn.textContent = '📹';
  videoBtn.title = t('videoOff');
  videoBtn.setAttribute('aria-label', t('videoOff'));
  videoBtn.dataset.active = 'true';
  const hangupBtn = document.createElement('button');
  hangupBtn.type = 'button';
  hangupBtn.className = 'qu-phone-hangup';
  hangupBtn.textContent = '📞';
  hangupBtn.title = t('hangUp');
  hangupBtn.setAttribute('aria-label', t('hangUp'));
  controls.append(muteBtn, videoBtn, hangupBtn);

  view.append(remoteVideo, localVideo, status, controls);
  container.appendChild(view);

  let call = null;
  let stopped = false;
  let audioEnabled = true;
  let videoEnabled = true;

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
  videoBtn.addEventListener('click', () => {
    if (!call) return;
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
        qu, identity, services, spaceId, remotePub, iceServers, initiator,
        onTrack: (stream) => { remoteVideo.srcObject = stream; },
        onPeerConnected: () => { status.textContent = t('connected'); },
        onDeclined: () => {
          status.textContent = t('declined');
          setTimeout(goBack, 1500);
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
