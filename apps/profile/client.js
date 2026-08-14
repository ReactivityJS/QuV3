/**
 * PROFILE — edit this identity's own profile (alias/avatar/custom fields,
 * public template/style, directory visibility) and view anyone else's
 * public profile read-only. The one app `apps/shell` special-cases: `#/~<pub>`
 * (matching the real Qu's own profile-link convention) always dispatches
 * here regardless of the normal by-name catalog lookup - see
 * `apps/shell/client.js`'s own doc comment.
 *
 * Routing (via `segments`, passed through by the shell UNCHANGED from the
 * hash - `#/profile` gives `['profile']`, `#/~<pub>` gives `['~<pub>']`,
 * `#/~<pub>/settings` gives `['~<pub>', 'settings']`):
 *   - Bare `#/profile` (no `~`) is a deliberate ambiguity redirect, exactly
 *     QuV2's own convention: immediately `location.hash = '#/~' + myPub`
 *     and render nothing itself.
 *   - `#/~<pub>` - `pub === myPub` renders the editable own-profile form;
 *     otherwise a read-only public view.
 *   - `#/~<pub>/settings` - language/theme preference picker, own profile
 *     only (redirects back to the plain view for anyone else's pub).
 *   - Reactive via `watch(qu, actorPath(pub, 'profile'), ...)` (same as
 *     QuV2) - re-renders live on sync updates, including this session's
 *     own saves.
 *
 * IDENTITY-BOUND LANGUAGE/THEME (Settings subpath): `preferredLocale`/
 * `preferredTheme` are private, self-encrypted profile fields (see
 * `ProfileService`'s own doc comment) - the source of truth, synced across
 * this identity's OWN devices. Saving here calls `setLocale()`/
 * `setStoredTheme()` immediately - persisted to `localStorage` right away,
 * confirmed correct end to end with a real relay - but NEITHER has any
 * live effect on the CURRENTLY RUNNING page: `@qu/i18n`'s own `setLocale()`
 * doc comment says so explicitly ("takes effect on next page load, not live
 * mid-session"), and `ensureTheme()` is idempotent (first call per page load
 * wins, see its own doc comment) - both were already-decided, deliberate
 * device-local designs from earlier rounds, not something this file
 * controls. What WAS wrong here: this file used to claim "instant effect on
 * THIS device" - it never was, and nothing told the user a reload was even
 * needed. Fixed with an explicit, persistent (non-auto-clearing) "reload to
 * apply" prompt + button after a Settings save, instead of a misleading
 * status flash implying it already happened.
 *
 * TEMPLATE/STYLE PREVIEW (own edit form): `template` picks one of a few
 * small READ-ONLY layout variants (`renderPublicProfile()` below) a VISITOR
 * sees; `style` reuses `@qu/ui`'s `THEME_PRESETS` (the SAME palette system
 * `apps/shell`'s own device theme uses) as an accent applied ONLY to the
 * profile page itself (an inline CSS custom property on that page's own
 * root, never `ensureTheme()`'s global `:root` - never affects the rest of
 * a visitor's UI). `#/~<myOwnPub>` always renders the EDITABLE form for the
 * owner, never `renderPublicProfile()` - meaning the owner could never
 * actually SEE their own template/style take effect, not even after a
 * reload, without asking someone else to look. Fixed with a small, live
 * preview box directly in the edit form (`renderProfileHeader()`/
 * `applyTemplateStyle()`, shared with `renderPublicProfile()`'s own
 * rendering so the preview is never able to drift from the real thing) -
 * updates on every keystroke/select change, no save required for the
 * preview itself.
 *
 * AVATAR UPLOAD: the `avatar` field stays the SAME plain string it always
 * was (an emoji, an `https://` image URL, or now a THIRD shape:
 * `asset:<assetId>`, an uploaded file via `@qu/services`' `AssetService` -
 * `@qu/engines`' `AssetEngine` doing the actual chunking/hashing/dedup/sync
 * retry, see either's own doc comment). Uploaded via `@qu/ui`'s
 * `<qu-asset-upload>` next to the existing text field (still directly
 * editable too - clearing it or pasting a URL/emoji overrides an uploaded
 * asset just as easily as it always could). Stored under THIS identity's
 * OWN pub as the asset `spaceId` (`services.assets.upload(myPub, assetId,
 * file)`) - a personal, always-unique-per-identity namespace, distinct from
 * any app's own `manifest.spaceId` (see `@qu/foundation`'s manifest schema
 * doc comment on why a space id must be collision-safe). `renderProfileHeader()`
 * below renders it via `@qu/ui`'s `renderAvatarOrAsset()`, which branches on
 * the `asset:` prefix and renders a `<qu-asset kind="image">` instead,
 * falling back to the plain URL/emoji/unset `renderAvatar()` otherwise -
 * `root.assetService` is set once in `mount()` (same "set on an ancestor
 * before children connect" discipline `.qu` already requires) so both this
 * app's own preview AND a VISITOR's read-only view
 * (`renderPublicProfile()`) can resolve it.
 * FIXED (was a documented scope cut for one round): `renderAvatarOrAsset()`
 * used to be a private helper local to this file - `user-list`/
 * `contact-list`/`forum` still only called `@qu/ui`'s plain `renderAvatar()`
 * for OTHER actors' avatars, so an actor who uploaded an asset avatar
 * showed correctly on their OWN profile page but fell back to the initials
 * badge everywhere else (a real user report: an unlisted user found via
 * FP/pub search showed no avatar, even though the SAME profile page showed
 * it fine). Promoted into `@qu/ui/avatar.js` (see its own doc comment) and
 * wired into all three other call sites too - this file now imports the
 * SAME shared function instead of keeping its own copy.
 *
 * USER SETTINGS EXTENSION POINT: Settings (`#/~<pub>/settings`) declares
 * `userSettings.contributions` in its own manifest's `definesExtensionPoints`
 * - the Drupal-hooks mechanism `@qu/foundation`'s `ExtensionPointHost` already
 * provides (see that file's own doc comment), used here for the first time
 * by a HOST rather than a contributor. `renderSettings()` below returns an
 * empty `.qu-profile-ext-settings` container; `mount()`'s own `render()`
 * then calls `extensionPoints.renderSlot('userSettings.contributions',
 * extRoot, {myPub, services})` on it - any OTHER app (a per-app preference
 * screen, or a future relay-level settings section) contributes its own
 * user-specific settings UI there via its OWN manifest's `contributes`
 * entry, without this file ever importing it, exactly like Forum's
 * `content.messageActions` point already works for content plugins. This
 * app defines the point but never contributes to it itself - the
 * language/theme/notifications/push sections above stay hard-coded here
 * because they're intrinsic to what "profile settings" already means, not
 * because the mechanism couldn't cover them too.
 *
 * Deliberately NOT ported from QuV2's `apps/profile`: the identity backup/
 * export/QR section (seed code, camera scan) - a whole separate concern
 * (device/identity management, not profile DATA), and no `@qu/qr` package
 * exists in V3 yet, same reasoning `apps/shell`'s onboarding screen already
 * documents for dropping QR entirely this round.
 */
