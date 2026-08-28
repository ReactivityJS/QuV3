/**
 * DATA MANAGER — a resolved viewer + filter + export/import UI over Qu data,
 * scoped by permission level:
 *
 *  - EVERY identity ("My Data") gets Overview/Chats/Browse: their own
 *    profile+contacts, every 1:1/group chat they're a member of (export a
 *    single chat or all of them, re-import previously-exported messages),
 *    and a generic recursive browser over any path they have local data
 *    under. ALL of this goes through the exact same client-side Services
 *    catalog (`@qu/services`) and `QuStore.getChildren()`/`.get()`/`.put()`
 *    every other app in this codebase already uses - no adapter reached
 *    into directly, no bespoke storage-walking mechanism invented for this
 *    app alone. Import for a shared chat re-POSTS through
 *    `MessageService.postMessage()` (real signing, real encryption, real
 *    `AccessEngine` authorization) rather than any lower-level write, so it
 *    can only ever restore messages THIS identity is actually authorized to
 *    write - see `importChatMessages()`'s own doc comment for exactly what
 *    that means for someone else's messages in an export file.
 *
 *  - An ADMIN (this relay's own `adminPubs`, same check `apps/relay-admin`
 *    already uses) additionally gets "Relay Data": a thin UI over
 *    `@qu/relay`'s ALREADY-EXISTING, already signature-gated
 *    `/admin/data/list`/`/admin/data/import` (`admin-http.js`'s own doc
 *    comment already named this exact gap - "Data Explorer has no UI here
 *    at all yet"). This view can see/restore EVERY QuBit on the relay's
 *    disk, byte-exact (`QuStore.putSealed()`), which is why it stays admin-
 *    only and server-verified, never merged into the "My Data" write path.
 *
 * Both tiers share one filtering primitive: `@qu/ui`'s own
 * `buildFilterInput()` (the same plain-text, client-side filter every other
 * app's sidebar search already uses) over whatever rows are currently
 * loaded - no new filter language invented for this app.
 */
import { QuCrypto } from '@qu/core';
import { createI18n } from '@qu/i18n';
import { ensureTheme, injectStyle, buildFilterInput } from '@qu/ui';
import { ChatService, formatActorLabel } from '@qu/services';

