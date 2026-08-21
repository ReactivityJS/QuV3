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
 *   - `#/~<pub>/settings` - language/theme/template/style/directory
 *     preferences, own profile only (redirects back to the plain view for
 *     anyone else's pub).
 *   - Reactive via `watch(qu, actorPath(pub, 'profile'), ...)` (same as
 *     QuV2) - re-renders live on sync updates, including this session's
 *     own saves.
 *
 * SAME SHAPE FOR OWN AND FOREIGN PROFILES: the own-profile view used to be a
 * plain settings-style form (a stack of labeled inputs/selects, a separate
 * live "preview" box so the owner could see what a visitor sees) that
 * looked nothing like `renderPublicProfile()`. Both now share ONE header
 * renderer (`renderIdentityHeader()` below) - avatar, alias, pub/epub - so
 * the owner's own page IS the same view a visitor gets, just with a few
 * pieces made directly interactive (click the avatar to upload a new one,
 * click the alias to edit it) instead of a separate edit form floating
 * above a separate preview of the real thing. `template`/`style` are
 * applied to the owner's own view exactly the same way
 * (`applyTemplateStyle()`) as to a visitor's - no more "preview" needed,
 * because the real page already looks like what a visitor sees.
 *
 * WHAT MOVED TO SETTINGS: `template`/`style` (purely cosmetic, own-eyes-only
 * preferences about how VISITORS see this profile) and "listed in
 * directory" (a visibility preference, not profile DATA) now live on
 * `#/~<pub>/settings` next to language/theme - not on the main profile page,
 * which now only ever shows the same core fields every profile (own or
 * foreign) has: alias, avatar, pub/epub, custom fields. Settings keeps its
 * own small live preview (reusing `applyTemplateStyle()`) so template/style
 * changes are still easy to see before saving, without cluttering the main
 * page with a second copy of the same header.
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
 * controls. An explicit, persistent (non-auto-clearing) "reload to apply"
 * prompt + button follows a Settings save, instead of a misleading status
 * flash implying it already happened.
 *
 * AVATAR UPLOAD: the `avatar` field stays the SAME plain string it always
 * was (an emoji, an `https://` image URL, or a THIRD shape:
 * `asset:<assetId>`, an uploaded file via `@qu/services`' `AssetService` -
 * `@qu/engines`' `AssetEngine` doing the actual chunking/hashing/dedup/sync
 * retry, see either's own doc comment). On the OWN profile it's uploaded by
 * clicking the avatar itself - a `<qu-asset-upload hide-picker>` sits
 * invisibly over the avatar badge (`renderIdentityHeader()` below), and a
 * click anywhere on the badge opens the native file picker via its
 * `openPicker()` method. Stored under THIS identity's OWN pub as the asset
 * `spaceId` (`services.assets.upload(myPub, assetId, file)`) - a personal,
 * always-unique-per-identity namespace, distinct from any app's own
 * `manifest.spaceId`. Rendered via `@qu/ui`'s `renderAvatarOrAsset()`, which
 * branches on the `asset:` prefix and renders a `<qu-asset kind="image">`
 * instead, falling back to the plain URL/emoji/unset `renderAvatar()`
 * otherwise - `root.assetService` is set once in `mount()` (same "set on an
 * ancestor before children connect" discipline `.qu` already requires) so
 * both this app's own header AND a VISITOR's read-only view
 * (`renderPublicProfile()`) can resolve it. A picked file is uploaded and
 * shown immediately (no save required to preview it locally) but only
 * becomes part of the actual profile once the fields Save button below is
 * clicked - same "local write is durable, sync-out verification deferred
 * until actually sent" flow `<qu-asset-upload>`'s own doc comment describes.
 *
 * ALIAS EDITING: rendered as a real `<input>` styled to look like a plain
 * heading until hovered/focused (no separate "Edit" button/mode toggle
 * needed - clicking it just works, the same "click text to edit it"
 * interaction the avatar gets). Still only actually saved by the same Save
 * button as the custom fields below it - editing the alias is instant
 * visually, but not persisted until Save, exactly like every other field on
 * this form always worked.
 *
 * COPY PUB/EPUB ON CLICK: both keys, on both the owner's own view and a
 * visitor's, are rendered via `copyableKeyRow()` below - a best-effort
 * `copyToClipboard()` (`@qu/thread-ui`, the same helper Forum/Chat/Todo's
 * own "Copy" menu items already use) on click, with a small transient
 * "Copied!" confirmation next to the key. No error surface on failure (e.g.
 * no clipboard permission) - same silent-degrade convention every OTHER
 * best-effort browser feature in this codebase already follows.
 *
 * CONTACT ACTION IN A CONTEXT MENU: a visitor's read-only view used to show
 * a bare star-icon toggle button for add/remove contact. It's now inside a
 * real "⋮" context menu (`renderContextMenu()`, `@qu/thread-ui` - the SAME
 * component Forum/Chat already use for their own per-message menus) with a
 * single "Add contact"/"Remove contact" item, computed fresh every time the
 * menu opens (so it can never show a stale add/remove label) - room left
 * for a future action to join it there without a layout change.
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
 * language/theme/template/style/directory/notifications/push sections above
 * stay hard-coded here because they're intrinsic to what "profile settings"
 * already means, not because the mechanism couldn't cover them too.
 *
 * NOT USING `qu-bind`/`qu-view`/`mountAppTemplate()`: this screen has no
 * list of children to stamp (`<qu-list>`'s own use case) and no
 * navigation/views tabs to switch between (`mountAppTemplate()`'s own use
 * case) - a single reactive document, rendered and re-rendered as plain DOM
 * on every `watch()` tick, is the SAME pattern most other screens in this
 * codebase already use for exactly this shape of screen (see
 * `docs/api-reference.md` §6 - `qu-*` custom elements are for a curated/
 * derived list or a single bound field, neither of which this screen has).
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
import { injectStyle, ensureTheme, renderAvatarOrAsset, ASSET_AVATAR_PREFIX, THEME_PRESETS, setStoredTheme, renderSubpage } from '@qu/ui';
import { formatActorLabel } from '@qu/services';
import { renderContextMenu, copyToClipboard } from '@qu/thread-ui';

const DICT = {
  en: {
    title: 'Profile',
    alias: 'Alias',
    aliasPlaceholder: 'How others see you (defaults to your public key if left empty)',
    avatar: 'Avatar',
    avatarChangeTitle: 'Click to change avatar',
    template: 'Template',
    style: 'Style',
    templateDefault: 'Default', templateCompact: 'Compact', templateBanner: 'Banner',
    save: 'Save', saved: 'Saved!',
    fields: 'Custom fields', fieldKey: 'Label', fieldValue: 'Value', fieldPublic: 'Public', fieldPrivate: 'Private (only you)',
    addField: 'Add field', removeField: 'Remove',
    listedInDirectory: 'Listed in directory (visible to the User List)',
    settingsLink: 'Settings',
    language: 'Language', theme: 'Theme', useDefault: '(use default)',
    pub: 'Signing key (pub)', epub: 'Encryption key (epub)',
    clickToCopy: 'Click to copy', copied: 'Copied!',
    actions: 'Actions',
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
    avatar: 'Avatar',
    avatarChangeTitle: 'Klicken, um den Avatar zu ändern',
    template: 'Vorlage',
    style: 'Stil',
    templateDefault: 'Standard', templateCompact: 'Kompakt', templateBanner: 'Banner',
    save: 'Speichern', saved: 'Gespeichert!',
    fields: 'Eigene Felder', fieldKey: 'Bezeichnung', fieldValue: 'Wert', fieldPublic: 'Öffentlich', fieldPrivate: 'Privat (nur du)',
    addField: 'Feld hinzufügen', removeField: 'Entfernen',
    listedInDirectory: 'Im Verzeichnis gelistet (sichtbar in der Nutzerliste)',
    settingsLink: 'Einstellungen',
    language: 'Sprache', theme: 'Theme', useDefault: '(Standard verwenden)',
    pub: 'Signatur-Schlüssel (pub)', epub: 'Verschlüsselungs-Schlüssel (epub)',
    clickToCopy: 'Klicken zum Kopieren', copied: 'Kopiert!',
    actions: 'Aktionen',
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
  .qu-profile { max-width: 100%; display: flex; flex-direction: column; gap: 1.1rem; position: relative; }
  .qu-profile-row { display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-profile-row label { font-weight: 600; font-size: 0.9em; }
  .qu-profile input[type="text"], .qu-profile select { padding: 0.5rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); font: inherit; }
  .qu-profile-fields { display: flex; flex-direction: column; gap: 0.5rem; }
  .qu-profile-field-row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  .qu-profile-field-row input[type="text"] { flex: 1; min-width: 6rem; }
  .qu-profile button { padding: 0.5rem 0.9rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: transparent; color: inherit; cursor: pointer; font: inherit; }
  .qu-profile button.qu-profile-primary { background: var(--qu-color-accent, #5b5bd6); color: white; border-color: transparent; }
  .qu-profile-status { opacity: 0.7; font-size: 0.9em; }
  .qu-profile-not-found { padding: 2rem; text-align: center; opacity: 0.7; }

  /* Shared identity header - own AND foreign profiles render the SAME
     structure, mobile-first (stacked-friendly flex, wraps naturally on
     narrow screens; widened/centered under the desktop media query below). */
  .qu-profile-header { display: flex; align-items: center; gap: 0.9rem; }
  .qu-profile-avatar-wrap { position: relative; flex-shrink: 0; }
  .qu-profile-avatar-editable { cursor: pointer; }
  .qu-profile-avatar-editable qu-asset-upload { position: absolute; inset: 0; opacity: 0; }
  .qu-profile-avatar-badge { position: absolute; right: -0.15rem; bottom: -0.15rem; width: 1.4rem; height: 1.4rem; display: flex; align-items: center; justify-content: center; font-size: 0.75em; background: var(--qu-color-accent, #5b5bd6); color: #fff; border-radius: 999px; box-shadow: 0 0 0 2px canvas; pointer-events: none; }
  .qu-profile-header-info { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .qu-profile-header-info h1 { margin: 0; font-size: 1.25em; }
  .qu-profile-alias-input { font: inherit; font-size: 1.25em; font-weight: 700; border: 1px solid transparent; background: transparent; color: inherit; padding: 0.1rem 0.35rem; margin: 0 0 0 -0.35rem; border-radius: var(--qu-radius-sm, 0.3rem); width: 100%; box-sizing: border-box; }
  .qu-profile-alias-input:hover, .qu-profile-alias-input:focus { border-color: var(--qu-color-border, #8884); outline: none; }
  .qu-profile-keys { display: flex; flex-direction: column; gap: 0.1rem; font-family: var(--qu-font-mono, ui-monospace, monospace); font-size: 0.78em; opacity: 0.8; }
  .qu-profile-key-row { display: flex; gap: 0.4rem; align-items: baseline; cursor: pointer; word-break: break-all; }
  .qu-profile-key-row:hover { opacity: 1; text-decoration: underline dotted; }
  .qu-profile-key-label { opacity: 0.7; flex-shrink: 0; }
  .qu-profile-key-copied { color: var(--qu-color-success, #3fb950); font-family: inherit; }

  .qu-profile-menu { position: absolute; top: 0; right: 0; }

  .qu-profile-view.qu-template-banner .qu-profile-header { flex-direction: column; text-align: center; padding: 1.5rem; border-radius: var(--qu-radius-md, 0.4rem); background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 12%, transparent); }
  .qu-profile-view.qu-template-banner .qu-profile-keys { align-items: center; }
  .qu-profile-view.qu-template-compact .qu-profile-header { gap: 0.5rem; }
  .qu-profile-view.qu-template-compact .qu-profile-header h1, .qu-profile-view.qu-template-compact .qu-profile-alias-input { font-size: 1.05em; }

  .qu-profile-preview-label { font-weight: 600; font-size: 0.9em; }
  .qu-profile-preview { border: 1px dashed var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.8rem; }
  .qu-profile-preview .qu-profile-header h1 { font-size: 1.1em; }
  .qu-profile-settings-reload { display: flex; align-items: center; gap: 0.6rem; }
  .qu-profile-notif-section { border-top: 1px solid var(--qu-color-border, #8884); padding-top: 0.8rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .qu-profile-notif-check-row { display: flex; align-items: center; gap: 0.5rem; }
  .qu-profile-notif-apps { display: flex; flex-direction: column; gap: 0.4rem; padding-left: 1rem; }
  .qu-profile-push-row { display: flex; align-items: center; gap: 0.6rem; }

  /* Desktop: the mobile-first rules above already work full-width on a
     phone; widen/center the column and give the header a bit more room once
     there's space for it, same 640px "settled tablet-and-up" breakpoint
     docs/app-navigation-standard.md's own examples use elsewhere. */
  @media (min-width: 640px) {
    .qu-profile { max-width: 34rem; margin: 0 auto; }
    .qu-profile-header { gap: 1.2rem; }
    .qu-profile-header-info h1, .qu-profile-alias-input { font-size: 1.4em; }
  }
`;

/** Shared by `renderPublicProfile()` (the real thing) and `renderSettings()`'s own live preview - so the preview can never drift from what a visitor actually sees. */
function applyTemplateStyle(el, template, style) {
  const validTemplate = TEMPLATES.includes(template) ? template : 'default';
  el.classList.add(`qu-template-${validTemplate}`);
  const stylePreset = THEME_PRESETS[style] || {};
  for (const [prop, value] of Object.entries(stylePreset)) el.style.setProperty(prop, value);
}

/**
 * One row of a pub/epub key - click (or Enter/Space) copies the full value
 * via `copyToClipboard()`, showing a small transient "Copied!" next to it.
 * Best-effort, same silent-degrade convention as every other browser
 * feature in this codebase - a failed copy just never shows the confirmation.
 */
function copyableKeyRow(label, value) {
  const row = document.createElement('div');
  row.className = 'qu-profile-key-row';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.title = t('clickToCopy');

  const labelEl = document.createElement('span');
  labelEl.className = 'qu-profile-key-label';
  labelEl.textContent = `${label}:`;
  const valueEl = document.createElement('span');
  valueEl.className = 'qu-profile-key-value';
  valueEl.textContent = value;
  const statusEl = document.createElement('span');
  statusEl.className = 'qu-profile-key-copied';
  row.append(labelEl, valueEl, statusEl);

  async function doCopy() {
    if (await copyToClipboard(value)) {
      statusEl.textContent = t('copied');
      setTimeout(() => { statusEl.textContent = ''; }, 1200);
    }
  }
  row.addEventListener('click', doCopy);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCopy(); }
  });
  return row;
}

/**
 * The ONE header shared by the owner's own profile and a visitor's read-only
 * view (see this file's own top doc comment on why there's no longer a
 * separate "preview" - this IS the real thing). `editable: true` (own
 * profile only) turns the avatar into a click-to-upload badge and the alias
 * into a click-to-edit input; either way the pub/epub rows below are always
 * `copyableKeyRow()`s.
 * @returns {{header: HTMLElement, avatarUpload: HTMLElement|null, aliasInput: HTMLInputElement|null, setAvatarDisplay: (value: string) => void}}
 */
function renderIdentityHeader({ pub, epub, alias, avatar, editable, avatarSize = '3.4rem' }) {
  const header = document.createElement('div');
  header.className = 'qu-profile-header';

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'qu-profile-avatar-wrap';
  avatarWrap.appendChild(renderAvatarOrAsset(pub, alias || pub, avatar, { size: avatarSize }));
  function setAvatarDisplay(value) {
    avatarWrap.replaceChild(renderAvatarOrAsset(pub, alias || pub, value, { size: avatarSize }), avatarWrap.children[0]);
  }

  let avatarUpload = null;
  if (editable) {
    avatarWrap.classList.add('qu-profile-avatar-editable');
    avatarWrap.title = t('avatarChangeTitle');
    avatarWrap.tabIndex = 0;
    avatarWrap.setAttribute('role', 'button');
    avatarUpload = document.createElement('qu-asset-upload');
    avatarUpload.setAttribute('space-id', pub); // this identity's own pub - a personal, always-unique asset namespace
    avatarUpload.setAttribute('hide-picker', '');
    avatarWrap.appendChild(avatarUpload);
    const badge = document.createElement('span');
    badge.className = 'qu-profile-avatar-badge';
    badge.textContent = '📷';
    badge.setAttribute('aria-hidden', 'true');
    avatarWrap.appendChild(badge);
    const openPicker = () => avatarUpload.openPicker();
    avatarWrap.addEventListener('click', openPicker);
    avatarWrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
    });
  }

  const info = document.createElement('div');
  info.className = 'qu-profile-header-info';

  let aliasInput = null;
  if (editable) {
    aliasInput = document.createElement('input');
    aliasInput.type = 'text';
    aliasInput.className = 'qu-profile-alias-input';
    aliasInput.value = alias ?? '';
    aliasInput.placeholder = t('aliasPlaceholder');
    aliasInput.setAttribute('aria-label', t('alias'));
    info.appendChild(aliasInput);
  } else {
    const heading = document.createElement('h1');
    heading.textContent = alias;
    info.appendChild(heading);
  }

  const keysWrap = document.createElement('div');
  keysWrap.className = 'qu-profile-keys';
  keysWrap.appendChild(copyableKeyRow(t('pub'), pub));
  if (epub) keysWrap.appendChild(copyableKeyRow(t('epub'), epub));
  info.appendChild(keysWrap);

  header.append(avatarWrap, info);
  return { header, avatarUpload, aliasInput, setAvatarDisplay };
}

/** Small, self-contained header used ONLY by the Settings-page template/style live preview (`renderSettings()` below) - deliberately simpler than `renderIdentityHeader()`, no upload/copy/edit affordances, since it's a read-only illustration of "how the real header will look", not the real header itself. */
function renderPreviewHeader(pub, label, avatar) {
  const header = document.createElement('div');
  header.className = 'qu-profile-header';
  header.appendChild(renderAvatarOrAsset(pub, label, avatar, { size: '2.2rem' }));
  const heading = document.createElement('h1');
  heading.textContent = label;
  header.appendChild(heading);
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
  // `<qu-asset-upload>` (own header only) resolve this via
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
        const listed = await services.directory.isVisible(myPub);
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
        const extRoot = renderSettings(root, own, listed, services, myPub, saveState, justSaved, notifPrefs, installedApps);
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
        if (stopped || token !== renderToken) return;
        const justSaved = saveState.justSaved;
        saveState.justSaved = false;
        root.textContent = '';
        renderOwnProfile(root, own, services, myPub, saveState, justSaved);
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

function renderOwnProfile(root, own, services, myPub, saveState, justSaved) {
  const view = document.createElement('div');
  view.className = 'qu-profile qu-profile-own qu-profile-view';
  // The owner's own page now looks exactly like a visitor's (see this
  // file's own top doc comment) - template/style are applied here too,
  // there is no separate "preview" of them anymore.
  applyTemplateStyle(view, own.template, own.style);

  const { header, avatarUpload, aliasInput, setAvatarDisplay } = renderIdentityHeader({
    pub: myPub, epub: own.epub, alias: own.alias, avatar: own.avatar, editable: true,
  });

  // A successful LOCAL upload (see `<qu-asset-upload>`'s own doc comment -
  // this fires before sync-out verification even starts) updates the live
  // header display immediately; Save still just reads `avatarValue`.
  let avatarValue = own.avatar ?? '';
  let lastUploadedAvatarAssetId = null;
  avatarUpload.addEventListener('qu-asset-uploaded', (e) => {
    lastUploadedAvatarAssetId = e.detail.assetId;
    avatarValue = `${ASSET_AVATAR_PREFIX}${e.detail.assetId}`;
    setAvatarDisplay(avatarValue);
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
      alias: aliasInput.value,
      avatar: avatarValue,
      template: own.template,
      style: own.style,
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
    if (lastUploadedAvatarAssetId && avatarValue === `${ASSET_AVATAR_PREFIX}${lastUploadedAvatarAssetId}`) {
      avatarUpload.confirmSent(lastUploadedAvatarAssetId);
    }
  });

  const settingsLink = document.createElement('a');
  settingsLink.href = `#/~${myPub}/settings`;
  settingsLink.textContent = `⚙️ ${t('settingsLink')}`;

  view.append(
    header,
    fieldsHeading, fieldsList, addFieldBtn,
    saveBtn, status,
    settingsLink
  );
  root.appendChild(view);
}

function renderSettings(root, own, listed, services, myPub, saveState, justSaved, notifPrefs, installedApps) {
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

  // Template/style/"listed in directory" - moved here from the main profile
  // page (see this file's own top doc comment): these are preferences about
  // how OTHERS see this profile, not profile data itself, so they belong
  // next to language/theme rather than cluttering the page every profile
  // (own or foreign) otherwise shows identically.
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
    const label = formatActorLabel(myPub, own);
    inner.appendChild(renderPreviewHeader(myPub, label, own.avatar));
    previewBox.appendChild(inner);
  }
  updatePreview();
  templateSelect.addEventListener('change', updatePreview);
  styleSelect.addEventListener('change', updatePreview);

  const listedLabel = document.createElement('label');
  const listedCheckbox = document.createElement('input');
  listedCheckbox.type = 'checkbox';
  listedCheckbox.checked = listed;
  listedCheckbox.addEventListener('change', () => services.directory.setVisible(listedCheckbox.checked));
  listedLabel.append(listedCheckbox, document.createTextNode(t('listedInDirectory')));

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
      template: templateSelect.value,
      style: styleSelect.value,
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

  view.append(
    heading, localeRow, themeRow,
    templateRow, styleRow, previewLabel, previewBox,
    listedLabel,
    saveBtn, reloadRow,
    notifSection, extRoot
  );
  // The shell header's own Back/Forward already covers "return to my
  // profile" - see docs/app-navigation-standard.md Rule 1 (same reasoning
  // apps/forum's/apps/chat's own renderSubpage() calls already document).
  renderSubpage(root, { showBackLink: false, render: (content) => content.appendChild(view) });
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
  const { header } = renderIdentityHeader({
    pub, epub: profile.epub, alias: label, avatar: profile.avatar, editable: false,
  });

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

  // "⋮" context menu (same component Forum/Chat already use for their own
  // per-message menus) - a single add/remove-contact action for now, room
  // left for more without a layout change. Computed fresh every time it
  // opens, so it can never show a stale add/remove label.
  const menu = renderContextMenu({
    triggerTitle: t('actions'),
    getItems: async () => {
      const isContact = await services.contacts.isContact(pub);
      return [{
        id: 'contact',
        icon: isContact ? '★' : '☆',
        label: isContact ? t('contactRemove') : t('contactAdd'),
        onClick: () => (isContact ? services.contacts.removeContact(pub) : services.contacts.addContact(pub)),
      }];
    },
  });
  const menuWrap = document.createElement('div');
  menuWrap.className = 'qu-profile-menu';
  menuWrap.appendChild(menu);

  view.append(menuWrap, header, fieldsBlock);
  root.appendChild(view);
}
