/**
 * RELAY ADMIN — the settings UI for `@qu/relay`'s already-existing signed
 * admin HTTP surface (`GET /config.json`, `POST /admin/settings` - see
 * `packages/relay/src/admin-http.js`/`relay-settings.js`). Fills a gap this
 * whole codebase has documented from the start ("Still deliberately not
 * built: apps/relay-admin", `README.md`) - until now, changing a relay's
 * own settings meant hand-crafting a signed HTTP request; this is the first
 * real UI for it, reachable at `#/relay-admin` (the shell header's user
 * menu already links there for an admin, see `apps/shell/src/header.js`).
 *
 * AUTHORIZATION - two independent layers, same "client hint, server gate"
 * split as everywhere else in this codebase that touches `adminPubs`
 * (`apps/shell/client.js`'s own `adminPubs` fetch is the other example):
 *   1. THIS FILE checks `/config.json`'s `adminPubs` against
 *      `services.actors.whoAmI()` before rendering the form at all - a
 *      non-admin sees a plain "not authorized" message, never the controls.
 *      Purely a UX courtesy; proves nothing on its own.
 *   2. `POST /admin/settings` independently re-verifies a real Ed25519
 *      signature over the exact settings payload against the SAME
 *      `adminPubs` list, server-side (`AdminHttp#verifyAdmin()`) - the only
 *      layer that actually matters. A non-admin who somehow reached this
 *      form (e.g. a modified client) still cannot save anything.
 *
 * SIGNING: mirrors `QuIdentityEngine.publishMainProfile()`'s own pattern
 * exactly (sign `TextEncoder().encode(JSON.stringify(payload))` with the
 * main identity's Ed25519 key, `QuCrypto.toBase64Url()` the signature) -
 * `admin-http.js`'s `#verifyAdmin()` re-`JSON.stringify()`s the exact same
 * parsed `settings` object to re-verify, so the signed bytes and the
 * request body's `settings` field must come from the SAME unmutated object.
 *
 * SCOPE - what this round deliberately does NOT build: the Flag TYPE
 * catalog (`settings.flagTypes`) is shown read-only, not an add/remove
 * editor (a real, valid follow-up - this round's ask was channel-creation
 * policy + per-app toggles, not a full flag-catalog CMS); the Data Explorer
 * (`admin-http.js`'s `handleDataList`/`handleDataImport`) has no UI here at
 * all yet, a separate, larger follow-up in its own right.
 */