const DICT = {
  en: {
    title: 'Data Manager',
    navOverview: 'Overview',
    navChats: 'Chats',
    navBrowse: 'Browse',
    navRelay: 'Relay Data (Admin)',
    notAuthorizedRelay: 'This identity is not a configured admin for this relay - nothing to show.',
    overviewHeading: 'My Data',
    myProfile: 'Profile',
    profileAlias: 'Alias',
    profilePub: 'Public key',
    noAlias: '(no alias set)',
    exportAllMyData: 'Export all my data',
    exportAllMyDataHint: 'Profile, contacts, and every chat you’re a member of, bundled into one JSON file.',
    importData: 'Import data file…',
    importDataHint: 'Restores your own previously-exported messages into the matching chats. Messages authored by someone else are listed, never re-posted under your identity.',
    chatsHeading: 'Chats',
    chatsEmpty: 'No chats found - either you have none yet, or nothing has synced to this device.',
    kindDm: 'Direct message',
    kindGroup: 'Group',
    exportChat: 'Export',
    openChat: 'Open',
    chatDetailHeading: 'Chat',
    backToChats: '← All chats',
    filterMessages: 'Filter messages…',
    exportThisChat: 'Export this chat',
    importIntoThisChat: 'Import messages…',
    noMessages: 'No messages loaded yet.',
    loadingMessages: 'Loading messages…',
    messageCount: '{count} messages',
    importResult: 'Imported {imported}, skipped {skipped} (not authored by you or already present) of {total}.',
    browseHeading: 'Browse',
    browseHint: 'Recursively lists every locally-known QuBit under the given path, via QuStore.getChildren() - the same API every other app in this platform reads through. Encrypted content shows as raw ciphertext, exactly as stored.',
    browsePathLabel: 'Path',
    browseLoad: 'Load',
    browseLoading: 'Loading…',
    browseEmpty: 'No entries found under this path.',
    exportVisible: 'Export visible entries',
    filterPathPlaceholder: 'Filter by path or content…',
    entryCount: '{count} entries',
    relayHeading: 'Relay Data (Admin)',
    relayHint: 'The complete relay-wide Data Explorer - every QuBit on this relay’s disk under the given prefix, list/export/import. Import restores the ORIGINAL signature/timestamp exactly (an admin operation, not a normal write) - see /admin/data/import.',
    relayPrefixLabel: 'Prefix',
    relayList: 'List',
    relayListing: 'Listing…',
    relayEmpty: 'No entries found under this prefix.',
    relayMore: 'More than {limit} entries matched - narrow the prefix to see/export the rest.',
    relayExport: 'Export listed entries',
    relayImport: 'Import file…',
    relayImportResult: 'Imported {imported}, skipped {skipped} of {total}.',
    relayFailed: 'Failed: {error}',
    unknownChat: 'Unknown chat',
    you: 'you',
  },
  de: {
    title: 'Daten-Manager',
    navOverview: 'Übersicht',
    navChats: 'Chats',
    navBrowse: 'Durchsuchen',
    navRelay: 'Relay-Daten (Admin)',
    notAuthorizedRelay: 'Diese Identität ist auf diesem Relay nicht als Admin konfiguriert - nichts anzuzeigen.',
    overviewHeading: 'Meine Daten',
    myProfile: 'Profil',
    profileAlias: 'Alias',
    profilePub: 'Öffentlicher Schlüssel',
    noAlias: '(kein Alias gesetzt)',
    exportAllMyData: 'Alle meine Daten exportieren',
    exportAllMyDataHint: 'Profil, Kontakte und jeder Chat, dessen Mitglied du bist, in einer JSON-Datei.',
    importData: 'Datendatei importieren…',
    importDataHint: 'Stellt deine eigenen, zuvor exportierten Nachrichten in den passenden Chats wieder her. Nachrichten anderer Autoren werden aufgelistet, aber nie unter deiner Identität erneut gepostet.',
    chatsHeading: 'Chats',
    chatsEmpty: 'Keine Chats gefunden - entweder gibt es noch keine, oder es ist noch nichts auf dieses Gerät synchronisiert.',
    kindDm: 'Direktnachricht',
    kindGroup: 'Gruppe',
    exportChat: 'Exportieren',
    openChat: 'Öffnen',
    chatDetailHeading: 'Chat',
    backToChats: '← Alle Chats',
    filterMessages: 'Nachrichten filtern…',
    exportThisChat: 'Diesen Chat exportieren',
    importIntoThisChat: 'Nachrichten importieren…',
    noMessages: 'Noch keine Nachrichten geladen.',
    loadingMessages: 'Nachrichten werden geladen…',
    messageCount: '{count} Nachrichten',
    importResult: '{imported} importiert, {skipped} übersprungen (nicht von dir verfasst oder bereits vorhanden) von {total}.',
    browseHeading: 'Durchsuchen',
    browseHint: 'Listet rekursiv jedes lokal bekannte QuBit unter dem angegebenen Pfad auf - über QuStore.getChildren(), dieselbe API, über die jede andere App dieser Plattform liest. Verschlüsselte Inhalte erscheinen als rohes Chiffrat, genau wie gespeichert.',
    browsePathLabel: 'Pfad',
    browseLoad: 'Laden',
    browseLoading: 'Wird geladen…',
    browseEmpty: 'Keine Einträge unter diesem Pfad gefunden.',
    exportVisible: 'Sichtbare Einträge exportieren',
    filterPathPlaceholder: 'Nach Pfad oder Inhalt filtern…',
    entryCount: '{count} Einträge',
    relayHeading: 'Relay-Daten (Admin)',
    relayHint: 'Der vollständige, relay-weite Data Explorer - jedes QuBit auf der Festplatte dieses Relays unter dem angegebenen Prefix, auflisten/exportieren/importieren. Import stellt Original-Signatur/-Zeitstempel exakt wieder her (eine Admin-Aktion, kein normaler Schreibvorgang) - siehe /admin/data/import.',
    relayPrefixLabel: 'Prefix',
    relayList: 'Auflisten',
    relayListing: 'Wird aufgelistet…',
    relayEmpty: 'Keine Einträge unter diesem Prefix gefunden.',
    relayMore: 'Mehr als {limit} Einträge gefunden - Prefix eingrenzen, um den Rest zu sehen/exportieren.',
    relayExport: 'Aufgelistete Einträge exportieren',
    relayImport: 'Datei importieren…',
    relayImportResult: '{imported} importiert, {skipped} übersprungen von {total}.',
    relayFailed: 'Fehlgeschlagen: {error}',
    unknownChat: 'Unbekannter Chat',
    you: 'du',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-data-manager-style';
const STYLE = `
  .qu-dm h1 { font-size: 1.3em; margin: 0 0 0.6rem; }
  .qu-dm section { margin-bottom: 1.4rem; }
  .qu-dm h2 { font-size: 1em; margin: 0 0 0.4rem; }
  .qu-dm p.qu-dm-hint { font-size: 0.85em; opacity: 0.7; margin: 0.2rem 0 0.6rem; max-width: 42rem; }
  .qu-dm button { font: inherit; padding: 0.35rem 0.8rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); background: none; cursor: pointer; }
  .qu-dm button:disabled { opacity: 0.5; cursor: default; }
  .qu-dm input[type="text"], .qu-dm input[type="search"] { font: inherit; padding: 0.3rem 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-dm-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: 0.3rem 0; }
  .qu-dm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-dm-list-item { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); flex-wrap: wrap; }
  .qu-dm-list-item-main { display: flex; flex-direction: column; min-width: 0; }
  .qu-dm-list-item-name { font-weight: 600; }
  .qu-dm-list-item-meta { font-size: 0.8em; opacity: 0.7; }
  .qu-dm-badge { font-size: 0.72em; padding: 0.05rem 0.4rem; border-radius: 999px; border: 1px solid var(--qu-color-border, #8884); opacity: 0.8; }
  .qu-dm-status { font-size: 0.85em; margin-top: 0.4rem; }
  .qu-dm-status-error { color: var(--qu-color-danger, #d64545); }
  .qu-dm-entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; max-height: 32rem; overflow-y: auto; }
  .qu-dm-entry { padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--qu-color-border, #8884); font-size: 0.85em; }
  .qu-dm-entry-path { font-family: monospace; word-break: break-all; }
  .qu-dm-entry-value { font-family: monospace; opacity: 0.75; white-space: pre-wrap; word-break: break-all; max-height: 6rem; overflow-y: auto; margin: 0.2rem 0 0; }
  .qu-dm-message { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-dm-message-meta { font-size: 0.78em; opacity: 0.65; }
`;

/** Splits `contacts[]`/`groupIds[]` into one uniform room-shape list. See `apps/chat/client.js`'s own `listRooms()` for the fuller version this borrows the discovery mechanism from (contacts + `listMyGroups()`) - trimmed here to just what a data manager needs (no unread/muted/hidden state). */
async function fetchAllRooms(services, myPub, chatSpaceId) {
  if (!chatSpaceId) return [];
  const [contacts, groupIds] = await Promise.all([services.contacts.listContacts(), services.chat.listMyGroups()]);

  const dmRooms = await Promise.all(contacts.map(async (c) => ({
    kind: 'dm',
    spaceId: chatSpaceId,
    threadId: await ChatService.roomId([myPub, c.actorPub]),
    name: formatActorLabel(c.actorPub, c.profile),
  })));

  const groupRooms = (await Promise.all(groupIds.map(async (groupId) => {
    const config = await services.messages.getConfig(chatSpaceId, groupId);
    if (!config) return null; // invited but the group thread itself hasn't synced in yet
    return { kind: 'group', spaceId: chatSpaceId, threadId: groupId, name: config.name ?? groupId };
  }))).filter(Boolean);

  return [...dmRooms, ...groupRooms];
}

/** Pages through `MessageService.listMessages()` end to end, oldest first - the full history a real export needs, not just one page. */
async function fetchAllMessages(services, spaceId, threadId) {
  const all = [];
  let cursor = null;
  do {
    const { messages, nextCursor } = await services.messages.listMessages(spaceId, threadId, { order: 'asc', limit: 200, cursor });
    all.push(...messages);
    cursor = nextCursor;
  } while (cursor);
  return all;
}

/** @returns {Promise<{app: string, version: number, kind: 'chat', exportedAt: number, spaceId: *, threadId: string, config: object, messages: Array<object>}>} */
async function buildChatExport(services, spaceId, threadId) {
  const [config, messages] = await Promise.all([services.messages.getConfig(spaceId, threadId), fetchAllMessages(services, spaceId, threadId)]);
  return { app: 'quv3-chat-export', version: 1, kind: 'chat', exportedAt: Date.now(), spaceId, threadId, config, messages };
}

/**
 * The write half of a chat import - re-POSTS each message through
 * `MessageService.postMessage()`, the exact same authorized, signed, (for a
 * restricted thread) encrypted write path a real chat send already uses.
 * This can only ever succeed for messages `myPub` itself authored: a
 * message with a different `author` is skipped, never silently re-posted
 * under this identity (that would misattribute someone else's words) and
 * never write-authorized anyway if the thread's own `writers` doesn't
 * include this identity. Because `postMessage()` always mints a fresh id/
 * timestamp, a re-imported message is a NEW entry with the same content,
 * not a byte-exact restore of the original - `extra.importedFrom` records
 * the original timestamp so a UI could tell them apart later. A byte-exact
 * restore (original signature/timestamp preserved) is what the admin-only
 * Relay Data tab's `/admin/data/import` is for instead.
 * @param {object} services @param {*} spaceId @param {string} threadId
 * @param {Array<object>} messages - As produced by `fetchAllMessages()`/`buildChatExport()`.
 * @param {string} myPub
 * @returns {Promise<{imported: number, skipped: number, total: number}>}
 */
async function importChatMessages(services, spaceId, threadId, messages, myPub) {
  let imported = 0;
  let skipped = 0;
  for (const message of messages) {
    if (message?.author !== myPub || typeof message?.body !== 'string') {
      skipped++;
      continue;
    }
    try {
      await services.messages.postMessage(spaceId, threadId, {
        body: message.body,
        replyTo: message.replyTo ?? null,
        extra: { importedFrom: message.ts ?? null },
      });
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped, total: messages.length };
}

/**
 * Recursively lists every locally-known QuBit under `rootPath`, purely via
 * `QuStore.getChildren()` (ONE level at a time, per its own documented
 * contract - see docs/v3-technical-concept.md §1.2) - never the underlying
 * adapter directly. A path can hold both a value AND children (e.g. a
 * thread's `meta` document is a sibling of its `msgs/` parent, not a
 * descendant), so every child is both recorded (if it has a value) and
 * recursed into, regardless.
 * @param {import('@qu/core').QuStore} qu @param {string} rootPath
 * @param {{maxDepth?: number, limitPerLevel?: number}} [options]
 * @returns {Promise<Array<{path: string, quBit: object}>>}
 */
async function walkQuTree(qu, rootPath, { maxDepth = 8, limitPerLevel = 500 } = {}) {
  const out = [];
  async function walk(path, depth) {
    if (depth > maxDepth) return;
    let children;
    try {
      children = await qu.getChildren(path, { limit: limitPerLevel });
    } catch {
      return; // not a listable mount (e.g. a path outside any registered mount) - nothing more to do
    }
    for (const { path: childPath, quBit } of children) {
      if (quBit && quBit.val !== null && quBit.val !== undefined) out.push({ path: childPath, quBit });
      await walk(childPath, depth + 1);
    }
  }
  await walk(rootPath, 0);
  return out;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** @param {(data: object) => void} onLoaded @returns {HTMLInputElement} A file-picker input already wired to parse+forward its JSON content; not yet appended anywhere. */
function buildImportInput(onLoaded, status) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await onLoaded(data);
    } catch (err) {
      if (status) {
        status.textContent = t('relayFailed', { error: err.message });
        status.classList.add('qu-dm-status-error');
        status.hidden = false;
      }
    }
  });
  return input;
}

