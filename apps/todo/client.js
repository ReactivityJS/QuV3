/**
 * TODO — shared to-do lists, built on the same "one fixed app space, many
 * independently-owned+shared rooms" shape `apps/calendar` already
 * established (see that app's own top doc comment for the full rationale -
 * `@qu/relay`'s manifest-driven push resolver only ever knows THIS app's
 * own `manifest.spaceId`, never a per-instance dynamic space). All the
 * membership/invite/ACL mechanics (owner/editor/viewer roles, invite by
 * alias/pub with live autocomplete, keeping a sibling resource's writer ACL
 * in sync as roles change, "my resources" private star list, pending-invite
 * discovery) are `@qu/services`' generic `SharingService` (`services.sharing`) -
 * extracted FROM Calendar's own previously-inline logic once THIS app
 * needed the identical shape, so neither app hand-rolls it a second time.
 *
 * STORAGE SHAPE — each list `<listId>` (a fresh `crypto.randomUUID()`) gets
 * two Documents, both real, per-resource ACL protected via `AccessService`:
 *   - `todo-<listId>-meta`: `{id, title, ownerPub, members: [{actorPub,
 *     role, addedAt}], createdAt}` - OWNER-ONLY writer.
 *   - `todo-<listId>-items`: `{items: [{id, parentId, title, content,
 *     attachment, done, assigneePub, dueDate, createdAt, createdBy,
 *     updatedAt}]}` - writers = owner + every current `editor`, grown/
 *     shrunk as roles change (`syncItemsAcl()`). `parentId` (nullable) is
 *     the whole of this version's subtask support - a task pointing at
 *     another task's `id` renders indented directly beneath it (one level,
 *     Google-Keep-style); no drag-and-drop reparenting yet, but nothing
 *     about this shape needs to change to add it later.
 * Deleting a list TOMBSTONES the meta document (`qu.put(path, null, ...)`,
 * same convention every entity kind in this codebase uses for "gone" -
 * `QuStore` has no `delete()`), exactly like `apps/calendar`'s own calendars.
 *
 * ASSIGNMENT is deliberately narrow (per this app's own design discussion):
 * a task's `assigneePub` may only be one of the list's CURRENT `members` -
 * never an arbitrary actor - so the assignee picker in the task form is a
 * plain `<select>` over `meta.members` (a small, already-locally-known set),
 * not a second live-autocomplete widget. Assigning notifies the assignee via
 * `services.messages.notify()` into their `invite-<pub>` mailbox, the same
 * mechanism list invites already use - see `notifyAssignment()`.
 *
 * SHARING is further restricted to this identity's own Contacts (never the
 * full Directory) - `renderSharePage()`'s `mountActorPicker()` call sets
 * `loadPool` to `services.contacts.listContacts()` only, and
 * `allowPastedPub: false` (no "paste a raw pub key" escape hatch), unlike
 * Calendar's own directory+contacts+paste picker.
 *
 * NOT in this version (see the plan this was built from): Confluence-style
 * inline macros (`[]`/`//`/`@` typed mid-sentence) - a real checkbox/
 * assignee-select/native date field already covers what a ToDo list needs,
 * without a bespoke text-parsing pipeline. Due date is a plain native
 * `<input type="date">`, no quick-pick trigger yet.
 *
 * ROUTING - `#/todo` (my lists), `#/todo/manage` (rename/share/delete/leave,
 * full-page - mirrors Calendar's own `/manage`), `#/todo/mine` (every task,
 * across every list, currently assigned to me), `#/todo/<listId>` (that
 * list's own tasks - unlike Calendar's merged multi-calendar view, each
 * ToDo list gets its own dedicated page), `#/todo/<listId>/share`,
 * `#/todo/<listId>/new[/<parentTaskId>]`, `#/todo/<listId>/<taskId>`.
 */
import { watch } from '@qu/reactive';
import { paths, THREAD_PRESETS, formatActorLabel, matchesActorQuery } from '@qu/services';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderSubpage, mountAppHeaderAction, renderNavPointsMenu, mountActorPicker, mountContextSwitcher } from '@qu/ui';
import { copyToClipboard } from '@qu/thread-ui';

const SPACE_ID = '63f5cc6f-62f6-4a43-a889-33900138f8b0'; // this app's own manifest.spaceId - see index.js's own copy of this constant

