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
 * FEDERATION SECTION: edits `settings.federation` (see
 * `packages/relay/src/relay-settings.js`'s own doc comment on that field,
 * and `packages/relay/src/federation-manager.js` for the mechanism it
 * drives) - peers/pending/blacklist are plain arrays edited in local,
 * in-memory copies (`federationPeers`/`federationPending`, same "batch
 * edit, one submit" convention every other section here already uses) and
 * only actually persisted on this form's own Save. The one exception is the
 * per-peer "Retry" button (shown only for a `dead` peer) - a genuine LIVE
 * action on the relay's own outbound connection (`POST
 * /admin/federation/retry`), not a settings edit, so it fires immediately
 * rather than waiting for Save. Live connection STATUS (connecting/
 * connected/backoff/dead) is never part of `settings` at all - it's read
 * fresh from `/config.json`'s own `federationStatus` field on mount, same
 * "state isn't in settings, read it separately" pattern this file has no
 * other example of yet, because no other section here has anything this
 * transient to show.
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
import { injectStyle, ensureTheme } from '@qu/ui';

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
    menuThreshold: 'Chrome menu threshold (items before collapsing into "More…")',
    menuThresholdHint: 'How many items a platform-owned sidebar/footer nav/views/settings section shows directly before collapsing the rest into a "More…" trigger. Does not apply to a live channel/room list, which is never truncated.',
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
    federation: 'Relay federation',
    federationHint: 'Connect this relay to other Qu relays: it dials out to each one, subscribes to whatever prefixes you configure (eager replication), and can forward a cache miss to them on demand (bounded by the hop limit below). See the README for how a client can also learn a foreign relay and suggest it here.',
    federationAutoLearn: 'Auto-learn client-suggested relays',
    federationAutoLearnHint: 'When off (recommended), a relay a client discovers and reports lands in "Pending suggestions" below for you to approve. When on, a validated Qu relay URL is added automatically as soon as it is not on the blacklist.',
    federationAllowSuggestViaSettings: 'Allow suggesting a relay from user settings',
    federationAllowSuggestViaShare: 'Allow suggesting a relay via a shared invite link',
    federationAllowSuggestHint: 'Both off by default - the underlying suggestion endpoint itself refuses every request unless at least one of these is on, not just the corresponding UI being hidden. See apps/relay-federation.',
    federationHopLimit: 'Hop limit (on-demand forwarding)',
    federationHopLimitHint: 'How many further relays a single forwarded query may transit before giving up.',
    federationHopTimeoutMs: 'Per-hop timeout (ms)',
    federationTryLimit: 'Reconnect try-limit',
    federationTryLimitHint: 'Consecutive failed connection attempts before a peer is marked dead and this relay stops auto-retrying it (it stays configured - retry it manually below).',
    federationPeers: 'Federated relays',
    federationPeersHint: 'Prefixes are comma-separated path prefixes this relay actively subscribes to and backfills from that peer (e.g. "/store/forum"). Leave empty to only allow on-demand forwarding to/from this peer, without eager replication.',
    federationAddPlaceholder: 'wss://relay.example.com',
    federationAdd: 'Add',
    federationPrefixesPlaceholder: 'prefixes, comma-separated',
    federationRemove: 'Remove',
    federationRetry: 'Retry',
    federationNoPeers: 'No federated relays configured yet.',
    federationStateConnecting: 'Connecting…',
    federationStateConnected: 'Connected',
    federationStateBackoff: 'Reconnecting…',
    federationStateDead: 'Dead',
    federationStateUntrusted: 'Untrusted (relayId mismatch)',
    federationStateUnknown: 'Unknown',
    federationPending: 'Pending suggestions',
    federationNoPending: 'No pending suggestions.',
    federationApprove: 'Approve',
    federationReject: 'Reject',
    federationBlacklist: 'Blacklist',
    federationBlacklistHint: 'One URL or relayId per line. Never dialed, never accepted, never auto-learned, even with auto-learn on.',
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
    menuThreshold: 'Chrome-Menü-Schwelle (Einträge vor Zusammenfassung in "Mehr…")',
    menuThresholdHint: 'Wie viele Einträge ein plattformeigener Sidebar-/Footer-Navigations-/Views-/Einstellungen-Bereich direkt anzeigt, bevor der Rest in einem "Mehr…"-Trigger zusammengefasst wird. Gilt nicht für eine live Kanal-/Raumliste - diese wird nie gekürzt.',
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
    federation: 'Relay-Föderation',
    federationHint: 'Dieses Relay mit anderen Qu-Relays verbinden: Es verbindet sich zu jedem konfigurierten Relay, abonniert die eingestellten Prefixe (aktive Replikation) und kann bei Bedarf einen lokalen Cache-Miss dorthin weiterleiten (begrenzt durch das Hop-Limit unten). Ein Client kann außerdem ein fremdes Relay "lernen" und hier vorschlagen.',
    federationAutoLearn: 'Von Clients vorgeschlagene Relays automatisch übernehmen',
    federationAutoLearnHint: 'Standardmäßig aus (empfohlen): ein von einem Client gemeldetes Relay landet unten unter "Vorschläge" zur manuellen Bestätigung. Bei "an" wird eine validierte Qu-Relay-URL automatisch hinzugefügt, sofern sie nicht auf der Blacklist steht.',
    federationAllowSuggestViaSettings: 'Relay-Vorschlag über Nutzer-Einstellungen erlauben',
    federationAllowSuggestViaShare: 'Relay-Vorschlag über geteilten Einladungslink erlauben',
    federationAllowSuggestHint: 'Beide standardmäßig aus - der zugrundeliegende Vorschlag-Endpunkt lehnt jede Anfrage ab, solange keine der beiden Optionen aktiv ist, nicht nur die jeweilige UI wird versteckt. Siehe apps/relay-federation.',
    federationHopLimit: 'Hop-Limit (bedarfsgesteuertes Routing)',
    federationHopLimitHint: 'Wie viele weitere Relays eine einzelne weitergeleitete Anfrage maximal durchlaufen darf.',
    federationHopTimeoutMs: 'Timeout pro Hop (ms)',
    federationTryLimit: 'Reconnect-Versuchslimit',
    federationTryLimitHint: 'Aufeinanderfolgende fehlgeschlagene Verbindungsversuche, bevor ein Peer als "tot" markiert wird und automatische Reconnects gestoppt werden (bleibt konfiguriert - unten manuell erneut versuchbar).',
    federationPeers: 'Föderierte Relays',
    federationPeersHint: 'Prefixe sind kommagetrennte Pfad-Prefixe, die dieses Relay aktiv von diesem Peer abonniert und nachlädt (z. B. "/store/forum"). Leer lassen, um mit diesem Peer nur bedarfsgesteuertes Routing zu erlauben, ohne aktive Replikation.',
    federationAddPlaceholder: 'wss://relay.example.com',
    federationAdd: 'Hinzufügen',
    federationPrefixesPlaceholder: 'Prefixe, kommagetrennt',
    federationRemove: 'Entfernen',
    federationRetry: 'Erneut versuchen',
    federationNoPeers: 'Noch keine föderierten Relays konfiguriert.',
    federationStateConnecting: 'Verbinde…',
    federationStateConnected: 'Verbunden',
    federationStateBackoff: 'Verbindung wird wiederhergestellt…',
    federationStateDead: 'Tot',
    federationStateUntrusted: 'Nicht vertrauenswürdig (relayId stimmt nicht überein)',
    federationStateUnknown: 'Unbekannt',
    federationPending: 'Vorschläge',
    federationNoPending: 'Keine offenen Vorschläge.',
    federationApprove: 'Bestätigen',
    federationReject: 'Ablehnen',
    federationBlacklist: 'Blacklist',
    federationBlacklistHint: 'Eine URL oder relayId pro Zeile. Wird nie angewählt, nie akzeptiert, nie automatisch gelernt - auch bei aktiviertem Auto-Learn.',
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
  .qu-relay-admin-federation-list { display: flex; flex-direction: column; gap: 0.3rem; margin: 0.4rem 0; }
  .qu-relay-admin-federation-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; padding: 0.35rem 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-relay-admin-federation-url { font-family: monospace; font-size: 0.9em; word-break: break-all; }
  .qu-relay-admin-federation-row input[type="text"] { flex: 1 1 12rem; min-width: 8rem; }
  .qu-relay-admin-federation-status { font-size: 0.78em; padding: 0.1rem 0.45rem; border-radius: 999px; border: 1px solid var(--qu-color-border, #8884); white-space: nowrap; }
  .qu-relay-admin-federation-status-connected { color: var(--qu-color-success, #2e8b57); border-color: var(--qu-color-success, #2e8b57); }
  .qu-relay-admin-federation-status-dead, .qu-relay-admin-federation-status-untrusted { color: var(--qu-color-danger, #d64545); border-color: var(--qu-color-danger, #d64545); }
  .qu-relay-admin-federation-status-connecting, .qu-relay-admin-federation-status-backoff { opacity: 0.75; }
  .qu-relay-admin-federation-add { display: flex; gap: 0.4rem; margin-top: 0.3rem; }
  .qu-relay-admin-federation-add input[type="text"] { flex: 1; }
  .qu-relay-admin textarea { font: inherit; padding: 0.3rem 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); width: 100%; max-width: 28rem; box-sizing: border-box; }
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
    // Chrome Inversion (`apps/shell/src/chrome.js`) - `container` is
    // already the platform's own content area; this app has no
    // navigation/views/primaryAction/settings needs, so there's no chrome
    // to set - just build straight into it, same as the real form below.
    const heading = document.createElement('h1');
    heading.textContent = t('title');
    const p = document.createElement('p');
    p.textContent = t('notAuthorized');
    container.append(heading, p);
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
  const menuThresholdLabel = document.createElement('label');
  const menuThresholdInput = document.createElement('input');
  menuThresholdInput.type = 'number';
  menuThresholdInput.min = '1';
  menuThresholdInput.value = String(settings.chrome?.menuThreshold ?? 8);
  menuThresholdLabel.append(document.createTextNode(t('menuThreshold')), menuThresholdInput);
  const menuThresholdHint = document.createElement('p');
  menuThresholdHint.className = 'qu-relay-admin-hint';
  menuThresholdHint.textContent = t('menuThresholdHint');
  generalSection.append(generalTitle, localeLabel, rateLimitLabel, menuThresholdLabel, menuThresholdHint);

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

  // ---- Federation ----
  const federationSection = document.createElement('section');
  const federationTitle = document.createElement('h2');
  federationTitle.textContent = t('federation');
  const federationHint = document.createElement('p');
  federationHint.className = 'qu-relay-admin-hint';
  federationHint.textContent = t('federationHint');

  const autoLearnLabel = document.createElement('label');
  const autoLearnInput = document.createElement('input');
  autoLearnInput.type = 'checkbox';
  autoLearnInput.checked = settings.federation?.autoLearn ?? false;
  autoLearnLabel.append(autoLearnInput, document.createTextNode(t('federationAutoLearn')));
  const autoLearnHint = document.createElement('p');
  autoLearnHint.className = 'qu-relay-admin-hint';
  autoLearnHint.textContent = t('federationAutoLearnHint');

  const allowSuggestSettingsLabel = document.createElement('label');
  const allowSuggestSettingsInput = document.createElement('input');
  allowSuggestSettingsInput.type = 'checkbox';
  allowSuggestSettingsInput.checked = settings.federation?.allowClientSuggestViaSettings ?? false;
  allowSuggestSettingsLabel.append(allowSuggestSettingsInput, document.createTextNode(t('federationAllowSuggestViaSettings')));

  const allowSuggestShareLabel = document.createElement('label');
  const allowSuggestShareInput = document.createElement('input');
  allowSuggestShareInput.type = 'checkbox';
  allowSuggestShareInput.checked = settings.federation?.allowClientSuggestViaShare ?? false;
  allowSuggestShareLabel.append(allowSuggestShareInput, document.createTextNode(t('federationAllowSuggestViaShare')));
  const allowSuggestHint = document.createElement('p');
  allowSuggestHint.className = 'qu-relay-admin-hint';
  allowSuggestHint.textContent = t('federationAllowSuggestHint');

  const hopLimitLabel = document.createElement('label');
  const hopLimitInput = document.createElement('input');
  hopLimitInput.type = 'number';
  hopLimitInput.min = '0';
  hopLimitInput.value = String(settings.federation?.hopLimit ?? 3);
  hopLimitLabel.append(document.createTextNode(t('federationHopLimit')), hopLimitInput);
  const hopLimitHint = document.createElement('p');
  hopLimitHint.className = 'qu-relay-admin-hint';
  hopLimitHint.textContent = t('federationHopLimitHint');

  const hopTimeoutLabel = document.createElement('label');
  const hopTimeoutInput = document.createElement('input');
  hopTimeoutInput.type = 'number';
  hopTimeoutInput.min = '100';
  hopTimeoutInput.step = '100';
  hopTimeoutInput.value = String(settings.federation?.hopTimeoutMs ?? 3000);
  hopTimeoutLabel.append(document.createTextNode(t('federationHopTimeoutMs')), hopTimeoutInput);

  const tryLimitLabel = document.createElement('label');
  const tryLimitInput = document.createElement('input');
  tryLimitInput.type = 'number';
  tryLimitInput.min = '1';
  tryLimitInput.value = String(settings.federation?.tryLimit ?? 10);
  tryLimitLabel.append(document.createTextNode(t('federationTryLimit')), tryLimitInput);
  const tryLimitHint = document.createElement('p');
  tryLimitHint.className = 'qu-relay-admin-hint';
  tryLimitHint.textContent = t('federationTryLimitHint');

  // Local, mutable copies - nothing here is persisted until the surrounding
  // form's own Save (same "batch edit, one submit" convention every other
  // section in this file already uses), except the dedicated Retry button
  // below, which is a genuine LIVE action, not a settings edit.
  let federationPeers = (settings.federation?.peers ?? []).map((p) => ({ ...p }));
  let federationPending = (settings.federation?.pending ?? []).map((p) => ({ ...p }));
  const federationStatusByUrl = new Map((config.federationStatus ?? []).map((s) => [s.url, s]));

  const peersTitle = document.createElement('h3');
  peersTitle.textContent = t('federationPeers');
  const peersHint = document.createElement('p');
  peersHint.className = 'qu-relay-admin-hint';
  peersHint.textContent = t('federationPeersHint');
  const peersList = document.createElement('div');
  peersList.className = 'qu-relay-admin-federation-list';

  function renderFederationPeers() {
    peersList.textContent = '';
    if (federationPeers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-relay-admin-hint';
      empty.textContent = t('federationNoPeers');
      peersList.appendChild(empty);
      return;
    }
    for (const peer of federationPeers) {
      const row = document.createElement('div');
      row.className = 'qu-relay-admin-federation-row';

      const urlSpan = document.createElement('span');
      urlSpan.className = 'qu-relay-admin-federation-url';
      urlSpan.textContent = peer.url;

      const status = federationStatusByUrl.get(peer.url);
      const statusBadge = document.createElement('span');
      const state = status?.state ?? 'unknown';
      statusBadge.className = `qu-relay-admin-federation-status qu-relay-admin-federation-status-${state}`;
      statusBadge.textContent = t(`federationState${state.charAt(0).toUpperCase()}${state.slice(1)}`);

      const prefixesInput = document.createElement('input');
      prefixesInput.type = 'text';
      prefixesInput.placeholder = t('federationPrefixesPlaceholder');
      prefixesInput.value = (peer.prefixes ?? []).join(', ');
      prefixesInput.addEventListener('input', () => {
        peer.prefixes = prefixesInput.value.split(',').map((s) => s.trim()).filter(Boolean);
      });

      row.append(urlSpan, statusBadge, prefixesInput);

      if (state === 'dead') {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.textContent = t('federationRetry');
        retryBtn.addEventListener('click', async () => {
          retryBtn.disabled = true;
          try {
            const mainKey = await identity.getMainKey();
            const signature = await QuCrypto.sign(new TextEncoder().encode(JSON.stringify({ url: peer.url })), mainKey.privateKeyPkcs8);
            const res = await fetch('/admin/federation/retry', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ actorPub: myPub, url: peer.url, signature: QuCrypto.toBase64Url(signature) }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
          } catch (err) {
            console.error('[relay-admin] federation retry failed:', err);
          } finally {
            retryBtn.disabled = false;
          }
        });
        row.appendChild(retryBtn);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = t('federationRemove');
      removeBtn.addEventListener('click', () => {
        federationPeers = federationPeers.filter((p) => p.url !== peer.url);
        renderFederationPeers();
      });
      row.appendChild(removeBtn);

      peersList.appendChild(row);
    }
  }
  renderFederationPeers();

  const addPeerRow = document.createElement('div');
  addPeerRow.className = 'qu-relay-admin-federation-add';
  const addPeerInput = document.createElement('input');
  addPeerInput.type = 'text';
  addPeerInput.placeholder = t('federationAddPlaceholder');
  const addPeerBtn = document.createElement('button');
  addPeerBtn.type = 'button';
  addPeerBtn.textContent = t('federationAdd');
  addPeerBtn.addEventListener('click', () => {
    const url = addPeerInput.value.trim();
    if (!url || federationPeers.some((p) => p.url === url)) return;
    federationPeers.push({ url, relayId: null, label: url, prefixes: [], addedAt: Date.now(), addedBy: myPub, source: 'manual' });
    addPeerInput.value = '';
    renderFederationPeers();
  });
  addPeerRow.append(addPeerInput, addPeerBtn);

  const pendingTitle = document.createElement('h3');
  pendingTitle.textContent = t('federationPending');
  const pendingList = document.createElement('div');
  pendingList.className = 'qu-relay-admin-federation-list';

  function renderFederationPending() {
    pendingList.textContent = '';
    if (federationPending.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'qu-relay-admin-hint';
      empty.textContent = t('federationNoPending');
      pendingList.appendChild(empty);
      return;
    }
    for (const item of federationPending) {
      const row = document.createElement('div');
      row.className = 'qu-relay-admin-federation-row';
      const label = document.createElement('span');
      label.className = 'qu-relay-admin-federation-url';
      label.textContent = `${item.url} (~${(item.suggestedBy ?? '').slice(0, 10)}…)`;
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.textContent = t('federationApprove');
      approveBtn.addEventListener('click', () => {
        federationPending = federationPending.filter((p) => p.url !== item.url);
        if (!federationPeers.some((p) => p.url === item.url)) {
          federationPeers.push({ url: item.url, relayId: item.relayId ?? null, label: item.url, prefixes: [], addedAt: Date.now(), addedBy: item.suggestedBy, source: 'client-learned' });
        }
        renderFederationPending();
        renderFederationPeers();
      });
      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.textContent = t('federationReject');
      rejectBtn.addEventListener('click', () => {
        federationPending = federationPending.filter((p) => p.url !== item.url);
        renderFederationPending();
      });
      row.append(label, approveBtn, rejectBtn);
      pendingList.appendChild(row);
    }
  }
  renderFederationPending();

  const blacklistLabel = document.createElement('h3');
  blacklistLabel.textContent = t('federationBlacklist');
  const blacklistHint = document.createElement('p');
  blacklistHint.className = 'qu-relay-admin-hint';
  blacklistHint.textContent = t('federationBlacklistHint');
  const blacklistTextarea = document.createElement('textarea');
  blacklistTextarea.rows = 3;
  blacklistTextarea.value = (settings.federation?.blacklist ?? []).join('\n');

  federationSection.append(
    federationTitle, federationHint,
    autoLearnLabel, autoLearnHint,
    allowSuggestSettingsLabel, allowSuggestShareLabel, allowSuggestHint,
    hopLimitLabel, hopLimitHint, hopTimeoutLabel, tryLimitLabel, tryLimitHint,
    peersTitle, peersHint, peersList, addPeerRow,
    pendingTitle, pendingList,
    blacklistLabel, blacklistHint, blacklistTextarea
  );

  // ---- Save ----
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.textContent = t('save');
  const status = document.createElement('p');
  status.className = 'qu-relay-admin-status';
  status.hidden = true;

  form.append(generalSection, appsSection, channelsSection, chatSection, linkPreviewsSection, ...orderSections.map((o) => o.section), flagTypesSection, federationSection, saveBtn, status);

  // Chrome Inversion (`apps/shell/src/chrome.js`) - none of
  // `navigation`/`views`/`primaryAction`/`settings` fit a single settings
  // form with no sibling "places" or create action, so there's no chrome
  // to set - `container` is already the platform's own content area, just
  // build straight into it, same shape `apps/search/client.js`'s own
  // `mount()` uses for its own chrome-less parts.
  const heading = document.createElement('h1');
  heading.textContent = t('title');
  container.append(heading, form);

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
        chrome: { menuThreshold: Math.max(1, Number(menuThresholdInput.value) || 8) },
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
        federation: {
          autoLearn: autoLearnInput.checked,
          allowClientSuggestViaSettings: allowSuggestSettingsInput.checked,
          allowClientSuggestViaShare: allowSuggestShareInput.checked,
          hopLimit: Math.max(0, Number(hopLimitInput.value) || 0),
          hopTimeoutMs: Math.max(100, Number(hopTimeoutInput.value) || 3000),
          tryLimit: Math.max(1, Number(tryLimitInput.value) || 10),
          peers: federationPeers,
          pending: federationPending,
          blacklist: blacklistTextarea.value.split('\n').map((s) => s.trim()).filter(Boolean),
        },
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