function fmt(key, vars) {
  return t(key).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ''));
}

function signAdminPayload(identity, payload) {
  return (async () => {
    const mainKey = await identity.getMainKey();
    const signature = await QuCrypto.sign(new TextEncoder().encode(JSON.stringify(payload)), mainKey.privateKeyPkcs8);
    return QuCrypto.toBase64Url(signature);
  })();
}

async function renderOverview(container, { services, identity, myPub, chatSpaceId }) {
  container.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = t('overviewHeading');
  container.appendChild(h1);

  const profile = await services.profile.getOwnProfile();
  const profileSection = document.createElement('section');
  const profileTitle = document.createElement('h2');
  profileTitle.textContent = t('myProfile');
  const aliasP = document.createElement('p');
  aliasP.textContent = `${t('profileAlias')}: ${profile.alias || t('noAlias')}`;
  const pubP = document.createElement('p');
  pubP.className = 'qu-dm-list-item-meta';
  pubP.textContent = `${t('profilePub')}: ${myPub}`;
  profileSection.append(profileTitle, aliasP, pubP);

  const exportSection = document.createElement('section');
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('exportAllMyData');
  const exportHint = document.createElement('p');
  exportHint.className = 'qu-dm-hint';
  exportHint.textContent = t('exportAllMyDataHint');
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const [contacts, rooms] = await Promise.all([services.contacts.listContacts(), fetchAllRooms(services, myPub, chatSpaceId)]);
      const chats = await Promise.all(rooms.map((room) => buildChatExport(services, room.spaceId, room.threadId).then((data) => ({ ...room, ...data }))));
      downloadJson(`quv3-my-data-${myPub.slice(0, 8)}.json`, {
        app: 'quv3-data-export', version: 1, kind: 'user', exportedAt: Date.now(), actorPub: myPub,
        profile, contacts: contacts.map(({ actorPub, starredAt }) => ({ actorPub, starredAt })), chats,
      });
    } finally {
      exportBtn.disabled = false;
    }
  });
  exportSection.append(exportBtn, exportHint);

  const importSection = document.createElement('section');
  const importStatus = document.createElement('p');
  importStatus.className = 'qu-dm-status';
  importStatus.hidden = true;
  const importInput = buildImportInput(async (data) => {
    if (data?.kind === 'user' && Array.isArray(data.chats)) {
      let imported = 0, skipped = 0, total = 0;
      for (const chat of data.chats) {
        if (!chat.spaceId || !chat.threadId || !Array.isArray(chat.messages)) continue;
        const result = await importChatMessages(services, chat.spaceId, chat.threadId, chat.messages, myPub);
        imported += result.imported; skipped += result.skipped; total += result.total;
      }
      importStatus.textContent = fmt('importResult', { imported, skipped, total });
      importStatus.classList.remove('qu-dm-status-error');
    } else if (data?.kind === 'chat' && data.spaceId && data.threadId) {
      const result = await importChatMessages(services, data.spaceId, data.threadId, data.messages ?? [], myPub);
      importStatus.textContent = fmt('importResult', result);
      importStatus.classList.remove('qu-dm-status-error');
    } else {
      importStatus.textContent = t('relayFailed', { error: 'unrecognized file' });
      importStatus.classList.add('qu-dm-status-error');
    }
    importStatus.hidden = false;
  }, importStatus);
  const importLabel = document.createElement('label');
  importLabel.className = 'qu-dm-row';
  importLabel.append(t('importData'), importInput);
  const importHint = document.createElement('p');
  importHint.className = 'qu-dm-hint';
  importHint.textContent = t('importDataHint');
  importSection.append(importLabel, importHint, importStatus);

  container.append(profileSection, exportSection, importSection);
}