import { watch } from '@qu/reactive';
import { actorPath } from '@qu/identity';
import { createI18n, AVAILABLE_LOCALES, setLocale } from '@qu/i18n';
import { injectStyle, ensureTheme, renderAvatarOrAsset, ASSET_AVATAR_PREFIX, renderFlagToggle, THEME_PRESETS, setStoredTheme } from '@qu/ui';
import { formatActorLabel } from '@qu/services';

const DICT = {
  en: {
    title: 'Profile',
    alias: 'Alias',
    aliasPlaceholder: 'How others see you (defaults to your public key if left empty)',
    avatar: 'Avatar (emoji or image URL)',
    template: 'Template',
    style: 'Style',
    templateDefault: 'Default', templateCompact: 'Compact', templateBanner: 'Banner',
    save: 'Save', saved: 'Saved!',
    fields: 'Custom fields', fieldKey: 'Label', fieldValue: 'Value', fieldPublic: 'Public', fieldPrivate: 'Private (only you)',
    addField: 'Add field', removeField: 'Remove',
    listedInDirectory: 'Listed in directory (visible to the User List)',
    settingsLink: 'Language & theme settings',
    backToProfile: 'Back to profile',
    language: 'Language', theme: 'Theme', useDefault: '(use default)',
    yourKeys: 'Your keys', pub: 'Signing key (pub)', epub: 'Encryption key (epub)',
    contactAdd: 'Add contact', contactRemove: 'Remove contact',
    notFound: 'This identity has not published a profile (yet).',
    savedReloadHint: 'Saved! Reload the page to see the new language/theme.',
    reloadNow: 'Reload now',
    preview: 'Preview (how visitors see your profile)',
    notifications: 'Notifications',
    notifEnabled: 'Enable notifications',
    notifMentions: 'Notify me on @mentions',
    notifPerApp: 'Per app',
    notifSave: 'Save notification settings',
    notifSaved: 'Saved!',
    pushTitle: 'Push notifications',
    pushEnableDevice: 'Enable on this device',
    pushEnabled: 'Enabled on this device',
    pushUnsupported: 'Push notifications are not supported in this browser.',
    pushNoVapid: 'This relay has not configured push notifications.',
    pushDenied: 'Notification permission was denied.',
    pushFailed: 'Could not enable push notifications: {message}',
  },
  de: {
    title: 'Profil',
    alias: 'Alias',
    aliasPlaceholder: 'Wie andere dich sehen (Standard: dein Public Key, falls leer)',
    avatar: 'Avatar (Emoji oder Bild-URL)',
    template: 'Vorlage',
    style: 'Stil',
    templateDefault: 'Standard', templateCompact: 'Kompakt', templateBanner: 'Banner',
    save: 'Speichern', saved: 'Gespeichert!',
    fields: 'Eigene Felder', fieldKey: 'Bezeichnung', fieldValue: 'Wert', fieldPublic: 'Öffentlich', fieldPrivate: 'Privat (nur du)',
    addField: 'Feld hinzufügen', removeField: 'Entfernen',
    listedInDirectory: 'Im Verzeichnis gelistet (sichtbar in der Nutzerliste)',
    settingsLink: 'Sprache & Theme',
    backToProfile: 'Zurück zum Profil',
    language: 'Sprache', theme: 'Theme', useDefault: '(Standard verwenden)',
    yourKeys: 'Deine Schlüssel', pub: 'Signatur-Schlüssel (pub)', epub: 'Verschlüsselungs-Schlüssel (epub)',
    contactAdd: 'Kontakt hinzufügen', contactRemove: 'Kontakt entfernen',
    notFound: 'Diese Identität hat (noch) kein Profil veröffentlicht.',
    savedReloadHint: 'Gespeichert! Lade die Seite neu, um Sprache/Theme zu sehen.',
    reloadNow: 'Jetzt neu laden',
    preview: 'Vorschau (so sehen dich Besucher)',
    notifications: 'Benachrichtigungen',
    notifEnabled: 'Benachrichtigungen aktivieren',
    notifMentions: 'Bei @Erwähnungen benachrichtigen',
    notifPerApp: 'Pro App',
    notifSave: 'Benachrichtigungseinstellungen speichern',
    notifSaved: 'Gespeichert!',
    pushTitle: 'Push-Benachrichtigungen',
    pushEnableDevice: 'Auf diesem Gerät aktivieren',
    pushEnabled: 'Auf diesem Gerät aktiviert',
    pushUnsupported: 'Push-Benachrichtigungen werden von diesem Browser nicht unterstützt.',
    pushNoVapid: 'Dieses Relay hat keine Push-Benachrichtigungen konfiguriert.',
    pushDenied: 'Berechtigung für Benachrichtigungen wurde verweigert.',
    pushFailed: 'Push-Benachrichtigungen konnten nicht aktiviert werden: {message}',
  },
};
const { t } = createI18n(DICT);

