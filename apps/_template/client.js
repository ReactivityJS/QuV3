/**
 * TEMPLATE — a minimal, runnable example app demonstrating the QUniverse App
 * Navigation Standard end to end (see `docs/app-navigation-standard.md`).
 * Copy this whole directory to start a new app; then:
 *   1. Rename the directory and `manifest.quapp`'s `name`/`label`/`icon`.
 *   2. Add `"clientMain": "./dist/client.js"` back to `manifest.quapp` (this
 *      template deliberately OMITS it - see that file's own note - so it
 *      never gets bundled/catalog-listed/nav-shown by ITSELF; a real app
 *      copied from it restores the field, per `docs/building-an-app.md` §2's
 *      field table, and everything wires up with no separate registration
 *      step).
 *   3. If your app needs its own storage space, generate and commit a real
 *      `spaceId` (`docs/building-an-app.md` §2.2) - this template has none,
 *      it only demonstrates NAVIGATION, using trivial in-memory data.
 *
 * A tiny "Notes" app: a small, fixed set of Folders (the switchable sibling
 * "places" - Rule 3, here rendered via Rule 5's AppConfig `navigation`) each
 * holding Notes (a list + a detail subpage - Rule 1), with "+ New note" as
 * the app's one create action (Rule 5's `primaryAction`). Data is a
 * closure-scoped in-memory array, reset on every `mount()` - a real app
 * would persist it via `@qu/services` (see `docs/api-reference.md`); that
 * part is deliberately NOT this template's concern.
 *
 * WHAT EACH STANDARD PIECE LOOKS LIKE HERE:
 *   - Rule 1 (global chrome owns Back/Forward): every subpage below
 *     (`renderNoteDetail()`, `renderNewNoteForm()`) goes through
 *     `renderSubpage({ showBackLink: false, ... })` - no bespoke back link
 *     anywhere in this file. Subpages render bare (no App Template chrome) -
 *     `mountAppTemplate()` is only called from `renderFolderView()` below,
 *     same as `mountContextSwitcher()` was before it.
 *   - Rule 5 (App Template / Footer-Sidebar Chrome, see
 *     `docs/app-navigation-standard.md`): `renderFolderView()` below is the
 *     one call to `@qu/ui`'s `mountAppTemplate()` - `navigation` carries the
 *     FOLDERS list (a left sidebar on wide screens, a pill+popup in the
 *     fixed bottom bar on narrow ones), `primaryAction` carries "+ New
 *     note" (a prominent sidebar button / a circular button at the end of
 *     the bar). Both are plain data - this file never builds a footer or a
 *     sidebar itself, the Core does.
 *   - Rule 4 (icon tooltips): every icon-only control `mountAppTemplate()`
 *     builds already sets `title`/`aria-label` itself - nothing to do here.
 *
 * Routes: `#/template` (defaults to the first folder), `#/template/f/<folderId>`
 * (a folder's notes), `#/template/n/<noteId>` (note detail), `#/template/new`
 * (new note form).
 */
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderSubpage, mountAppTemplate } from '@qu/ui';

const FOLDERS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'archive', label: 'Archive' },
];
const DEFAULT_FOLDER_ID = FOLDERS[0].id;

// In-memory only, reset every mount() - see this file's own top doc comment.
let notes = [
  { id: 'welcome', folderId: 'inbox', title: 'Welcome', body: 'This is an example note - edit apps/_template/client.js to build your own app.' },
];