async function renderChatsOverview(container, { services, myPub, chatSpaceId }) {
  container.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = t('chatsHeading');
  container.appendChild(h1);

  const rooms = await fetchAllRooms(services, myPub, chatSpaceId);
  if (rooms.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = t('chatsEmpty');
    container.appendChild(empty);
    return;
  }

  const filterWrap = document.createElement('div');
  const list = document.createElement('ul');
  list.className = 'qu-dm-list';

  for (const room of rooms) {
    const li = document.createElement('li');
    li.className = 'qu-dm-list-item';
    li.dataset.search = room.name.toLowerCase();

    const main = document.createElement('div');
    main.className = 'qu-dm-list-item-main';
    const name = document.createElement('span');
    name.className = 'qu-dm-list-item-name';
    name.textContent = room.name;
    const badge = document.createElement('span');
    badge.className = 'qu-dm-badge';
    badge.textContent = room.kind === 'group' ? t('kindGroup') : t('kindDm');
    main.append(name, badge);

    const actions = document.createElement('div');
    actions.className = 'qu-dm-row';
    const openLink = document.createElement('a');
    openLink.href = `#/data-manager/chats/${encodeURIComponent(room.spaceId)}/${encodeURIComponent(room.threadId)}`;
    openLink.textContent = t('openChat');
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = t('exportChat');
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      try {
        const data = await buildChatExport(services, room.spaceId, room.threadId);
        downloadJson(`quv3-chat-${room.threadId}.json`, { ...data, name: room.name });
      } finally {
        exportBtn.disabled = false;
      }
    });
    actions.append(openLink, exportBtn);

    li.append(main, actions);
    list.appendChild(li);
  }

  filterWrap.appendChild(buildFilterInput(
    () => [...list.children].map((el) => ({ el, search: el.dataset.search ?? '' })),
    { placeholder: t('filterMessages') },
  ));
  container.append(filterWrap, list);
}