const KNOWN_PUBLIC_KEYS = ['pub', 'epub', 'alias', 'avatar', 'template', 'style'];
const TEMPLATES = ['default', 'compact', 'banner'];

const STYLE_ID = 'qu-profile-style';
const STYLE = `
  .qu-profile { max-width: 34rem; display: flex; flex-direction: column; gap: 1rem; }
  .qu-profile-row { display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-profile-row label { font-weight: 600; font-size: 0.9em; }
  .qu-profile input[type="text"], .qu-profile select { padding: 0.5rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); font: inherit; }
  .qu-profile-fields { display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-profile-field-row { display: flex; gap: 0.4rem; align-items: center; }
  .qu-profile-field-row input[type="text"] { flex: 1; }
  .qu-profile button { padding: 0.5rem 0.9rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: transparent; color: inherit; cursor: pointer; font: inherit; }
  .qu-profile button.qu-profile-primary { background: var(--qu-color-accent, #5b5bd6); color: white; border-color: transparent; }
  .qu-profile-keys { font-family: var(--qu-font-mono, ui-monospace, monospace); font-size: 0.85em; opacity: 0.75; word-break: break-all; }
  .qu-profile-status { opacity: 0.7; font-size: 0.9em; }
  .qu-profile-header { display: flex; align-items: center; gap: 0.8rem; }
  .qu-profile-header h1 { margin: 0; }
  .qu-profile-view.qu-template-banner .qu-profile-header { flex-direction: column; text-align: center; padding: 1.5rem; border-radius: var(--qu-radius-md, 0.4rem); background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 12%, transparent); }
  .qu-profile-view.qu-template-compact .qu-profile-header { gap: 0.5rem; }
  .qu-profile-view.qu-template-compact .qu-profile-header h1 { font-size: 1.1em; }
  .qu-profile-not-found { padding: 2rem; text-align: center; opacity: 0.7; }
  .qu-profile-preview-label { font-weight: 600; font-size: 0.9em; }
  .qu-profile-preview { border: 1px dashed var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.8rem; }
  .qu-profile-preview .qu-profile-header h1 { font-size: 1.1em; }
  .qu-profile-settings-reload { display: flex; align-items: center; gap: 0.6rem; }
  .qu-profile-avatar-row { display: flex; align-items: center; gap: 0.6rem; }
  .qu-profile-notif-section { border-top: 1px solid var(--qu-color-border, #8884); padding-top: 0.8rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-profile-notif-check-row { display: flex; align-items: center; gap: 0.5rem; }
  .qu-profile-notif-apps { display: flex; flex-direction: column; gap: 0.4rem; padding-left: 1rem; }
  .qu-profile-push-row { display: flex; align-items: center; gap: 0.6rem; }
`;

/** Shared by `renderPublicProfile()` (the real thing) and `renderOwnProfile()`'s own live preview - so the preview can never drift from what a visitor actually sees. */
function applyTemplateStyle(el, template, style) {
  const validTemplate = TEMPLATES.includes(template) ? template : 'default';
  el.classList.add(`qu-template-${validTemplate}`);
  const stylePreset = THEME_PRESETS[style] || {};
  for (const [prop, value] of Object.entries(stylePreset)) el.style.setProperty(prop, value);
}

/** Same sharing reason as `applyTemplateStyle()` above. */
function renderProfileHeader(pub, label, avatar, avatarSize = '3rem') {
  const header = document.createElement('div');
  header.className = 'qu-profile-header';
  header.appendChild(renderAvatarOrAsset(pub, label, avatar, { size: avatarSize }));
  const headingWrap = document.createElement('div');
  const heading = document.createElement('h1');
  heading.textContent = label;
  headingWrap.appendChild(heading);
  header.appendChild(headingWrap);
  return header;
}