const DICT = {
  en: {
    title: 'ToDo', myTasks: 'Assigned to me', noAssignedTasks: 'Nothing assigned to you right now.',
    newListPlaceholder: 'New list name…', create: 'Create', noLists: 'No lists yet — create one below, or wait for an invite.',
    untitled: 'Untitled list', sharedBadge: 'Shared', manageLists: 'Manage lists',
    newList: 'New list', newActions: 'Create new…', listsMenu: 'Lists',
    copyLink: 'Copy link', linkCopied: 'Link copied',
    share: 'Share', delete: 'Delete', leave: 'Leave',
    deleteListConfirm: 'Delete "{title}"? This removes it for everyone and cannot be undone.',
    leaveConfirm: 'Leave "{title}"? You will lose access unless invited again, and the owner will be notified.',
    newTask: 'New task', noTasks: 'No tasks yet.',
    listLabel: 'List', sharedListOption: '{title} (shared by {owner})',
    taskTitle: 'Title', taskContent: 'Notes (optional)', dueDate: 'Due date (optional)',
    attachment: 'Attachment (optional)', attachRemove: 'Remove',
    assignee: 'Assignee', unassigned: 'Unassigned', youSuffix: '{name} (you)',
    save: 'Save', cancel: 'Cancel',
    newSubtask: 'New subtask of "{title}"', editTask: 'Edit task', addSubtask: '+ Add subtask',
    subtasks: 'Subtasks', deleteTaskConfirm: 'Delete "{title}"? This cannot be undone.',
    taskNotFound: 'This task no longer exists.', taskNoAccess: 'You don’t have access to this task.',
    invalidLink: 'This list link is invalid, or the list isn’t reachable right now.',
    noAccessTitle: 'No access', noAccessBody: 'You don’t have access to "{title}" — ask the owner to invite you.',
    shareTitle: 'Share "{title}"', renameLabel: 'Name', people: 'People',
    invite: 'Invite', invitePlaceholder: 'Search your contacts…', noMatches: 'No matching contacts.',
    role_owner: 'Owner', role_editor: 'Editor', role_viewer: 'Viewer',
    remove: 'Remove', inviteFailed: 'Could not invite {name}: {message}',
    unknownPerson: '~{pub}…',
  },
  de: {
    title: 'ToDo', myTasks: 'Mir zugewiesen', noAssignedTasks: 'Dir ist gerade nichts zugewiesen.',
    newListPlaceholder: 'Name der neuen Liste…', create: 'Erstellen', noLists: 'Noch keine Listen — unten eine anlegen oder auf eine Einladung warten.',
    untitled: 'Unbenannte Liste', sharedBadge: 'Geteilt', manageLists: 'Listen verwalten',
    newList: 'Neue Liste', newActions: 'Neu erstellen…', listsMenu: 'Listen',
    copyLink: 'Link kopieren', linkCopied: 'Link kopiert',
    share: 'Teilen', delete: 'Löschen', leave: 'Verlassen',
    deleteListConfirm: '"{title}" löschen? Dies entfernt sie für alle und kann nicht rückgängig gemacht werden.',
    leaveConfirm: '"{title}" verlassen? Du verlierst den Zugriff, bis du erneut eingeladen wirst, der Eigentümer wird benachrichtigt.',
    newTask: 'Neue Aufgabe', noTasks: 'Noch keine Aufgaben.',
    listLabel: 'Liste', sharedListOption: '{title} (geteilt von {owner})',
    taskTitle: 'Titel', taskContent: 'Notiz (optional)', dueDate: 'Fälligkeitsdatum (optional)',
    attachment: 'Anhang (optional)', attachRemove: 'Entfernen',
    assignee: 'Bearbeiter', unassigned: 'Nicht zugewiesen', youSuffix: '{name} (du)',
    save: 'Speichern', cancel: 'Abbrechen',
    newSubtask: 'Neue Unteraufgabe von „{title}“', editTask: 'Aufgabe bearbeiten', addSubtask: '+ Unteraufgabe hinzufügen',
    subtasks: 'Unteraufgaben', deleteTaskConfirm: '"{title}" löschen? Dies kann nicht rückgängig gemacht werden.',
    taskNotFound: 'Diese Aufgabe existiert nicht mehr.', taskNoAccess: 'Du hast keinen Zugriff auf diese Aufgabe.',
    invalidLink: 'Dieser Listenlink ist ungültig oder die Liste ist gerade nicht erreichbar.',
    noAccessTitle: 'Kein Zugriff', noAccessBody: 'Du hast keinen Zugriff auf „{title}“ — bitte den Eigentümer um eine Einladung.',
    shareTitle: '„{title}“ teilen', renameLabel: 'Name', people: 'Personen',
    invite: 'Einladen', invitePlaceholder: 'Kontakte durchsuchen…', noMatches: 'Keine passenden Kontakte.',
    role_owner: 'Eigentümer', role_editor: 'Bearbeiter', role_viewer: 'Betrachter',
    remove: 'Entfernen', inviteFailed: '{name} konnte nicht eingeladen werden: {message}',
    unknownPerson: '~{pub}…',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-todo-style';
const STYLE = `
  .qu-todo-page { max-width: 34rem; padding-bottom: 3rem; }
  .qu-todo-mine-link { display: inline-block; margin-bottom: 0.8rem; }
  .qu-todo-empty { opacity: 0.7; }
  .qu-todo-lists { list-style: none; margin: 0 0 1rem; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-todo-lists li { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-todo-row-title { flex: 1; text-decoration: none; color: inherit; }
  .qu-todo-badge { font-size: 0.75em; opacity: 0.65; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; padding: 0.1rem 0.55rem; }
  .qu-todo-new { display: flex; gap: 0.5rem; }
  .qu-todo-new input { flex: 1; padding: 0.55rem; font: inherit; border-radius: var(--qu-radius-sm, 0.3rem); border: 1px solid var(--qu-color-border, #8884); box-sizing: border-box; }
  .qu-todo-new button { padding: 0.55rem 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: none; background: var(--qu-color-accent, #5b5bd6); color: #fff; cursor: pointer; font: inherit; }
  .qu-todo-manage-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-todo-manage-row > span { flex: 1; }
  .qu-todo-manage-row button, .qu-todo-manage-row a { padding: 0.35rem 0.7rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: none; cursor: pointer; font: inherit; text-decoration: none; color: inherit; }
  .qu-todo-list-actions { display: flex; gap: 0.6rem; margin-bottom: 0.8rem; }
  .qu-todo-list-actions a { padding: 0.4rem 0.8rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); text-decoration: none; color: inherit; }
  .qu-todo-tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-todo-task-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-todo-task-indent { margin-left: 1.8rem; opacity: 0.92; }
  .qu-todo-task-title { flex: 1; text-decoration: none; color: inherit; }
  .qu-todo-task-done { text-decoration: line-through; opacity: 0.6; }
  .qu-todo-task-assignee, .qu-todo-task-due { font-size: 0.8em; opacity: 0.7; white-space: nowrap; }
  .qu-todo-task-list-link { font-size: 0.8em; opacity: 0.7; white-space: nowrap; border: 1px solid var(--qu-color-border, #8884); border-radius: 999px; padding: 0.1rem 0.55rem; text-decoration: none; color: inherit; }
  .qu-todo-task-list-link:hover { opacity: 1; background: var(--qu-color-border, #8884); }
  .qu-todo-copy-link { background: none; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.4rem 0.8rem; cursor: pointer; font: inherit; color: inherit; }
  .qu-todo-form { display: flex; flex-direction: column; gap: 0.7rem; margin-bottom: 1rem; }
  .qu-todo-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9em; }
  .qu-todo-form input, .qu-todo-form select, .qu-todo-form textarea { padding: 0.55rem; font: inherit; font-size: 1rem; box-sizing: border-box; border-radius: var(--qu-radius-sm, 0.3rem); border: 1px solid var(--qu-color-border, #8884); }
  .qu-todo-form-actions { display: flex; gap: 0.5rem; }
  .qu-todo-form-actions button { padding: 0.55rem 1rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: none; cursor: pointer; font: inherit; }
  .qu-todo-form-actions button[type="submit"] { border: none; background: var(--qu-color-accent, #5b5bd6); color: #fff; }
  .qu-todo-attach { display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-todo-attach-preview { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9em; }
  .qu-todo-danger { color: var(--qu-color-danger, #c00); border-color: var(--qu-color-danger, #c00); }
  .qu-todo-detail-content { white-space: pre-wrap; margin: 0.4rem 0 1rem; }
  .qu-todo-member-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-todo-member-row:last-child { border-bottom: none; }
  .qu-todo-member-row > span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-todo-status { font-size: 0.85em; opacity: 0.75; min-height: 1.2em; }
  .qu-todo-noaccess { max-width: 28rem; }
`;

function metaResourceId(listId) { return `todo-${listId}-meta`; }
function itemsResourceId(listId) { return `todo-${listId}-items`; }
function activityThreadId(listId) { return `activity-${listId}`; }
function listHash(listId) { return `#/todo/${listId}`; }
function shareHash(listId) { return `#/todo/${listId}/share`; }
function newTaskHash(listId, parentId) { return parentId ? `#/todo/${listId}/new/${parentId}` : `#/todo/${listId}/new`; }
function taskHash(listId, taskId) { return `#/todo/${listId}/${taskId}`; }
const mineHash = '#/todo/mine';
/** Resolved against the full current URL (not just origin), same reasoning apps/forum's/apps/chat's own absoluteMessagePermalink() give - survives being pasted elsewhere or subpath deployments. */
function absoluteHash(hash) { return new URL(hash, window.location.href).href; }

function shortPerson(actorPub, profile) {
  return formatActorLabel(actorPub, profile) || t('unknownPerson', { pub: actorPub.slice(0, 10) });
}
function toDateInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fromDateInputValue(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
function formatDueDate(ms) {
  return new Date(ms).toLocaleDateString();
}

/** A small "🔗 Copy link" button - same copyToClipboard()+absolute-URL pattern apps/forum's/apps/chat's own permalink "Copy link" menu item use, for a list/mine page's own direct/shareable link. */
function copyLinkButton(hash) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qu-todo-copy-link';
  const defaultLabel = `🔗 ${t('copyLink')}`;
  btn.textContent = defaultLabel;
  btn.addEventListener('click', async () => {
    await copyToClipboard(absoluteHash(hash));
    btn.textContent = `✓ ${t('linkCopied')}`;
    setTimeout(() => { btn.textContent = defaultLabel; }, 1500);
  });
  return btn;
}

// ===========================================================================
// Header nav points - "New list"/"New task" (see docs/app-navigation-standard.md
// Rule 2). Always 2 items while ToDo is active - unlike Forum's "New topic"
// (only meaningful once a channel is open), BOTH of ToDo's own actions are
// always reachable, so this is a real, always-present dropdown (the "▾"
// caret + menuLabel tooltip renderNavPointsMenu() already draws once there
// are 2+ items - see that file's own doc comment) rather than a bare "+"
// that only sometimes turns into a menu. List creation moving here (out of
// the old inline "+ New list" form at the bottom of #/todo/#/todo/manage -
// see renderNewListPage() below) is the direct fix for that anti-pattern,
// same move Forum already made for "+ New channel".
// ===========================================================================
export function renderHeaderNavPoints(container, { getContext, onContextChange, services, qu }) {
  mountAppHeaderAction(container, {
    appId: 'todo', getContext, onContextChange,
    render: (wrap) => {
      let stopped = false;
      // "New task" starts pointing at the list picker (#/todo) - unlike
      // Calendar's "+ New event" (which needs an editable CALENDAR to exist
      // first), a user with no editable list yet can still use this to reach
      // the page where they create one - then upgrades in place to the
      // resolved list's own new-task route once/if an editable list is found.
      let newTaskHref = '#/todo';
      function update() {
        if (stopped) return;
        wrap.textContent = '';
        renderNavPointsMenu(wrap, {
          items: [
            { label: t('newList'), href: '#/todo/new' },
            { label: t('newTask'), href: newTaskHref },
          ],
          menuLabel: t('newActions'),
        });
      }
      update();

      (async () => {
        const myPub = await services.actors.whoAmI();
        const mine = await services.sharing.listMine('todo', 'list');
        for (const l of mine) {
          if (stopped) return;
          const quBit = await qu.get(paths.documentPath(SPACE_ID, metaResourceId(l.id)));
          const role = quBit?.val?.members?.find((m) => m.actorPub === myPub)?.role;
          if (role === 'owner' || role === 'editor') {
            newTaskHref = newTaskHash(l.id, null);
            update();
            return;
          }
        }
      })();
      return () => { stopped = true; };
    },
  });
}

// ===========================================================================
// mount()
// ===========================================================================
export function mount(container, { qu, services, segments, subscribe, syncFetch }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  container.assetService = services.assets; // ancestor for every <qu-asset-upload>/<qu-asset> below - see @qu/ui's asset-components.js
  let stopped = false;
  let unwatches = [];
  let pickerCleanups = [];
  let myActorPub = null;
  let pendingInvitesChecked = false; // discoverPendingInvites() - runs once per mount, mirrors apps/calendar's own guard

  const seg1 = segments[1] ?? null; // listId | 'mine' | 'manage' | 'new' | null
  const sub = segments[2] ?? null; // null | 'share' | 'new' | <taskId>
  const extra = segments[3] ?? null; // 'new'-only: an optional parent task id (subtask creation)

  (async () => {
    myActorPub = await services.actors.whoAmI();
    if (stopped) return;
    if (seg1 === 'manage') { await renderManagePage(); return; }
    if (seg1 === 'mine') { await renderMyTasksPage(); return; }
    // 'new' (a fixed literal - crypto.randomUUID() never produces it, same
    // reasoning apps/geochase's own 'all'-sentinel comment gives) is the
    // dedicated "create a list" page (see renderHeaderNavPoints()'s own doc
    // comment), never a listId.
    if (seg1 === 'new') { await renderNewListPage(); return; }
    if (!seg1) { await renderMain(); return; }
    if (!sub) { await renderListPage(seg1); return; }
    if (sub === 'share') { await renderSharePage(seg1); return; }
    if (sub === 'new') { await renderNewTaskForm(seg1, extra || null); return; }
    await renderTaskDetail(seg1, sub);
  })();

  function clearWatches() {
    for (const u of unwatches) u();
    unwatches = [];
    for (const cleanup of pickerCleanups) cleanup();
    pickerCleanups = [];
  }

  async function fetchDoc(docId, fallback) {
    const path = paths.documentPath(SPACE_ID, docId);
    let quBit = await qu.get(path);
    if (!quBit?.val) {
      if (syncFetch) { try { await syncFetch(path); } catch { /* unreachable, or genuinely absent */ } }
      quBit = await qu.get(path);
    }
    return quBit?.val ?? fallback;
  }
  const fetchMeta = (id) => fetchDoc(metaResourceId(id), null);
  const fetchItems = (id) => fetchDoc(itemsResourceId(id), { items: [] });

  // Role/membership/invite mechanics below are thin forwards onto
  // `services.sharing` (`SharingService`) - the generic version of what
  // used to be apps/calendar's own private logic, now shared by both apps.
  function roleOf(meta, actorPub) { return services.sharing.roleOf(meta, actorPub); }
  function canEdit(role) { return services.sharing.canEdit(role); }
  function canManage(role) { return services.sharing.canManage(role); }
  async function listMine() { return services.sharing.listMine('todo', 'list'); }
  async function starIfMember(id, meta) { return services.sharing.starIfMember('todo', 'list', id, meta); }
  async function discoverPendingInvites() {
    await services.sharing.discoverPendingInvites(SPACE_ID, {
      flagType: 'todo', entityKind: 'list', resourceKey: 'listId', fetchMeta,
    });
  }

  // ---------------------------------------------------------------------
  // Main view - #/todo
  // ---------------------------------------------------------------------
  async function loadListInfos(onChange) {
    subscribe?.(paths.spacePath(SPACE_ID));
    if (!pendingInvitesChecked) {
      pendingInvitesChecked = true;
      await discoverPendingInvites();
      if (stopped) return null;
    }
    const mine = await listMine();
    if (stopped) return null;

    clearWatches();
    const infos = [];
    for (const l of mine) {
      unwatches.push(watch(qu, paths.documentPath(SPACE_ID, metaResourceId(l.id)), () => onChange(), { initial: false, syncFetch }));
      const meta = await fetchMeta(l.id);
      infos.push({ id: l.id, meta: meta ?? { title: t('untitled'), members: [], ownerPub: null }, role: roleOf(meta, myActorPub) });
    }
    if (stopped) return null;
    return infos;
  }

  /**
   * The Lists <-> "Mir zugewiesen" switcher's own sidebar items - "Mir
   * zugewiesen" first, then every list this identity is a member of. Used
   * by both renderListPage() and renderMyTasksPage() (see their own
   * mountContextSwitcher() calls) so a mobile user viewing one list, or
   * their assigned-to-me aggregate, has a direct way to jump to another one
   * - the same "esoTalk-style persistent switcher" idiom apps/forum's own
   * channel sidebar and apps/calendar's own calendars sidebar already use
   * (see docs/app-navigation-standard.md Rule 3). Deliberately a plain,
   * unwatched read (unlike loadListInfos() above) - it must NOT call
   * clearWatches() itself, which would wipe out whichever page-specific
   * watch(es) the caller already pushed for ITS OWN list/task data.
   */
  async function fetchSwitcherItems() {
    const mine = await listMine();
    const items = [{ id: 'mine', label: t('myTasks'), href: mineHash }];
    for (const l of mine) {
      const meta = await fetchMeta(l.id);
      if (!meta) continue;
      items.push({
        id: l.id,
        label: meta.title || t('untitled'),
        href: listHash(l.id),
        badge: roleOf(meta, myActorPub) !== 'owner' ? t('sharedBadge') : undefined,
      });
    }
    return items;
  }

  /**
   * The "create a list" form itself - shared by the dedicated `#/todo/new`
   * page below (reachable from the shell header's App Navigation Points
   * Slot - see renderHeaderNavPoints()'s own doc comment, the SAME "Rule 2"
   * move apps/forum/client.js's own "+ New channel" already made) AND the
   * inline copy still sitting at the bottom of `#/todo`/`#/todo/manage` -
   * list creation was deliberately made reachable from BOTH places rather
   * than moved wholesale, unlike Forum's channel creation, since a list
   * (unlike a channel) is something users create far more casually/often
   * while already looking at their list picker.
   * @param {(listId: string) => Promise<void>} onCreated
   */
  function newListForm(onCreated) {
    const form = document.createElement('form');
    form.className = 'qu-todo-new';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('newListPlaceholder');
    input.required = true;
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = t('create');
    form.append(input, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      btn.disabled = true;
      try {
        const listId = await createList(title);
        await onCreated(listId);
      } finally {
        btn.disabled = false;
      }
    });
    return form;
  }

  // ---------------------------------------------------------------------
  // New list - #/todo/new - the dedicated-page half of newListForm() above.
  // ---------------------------------------------------------------------
  async function renderNewListPage() {
    if (stopped) return;
    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';
        const h1 = document.createElement('h1');
        h1.textContent = t('newList');
        page.appendChild(h1);
        page.appendChild(newListForm(async (listId) => { window.location.hash = listHash(listId); }));
        content.appendChild(page);
      },
    });
  }

  async function renderMain() {
    if (stopped) return;
    const infos = await loadListInfos(renderMain);
    if (!infos) return;
    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';
        const h1 = document.createElement('h1');
        h1.textContent = t('title');
        page.appendChild(h1);

        const mineLink = document.createElement('a');
        mineLink.className = 'qu-todo-mine-link';
        mineLink.href = '#/todo/mine';
        mineLink.textContent = t('myTasks');
        page.appendChild(mineLink);

        if (infos.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'qu-todo-empty';
          empty.textContent = t('noLists');
          page.appendChild(empty);
        } else {
          const ul = document.createElement('ul');
          ul.className = 'qu-todo-lists';
          for (const info of infos) {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = listHash(info.id);
            a.className = 'qu-todo-row-title';
            a.textContent = info.meta.title || t('untitled');
            li.appendChild(a);
            if (info.role && info.role !== 'owner') {
              const badge = document.createElement('span');
              badge.className = 'qu-todo-badge';
              badge.textContent = t('sharedBadge');
              li.appendChild(badge);
            }
            ul.appendChild(li);
          }
          page.appendChild(ul);
        }

        page.appendChild(newListForm(async () => { await renderMain(); }));
        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // Manage page - #/todo/manage
  // ---------------------------------------------------------------------
  async function renderManagePage() {
    if (stopped) return;
    const infos = await loadListInfos(renderManagePage);
    if (!infos) return;
    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';
        const h1 = document.createElement('h1');
        h1.textContent = t('manageLists');
        page.appendChild(h1);

        if (infos.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'qu-todo-empty';
          empty.textContent = t('noLists');
          page.appendChild(empty);
        }
        for (const info of infos) {
          const row = document.createElement('div');
          row.className = 'qu-todo-manage-row';
          const name = document.createElement('span');
          name.textContent = info.meta.title || t('untitled');
          row.appendChild(name);
          if (canManage(info.role)) {
            const shareLink = document.createElement('a');
            shareLink.href = shareHash(info.id);
            shareLink.textContent = t('share');
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'qu-todo-danger';
            deleteBtn.textContent = t('delete');
            deleteBtn.addEventListener('click', async () => {
              if (!window.confirm(t('deleteListConfirm', { title: info.meta.title || t('untitled') }))) return;
              await deleteList(info.id);
              await renderManagePage();
            });
            row.append(shareLink, deleteBtn);
          } else if (info.role) {
            const leaveBtn = document.createElement('button');
            leaveBtn.type = 'button';
            leaveBtn.textContent = t('leave');
            leaveBtn.addEventListener('click', async () => {
              if (!window.confirm(t('leaveConfirm', { title: info.meta.title || t('untitled') }))) return;
              await services.sharing.unstar('todo', 'list', info.id);
              await notifyActivity(info.id, 'left');
              await renderManagePage();
            });
            row.appendChild(leaveBtn);
          }
          page.appendChild(row);
        }
        page.appendChild(newListForm(async () => { await renderManagePage(); }));
        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // My Tasks aggregate - #/todo/mine
  // ---------------------------------------------------------------------
  async function renderMyTasksPage() {
    if (stopped) return;
    clearWatches();
    subscribe?.(paths.spacePath(SPACE_ID));
    const mine = await listMine();
    if (stopped) return;

    const assigned = [];
    for (const l of mine) {
      // Live - a task assigned/unassigned/completed/renamed elsewhere (this
      // identity's own change from the list page itself, or a co-editor's)
      // updates this aggregate without a manual reload, same as every other
      // watched view in this file.
      unwatches.push(watch(qu, paths.documentPath(SPACE_ID, itemsResourceId(l.id)), () => renderMyTasksPage(), { initial: false, syncFetch }));
      const meta = await fetchMeta(l.id);
      const doc = await fetchItems(l.id);
      const editable = canEdit(roleOf(meta, myActorPub));
      for (const task of doc.items ?? []) {
        if (task.assigneePub === myActorPub && !task.done) {
          assigned.push({ ...task, listId: l.id, listTitle: meta?.title || t('untitled'), editable });
        }
      }
    }
    assigned.sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));
    if (stopped) return;
    const switcherItems = await fetchSwitcherItems();
    if (stopped) return;

    mountContextSwitcher(container, {
      items: switcherItems,
      activeId: 'mine',
      heading: t('listsMenu'),
      variant: 'page',
      switchHref: '#/todo',
      activeLabel: t('myTasks'),
      newItem: { label: `+ ${t('newList')}`, href: '#/todo/new' },
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';
        const h1 = document.createElement('h1');
        h1.textContent = t('myTasks');
        page.appendChild(h1);
        page.appendChild(copyLinkButton(mineHash));

        if (assigned.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'qu-todo-empty';
          empty.textContent = t('noAssignedTasks');
          page.appendChild(empty);
          content.appendChild(page);
          return;
        }
        const ul = document.createElement('ul');
        ul.className = 'qu-todo-tasks';
        for (const task of assigned) {
          ul.appendChild(renderTaskRow(task.listId, task, task.editable, {
            listLabel: task.listTitle,
            onToggled: renderMyTasksPage, // a just-completed task must drop out of THIS (not-done-only) aggregate immediately
          }));
        }
        page.appendChild(ul);
        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // List page - #/todo/<listId>
  // ---------------------------------------------------------------------
  /**
   * @param {string} listId @param {object} item @param {boolean} editable
   * @param {{listLabel?: string, onToggled?: () => Promise<void>}} [options]
   *   `listLabel` - shown as a small "jump to this list" link when set (the
   *   "Mir zugewiesen" aggregate spans multiple lists, so each row needs to
   *   say/link WHICH one - see renderMyTasksPage()'s own call site; the
   *   single-list page never passes it, since that context is already the
   *   page's own <h1>). `onToggled` - called after a checkbox toggle lands;
   *   renderMyTasksPage() uses this to re-run itself, since that aggregate
   *   only ever shows NOT-done tasks, so a just-completed one must drop out
   *   of the list immediately, not just gain a strikethrough in place (what
   *   the plain list page's own checkbox already does with no callback).
   */
  function renderTaskRow(listId, item, editable, { listLabel, onToggled } = {}) {
    const li = document.createElement('li');
    li.className = item.parentId ? 'qu-todo-task-row qu-todo-task-indent' : 'qu-todo-task-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!item.done;
    checkbox.disabled = !editable;
    checkbox.addEventListener('change', async () => {
      await toggleDone(listId, item.id, checkbox.checked);
      await onToggled?.();
    });
    li.appendChild(checkbox);

    const a = document.createElement('a');
    a.href = taskHash(listId, item.id);
    a.className = item.done ? 'qu-todo-task-title qu-todo-task-done' : 'qu-todo-task-title';
    a.textContent = item.title;
    li.appendChild(a);

    if (listLabel) {
      const listLink = document.createElement('a');
      listLink.className = 'qu-todo-task-list-link';
      listLink.href = listHash(listId);
      listLink.textContent = listLabel;
      li.appendChild(listLink);
    }

    if (item.assigneePub) {
      const assignee = document.createElement('span');
      assignee.className = 'qu-todo-task-assignee';
      assignee.textContent = shortPerson(item.assigneePub, null);
      services.profile.getPublicProfile(item.assigneePub).then((profile) => {
        if (profile?.alias) assignee.textContent = profile.alias;
      });
      li.appendChild(assignee);
    }
    if (item.dueDate) {
      const due = document.createElement('span');
      due.className = 'qu-todo-task-due';
      due.textContent = formatDueDate(item.dueDate);
      li.appendChild(due);
    }
    return li;
  }

  /** Top-level tasks first, each followed immediately by its own direct children indented beneath it - one level, see this file's own top doc comment. */
  function renderTaskTree(listId, items, editable) {
    const ul = document.createElement('ul');
    ul.className = 'qu-todo-tasks';
    const byParent = new Map();
    for (const item of items) {
      const key = item.parentId ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(item);
    }
    const byCreated = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0);
    for (const item of (byParent.get(null) ?? []).sort(byCreated)) {
      ul.appendChild(renderTaskRow(listId, item, editable));
      for (const child of (byParent.get(item.id) ?? []).sort(byCreated)) {
        ul.appendChild(renderTaskRow(listId, child, editable));
      }
    }
    return ul;
  }

  function renderNoAccess(meta) {
    container.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'qu-todo-noaccess';
    const h = document.createElement('h1');
    h.textContent = t('noAccessTitle');
    const p = document.createElement('p');
    p.textContent = t('noAccessBody', { title: meta?.title || t('untitled') });
    wrap.append(h, p);
    container.appendChild(wrap);
  }

  async function renderListPage(id) {
    if (stopped) return;
    clearWatches();
    subscribe?.(paths.spacePath(SPACE_ID));
    unwatches.push(watch(qu, paths.documentPath(SPACE_ID, metaResourceId(id)), () => renderListPage(id), { initial: false, syncFetch }));
    unwatches.push(watch(qu, paths.documentPath(SPACE_ID, itemsResourceId(id)), () => renderListPage(id), { initial: false, syncFetch }));

    const meta = await fetchMeta(id);
    if (stopped) return;
    if (!meta) {
      container.textContent = '';
      const p = document.createElement('p');
      p.textContent = t('invalidLink');
      container.appendChild(p);
      return;
    }
    const role = roleOf(meta, myActorPub);
    if (!role) { renderNoAccess(meta); return; }
    await starIfMember(id, meta); // no-op once already starred - handles a fresh invite click-through

    const doc = await fetchItems(id);
    const items = doc.items ?? [];
    const editable = canEdit(role);
    const switcherItems = await fetchSwitcherItems();
    if (stopped) return;

    mountContextSwitcher(container, {
      items: switcherItems,
      activeId: id,
      heading: t('listsMenu'),
      variant: 'page',
      switchHref: '#/todo',
      activeLabel: meta.title || t('untitled'),
      newItem: { label: `+ ${t('newList')}`, href: '#/todo/new' },
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';
        const h1 = document.createElement('h1');
        h1.textContent = meta.title || t('untitled');
        page.appendChild(h1);

        const actions = document.createElement('div');
        actions.className = 'qu-todo-list-actions';
        if (editable) {
          const newTaskLink = document.createElement('a');
          newTaskLink.href = newTaskHash(id, null);
          newTaskLink.textContent = t('newTask');
          actions.appendChild(newTaskLink);
        }
        if (canManage(role)) {
          const shareLink = document.createElement('a');
          shareLink.href = shareHash(id);
          shareLink.textContent = t('share');
          actions.appendChild(shareLink);
        }
        actions.appendChild(copyLinkButton(listHash(id)));
        page.appendChild(actions);

        if (items.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'qu-todo-empty';
          empty.textContent = t('noTasks');
          page.appendChild(empty);
        } else {
          page.appendChild(renderTaskTree(id, items, editable));
        }
        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // Task form - shared by New Task and Edit Task
  // ---------------------------------------------------------------------
  /**
   * @param {{existing: object|null, meta: object, myEditableLists?: Array<{id: string, title: string, role: string, ownerPub: string}>,
   *   selectedListId?: string, lockList?: boolean, onSubmit: Function, onCancel: Function}} opts
   *   `myEditableLists` is only ever passed for the NEW-task flow (never
   *   when editing - a task never moves between lists after creation, see
   *   this file's own top doc comment) - its presence is what turns on the
   *   "which list" picker at all. `lockList` disables it (still shown, for
   *   context) when creating a SUBTASK, which must stay in its parent's list.
   */
  function buildTaskForm({ existing, meta, myEditableLists, selectedListId, lockList, onSubmit, onCancel }) {
    const form = document.createElement('form');
    form.className = 'qu-todo-form';
    let currentMeta = meta; // swapped out on listSelect's own 'change' - see below

    let listSelect = null;
    if (myEditableLists) {
      listSelect = document.createElement('select');
      listSelect.className = 'qu-todo-list-select';
      listSelect.disabled = !!lockList;
      for (const l of myEditableLists) {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.role === 'owner' ? l.title : t('sharedListOption', { title: l.title, owner: shortPerson(l.ownerPub, null) });
        if (l.role !== 'owner') {
          services.profile.getPublicProfile(l.ownerPub).then((profile) => {
            if (profile?.alias) opt.textContent = t('sharedListOption', { title: l.title, owner: profile.alias });
          });
        }
        listSelect.appendChild(opt);
      }
      listSelect.value = selectedListId;
      const listLabel = document.createElement('label');
      listLabel.append(t('listLabel'), listSelect);
      form.appendChild(listLabel);
    }

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.required = true;
    titleInput.value = existing?.title ?? '';
    const titleLabel = document.createElement('label');
    titleLabel.append(t('taskTitle'), titleInput);

    const contentInput = document.createElement('textarea');
    contentInput.rows = 4;
    contentInput.value = existing?.content ?? '';
    const contentLabel = document.createElement('label');
    contentLabel.append(t('taskContent'), contentInput);

    const dueInput = document.createElement('input');
    dueInput.type = 'date';
    if (existing?.dueDate) dueInput.value = toDateInputValue(existing.dueDate);
    const dueLabel = document.createElement('label');
    dueLabel.append(t('dueDate'), dueInput);

    // Default assignee is always ME - assigning it to someone else is an
    // active choice, not the starting state (per this app's own design
    // discussion). Only applies to a NEW task; editing an existing one keeps
    // showing whatever is already stored, including an explicit "Unassigned".
    const assigneeSelect = document.createElement('select');
    assigneeSelect.className = 'qu-todo-assignee-select';
    function renderAssigneeOptions(forMeta) {
      assigneeSelect.textContent = '';
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = t('unassigned');
      assigneeSelect.appendChild(noneOpt);
      for (const member of forMeta.members) {
        const opt = document.createElement('option');
        opt.value = member.actorPub;
        opt.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: shortPerson(member.actorPub, null) }) : shortPerson(member.actorPub, null);
        services.profile.getPublicProfile(member.actorPub).then((profile) => {
          if (!profile?.alias) return;
          opt.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: profile.alias }) : profile.alias;
        });
        assigneeSelect.appendChild(opt);
      }
      assigneeSelect.value = existing ? (existing.assigneePub ?? '') : myActorPub;
    }
    renderAssigneeOptions(currentMeta);
    const assigneeLabel = document.createElement('label');
    assigneeLabel.append(t('assignee'), assigneeSelect);

    if (listSelect) {
      // Switching lists changes who's even assignable - re-fetch that
      // list's own members instead of leaving stale options from the
      // PREVIOUS list's meta showing.
      listSelect.addEventListener('change', async () => {
        const newMeta = await fetchMeta(listSelect.value);
        if (!newMeta) return;
        currentMeta = newMeta;
        renderAssigneeOptions(currentMeta);
      });
    }

    let pendingAttachment = existing?.attachment ?? null;
    const attachWrap = document.createElement('div');
    attachWrap.className = 'qu-todo-attach';
    const attachPreview = document.createElement('div');
    attachPreview.className = 'qu-todo-attach-preview';
    function renderAttachPreview() {
      attachPreview.textContent = '';
      if (!pendingAttachment) return;
      const viewer = document.createElement('qu-asset');
      viewer.setAttribute('space-id', SPACE_ID);
      viewer.setAttribute('asset-id', pendingAttachment.assetId);
      const label = document.createElement('span');
      label.textContent = `📎 ${pendingAttachment.name ?? ''}`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = t('attachRemove');
      removeBtn.addEventListener('click', () => { pendingAttachment = null; renderAttachPreview(); });
      attachPreview.append(viewer, label, removeBtn);
    }
    renderAttachPreview();
    const attachUpload = document.createElement('qu-asset-upload');
    attachUpload.setAttribute('space-id', SPACE_ID);
    attachUpload.addEventListener('qu-asset-uploaded', (e) => {
      pendingAttachment = { assetId: e.detail.assetId, ...e.detail.meta };
      renderAttachPreview();
    });
    attachWrap.append(attachPreview, attachUpload);
    const attachLabel = document.createElement('label');
    attachLabel.append(t('attachment'), attachWrap);

    const actions = document.createElement('div');
    actions.className = 'qu-todo-form-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = t('save');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', onCancel);
    actions.append(saveBtn, cancelBtn);

    form.append(titleLabel, contentLabel, dueLabel, assigneeLabel, attachLabel, actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const wasUploadedFresh = pendingAttachment && pendingAttachment.assetId !== existing?.attachment?.assetId;
      const values = {
        title: titleInput.value.trim(),
        content: contentInput.value.trim(),
        dueDate: dueInput.value ? fromDateInputValue(dueInput.value) : null,
        assigneePub: assigneeSelect.value || null,
        attachment: pendingAttachment,
      };
      if (listSelect) values.listId = listSelect.value;
      await onSubmit(values);
      // Only now, once the attachment is genuinely part of a saved task, does
      // the deferred sync-out verification phase start - see
      // <qu-asset-upload>'s own doc comment on confirmSent() for why.
      if (wasUploadedFresh) attachUpload.confirmSent(pendingAttachment.assetId);
    });
    return form;
  }

  async function notifyAssignment(listId, task) {
    try {
      await services.messages.notify(SPACE_ID, task.assigneePub, 'assigned', { listId, taskId: task.id, taskTitle: task.title });
    } catch {
      // The assignee's profile/keys haven't synced yet - the task itself is
      // still saved either way, this notification is best-effort.
    }
  }

  // ---------------------------------------------------------------------
  // New Task - #/todo/<listId>/new[/<parentTaskId>]
  // ---------------------------------------------------------------------
  async function renderNewTaskForm(listId, parentId) {
    if (stopped) return;
    const meta = await fetchMeta(listId);
    if (stopped) return;
    if (!meta || !canEdit(roleOf(meta, myActorPub))) { window.location.hash = listHash(listId); return; }

    let parentTitle = null;
    if (parentId) {
      const doc = await fetchItems(listId);
      parentTitle = (doc.items ?? []).find((it) => it.id === parentId)?.title ?? null;
    }

    // Which list this new task can land in - locked to the current one for
    // a subtask (it must stay in its parent's own list), otherwise every
    // list this identity can currently add tasks to, shared ones clearly
    // marked with their owner's alias/pub.
    let editableLists;
    if (parentId) {
      editableLists = [{ id: listId, title: meta.title || t('untitled'), role: roleOf(meta, myActorPub), ownerPub: meta.ownerPub }];
    } else {
      const mine = await listMine();
      editableLists = [];
      for (const l of mine) {
        const m = await fetchMeta(l.id);
        const role = roleOf(m, myActorPub);
        if (m && canEdit(role)) editableLists.push({ id: l.id, title: m.title || t('untitled'), role, ownerPub: m.ownerPub });
      }
    }
    if (stopped) return;

    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';
        const h1 = document.createElement('h1');
        h1.textContent = parentTitle ? t('newSubtask', { title: parentTitle }) : t('newTask');
        page.appendChild(h1);
        page.appendChild(buildTaskForm({
          existing: null, meta, myEditableLists: editableLists, selectedListId: listId, lockList: !!parentId,
          onSubmit: async ({ listId: targetListId, ...values }) => {
            const finalListId = targetListId || listId;
            const payload = { id: crypto.randomUUID(), parentId: parentId || null, ...values, done: false, createdAt: Date.now(), createdBy: myActorPub, updatedAt: Date.now() };
            await upsertTask(finalListId, payload, { isNew: true });
            if (payload.assigneePub && payload.assigneePub !== myActorPub) await notifyAssignment(finalListId, payload);
            window.location.hash = listHash(finalListId);
          },
          onCancel: () => { window.location.hash = listHash(listId); },
        }));
        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // Task detail / edit - #/todo/<listId>/<taskId>
  // ---------------------------------------------------------------------
  async function renderTaskDetail(listId, taskId) {
    if (stopped) return;
    clearWatches();
    subscribe?.(paths.spacePath(SPACE_ID));
    unwatches.push(watch(qu, paths.documentPath(SPACE_ID, itemsResourceId(listId)), () => renderTaskDetail(listId, taskId), { initial: false, syncFetch }));

    const meta = await fetchMeta(listId);
    if (stopped) return;
    const role = roleOf(meta, myActorPub);
    if (!meta || !role) { renderNoAccess(meta); return; }

    const doc = await fetchItems(listId);
    const task = (doc.items ?? []).find((it) => it.id === taskId);
    if (!task) {
      container.textContent = '';
      const p = document.createElement('p');
      p.textContent = t('taskNotFound');
      container.appendChild(p);
      return;
    }
    const editable = canEdit(role);
    const subtasks = (doc.items ?? []).filter((it) => it.parentId === taskId);

    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';

        if (!editable) {
          const h1 = document.createElement('h1');
          h1.textContent = task.title;
          page.appendChild(h1);
          if (task.content) {
            const p = document.createElement('p');
            p.className = 'qu-todo-detail-content';
            p.textContent = task.content;
            page.appendChild(p);
          }
          content.appendChild(page);
          return;
        }

        const h1 = document.createElement('h1');
        h1.textContent = t('editTask');
        page.appendChild(h1);
        page.appendChild(buildTaskForm({
          existing: task, meta,
          onSubmit: async (values) => {
            const prevAssignee = task.assigneePub;
            const payload = { ...task, ...values, updatedAt: Date.now() };
            await upsertTask(listId, payload, { isNew: false });
            if (payload.assigneePub && payload.assigneePub !== prevAssignee && payload.assigneePub !== myActorPub) await notifyAssignment(listId, payload);
            window.location.hash = listHash(listId);
          },
          onCancel: () => { window.location.hash = listHash(listId); },
        }));

        const addSubtaskLink = document.createElement('a');
        addSubtaskLink.href = newTaskHash(listId, taskId);
        addSubtaskLink.textContent = t('addSubtask');
        page.appendChild(addSubtaskLink);

        if (subtasks.length) {
          const h2 = document.createElement('h3');
          h2.textContent = t('subtasks');
          page.appendChild(h2);
          page.appendChild(renderTaskTree(listId, subtasks, editable));
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'qu-todo-danger';
        deleteBtn.textContent = t('delete');
        deleteBtn.addEventListener('click', async () => {
          if (!window.confirm(t('deleteTaskConfirm', { title: task.title }))) return;
          await removeTask(listId, taskId);
          window.location.hash = listHash(listId);
        });
        page.appendChild(deleteBtn);

        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // Share page - #/todo/<listId>/share - owner-only.
  // ---------------------------------------------------------------------
  function renderMembers(listEl, info) {
    listEl.textContent = '';
    for (const member of info.meta.members) {
      const row = document.createElement('div');
      row.className = 'qu-todo-member-row';
      const name = document.createElement('span');
      name.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: shortPerson(member.actorPub, null) }) : shortPerson(member.actorPub, null);
      services.profile.getPublicProfile(member.actorPub).then((profile) => {
        if (!profile?.alias) return;
        name.textContent = member.actorPub === myActorPub ? t('youSuffix', { name: profile.alias }) : profile.alias;
      });
      row.appendChild(name);

      if (member.role === 'owner') {
        const badge = document.createElement('span');
        badge.className = 'qu-todo-badge';
        badge.textContent = t('role_owner');
        row.appendChild(badge);
      } else {
        const roleSelect = document.createElement('select');
        for (const [val, label] of [['editor', t('role_editor')], ['viewer', t('role_viewer')]]) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          if (val === member.role) opt.selected = true;
          roleSelect.appendChild(opt);
        }
        roleSelect.addEventListener('change', async () => {
          await changeMemberRole(info.id, member.actorPub, roleSelect.value);
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = t('remove');
        removeBtn.addEventListener('click', async () => {
          await removeMember(info.id, member.actorPub);
          const refreshedMeta = await fetchMeta(info.id);
          renderMembers(listEl, { ...info, meta: refreshedMeta });
        });
        row.append(roleSelect, removeBtn);
      }
      listEl.appendChild(row);
    }
  }

  async function renderSharePage(id) {
    if (stopped) return;
    clearWatches();
    subscribe?.(paths.spacePath(SPACE_ID));
    unwatches.push(watch(qu, paths.documentPath(SPACE_ID, metaResourceId(id)), () => renderSharePage(id), { initial: false, syncFetch }));

    const meta = await fetchMeta(id);
    if (stopped) return;
    if (!meta || !canManage(roleOf(meta, myActorPub))) { window.location.hash = '#/todo'; return; }

    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const page = document.createElement('div');
        page.className = 'qu-todo-page';
        const h = document.createElement('h1');
        h.textContent = t('shareTitle', { title: meta.title || t('untitled') });
        page.appendChild(h);

        const renameForm = document.createElement('form');
        renameForm.className = 'qu-todo-form';
        const nameInput = document.createElement('input');
        nameInput.value = meta.title || '';
        const nameLabel = document.createElement('label');
        nameLabel.append(t('renameLabel'), nameInput);
        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.textContent = t('save');
        renameForm.append(nameLabel, saveBtn);
        renameForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(id));
          await qu.put(paths.documentPath(SPACE_ID, metaResourceId(id)), { ...meta, title: nameInput.value.trim() || t('untitled') }, writeOptions);
        });
        page.appendChild(renameForm);

        const peopleHeading = document.createElement('h3');
        peopleHeading.textContent = t('people');
        page.appendChild(peopleHeading);

        const memberList = document.createElement('div');
        page.appendChild(memberList);
        const info = { id, meta };
        renderMembers(memberList, info);

        const roleSelect = document.createElement('select');
        for (const [val, label] of [['editor', t('role_editor')], ['viewer', t('role_viewer')]]) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          roleSelect.appendChild(opt);
        }
        const pickerRow = document.createElement('div');
        const roleLabel = document.createElement('label');
        roleLabel.append(t('invite'), roleSelect);
        pickerRow.appendChild(roleLabel);
        page.appendChild(pickerRow);

        const pickerHost = document.createElement('div');
        page.appendChild(pickerHost);
        const status = document.createElement('p');
        status.className = 'qu-todo-status';
        page.appendChild(status);

        // Per this app's own sharing policy (see top doc comment): invite
        // candidates are drawn ONLY from this identity's own Contacts, never
        // the full Directory, and there is no "paste a raw pub key" escape
        // hatch - unlike apps/calendar's own, more permissive picker.
        const cleanup = mountActorPicker(pickerHost, {
          loadPool: () => services.contacts.listContacts(),
          matchesQuery: matchesActorQuery,
          formatLabel: shortPerson,
          excludePubs: new Set(meta.members.map((m) => m.actorPub)),
          allowPastedPub: false,
          labels: { placeholder: t('invitePlaceholder'), noMatches: t('noMatches'), pasteAsIs: () => '' },
          onPick: async (actorPub, label) => {
            status.textContent = '';
            try {
              await inviteMember(id, actorPub, roleSelect.value);
              const refreshedMeta = await fetchMeta(id);
              renderMembers(memberList, { ...info, meta: refreshedMeta });
            } catch (err) {
              status.textContent = t('inviteFailed', { name: label, message: err.message });
            }
          },
        });
        pickerCleanups.push(cleanup);

        content.appendChild(page);
      },
    });
  }

  // ---------------------------------------------------------------------
  // CRUD + sharing primitives
  // ---------------------------------------------------------------------
  async function createList(title) {
    const listId = crypto.randomUUID();
    await services.sharing.createOwned(SPACE_ID, 'docs', metaResourceId(listId), { id: listId, title }, { flagType: 'todo', entityKind: 'list' });

    await services.access.protect(SPACE_ID, 'docs', itemsResourceId(listId), { writers: [myActorPub] });
    const itemsWriteOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', itemsResourceId(listId));
    await qu.put(paths.documentPath(SPACE_ID, itemsResourceId(listId)), { items: [] }, itemsWriteOptions);

    await services.messages.createThread(SPACE_ID, activityThreadId(listId), THREAD_PRESETS.activity([myActorPub]));
    return listId;
  }

  /** Grows/shrinks the `items` document's writer ACL to exactly "owner + every current editor" - called after any membership/role change. */
  async function syncItemsAcl(id, members) {
    await services.sharing.syncWriterAcl(SPACE_ID, 'docs', itemsResourceId(id), members);
  }

  async function ensureListMembership(id, actorPub, role) {
    return services.sharing.ensureMembership(SPACE_ID, 'docs', metaResourceId(id), actorPub, role, {
      onMembersChanged: async (members) => {
        await syncItemsAcl(id, members);
        await services.messages.addReader(SPACE_ID, activityThreadId(id), actorPub);
      },
    });
  }

  async function inviteMember(id, actorPub, role) {
    const meta = await fetchMeta(id);
    await services.sharing.inviteMember(SPACE_ID, 'docs', metaResourceId(id), actorPub, role, {
      notifyBody: 'invited',
      notifyExtra: { listId: id, listTitle: meta?.title ?? t('untitled') },
      onMembersChanged: async (members) => {
        await syncItemsAcl(id, members);
        await services.messages.addReader(SPACE_ID, activityThreadId(id), actorPub);
      },
    });
  }

  async function changeMemberRole(id, actorPub, role) {
    return services.sharing.changeMemberRole(SPACE_ID, 'docs', metaResourceId(id), actorPub, role, {
      onMembersChanged: (members) => syncItemsAcl(id, members),
    });
  }

  async function removeMember(id, actorPub) {
    return services.sharing.removeMember(SPACE_ID, 'docs', metaResourceId(id), actorPub, {
      activityThreadId: activityThreadId(id),
      onMembersChanged: (members) => syncItemsAcl(id, members),
    });
  }

  async function deleteList(id) {
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', metaResourceId(id));
    await qu.put(paths.documentPath(SPACE_ID, metaResourceId(id)), null, writeOptions);
    await services.sharing.unstar('todo', 'list', id);
  }

  /** Posts into the list's `activity-<listId>` Thread purely to give `@qu/relay`'s push-delivery pipeline something to react to - every other current member gets an in-app notice + push. A no-op for a solo (owner-only) list. */
  async function notifyActivity(id, kind) {
    const meta = await fetchMeta(id);
    if (!meta || (meta.members?.length ?? 0) < 2) return;
    try {
      await services.messages.postMessage(SPACE_ID, activityThreadId(id), { body: kind, extra: { listId: id } });
    } catch {
      // activity thread missing (shouldn't happen post-creation) - not worth failing the actual write over
    }
  }

  async function upsertTask(listId, payload, { isNew }) {
    const doc = await fetchItems(listId);
    const items = doc.items ?? [];
    const next = isNew ? [...items, payload] : items.map((it) => (it.id === payload.id ? payload : it));
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', itemsResourceId(listId));
    await qu.put(paths.documentPath(SPACE_ID, itemsResourceId(listId)), { items: next }, writeOptions);
    await notifyActivity(listId, isNew ? 'created' : 'updated');
  }

  /** Deleting a task also deletes its own direct subtasks (one level - see this file's own top doc comment) rather than orphaning them. */
  async function removeTask(listId, taskId) {
    const doc = await fetchItems(listId);
    const remaining = (doc.items ?? []).filter((it) => it.id !== taskId && it.parentId !== taskId);
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', itemsResourceId(listId));
    await qu.put(paths.documentPath(SPACE_ID, itemsResourceId(listId)), { items: remaining }, writeOptions);
    await notifyActivity(listId, 'deleted');
  }

  async function toggleDone(listId, taskId, done) {
    const doc = await fetchItems(listId);
    const items = (doc.items ?? []).map((it) => (it.id === taskId ? { ...it, done, updatedAt: Date.now() } : it));
    const writeOptions = await services.access.writeOptionsFor(SPACE_ID, 'docs', itemsResourceId(listId));
    await qu.put(paths.documentPath(SPACE_ID, itemsResourceId(listId)), { items }, writeOptions);
  }

  return () => {
    stopped = true;
    clearWatches();
  };
}