async function renderChatDetail(container, { services, myPub, spaceId, threadId }) {
  container.textContent = '';
  const back = document.createElement('a');
  back.href = '#/data-manager/chats';
  back.textContent = t('backToChats');
  container.appendChild(back);

  const h1 = document.createElement('h1');
  container.appendChild(h1);

  const status = document.createElement('p');
  status.className = 'qu-dm-status';
  status.hidden = true;

  const config = await services.messages.getConfig(spaceId, threadId);
  h1.textContent = config?.name ? config.name : t('unknownChat');

  const actions = document.createElement('div');
  actions.className = 'qu-dm-row';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('exportThisChat');
  const importInput = buildImportInput(async (data) => {
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const result = await importChatMessages(services, spaceId, threadId, messages, myPub);
    status.textContent = fmt('importResult', result);
    status.classList.remove('qu-dm-status-error');
    status.hidden = false;
    await renderMessages();
  }, status);
  const importLabel = document.createElement('label');
  importLabel.append(t('importIntoThisChat'), importInput);
  actions.append(exportBtn, importLabel);

  const countP = document.createElement('p');
  countP.textContent = t('loadingMessages');

  const filterWrap = document.createElement('div');
  const list = document.createElement('ul');
  list.className = 'qu-dm-entries';

  container.append(actions, countP, filterWrap, list, status);

  let currentMessages = [];
  exportBtn.addEventListener('click', () => {
    downloadJson(`quv3-chat-${threadId}.json`, { app: 'quv3-chat-export', version: 1, kind: 'chat', exportedAt: Date.now(), spaceId, threadId, config, messages: currentMessages });
  });

  async function renderMessages() {
    list.textContent = '';
    countP.textContent = t('loadingMessages');
    currentMessages = await fetchAllMessages(services, spaceId, threadId);
    countP.textContent = fmt('messageCount', { count: currentMessages.length });
    if (currentMessages.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('noMessages');
      list.appendChild(empty);
      return;
    }
    for (const message of currentMessages) {
      const li = document.createElement('li');
      li.className = 'qu-dm-message';
      li.dataset.search = (message.body ?? '').toLowerCase();
      const meta = document.createElement('div');
      meta.className = 'qu-dm-message-meta';
      meta.textContent = `${message.author === myPub ? t('you') : `~${String(message.author).slice(0, 10)}…`} · ${new Date(message.ts).toLocaleString()}`;
      const body = document.createElement('div');
      body.textContent = message.body ?? '';
      li.append(meta, body);
      list.appendChild(li);
    }
  }
  await renderMessages();

  filterWrap.appendChild(buildFilterInput(
    () => [...list.children].filter((el) => el.classList.contains('qu-dm-message')).map((el) => ({ el, search: el.dataset.search ?? '' })),
    { placeholder: t('filterMessages') },
  ));
}