/**
 * A VAPID public key (`@qu/push`'s `generateVapidKeys()`, served at
 * `/push/vapid-public-key`) is base64url-encoded raw EC point bytes - the
 * standard, widely-used conversion `PushManager.subscribe()`'s
 * `applicationServerKey` needs (it wants an actual `Uint8Array`/
 * `BufferSource`, not a string).
 * @param {string} base64Url @returns {Uint8Array}
 */
function urlBase64ToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * The real `PushManager.subscribe()` flow this codebase's own `apps/shell`/
 * `sw.js` doc comments have long deferred as "a separate, larger feature
 * needing its own permission UI" - this IS that UI (Profile Settings, next
 * to every other identity-bound preference). Requests Notification
 * permission (a real user-gesture-gated browser prompt), waits for the
 * ALREADY-registered service worker (`apps/shell`'s own `registerServiceWorker()`
 * already did this at boot - `navigator.serviceWorker.ready` just resolves
 * to that same registration, no new one needed here), fetches this relay's
 * VAPID public key, subscribes, and stores the result via
 * `services.pushSubscriptions` so `@qu/relay`'s `PushDeliveryService` knows
 * where to reach this device.
 * @param {object} services
 * @returns {Promise<PushSubscription>}
 * @throws {Error} If unsupported, permission is denied, or this relay has
 *   no VAPID keys configured - the caller shows the message to the user,
 *   nothing here is silently swallowed (unlike most of this codebase's
 *   OTHER browser-feature-detection, e.g. `pwa.js`'s own - this is a real
 *   user-initiated action with an explicit "did it work?" button, not a
 *   passive background enhancement).
 */
async function subscribeToPush(services) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error(t('pushUnsupported'));
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(t('pushDenied'));

  const registration = await navigator.serviceWorker.ready;
  const res = await fetch('/push/vapid-public-key');
  const { publicKey } = res.ok ? await res.json() : { publicKey: null };
  if (!publicKey) throw new Error(t('pushNoVapid'));

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await services.pushSubscriptions.subscribe(subscription.toJSON());
  return subscription;
}

export function mount(container, { qu, identity, services, segments = [], extensionPoints }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let off = null;

  const root = document.createElement('div');
  // Same "set on an ancestor before descendant Custom Elements connect"
  // discipline `.qu` already requires elsewhere in `@qu/ui` - both
  // `<qu-asset>` (avatar rendering, own AND visitor views) and
  // `<qu-asset-upload>` (own edit form only) resolve this via
  // `findAssetService()`'s ancestor walk.
  root.assetService = services.assets;
  container.appendChild(root);
  // Own saves write to the SAME path this component `watch()`es below (see
  // ProfileService.saveProfile() - it always republishes the public profile
  // document, even when only a private field changed), so every save
  // triggers its own re-render, which throws away and rebuilds the whole
  // form - including whatever DOM node a save button's click handler might
  // otherwise have held onto to flash a "Saved!" message. `saveState` is a
  // mutable flag SHARED by reference between this closure and
  // renderOwnProfile()/renderSettings() below, precisely so "show the flash
  // on the very next render" survives that rebuild: the click handler sets
  // it (synchronously, before awaiting `saveProfile()`) and `render()`
  // reads-then-clears it right before rebuilding.
  const saveState = { justSaved: false };

  (async () => {
    const myPub = await services.actors.whoAmI();
    if (stopped) return;

    const rawFirst = segments[0];
    if (!rawFirst || !rawFirst.startsWith('~')) {
      window.location.hash = `#/~${myPub}`;
      return;
    }
    const targetPub = rawFirst.slice(1);
    const isOwn = targetPub === myPub;
    const isSettings = segments[1] === 'settings';
    if (isSettings && !isOwn) {
      window.location.hash = `#/~${targetPub}`;
      return;
    }

    // `render()` does real async work (getOwnProfile()/isVisible()/
    // getPublicProfile() each hit ProfileService's own background-refresh/
    // syncFetch backfill) BETWEEN being triggered and actually touching the
    // DOM - a live relay can legitimately fire watch()'s callback twice in
    // quick succession (e.g. the initial local read, then a fresher value
    // arriving moments later from ProfileService's own background
    // freshness check - see its own doc comment). Without a guard, two
    // overlapping render() calls both eventually reach `root.append(...)`,
    // and since neither call's OWN await chain gives the other a chance to
    // finish clearing first, BOTH end up appending their own full view on
    // top of each other (confirmed live: two "Add field" buttons on one
    // screen). `renderToken` mirrors the exact monotonic-counter pattern
    // `apps/user-list`'s own `unlistedToken` already uses for the same
    // "only the LATEST of several overlapping async calls may touch the
    // DOM" problem: every render() call gets a fresh token; only the call
    // still holding the latest token when its own async work finishes is
    // allowed to clear+repopulate `root` - an older, superseded call's
    // result is simply discarded, never applied.
    let renderToken = 0;
    async function render() {
      const token = ++renderToken;
      if (stopped) return;
      if (isSettings) {
        const own = await services.profile.getOwnProfile();
        const notifPrefs = await services.notificationPrefs.getOwnPrefs();
        // Only apps that can actually SEND a notification are worth a
        // toggle - filtered here (not left for renderNotifications() to
        // filter) so an empty result means "no per-app row", not "no data
        // yet" from the caller's perspective.
        let installedApps = [];
        try {
          const res = await fetch('/apps.json');
          const all = res.ok ? await res.json() : [];
          installedApps = all.filter((a) => Array.isArray(a.pushActions) && a.pushActions.length > 0);
        } catch { /* offline/unreachable - the per-app section just stays empty, everything else still works */ }
        if (stopped || token !== renderToken) return;
        const justSaved = saveState.justSaved;
        saveState.justSaved = false;
        root.textContent = '';
        const extRoot = renderSettings(root, own, services, myPub, saveState, justSaved, notifPrefs, installedApps);
        // The `userSettings.contributions` extension point (see this file's
        // own top doc comment) - any OTHER app (or a future relay-level
        // settings section) may render its own per-user preferences here,
        // without this file ever importing it. Best-effort: `extensionPoints`
        // is undefined in a context that doesn't provide one (e.g. this
        // app's own unit tests calling mount() directly with a partial ctx),
        // same "optional dependency, no crash" treatment every other
        // best-effort ctx field in this codebase already gets.
        if (extensionPoints) await extensionPoints.renderSlot('userSettings.contributions', extRoot, { myPub, services });
        return;
      }
      if (isOwn) {
        const own = await services.profile.getOwnProfile();
        const listed = await services.directory.isVisible(myPub);
        if (stopped || token !== renderToken) return;
        const justSaved = saveState.justSaved;
        saveState.justSaved = false;
        root.textContent = '';
        renderOwnProfile(root, own, listed, services, myPub, saveState, justSaved);
        return;
      }
      const pub = await services.profile.getPublicProfile(targetPub);
      if (stopped || token !== renderToken) return;
      root.textContent = '';
      if (!pub) {
        const p = document.createElement('p');
        p.className = 'qu-profile-not-found';
        p.textContent = t('notFound');
        root.appendChild(p);
        return;
      }
      renderPublicProfile(root, targetPub, pub, services);
    }

    off = watch(qu, actorPath(targetPub, 'profile'), () => render());
  })();

  return () => {
    stopped = true;
    off?.();
  };
}

