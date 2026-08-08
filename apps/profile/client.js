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
 * this identity's OWN devices. Saving here ALSO calls `setLocale()`/
 * `setStoredTheme()` immediately (instant effect on THIS device, matching
 * `@qu/i18n`'s own "takes effect on next page load" note for locale); every
 * other device this identity logs into picks it up the same way `apps/shell`'s
 * own boot sequence already does (see that file's own doc comment) - no
 * live cross-device push, consistent with the existing locale precedent.
 *
 * TEMPLATE/STYLE (own edit form only, no live "preview as a visitor" mode -
 * scope cut, not a limitation anyone has hit): `template` picks one of a
 * few small READ-ONLY layout variants (`renderPublicProfile()` below) a
 * VISITOR sees; `style` reuses `@qu/ui`'s `THEME_PRESETS` (the SAME palette
 * system `apps/shell`'s own device theme uses) as an accent applied ONLY to
 * the profile page itself (an inline CSS custom property on this page's own
 * root, never `ensureTheme()`'s global `:root` - never affects the rest of
 * a visitor's UI).
 *
 * Avatar stays a plain text field (URL or emoji) - `renderAvatar()` already
 * supports both fully; no file upload via an Asset/Blob engine this round
 * (no QuV2 precedent, no current need).
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
import { injectStyle, ensureTheme, renderAvatar, renderFlagToggle, THEME_PRESETS, setStoredTheme } from '@qu/ui';
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
`;

export function mount(container, { qu, identity, services, segments = [] }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let off = null;

  const root = document.createElement('div');
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
        if (stopped || token !== renderToken) return;
        const justSaved = saveState.justSaved;
        saveState.justSaved = false;
        root.textContent = '';
        renderSettings(root, own, services, myPub, saveState, justSaved);
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

function renderSettings(root, own, services, myPub, saveState, justSaved) {
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
  // See mount()'s/renderOwnProfile()'s own doc comments on `saveState` -
  // this save also republishes the public profile document, so the flash
  // is shown on the NEXT render(), not set directly on this soon-to-be-
  // discarded `status` node.
  if (justSaved) {
    status.textContent = t('saved');
    setTimeout(() => { status.textContent = ''; }, 1500);
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
    // Instant effect on THIS device - other devices this identity logs
    // into pick it up via apps/shell's own boot sequence (see this file's
    // own doc comment).
    setLocale(preferredLocale);
    setStoredTheme(preferredTheme);
  });

  const backLink = document.createElement('a');
  backLink.href = `#/~${myPub}`;
  backLink.textContent = t('backToProfile');

  view.append(heading, localeRow, themeRow, saveBtn, status, backLink);
  root.appendChild(view);
}

function renderPublicProfile(root, pub, profile, services) {
  const template = TEMPLATES.includes(profile.template) ? profile.template : 'default';
  const stylePreset = THEME_PRESETS[profile.style] || {};

  const view = document.createElement('div');
  view.className = `qu-profile qu-profile-view qu-template-${template}`;
  for (const [prop, value] of Object.entries(stylePreset)) view.style.setProperty(prop, value);

  const label = formatActorLabel(pub, profile);
  const header = document.createElement('div');
  header.className = 'qu-profile-header';
  header.appendChild(renderAvatar(pub, label, profile.avatar, { size: '3rem' }));
  const headingWrap = document.createElement('div');
  const heading = document.createElement('h1');
  heading.textContent = label;
  headingWrap.appendChild(heading);
  header.appendChild(headingWrap);

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