const DICT = {
  en: {
    title: 'Template', folders: 'Folders', newNote: 'New note',
    noteTitle: 'Title', noteBody: 'Body', save: 'Save', cancel: 'Cancel',
    empty: 'No notes in this folder yet.', notFound: 'This note no longer exists.',
    delete: 'Delete',
  },
  de: {
    title: 'Vorlage', folders: 'Ordner', newNote: 'Neue Notiz',
    noteTitle: 'Titel', noteBody: 'Inhalt', save: 'Speichern', cancel: 'Abbrechen',
    empty: 'Noch keine Notizen in diesem Ordner.', notFound: 'Diese Notiz existiert nicht mehr.',
    delete: 'Löschen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-template-style';
const STYLE = `
  .qu-template-notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-template-notes a { display: block; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); text-decoration: none; color: inherit; }
  .qu-template-notes a:hover { background: var(--qu-color-surface, #8882); }
  .qu-template-empty { opacity: 0.7; }
  .qu-template-form { display: flex; flex-direction: column; gap: 0.6rem; max-width: 28rem; }
  .qu-template-form input, .qu-template-form textarea { padding: 0.5rem; font: inherit; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); box-sizing: border-box; }
  .qu-template-form-actions { display: flex; gap: 0.5rem; }
  .qu-template-form-actions button { padding: 0.45rem 0.9rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: none; cursor: pointer; font: inherit; }
  .qu-template-form-actions button[type="submit"] { border: none; background: var(--qu-color-accent, #5b5bd6); color: #fff; }
`;

// ===========================================================================
// mount()
// ===========================================================================
export function mount(container, { services, segments = [] }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  // The one async step every real app in this repo starts with (see
  // `docs/building-an-app.md` §9's own `renderToken` gotcha) - not strictly
  // needed by this template's own trivial, synchronous in-memory data, but
  // kept here as the realistic shape a copier will actually need once this
  // reads real storage via `services`.
  (async () => {
    await services.actors.whoAmI();
    if (stopped) return;
    route();
  })();

  function route() {
    if (stopped) return;
    const [, seg1, seg2] = segments;
    if (seg1 === 'new') return renderNewNoteForm();
    if (seg1 === 'n' && seg2) return renderNoteDetail(seg2);
    if (seg1 === 'f' && seg2) return renderFolderView(seg2);
    return renderFolderView(DEFAULT_FOLDER_ID);
  }

  // ---------------------------------------------------------------------
  // Folder view - #/template or #/template/f/<folderId>
  // ---------------------------------------------------------------------
  function renderFolderView(folderId) {
    const folder = FOLDERS.find((f) => f.id === folderId) ?? FOLDERS[0];

    mountAppTemplate(container, {
      navigation: {
        items: FOLDERS.map((f) => ({ id: f.id, label: f.label, href: `#/template/f/${f.id}` })),
        activeId: folder.id,
        heading: t('folders'),
      },
      primaryAction: { label: t('newNote'), href: '#/template/new', icon: '✏️' },
      render: (content) => {
        const inFolder = notes.filter((n) => n.folderId === folder.id);
        if (inFolder.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'qu-template-empty';
          empty.textContent = t('empty');
          content.appendChild(empty);
          return;
        }
        const ul = document.createElement('ul');
        ul.className = 'qu-template-notes';
        for (const note of inFolder) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = `#/template/n/${note.id}`;
          a.textContent = note.title;
          li.appendChild(a);
          ul.appendChild(li);
        }
        content.appendChild(ul);
      },
    });
  }

  // ---------------------------------------------------------------------
  // Note detail - #/template/n/<noteId>
  // ---------------------------------------------------------------------
  function renderNoteDetail(noteId) {
    const note = notes.find((n) => n.id === noteId);
    renderSubpage(container, {
      // The shell header's own Back/Forward already covers this - see
      // docs/app-navigation-standard.md Rule 1.
      showBackLink: false,
      render: (content) => {
        if (!note) {
          const p = document.createElement('p');
          p.textContent = t('notFound');
          content.appendChild(p);
          return;
        }
        const h1 = document.createElement('h1');
        h1.textContent = note.title;
        const body = document.createElement('p');
        body.textContent = note.body;
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.textContent = t('delete');
        deleteBtn.addEventListener('click', () => {
          notes = notes.filter((n) => n.id !== note.id);
          window.location.hash = `#/template/f/${note.folderId}`;
        });
        content.append(h1, body, deleteBtn);
      },
    });
  }

  // ---------------------------------------------------------------------
  // New note form - #/template/new
  // ---------------------------------------------------------------------
  function renderNewNoteForm() {
    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        const h1 = document.createElement('h1');
        h1.textContent = t('newNote');

        const form = document.createElement('form');
        form.className = 'qu-template-form';
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.placeholder = t('noteTitle');
        titleInput.required = true;
        const bodyInput = document.createElement('textarea');
        bodyInput.placeholder = t('noteBody');
        bodyInput.rows = 4;

        const actions = document.createElement('div');
        actions.className = 'qu-template-form-actions';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.textContent = t('save');
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = t('cancel');
        cancelBtn.addEventListener('click', () => { window.location.hash = '#/template'; });
        actions.append(saveBtn, cancelBtn);

        form.append(titleInput, bodyInput, actions);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const id = crypto.randomUUID();
          notes = [...notes, { id, folderId: DEFAULT_FOLDER_ID, title: titleInput.value.trim() || t('noteTitle'), body: bodyInput.value.trim() }];
          window.location.hash = `#/template/n/${id}`;
        });

        content.append(h1, form);
      },
    });
  }

  return () => { stopped = true; };
}