function fieldRow(field = { key: '', value: '', visibility: 'public' }) {
  const row = document.createElement('div');
  row.className = 'qu-profile-field-row';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = t('fieldKey');
  keyInput.value = field.key;

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = t('fieldValue');
  valueInput.value = field.value;

  const visibility = document.createElement('select');
  for (const [value, label] of [['public', t('fieldPublic')], ['private', t('fieldPrivate')]]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    visibility.appendChild(opt);
  }
  visibility.value = field.visibility;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = t('removeField');
  removeBtn.addEventListener('click', () => row.remove());

  row.append(keyInput, valueInput, visibility, removeBtn);
  row.qu_key = keyInput;
  row.qu_value = valueInput;
  row.qu_visibility = visibility;
  return row;
}

function renderOwnProfile(root, own, listed, services, myPub, saveState, justSaved) {
  const view = document.createElement('div');
  view.className = 'qu-profile qu-profile-own';

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const aliasRow = labeledInput(t('alias'), own.alias, t('aliasPlaceholder'));
  const avatarRow = labeledInput(t('avatar'), own.avatar);
  avatarRow.row.className = 'qu-profile-row qu-profile-avatar-row';
  const avatarUpload = document.createElement('qu-asset-upload');
  avatarUpload.setAttribute('space-id', myPub); // this identity's own pub - a personal, always-unique asset namespace, see this file's own top doc comment
  avatarUpload.setAttribute('label', '📷');
  avatarRow.row.appendChild(avatarUpload);

  const templateRow = document.createElement('div');
  templateRow.className = 'qu-profile-row';
  const templateLabel = document.createElement('label');
  templateLabel.textContent = t('template');
  const templateSelect = document.createElement('select');
  for (const name of TEMPLATES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = t(`template${name[0].toUpperCase()}${name.slice(1)}`);
    templateSelect.appendChild(opt);
  }
  templateSelect.value = own.template || 'default';
  templateRow.append(templateLabel, templateSelect);

  const styleRow = document.createElement('div');
  styleRow.className = 'qu-profile-row';
  const styleLabel = document.createElement('label');
  styleLabel.textContent = t('style');
  const styleSelect = document.createElement('select');
  for (const name of Object.keys(THEME_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    styleSelect.appendChild(opt);
  }
  styleSelect.value = own.style || 'default';
  styleRow.append(styleLabel, styleSelect);

  // Live preview - updates on every keystroke/select change, no save
  // needed, using the SAME `applyTemplateStyle()`/`renderProfileHeader()`
  // `renderPublicProfile()` itself renders with, so it can never drift from
  // what a visitor actually sees. See this file's own top doc comment on
  // why this exists: `#/~<myOwnPub>` never renders `renderPublicProfile()`
  // for its own owner, so without this the owner could never see their own
  // template/style take effect at all, not even after a reload.
  const previewLabel = document.createElement('label');
  previewLabel.className = 'qu-profile-preview-label';
  previewLabel.textContent = t('preview');
  const previewBox = document.createElement('div');
  previewBox.className = 'qu-profile-preview';
  function updatePreview() {
    previewBox.textContent = '';
    const inner = document.createElement('div');
    inner.className = 'qu-profile-view';
    applyTemplateStyle(inner, templateSelect.value, styleSelect.value);
    const label = formatActorLabel(myPub, { alias: aliasRow.input.value.trim() });
    inner.appendChild(renderProfileHeader(myPub, label, avatarRow.input.value, '2.2rem'));
    previewBox.appendChild(inner);
  }
  updatePreview();
  aliasRow.input.addEventListener('input', updatePreview);
  avatarRow.input.addEventListener('input', updatePreview);
  templateSelect.addEventListener('change', updatePreview);
  styleSelect.addEventListener('change', updatePreview);
  // A successful LOCAL upload (see `<qu-asset-upload>`'s own doc comment -
  // this fires before sync-out verification even starts) updates the SAME
  // `avatar` text field an upload is meant to replace, not a separate
  // hidden field - Save still just reads `avatarRow.input.value`, unchanged.
  let lastUploadedAvatarAssetId = null;
  avatarUpload.addEventListener('qu-asset-uploaded', (e) => {
    lastUploadedAvatarAssetId = e.detail.assetId;
    avatarRow.input.value = `${ASSET_AVATAR_PREFIX}${e.detail.assetId}`;
    updatePreview();
  });

  const fieldsHeading = document.createElement('label');
  fieldsHeading.textContent = t('fields');
  const fieldsList = document.createElement('div');
  fieldsList.className = 'qu-profile-fields';
  for (const field of own.fields) fieldsList.appendChild(fieldRow(field));
  const addFieldBtn = document.createElement('button');
  addFieldBtn.type = 'button';
  addFieldBtn.textContent = t('addField');
  addFieldBtn.addEventListener('click', () => fieldsList.appendChild(fieldRow()));

  const status = document.createElement('span');
  status.className = 'qu-profile-status';
  // See mount()'s own doc comment on `saveState`: this save always
  // republishes the public profile document, which triggers this same
  // component's own watch()-driven re-render - by the time that happens,
  // THIS `status` node is already gone, so the flash lives in `saveState`
  // (read by the NEXT render()) rather than being set directly here.
  if (justSaved) {
    status.textContent = t('saved');
    setTimeout(() => { status.textContent = ''; }, 1500);
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'qu-profile-primary';
  saveBtn.textContent = t('save');
  saveBtn.addEventListener('click', async () => {
    const fields = [...fieldsList.querySelectorAll('.qu-profile-field-row')]
      .map((row) => ({ key: row.qu_key.value.trim(), value: row.qu_value.value, visibility: row.qu_visibility.value }))
      .filter((f) => f.key);
    saveState.justSaved = true;
    await services.profile.saveProfile({
      alias: aliasRow.input.value,
      avatar: avatarRow.input.value,
      template: templateSelect.value,
      style: styleSelect.value,
      fields,
      preferredLocale: own.preferredLocale,
      preferredTheme: own.preferredTheme,
    });
    // Only now, once the freshly uploaded avatar is genuinely part of a
    // saved profile, does its (deferred) sync-out verification phase start
    // - see <qu-asset-upload>'s own doc comment on confirmSent() for why.
    // Guarded against the field having been hand-edited/cleared after the
    // upload but before Save - confirmSent()'s own assetId match already
    // covers a NEWER upload replacing this one, this covers the field
    // simply no longer pointing at it at all.
    if (lastUploadedAvatarAssetId && avatarRow.input.value === `${ASSET_AVATAR_PREFIX}${lastUploadedAvatarAssetId}`) {
      avatarUpload.confirmSent(lastUploadedAvatarAssetId);
    }
  });

  const listedLabel = document.createElement('label');
  const listedCheckbox = document.createElement('input');
  listedCheckbox.type = 'checkbox';
  listedCheckbox.checked = listed;
  listedCheckbox.addEventListener('change', () => services.directory.setVisible(listedCheckbox.checked));
  listedLabel.append(listedCheckbox, document.createTextNode(t('listedInDirectory')));

  const settingsLink = document.createElement('a');
  settingsLink.href = `#/~${myPub}/settings`;
  settingsLink.textContent = t('settingsLink');

  const keysBlock = document.createElement('div');
  keysBlock.className = 'qu-profile-keys';
  keysBlock.innerHTML = `<div>${t('pub')}: ${own.pub}</div><div>${t('epub')}: ${own.epub}</div>`;

  view.append(
    heading, aliasRow.row, avatarRow.row, templateRow, styleRow,
    previewLabel, previewBox,
    fieldsHeading, fieldsList, addFieldBtn,
    saveBtn, status,
    listedLabel, settingsLink, keysBlock
  );
  root.appendChild(view);
}

function labeledInput(label, value, placeholder = '') {
  const row = document.createElement('div');
  row.className = 'qu-profile-row';
  const labelEl = document.createElement('label');
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  if (placeholder) input.placeholder = placeholder;
  row.append(labelEl, input);
  return { row, input };
}

function renderSettings(root, own, services, myPub, saveState, justSaved, notifPrefs, installedApps) {
  const view = document.createElement('div');
  view.className = 'qu-profile qu-profile-settings';

  const heading = document.createElement('h1');
  heading.textContent = t('settingsLink');

  const localeRow = document.createElement('div');
  localeRow.className = 'qu-profile-row';
  const localeLabel = document.createElement('label');
  localeLabel.textContent = t('language');
  const localeSelect = document.createElement('select');
  const defaultLocaleOpt = document.createElement('option');
  defaultLocaleOpt.value = '';
  defaultLocaleOpt.textContent = t('useDefault');
  localeSelect.appendChild(defaultLocaleOpt);
  for (const { code, label } of AVAILABLE_LOCALES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    localeSelect.appendChild(opt);
  }
  localeSelect.value = own.preferredLocale || '';
  localeRow.append(localeLabel, localeSelect);

  const themeRow = document.createElement('div');
  themeRow.className = 'qu-profile-row';
  const themeLabel = document.createElement('label');
  themeLabel.textContent = t('theme');
  const themeSelect = document.createElement('select');
  const defaultThemeOpt = document.createElement('option');
  defaultThemeOpt.value = '';
  defaultThemeOpt.textContent = t('useDefault');
  themeSelect.appendChild(defaultThemeOpt);
  for (const name of Object.keys(THEME_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    themeSelect.appendChild(opt);
  }
  themeSelect.value = own.preferredTheme || '';
  themeRow.append(themeLabel, themeSelect);

  const status = document.createElement('span');
  status.className = 'qu-profile-status';
  const reloadRow = document.createElement('div');
  reloadRow.className = 'qu-profile-settings-reload';
  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = t('reloadNow');
  reloadBtn.hidden = true;
  reloadBtn.addEventListener('click', () => window.location.reload());
  reloadRow.append(status, reloadBtn);
  // See mount()'s/renderOwnProfile()'s own doc comments on `saveState` -
  // this save also republishes the public profile document, so this is
  // shown on the NEXT render(), not set directly on this soon-to-be-
  // discarded `status`/`reloadBtn` pair. Deliberately NOT auto-clearing
  // (unlike renderOwnProfile()'s own transient "Saved!" flash) - the user
  // still needs to actually reload to see the language/theme change take
  // effect (see this file's own top doc comment), so the prompt stays
  // until they do, or navigate away.
  if (justSaved) {
    status.textContent = t('savedReloadHint');
    reloadBtn.hidden = false;
  }

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'qu-profile-primary';
  saveBtn.textContent = t('save');
  saveBtn.addEventListener('click', async () => {
    const preferredLocale = localeSelect.value || null;
    const preferredTheme = themeSelect.value || null;
    saveState.justSaved = true;
    await services.profile.saveProfile({
      alias: own.alias,
      avatar: own.avatar,
      template: own.template,
      style: own.style,
      fields: own.fields,
      preferredLocale,
      preferredTheme,
    });
    // Persisted for the NEXT page load (see this file's own top doc
    // comment - neither @qu/i18n's locale nor @qu/ui's theme has any live
    // effect on the currently running page, by design in both packages).
    setLocale(preferredLocale);
    setStoredTheme(preferredTheme);
  });

  const notifSection = renderNotificationsSection(services, notifPrefs, installedApps);

  // The `userSettings.contributions` extension point's mount container -
  // left empty here on purpose, filled (if at all) by the caller's own
  // `extensionPoints.renderSlot()` call once this function returns (see
  // `mount()`'s own doc comment on why that stays a caller concern: this
  // function has no `extensionPoints` of its own, and shouldn't need one
  // just to know WHERE a contribution belongs).
  const extRoot = document.createElement('div');
  extRoot.className = 'qu-profile-ext-settings';

  const backLink = document.createElement('a');
  backLink.href = `#/~${myPub}`;
  backLink.textContent = t('backToProfile');

  view.append(heading, localeRow, themeRow, saveBtn, reloadRow, notifSection, extRoot, backLink);
  root.appendChild(view);
  return extRoot;
}

/**
 * The granular "diverse apps" notification preferences (`@qu/services`'
 * `NotificationPrefsService` - see its own doc comment for why it's
 * public/signed, not encrypted) plus the real `PushManager.subscribe()`
 * flow (`subscribeToPush()` above). Self-contained on purpose: unlike
 * `renderSettings()`'s language/theme fields, saving here does NOT
 * re-trigger this component's own `watch()`-driven re-render (notification
 * prefs live at a different path than the profile document that `watch()`
 * actually watches - see `mount()`'s own `watch()` call), so there is no
 * "the DOM I'm about to flash a status on is already gone" race to guard
 * against the way `renderOwnProfile()`/`renderSettings()`'s own shared
 * `saveState` trick does for profile saves. A plain local "Saved!" flash
 * suffices.
 * @param {object} services
 * @param {{enabled: boolean, mentions: boolean, apps: Record<string, {enabled?: boolean}>}} notifPrefs
 * @param {Array<{name: string, label?: string}>} installedApps - Every
 *   catalog entry that declares at least one `pushActions` entry (already
 *   filtered by the caller - see `render()`'s own doc comment on why).
 * @returns {HTMLElement}
 */
function renderNotificationsSection(services, notifPrefs, installedApps) {
  const section = document.createElement('div');
  section.className = 'qu-profile-notif-section';

  const heading = document.createElement('h2');
  heading.textContent = t('notifications');

  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'qu-profile-notif-check-row';
  const enabledCheckbox = document.createElement('input');
  enabledCheckbox.type = 'checkbox';
  enabledCheckbox.checked = notifPrefs.enabled;
  enabledLabel.append(enabledCheckbox, document.createTextNode(t('notifEnabled')));

  const mentionsLabel = document.createElement('label');
  mentionsLabel.className = 'qu-profile-notif-check-row';
  const mentionsCheckbox = document.createElement('input');
  mentionsCheckbox.type = 'checkbox';
  mentionsCheckbox.checked = notifPrefs.mentions;
  mentionsLabel.append(mentionsCheckbox, document.createTextNode(t('notifMentions')));

  const appsHeading = document.createElement('label');
  appsHeading.textContent = t('notifPerApp');
  const appsList = document.createElement('div');
  appsList.className = 'qu-profile-notif-apps';
  /** @type {Array<{name: string, checkbox: HTMLInputElement}>} */
  const appCheckboxes = [];
  for (const app of installedApps) {
    const label = document.createElement('label');
    label.className = 'qu-profile-notif-check-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    // Default true (no entry yet, or `enabled` unset) - matches
    // NotificationPrefsService.shouldNotify()'s own default-open reading
    // of a per-app override (`appPrefs?.enabled === false` is the only
    // thing that turns it off).
    checkbox.checked = notifPrefs.apps?.[app.name]?.enabled !== false;
    label.append(checkbox, document.createTextNode(app.label ?? app.name));
    appsList.appendChild(label);
    appCheckboxes.push({ name: app.name, checkbox });
  }

  const notifStatus = document.createElement('span');
  notifStatus.className = 'qu-profile-status qu-profile-notif-status';
  const notifSaveBtn = document.createElement('button');
  notifSaveBtn.type = 'button';
  notifSaveBtn.textContent = t('notifSave');
  notifSaveBtn.addEventListener('click', async () => {
    const apps = {};
    for (const { name, checkbox } of appCheckboxes) apps[name] = { enabled: checkbox.checked };
    await services.notificationPrefs.savePrefs({ enabled: enabledCheckbox.checked, mentions: mentionsCheckbox.checked, apps });
    notifStatus.textContent = t('notifSaved');
    setTimeout(() => { notifStatus.textContent = ''; }, 1500);
  });

  const pushHeading = document.createElement('label');
  pushHeading.textContent = t('pushTitle');
  const pushRow = document.createElement('div');
  pushRow.className = 'qu-profile-push-row';
  const pushBtn = document.createElement('button');
  pushBtn.type = 'button';
  pushBtn.textContent = t('pushEnableDevice');
  const pushStatus = document.createElement('span');
  pushStatus.className = 'qu-profile-status';
  pushRow.append(pushBtn, pushStatus);

  // Best-effort, matching this codebase's own "an optional browser
  // feature degrades gracefully" convention (see e.g. pwa.js) - checking
  // for an ALREADY-active subscription on THIS device is read-only and
  // needs no user gesture, unlike subscribing itself.
  (async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        pushBtn.hidden = true;
        pushStatus.textContent = t('pushEnabled');
      }
    } catch { /* ignore - the button just stays in its default "not yet enabled" state */ }
  })();

  pushBtn.addEventListener('click', async () => {
    pushBtn.disabled = true;
    pushStatus.textContent = '';
    try {
      await subscribeToPush(services);
      pushBtn.hidden = true;
      pushStatus.textContent = t('pushEnabled');
    } catch (err) {
      pushStatus.textContent = t('pushFailed', { message: err.message });
      pushBtn.disabled = false;
    }
  });

  section.append(heading, enabledLabel, mentionsLabel, appsHeading, appsList, notifSaveBtn, notifStatus, pushHeading, pushRow);
  return section;
}