async function renderBrowse(container, { qu, myPub, subscribe, syncFetch }) {
  container.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = t('browseHeading');
  const hint = document.createElement('p');
  hint.className = 'qu-dm-hint';
  hint.textContent = t('browseHint');
  container.append(h1, hint);

  const pathRow = document.createElement('div');
  pathRow.className = 'qu-dm-row';
  const pathLabel = document.createElement('label');
  pathLabel.textContent = t('browsePathLabel');
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.value = `/store/actors/~${myPub}`;
  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.textContent = t('browseLoad');
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('exportVisible');
  exportBtn.disabled = true;
  pathRow.append(pathLabel, pathInput, loadBtn, exportBtn);

  const countP = document.createElement('p');
  const filterWrap = document.createElement('div');
  const list = document.createElement('ul');
  list.className = 'qu-dm-entries';
  container.append(pathRow, countP, filterWrap, list);

  let currentEntries = [];
  exportBtn.addEventListener('click', () => {
    downloadJson('quv3-browse-export.json', { app: 'quv3-data-export', version: 1, kind: 'entries', exportedAt: Date.now(), entries: currentEntries.map(({ path, quBit }) => ({ path, value: quBit })) });
  });

  async function load() {
    if (loadBtn.disabled) return; // already loading - a click (or the initial auto-load) mid-flight must never race a second walkQuTree() against the same list/countP
    const rootPath = pathInput.value.trim();
    if (!rootPath) return;
    loadBtn.disabled = true;
    subscribe?.(rootPath);
    await syncFetch?.(rootPath)?.catch(() => {});
    countP.textContent = t('browseLoading');
    list.textContent = '';
    try {
      currentEntries = await walkQuTree(qu, rootPath);
      countP.textContent = currentEntries.length === 0 ? t('browseEmpty') : fmt('entryCount', { count: currentEntries.length });
      exportBtn.disabled = currentEntries.length === 0;
      for (const { path, quBit } of currentEntries) {
        const li = document.createElement('li');
        li.className = 'qu-dm-entry';
        const preview = JSON.stringify(quBit.val);
        li.dataset.search = `${path} ${preview}`.toLowerCase();
        const pathEl = document.createElement('div');
        pathEl.className = 'qu-dm-entry-path';
        pathEl.textContent = path;
        const valueEl = document.createElement('pre');
        valueEl.className = 'qu-dm-entry-value';
        valueEl.textContent = preview.length > 2000 ? `${preview.slice(0, 2000)}…` : preview;
        li.append(pathEl, valueEl);
        list.appendChild(li);
      }
    } finally {
      loadBtn.disabled = false;
    }
  }
  loadBtn.addEventListener('click', load);

  filterWrap.appendChild(buildFilterInput(
    () => [...list.children].map((el) => ({ el, search: el.dataset.search ?? '' })),
    { placeholder: t('filterPathPlaceholder') },
  ));

  await load();
}

