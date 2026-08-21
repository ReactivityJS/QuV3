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
 *
 * CHAT SECTION (added alongside `apps/chat`'s port): `settings.chat.
 * allowMemberCreateGroup` mirrors Channels' own `allowMemberCreate` toggle
 * exactly - see `packages/relay/src/relay-settings.js`'s own doc comment on
 * that field for why chat needs no `allowMemberRestricted` counterpart (a
 * chat room/group is ALWAYS reader-restricted, never a public option).
 *
 * MESSAGE ROW / MENU ORDER SECTIONS (added alongside the same round's
 * message-chrome redesign - see `apps/forum/client.js`'s own top doc
 * comment on `content.messageFooter`/`content.messageMenu`): edits
 * `settings.extensionOrder`, an admin-wide `{[point]: [id, ...]}` map
 * `@qu/foundation`'s `rankFor()` consults to sort BOTH a host app's own
 * native items (`core.menu`, `edit`, ...) and a plugin's manifest
 * `contributes` entry (`reactions`, `pins`, `bookmarks`) for a given point -
 * see that function's own doc comment. `KNOWN_ORDER_POINTS` below is the
 * FIXED catalog of points this UI knows how to edit (native ids + a default
 * order, hand-picked to match `apps/forum/client.js`'s/`apps/chat/client.js`'s
 * own `FOOTER_ORDER_DEFAULT`/`MENU_ORDER_DEFAULT` - keep all three copies in
 * sync if any of them ever changes) - a real future round could discover
 * points generically via `@qu/foundation`'s `listDefinedPoints()` instead of
 * this hardcoded list, deliberately not built here to keep this round's
 * scope to what was actually asked (order two known points, simply and
 * robustly) rather than a fully generic point-editor.
 *
 * REORDERING UI is a plain ordered list with ▲/▼ buttons, not drag-and-drop
 * - a deliberate simplicity choice (no drag-and-drop library, no custom
 * HTML5 drag-event wiring to maintain) that's exactly as capable for a
 * short, few-item list like either point has today.
 *
 * LINK PREVIEWS SECTION: `settings.linkPreviews.enabled` is a plain on/off
 * kill switch for `@qu/relay`'s `link-preview.js`/its `/link-preview` route
 * - see that module's own doc comment for what it fetches and why (server-
 * side Open Graph unfurling, so a viewer's own browser never fetches an
 * arbitrary third-party URL directly). Deliberately no allowlist/blocklist
 * editor here - the actual SSRF defense (refusing private/internal address
 * ranges) is a hard-coded safety floor in that module, never something an
 * admin should be able to loosen through this UI.
 */
import { QuCrypto } from '@qu/core';
import { createI18n } from '@qu/i18n';
import { rankFor } from '@qu/foundation';
import { injectStyle, ensureTheme, mountAppTemplate } from '@qu/ui';

/**
 * The fixed catalog of extension points this UI can reorder - native item
 * ids/labels + a default order matching `apps/forum/client.js`'s/
 * `apps/chat/client.js`'s own `FOOTER_ORDER_DEFAULT`/`MENU_ORDER_DEFAULT`.
 * `titleKey`/`nativeLabelKey`s are `DICT` keys, resolved at render time
 * (after `t` exists) rather than stored as already-resolved strings here.
 */
const KNOWN_ORDER_POINTS = [
  {
    point: 'content.messageFooter',
    titleKey: 'orderMessageFooter',
    defaultOrder: { reactions: 0, 'core.menu': 10, 'core.timestamp': 20, 'core.readReceipt': 30 },
    nativeItems: [
      { id: 'core.menu', labelKey: 'orderCoreMenu' },
      { id: 'core.timestamp', labelKey: 'orderCoreTimestamp' },
      { id: 'core.readReceipt', labelKey: 'orderCoreReadReceipt' },
    ],
  },
  {
    point: 'content.messageMenu',
    titleKey: 'orderMessageMenu',
    defaultOrder: { edit: 0, reply: 5, pin: 10, bookmark: 20 },
    nativeItems: [
      { id: 'edit', labelKey: 'orderCoreEdit' },
      { id: 'reply', labelKey: 'orderCoreReply' },
    ],
  },
];

const DICT = {
  en: {
    title: 'Relay Admin',
    notAuthorized: 'This identity is not a configured admin for this relay - nothing to show.',
    general: 'General',
    defaultLocale: 'Default locale',
    maxMessagesPerMinute: 'Rate limit (messages/minute, 0 = unlimited)',
    apps: 'Apps',
    appsHint: 'Unchecking an app disables it for everyone on this relay - it stops loading (and, for a UI plugin, stops contributing) immediately, no restart needed.',
    hideFromList: 'Hide from App List',
    hideFromListHint: 'Keeps an app fully enabled and reachable, just off apps/app-list\'s own browse page - for a widget-only plugin with no standalone page of its own (e.g. Pins), which has nothing to show if someone lands on its route directly.',
    channels: 'Channels',
    allowMemberCreate: 'Members may create channels',
    allowMemberRestricted: 'Members may create restricted (private) channels',
    channelsHint: 'This relay\'s own admins can always create channels/restricted channels, regardless of these settings.',
    chat: 'Chat',
    allowMemberCreateGroup: 'Members may create chat groups',
    chatHint: 'This relay\'s own admins can always create a chat group, regardless of this setting. 1:1 chats between contacts are never gated.',
    linkPreviews: 'Link previews',
    linkPreviewsEnabled: 'Fetch link preview cards (title/description/image) for URLs in messages',
    linkPreviewsHint: 'This relay fetches each URL server-side (never the viewer\'s own browser) to build the preview, with built-in protection against being used to probe this relay\'s own internal network - that protection is not configurable here, only whether the feature runs at all.',
    flagTypes: 'Flag types',
    flagTypesHint: 'Read-only for now - edit via a future round.',
    orderMessageFooter: 'Message row order',
    orderMessageFooterHint: 'The per-message footer row (below every forum post / chat bubble) - same order in Forum and Chat.',
    orderMessageMenu: 'Message menu order',
    orderMessageMenuHint: 'The "⋮" context menu on a message - same order in Forum and Chat. An unchecked app in the Apps section above removes its own entry entirely.',
    orderCoreMenu: '⋮ Context menu',
    orderCoreTimestamp: 'Timestamp',
    orderCoreReadReceipt: 'Read tick (chat)',
    orderCoreEdit: 'Edit',
    orderCoreReply: 'Reply (chat)',
    orderMoveUp: 'Move up',
    orderMoveDown: 'Move down',
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
    hideFromList: 'Aus App-Liste ausblenden',
    hideFromListHint: 'Die App bleibt vollständig aktiv und erreichbar, erscheint aber nicht mehr auf der App-Liste-Übersichtsseite - für reine Widget-Plugins ohne eigene Seite (z. B. Pins), die nichts anzuzeigen haben, wenn jemand direkt auf ihrer Route landet.',
    channels: 'Kanäle',
    allowMemberCreate: 'Mitglieder dürfen Kanäle anlegen',
    allowMemberRestricted: 'Mitglieder dürfen private (restricted) Kanäle anlegen',
    channelsHint: 'Admins dieses Relays dürfen unabhängig von diesen Einstellungen immer Kanäle/private Kanäle anlegen.',
    chat: 'Chat',
    allowMemberCreateGroup: 'Mitglieder dürfen Chat-Gruppen anlegen',
    chatHint: 'Admins dieses Relays dürfen unabhängig von dieser Einstellung immer eine Chat-Gruppe anlegen. 1:1-Chats zwischen Kontakten sind nie eingeschränkt.',
    linkPreviews: 'Link-Vorschauen',
    linkPreviewsEnabled: 'Vorschaukarten (Titel/Beschreibung/Bild) für Links in Nachrichten abrufen',
    linkPreviewsHint: 'Dieses Relay ruft jede URL serverseitig ab (nie der Browser des Betrachters), mit eingebautem Schutz davor, damit das interne Netzwerk dieses Relays ausgekundschaftet zu werden - dieser Schutz ist hier nicht konfigurierbar, nur ob das Feature überhaupt aktiv ist.',
    flagTypes: 'Flag-Typen',
    flagTypesHint: 'Aktuell nur lesbar - Bearbeitung folgt in einer späteren Runde.',
    orderMessageFooter: 'Reihenfolge der Nachrichtenzeile',
    orderMessageFooterHint: 'Die Fußzeile unter jedem Forumsbeitrag / jeder Chat-Nachricht - identische Reihenfolge in Forum und Chat.',
    orderMessageMenu: 'Reihenfolge des Nachrichtenmenüs',
    orderMessageMenuHint: 'Das "⋮"-Kontextmenü einer Nachricht - identische Reihenfolge in Forum und Chat. Eine oben in "Apps" abgewählte App entfernt ihren Eintrag komplett.',
    orderCoreMenu: '⋮ Kontextmenü',
    orderCoreTimestamp: 'Zeitstempel',
    orderCoreReadReceipt: 'Gelesen-Häkchen (Chat)',
    orderCoreEdit: 'Bearbeiten',
    orderCoreReply: 'Antworten (Chat)',
    orderMoveUp: 'Nach oben',
    orderMoveDown: 'Nach unten',
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
  .qu-relay-admin-apps-row { display: flex; align-items: center; gap: 1rem; padding: 0.15rem 0; flex-wrap: wrap; }
  .qu-relay-admin-apps-row label { margin: 0; }
  .qu-relay-admin-apps-row-hide { opacity: 0.8; font-size: 0.92em; }
  .qu-relay-admin-flagtypes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
  .qu-relay-admin-status { margin-top: 0.6rem; font-size: 0.9em; }
  .qu-relay-admin-status.qu-relay-admin-status-error { color: var(--qu-color-danger, #d64545); }
  .qu-relay-admin-order-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; max-width: 22rem; }
  .qu-relay-admin-order-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.3rem 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-relay-admin-order-row-buttons { display: flex; gap: 0.2rem; flex-shrink: 0; }
  .qu-relay-admin-order-row-buttons button { background: none; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); cursor: pointer; font: inherit; line-height: 1; padding: 0.2rem 0.4rem; }
  .qu-relay-admin-order-row-buttons button:disabled { opacity: 0.35; cursor: default; }
`;

/**
 * @param {string} point
 * @param {Array<{id: string}>} nativeItems
 * @param {Record<string, number>} defaultOrder
 * @param {Array<object>} apps - the manifest catalog, for discovering which
 *   apps actually contribute to `point` today (their manifest `label`/`icon`
 *   for display).
 * @param {string[]|undefined} configured - `settings.extensionOrder[point]`, if already set.
 * @returns {Array<{id: string, label: string}>} The list to display/reorder,
 *   in EFFECTIVE current order - `configured` if set (any newly-appeared id
 *   not yet in it gets appended, same "unlisted ids go to the end" rule
 *   `rankFor()` itself already applies at render time), else every known
 *   id sorted by `defaultOrder`.
 */
function resolveOrderItems(point, nativeItems, defaultOrder, apps, configured) {
  const catalogContributors = apps
    .filter((a) => a.enabled !== false && (a.contributes ?? []).some((c) => c.point === point))
    .map((a) => ({ id: a.name, label: `${a.icon ?? '🧩'} ${a.label ?? a.name}` }));
  const known = new Map([...nativeItems.map((n) => [n.id, n]), ...catalogContributors.map((c) => [c.id, c])]);

  const ids = Array.isArray(configured) && configured.length > 0
    ? [...configured.filter((id) => known.has(id)), ...[...known.keys()].filter((id) => !configured.includes(id))]
    : [...known.keys()].sort((a, b) => rankFor({}, point, a, defaultOrder[a] ?? 50) - rankFor({}, point, b, defaultOrder[b] ?? 50));

  return ids.map((id) => known.get(id));
}

/**
 * One reorderable `<section>` for a single point - ▲/▼ buttons mutate a
 * local array (nothing persisted until the surrounding form's own Save),
 * see this file's own top doc comment on why not drag-and-drop.
 * @returns {{section: HTMLElement, getOrder: () => string[]}}
 */
function buildOrderSection(titleKey, hintKey, items) {
  const section = document.createElement('section');
  const title = document.createElement('h2');
  title.textContent = t(titleKey);
  const hint = document.createElement('p');
  hint.className = 'qu-relay-admin-hint';
  hint.textContent = t(hintKey);
  const list = document.createElement('ul');
  list.className = 'qu-relay-admin-order-list';
  section.append(title, hint, list);

  let order = items.map((item) => item.id);
  const labelOf = (id) => items.find((item) => item.id === id)?.label ?? id;

  function render() {
    list.textContent = '';
    order.forEach((id, index) => {
      const li = document.createElement('li');
      li.className = 'qu-relay-admin-order-row';
      const label = document.createElement('span');
      label.textContent = labelOf(id);
      const buttons = document.createElement('div');
      buttons.className = 'qu-relay-admin-order-row-buttons';
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.textContent = '▲';
      upBtn.title = t('orderMoveUp');
      upBtn.setAttribute('aria-label', t('orderMoveUp'));
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', () => {
        [order[index - 1], order[index]] = [order[index], order[index - 1]];
        render();
      });
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.textContent = '▼';
      downBtn.title = t('orderMoveDown');
      downBtn.setAttribute('aria-label', t('orderMoveDown'));
      downBtn.disabled = index === order.length - 1;
      downBtn.addEventListener('click', () => {
        [order[index], order[index + 1]] = [order[index + 1], order[index]];
        render();
      });
      buttons.append(upBtn, downBtn);
      li.append(label, buttons);
      list.appendChild(li);
    });
  }
  render();

  return { section, getOrder: () => order };
}