function renderPublicProfile(root, pub, profile, services) {
  const view = document.createElement('div');
  view.className = 'qu-profile qu-profile-view';
  applyTemplateStyle(view, profile.template, profile.style);

  const label = formatActorLabel(pub, profile);
  const header = renderProfileHeader(pub, label, profile.avatar);

  const fieldsBlock = document.createElement('div');
  fieldsBlock.className = 'qu-profile-fields';
  for (const [key, value] of Object.entries(profile)) {
    if (KNOWN_PUBLIC_KEYS.includes(key)) continue;
    const row = document.createElement('div');
    row.className = 'qu-profile-row';
    const l = document.createElement('label');
    l.textContent = key;
    const v = document.createElement('span');
    v.textContent = value;
    row.append(l, v);
    fieldsBlock.appendChild(row);
  }

  const contactToggle = renderFlagToggle({
    flags: {
      hasPrivate: () => services.contacts.isContact(pub),
      setPrivate: (_ft, _ek, _er, on) => (on ? services.contacts.addContact(pub) : services.contacts.removeContact(pub)),
    },
    flagType: 'favorite', entityKind: 'user', entityRef: pub,
    icon: '☆', activeIcon: '★', title: t('contactAdd'), activeTitle: t('contactRemove'),
  });

  const keysBlock = document.createElement('div');
  keysBlock.className = 'qu-profile-keys';
  keysBlock.innerHTML = `<div>${t('pub')}: ${profile.pub}</div><div>${t('epub')}: ${profile.epub}</div>`;

  view.append(header, fieldsBlock, contactToggle, keysBlock);
  root.appendChild(view);
}