async function renderRelay(container, { identity, myPub }) {
  container.textContent = '';
  const h1 = document.createElement('h1');
  h1.textContent = t('relayHeading');
  const hint = document.createElement('p');
  hint.className = 'qu-dm-hint';
  hint.textContent = t('relayHint');
  container.append(h1, hint);

  const prefixRow = document.createElement('div');
  prefixRow.className = 'qu-dm-row';
  const prefixLabel = document.createElement('label');
  prefixLabel.textContent = t('relayPrefixLabel');
  const prefixInput = document.createElement('input');
  prefixInput.type = 'text';
  prefixInput.value = '/store';
  const listBtn = document.createElement('button');
  listBtn.type = 'button';
  listBtn.textContent = t('relayList');
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.textContent = t('relayExport');
  exportBtn.disabled = true;
  prefixRow.append(prefixLabel, prefixInput, listBtn, exportBtn);

  const countP = document.createElement('p');
  const filterWrap = document.createElement('div');
  const list = document.createElement('ul');
  list.className = 'qu-dm-entries';
  const status = document.createElement('p');
  status.className = 'qu-dm-status';
  status.hidden = true;

  const importInput = buildImportInput(async (data) => {
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const signature = await signAdminPayload(identity, entries);
    const res = await fetch('/admin/data/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorPub: myPub, entries, signature }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status.textContent = t('relayFailed', { error: body.error ?? `HTTP ${res.status}` });
      status.classList.add('qu-dm-status-error');
    } else {
      status.textContent = fmt('relayImportResult', body);
      status.classList.remove('qu-dm-status-error');
    }
    status.hidden = false;
  }, status);
  const importLabel = document.createElement('label');
  importLabel.className = 'qu-dm-row';
  importLabel.append(t('relayImport'), importInput);

  const moreP = document.createElement('p');
  moreP.className = 'qu-dm-hint';
  moreP.hidden = true;

  container.append(prefixRow, countP, moreP, filterWrap, list, importLabel, status);

  let currentEntries = [];
  exportBtn.addEventListener('click', () => {
    downloadJson('quv3-relay-export.json', { app: 'quv3-data-export', version: 1, kind: 'entries', exportedAt: Date.now(), entries: currentEntries });
  });

  async function load() {
    if (listBtn.disabled) return; // already loading - see renderBrowse()'s own load() for why this guard has to be the very first, synchronous statement
    listBtn.disabled = true;
    const query = { prefix: prefixInput.value.trim() || '/store', limit: 1000 };
    countP.textContent = t('relayListing');
    list.textContent = '';
    status.hidden = true;
    try {
      const signature = await signAdminPayload(identity, query);
      const res = await fetch('/admin/data/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorPub: myPub, query, signature }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      currentEntries = body.entries ?? [];
      countP.textContent = currentEntries.length === 0 ? t('relayEmpty') : fmt('entryCount', { count: currentEntries.length });
      exportBtn.disabled = currentEntries.length === 0;
      moreP.hidden = !body.hasMore;
      moreP.textContent = body.hasMore ? fmt('relayMore', { limit: query.limit }) : '';
      for (const entry of currentEntries) {
        const li = document.createElement('li');
        li.className = 'qu-dm-entry';
        const preview = entry.truncated ? `[${entry.byteLength} bytes, truncated]` : entry.error ? `[error: ${entry.error}]` : JSON.stringify(entry.value);
        li.dataset.search = `${entry.path} ${preview}`.toLowerCase();
        const pathEl = document.createElement('div');
        pathEl.className = 'qu-dm-entry-path';
        pathEl.textContent = entry.path;
        const valueEl = document.createElement('pre');
        valueEl.className = 'qu-dm-entry-value';
        valueEl.textContent = preview.length > 2000 ? `${preview.slice(0, 2000)}…` : preview;
        li.append(pathEl, valueEl);
        list.appendChild(li);
      }
    } catch (err) {
      countP.textContent = '';
      status.textContent = t('relayFailed', { error: err.message });
      status.classList.add('qu-dm-status-error');
      status.hidden = false;
    } finally {
      listBtn.disabled = false;
    }
  }
  listBtn.addEventListener('click', load);

  filterWrap.appendChild(buildFilterInput(
    () => [...list.children].map((el) => ({ el, search: el.dataset.search ?? '' })),
    { placeholder: t('filterPathPlaceholder') },
  ));

  await load();
}

function renderNotAuthorized(container) {
  container.textContent = '';
  const p = document.createElement('p');
  p.textContent = t('notAuthorizedRelay');
  container.appendChild(p);
}

/**
 * @param {HTMLElement} container
 * @param {{qu: object, identity: object, services: object, apps: Array<object>, segments?: string[], subscribe?: Function, syncFetch?: Function, chrome?: {set: Function}}} ctx
 */
export function mount(container, { qu, identity, services, apps = [], segments = [], subscribe, syncFetch, chrome = { set() {} } }) {
  let stopped = false;
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  container.classList.add('qu-dm');

  (async () => {
    const myPub = await services.actors.whoAmI();
    if (stopped) return;

    let adminPubs = [];
    try {
      const res = await fetch('/config.json');
      if (res.ok) adminPubs = (await res.json())?.adminPubs ?? [];
    } catch { /* offline/unreachable - same as "not admin": nothing privileged this identity could do right now anyway */ }
    if (stopped) return;
    const isAdmin = adminPubs.includes(myPub);

    const chatSpaceId = apps.find((a) => a.name === 'chat')?.spaceId ?? null;
    subscribe?.(`/store/actors/~${myPub}`);
    if (chatSpaceId) subscribe?.(`/store/${chatSpaceId}`);

    const view = segments[1] ?? 'overview';
    const navItems = [
      { id: 'overview', label: t('navOverview'), href: '#/data-manager' },
      { id: 'chats', label: t('navChats'), href: '#/data-manager/chats' },
      { id: 'browse', label: t('navBrowse'), href: '#/data-manager/browse' },
    ];
    if (isAdmin) navItems.push({ id: 'relay', label: t('navRelay'), href: '#/data-manager/relay' });
    chrome.set({ navigation: { items: navItems, activeId: view === 'overview' ? 'overview' : view, heading: t('title') } });

    if (view === 'chats' && segments[2] && segments[3]) {
      await renderChatDetail(container, { services, myPub, spaceId: decodeURIComponent(segments[2]), threadId: decodeURIComponent(segments[3]) });
    } else if (view === 'chats') {
      await renderChatsOverview(container, { services, myPub, chatSpaceId });
    } else if (view === 'browse') {
      await renderBrowse(container, { qu, myPub, subscribe, syncFetch });
    } else if (view === 'relay') {
      if (isAdmin) await renderRelay(container, { identity, myPub });
      else renderNotAuthorized(container);
    } else {
      await renderOverview(container, { services, identity, myPub, chatSpaceId });
    }
  })();

  return () => { stopped = true; };
}