import { QuCrypto } from '@qu/core';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const DICT = {
  en: {
    title: 'Relay Admin',
    notAuthorized: 'This identity is not a configured admin for this relay - nothing to show.',
    general: 'General',
    defaultLocale: 'Default locale',
    maxMessagesPerMinute: 'Rate limit (messages/minute, 0 = unlimited)',
    apps: 'Apps',
    appsHint: 'Unchecking an app disables it for everyone on this relay - it stops loading (and, for a UI plugin, stops contributing) immediately, no restart needed.',
    channels: 'Channels',
    allowMemberCreate: 'Members may create channels',
    allowMemberRestricted: 'Members may create restricted (private) channels',
    channelsHint: 'This relay\'s own admins can always create channels/restricted channels, regardless of these settings.',
    flagTypes: 'Flag types',
    flagTypesHint: 'Read-only for now - edit via a future round.',
    save: 'Save settings',
    saved: 'Saved.',
    saveFailed: 'Save failed: {error}',
  },
  de: {
    title: 'Relay-Administration',
    notAuthorized: 'Diese Identität ist auf diesem Relay nicht als Admin konfiguriert - nichts anzuzeigen.',
    general: 'Allgemein',
    defaultLocale: 'Standardsprache',
    maxMessagesPerMinute: 'Ratenlimit (Nachrichten/Minute, 0 = unbegrenzt)',
    apps: 'Apps',
    appsHint: 'Eine App abwählen deaktiviert sie sofort für alle auf diesem Relay - kein Neustart nötig.',
    channels: 'Kanäle',
    allowMemberCreate: 'Mitglieder dürfen Kanäle anlegen',
    allowMemberRestricted: 'Mitglieder dürfen private (restricted) Kanäle anlegen',
    channelsHint: 'Admins dieses Relays dürfen unabhängig von diesen Einstellungen immer Kanäle/private Kanäle anlegen.',
    flagTypes: 'Flag-Typen',
    flagTypesHint: 'Aktuell nur lesbar - Bearbeitung folgt in einer späteren Runde.',
    save: 'Einstellungen speichern',
    saved: 'Gespeichert.',
    saveFailed: 'Speichern fehlgeschlagen: {error}',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-relay-admin-style';
const STYLE = `
  .qu-relay-admin section { margin-bottom: 1.2rem; }
  .qu-relay-admin h2 { font-size: 1em; margin: 0 0 0.4rem; }
  .qu-relay-admin .qu-relay-admin-hint { font-size: 0.8em; opacity: 0.7; margin: 0.2rem 0 0.5rem; }
  .qu-relay-admin label { display: flex; align-items: center; gap: 0.4rem; margin: 0.3rem 0; }
  .qu-relay-admin input[type="text"], .qu-relay-admin input[type="number"], .qu-relay-admin select { font: inherit; padding: 0.3rem 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-relay-admin-apps-list { display: flex; flex-direction: column; gap: 0.1rem; }
  .qu-relay-admin-flagtypes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-relay-admin-status { margin-top: 0.6rem; font-size: 0.9em; }
  .qu-relay-admin-status.qu-relay-admin-status-error { color: var(--qu-color-danger, #d64545); }
`;

/**
 * @param {HTMLElement} container
 * @param {{qu: object, identity: import('@qu/identity').QuIdentityEngine, services: object, apps: Array<object>, subscribe?: Function, syncFetch?: Function}} ctx
 */
export async function mount(container, { identity, services, apps }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  container.textContent = '';
  let stopped = false;

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  container.appendChild(heading);
  const bodyRoot = document.createElement('div');
  container.appendChild(bodyRoot);

  const myPub = await services.actors.whoAmI();
  if (stopped) return;

  let config;
  try {
    const res = await fetch('/config.json');
    config = res.ok ? await res.json() : null;
  } catch { /* offline/unreachable - treated the same as "not authorized": nothing this identity could save right now anyway */ }
  if (stopped) return;

  const adminPubs = config?.adminPubs ?? [];
  if (!adminPubs.includes(myPub)) {
    const p = document.createElement('p');
    p.textContent = t('notAuthorized');
    bodyRoot.appendChild(p);
    return () => { stopped = true; };
  }

  const settings = config.settings;
  const form = document.createElement('form');
  form.className = 'qu-relay-admin';

  // ---- General ----
  const generalSection = document.createElement('section');
  const generalTitle = document.createElement('h2');
  generalTitle.textContent = t('general');
  const localeLabel = document.createElement('label');
  const localeSelect = document.createElement('select');
  for (const locale of ['en', 'de']) {
    const opt = document.createElement('option');
    opt.value = locale;
    opt.textContent = locale;
    if (locale === settings.defaultLocale) opt.selected = true;
    localeSelect.appendChild(opt);
  }
  localeLabel.append(document.createTextNode(t('defaultLocale')), localeSelect);
  const rateLimitLabel = document.createElement('label');
  const rateLimitInput = document.createElement('input');
  rateLimitInput.type = 'number';
  rateLimitInput.min = '0';
  rateLimitInput.value = String(settings.rateLimits?.maxMessagesPerMinute ?? 0);
  rateLimitLabel.append(document.createTextNode(t('maxMessagesPerMinute')), rateLimitInput);
  generalSection.append(generalTitle, localeLabel, rateLimitLabel);

  // ---- Apps ----
  const appsSection = document.createElement('section');
  const appsTitle = document.createElement('h2');
  appsTitle.textContent = t('apps');
  const appsHint = document.createElement('p');
  appsHint.className = 'qu-relay-admin-hint';
  appsHint.textContent = t('appsHint');
  const appsList = document.createElement('div');
  appsList.className = 'qu-relay-admin-apps-list';
  const disabledApps = new Set(settings.disabledApps ?? []);
  const appCheckboxes = [];
  for (const app of [...apps].sort((a2, b2) => a2.name.localeCompare(b2.name))) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !disabledApps.has(app.name);
    label.append(checkbox, document.createTextNode(`${app.icon ?? '🧩'} ${app.label ?? app.name} (${app.name})`));
    appsList.appendChild(label);
    appCheckboxes.push({ name: app.name, checkbox });
  }
  appsSection.append(appsTitle, appsHint, appsList);

  // ---- Channels ----
  const channelsSection = document.createElement('section');
  const channelsTitle = document.createElement('h2');
  channelsTitle.textContent = t('channels');
  const allowCreateLabel = document.createElement('label');
  const allowCreateInput = document.createElement('input');
  allowCreateInput.type = 'checkbox';
  allowCreateInput.checked = settings.channels?.allowMemberCreate ?? true;
  allowCreateLabel.append(allowCreateInput, document.createTextNode(t('allowMemberCreate')));
  const allowRestrictedLabel = document.createElement('label');
  const allowRestrictedInput = document.createElement('input');
  allowRestrictedInput.type = 'checkbox';
  allowRestrictedInput.checked = settings.channels?.allowMemberRestricted ?? false;
  allowRestrictedLabel.append(allowRestrictedInput, document.createTextNode(t('allowMemberRestricted')));
  const channelsHint = document.createElement('p');
  channelsHint.className = 'qu-relay-admin-hint';
  channelsHint.textContent = t('channelsHint');
  channelsSection.append(channelsTitle, allowCreateLabel, allowRestrictedLabel, channelsHint);

  // ---- Flag types (read-only) ----
  const flagTypesSection = document.createElement('section');
  const flagTypesTitle = document.createElement('h2');
  flagTypesTitle.textContent = t('flagTypes');
  const flagTypesHint = document.createElement('p');
  flagTypesHint.className = 'qu-relay-admin-hint';
  flagTypesHint.textContent = t('flagTypesHint');
  const flagTypesList = document.createElement('ul');
  flagTypesList.className = 'qu-relay-admin-flagtypes';
  for (const flagType of settings.flagTypes ?? []) {
    const li = document.createElement('li');
    li.textContent = `${flagType.icon} ${flagType.label} (${flagType.id}, ${flagType.mode}, ${flagType.entityKinds.join(', ')})`;
    flagTypesList.appendChild(li);
  }
  flagTypesSection.append(flagTypesTitle, flagTypesHint, flagTypesList);

  // ---- Save ----
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = t('save');
  const status = document.createElement('p');
  status.className = 'qu-relay-admin-status';
  status.hidden = true;

  form.append(generalSection, appsSection, channelsSection, flagTypesSection, saveBtn, status);
  bodyRoot.appendChild(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true; // same double-submit guard convention as apps/forum's own create-channel/create-topic forms
    status.hidden = true;
    try {
      const newDisabledApps = appCheckboxes.filter(({ checkbox }) => !checkbox.checked).map(({ name }) => name);
      const patch = {
        defaultLocale: localeSelect.value,
        rateLimits: { maxMessagesPerMinute: Number(rateLimitInput.value) || 0 },
        disabledApps: newDisabledApps,
        channels: { allowMemberCreate: allowCreateInput.checked, allowMemberRestricted: allowRestrictedInput.checked },
      };
      const mainKey = await identity.getMainKey();
      const signature = await QuCrypto.sign(new TextEncoder().encode(JSON.stringify(patch)), mainKey.privateKeyPkcs8);
      const res = await fetch('/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorPub: myPub, settings: patch, signature: QuCrypto.toBase64Url(signature) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      status.textContent = t('saved');
      status.classList.remove('qu-relay-admin-status-error');
      status.hidden = false;
    } catch (err) {
      status.textContent = t('saveFailed', { error: err.message });
      status.classList.add('qu-relay-admin-status-error');
      status.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  return () => { stopped = true; };
}