/**
 * @param {HTMLElement} container
 * @param {{qu: object, identity: import('@qu/identity').QuIdentityEngine, services: object, apps: Array<object>, subscribe?: Function, syncFetch?: Function}} ctx
 */
export async function mount(container, { identity, services, apps }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  const myPub = await services.actors.whoAmI();
  if (stopped) return () => { stopped = true; };

  let config;
  try {
    const res = await fetch('/config.json');
    config = res.ok ? await res.json() : null;
  } catch { /* offline/unreachable - treated the same as "not authorized": nothing this identity could save right now anyway */ }
  if (stopped) return () => { stopped = true; };

  const adminPubs = config?.adminPubs ?? [];
  if (!adminPubs.includes(myPub)) {
    // Rule 5 (docs/app-navigation-standard.md) - even this single, chrome-
    // less "not authorized" state routes through mountAppTemplate(), same
    // as the real form below, rather than appending straight to `container`.
    mountAppTemplate(container, {
      render: (content) => {
        const heading = document.createElement('h1');
        heading.textContent = t('title');
        const p = document.createElement('p');
        p.textContent = t('notAuthorized');
        content.append(heading, p);
      },
    });
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
  const hiddenFromAppList = new Set(settings.hiddenFromAppList ?? []);
  const appCheckboxes = [];
  for (const app of [...apps].sort((a2, b2) => a2.name.localeCompare(b2.name))) {
    const row = document.createElement('div');
    row.className = 'qu-relay-admin-apps-row';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !disabledApps.has(app.name);
    label.append(checkbox, document.createTextNode(`${app.icon ?? '🧩'} ${app.label ?? app.name} (${app.name})`));

    const hideLabel = document.createElement('label');
    hideLabel.className = 'qu-relay-admin-apps-row-hide';
    const hideCheckbox = document.createElement('input');
    hideCheckbox.type = 'checkbox';
    hideCheckbox.checked = hiddenFromAppList.has(app.name);
    hideLabel.append(hideCheckbox, document.createTextNode(t('hideFromList')));

    row.append(label, hideLabel);
    appsList.appendChild(row);
    appCheckboxes.push({ name: app.name, checkbox, hideCheckbox });
  }
  const hideFromListHint = document.createElement('p');
  hideFromListHint.className = 'qu-relay-admin-hint';
  hideFromListHint.textContent = t('hideFromListHint');
  appsSection.append(appsTitle, appsHint, appsList, hideFromListHint);

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

  // ---- Chat ----
  const chatSection = document.createElement('section');
  const chatTitle = document.createElement('h2');
  chatTitle.textContent = t('chat');
  const allowCreateGroupLabel = document.createElement('label');
  const allowCreateGroupInput = document.createElement('input');
  allowCreateGroupInput.type = 'checkbox';
  allowCreateGroupInput.checked = settings.chat?.allowMemberCreateGroup ?? true;
  allowCreateGroupLabel.append(allowCreateGroupInput, document.createTextNode(t('allowMemberCreateGroup')));
  const chatHint = document.createElement('p');
  chatHint.className = 'qu-relay-admin-hint';
  chatHint.textContent = t('chatHint');
  chatSection.append(chatTitle, allowCreateGroupLabel, chatHint);

  // ---- Link previews ----
  const linkPreviewsSection = document.createElement('section');
  const linkPreviewsTitle = document.createElement('h2');
  linkPreviewsTitle.textContent = t('linkPreviews');
  const linkPreviewsEnabledLabel = document.createElement('label');
  const linkPreviewsEnabledInput = document.createElement('input');
  linkPreviewsEnabledInput.type = 'checkbox';
  linkPreviewsEnabledInput.checked = settings.linkPreviews?.enabled ?? true;
  linkPreviewsEnabledLabel.append(linkPreviewsEnabledInput, document.createTextNode(t('linkPreviewsEnabled')));
  const linkPreviewsHint = document.createElement('p');
  linkPreviewsHint.className = 'qu-relay-admin-hint';
  linkPreviewsHint.textContent = t('linkPreviewsHint');
  linkPreviewsSection.append(linkPreviewsTitle, linkPreviewsEnabledLabel, linkPreviewsHint);

  // ---- Message row / menu order ----
  const orderSections = KNOWN_ORDER_POINTS.map(({ point, titleKey, defaultOrder, nativeItems }) => {
    const resolvedNativeItems = nativeItems.map((n) => ({ id: n.id, label: t(n.labelKey) }));
    const items = resolveOrderItems(point, resolvedNativeItems, defaultOrder, apps, settings.extensionOrder?.[point]);
    const built = buildOrderSection(titleKey, `${titleKey}Hint`, items);
    return { point, ...built };
  });

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

  form.append(generalSection, appsSection, channelsSection, chatSection, linkPreviewsSection, ...orderSections.map((o) => o.section), flagTypesSection, saveBtn, status);

  // Rule 5 (docs/app-navigation-standard.md) - none of `navigation`/`views`/
  // `primaryAction`/`settings` fit a single settings form with no sibling
  // "places" or create action, so `render` is all that's passed - the same
  // chrome-less shape apps/search/client.js's own mount() uses.
  mountAppTemplate(container, {
    render: (content) => {
      const heading = document.createElement('h1');
      heading.textContent = t('title');
      content.append(heading, form);
    },
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true; // same double-submit guard convention as apps/forum's own create-channel/create-topic forms
    status.hidden = true;
    try {
      const newDisabledApps = appCheckboxes.filter(({ checkbox }) => !checkbox.checked).map(({ name }) => name);
      const newHiddenFromAppList = appCheckboxes.filter(({ hideCheckbox }) => hideCheckbox.checked).map(({ name }) => name);
      const patch = {
        defaultLocale: localeSelect.value,
        rateLimits: { maxMessagesPerMinute: Number(rateLimitInput.value) || 0 },
        disabledApps: newDisabledApps,
        hiddenFromAppList: newHiddenFromAppList,
        channels: { allowMemberCreate: allowCreateInput.checked, allowMemberRestricted: allowRestrictedInput.checked },
        chat: { allowMemberCreateGroup: allowCreateGroupInput.checked },
        linkPreviews: { enabled: linkPreviewsEnabledInput.checked },
        // extensionOrder replaces the WHOLE map on save (see relay-settings.js's
        // own doc comment on that field) - every known point from
        // KNOWN_ORDER_POINTS is always included here, so a point this form
        // doesn't show is simply never in the patch (nothing to preserve -
        // this UI is currently the only writer of extensionOrder at all).
        extensionOrder: Object.fromEntries(orderSections.map((o) => [o.point, o.getOrder()])),
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
