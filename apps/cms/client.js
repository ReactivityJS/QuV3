/**
 * CMS — Admin (global) and User (own space) content, with clear navigation
 * across (sub)pages, an owner-chosen Content Editor (constrained by an
 * admin allow-list), templates (standard or self-defined), and per-page
 * local style customization. See docs/v4-concept.md §10.2 for the original
 * roadmap note this app implements (updated here: richtext/WYSIWYG IS built,
 * per an explicit later request - see `@qu/content-ui`'s `richtext-editor.js`).
 *
 * TWO SPACES, same `EntityService`/`'page'` EntityType
 * (`packages/services/src/entity-types.js`) for both:
 *   - "mine" - `paths.cmsUserSpaceId(myPub)` - the signed-in identity's own
 *     space. `#/cms/mine` always means YOUR OWN space, never anyone else's -
 *     there is no route for browsing another identity's space (see this
 *     app's own plan/doc note - a cheap, later addition if ever needed, not
 *     built now). Every page is protected (`AccessService.protect()`) with
 *     `writers:[myPub]` at creation - only its owner can ever write to it.
 *   - "global" - this manifest's own fixed `spaceId` - writable only by this
 *     relay's current `adminPubs` (`/config.json`, the same courtesy-check
 *     pattern `apps/relay-admin/client.js` already uses for its own gate).
 *     Every save re-`protect()`s against the CURRENT admin list, so an
 *     admin-list change self-heals instead of needing a manual resync tool.
 *
 * ROUTES are full, slash-separated paths WITHIN a space's own `'page'`
 * entities (`page.route`) - `''` is that space's own root/home page, e.g.
 * `about-me` a top-level page, `blog/2026-08-28/my-post` a nested one.
 * `buildPageTree()` below derives the whole navigation tree from this one
 * field - there is no separate `parentId`.
 *
 * EDITOR CHOICE: `settings.cms.allowedEditors` (admin, via Relay Admin) is
 * the allow-list; a page's own `editor` field ('markdown'|'richtext') is the
 * owner's choice among it, and a per-identity `preferredEditor` (a small
 * protected settings Document at `documentPath(cmsUserSpaceId(pub),
 * 'settings')`) is the default a NEW page starts with. Markdown is a plain
 * `<textarea>`, not `@qu/content-ui`'s `mountContentEditor()` - that
 * primitive's Enter-submits-instead-of-newline keydown handling (built for a
 * chat/reply composer) would eat every plain Enter keystroke in a multi-
 * paragraph page body, which is wrong for a save-button FORM; richtext uses
 * `mountRichTextEditor()` (`@qu/content-ui`), the WYSIWYG surface this app
 * needed built (see that file's own doc comment for its own scope/safety
 * notes - `sanitizeRichTextHtml()` re-sanitizes on every RENDER, not just at
 * save time, since a page's stored HTML is served to arbitrary readers).
 *
 * TEMPLATES/STYLE: a page's `templateId` resolves against a small fixed
 * `STANDARD_TEMPLATES` catalog first, then a `'cms-template'` Entity in the
 * SAME space (a user/admin-defined named `{layout, style}` preset) - same
 * "fixed catalog ∪ dynamic entries" shape `apps/relay-admin/client.js`'s own
 * `resolveOrderItems()` already uses. Local style customization is
 * deliberately NOT raw CSS/HTML - a small, validated set of CSS custom
 * properties (colors/font/max-width, see `sanitizeStyle()`/`applyPageStyle()`
 * below), merged (template default -> page override) and applied via
 * `element.style.setProperty()` - never a `<style>` tag with user content.
 */
import { watchChildren } from '@qu/reactive';
import { paths, createContent, renderContent } from '@qu/services';
import { mountRichTextEditor, sanitizeRichTextHtml } from '@qu/content-ui';
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderSubpage } from '@qu/ui';

const GLOBAL_SPACE_ID = 'c9e6b279-2835-4388-aa0e-4805339e3495'; // this manifest's own committed spaceId - see manifest.quapp

/** The small, fixed layout catalog every page/template picks from - see class doc comment's "TEMPLATES/STYLE" section. */
export const STANDARD_TEMPLATES = [
  { id: 'std:standard', labelKey: 'templateStandard', layout: 'standard' },
  { id: 'std:wide', labelKey: 'templateWide', layout: 'wide' },
  { id: 'std:sidebar', labelKey: 'templateSidebar', layout: 'sidebar' },
];
const DEFAULT_TEMPLATE_ID = 'std:standard';

const FONT_STACKS = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
};
const MAX_WIDTHS = { narrow: '32rem', normal: '48rem', wide: '64rem', full: '100%' };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

const DICT = {
  en: {
    title: 'CMS',
    mine: 'My pages',
    global: 'Global',
    pages: 'Pages',
    home: 'Home',
    untitled: '(untitled)',
    newPage: 'New page',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    saving: 'Saving…',
    saveFailed: 'Save failed: {error}',
    notAuthorized: 'You are not allowed to edit this space.',
    notFound: 'This page no longer exists.',
    emptyMine: 'You have no pages yet.',
    emptyGlobal: 'No global pages yet.',
    createFirst: 'Create the first one.',
    subpages: 'Subpages',
    fieldTitle: 'Title',
    fieldRoute: 'Route',
    routeHint: 'A slash-separated path within this space, e.g. "about-me" or "blog/2026-08-28/my-post". Leave empty for this space\'s home page.',
    routeCollision: 'Another page already uses this route.',
    fieldParent: 'Parent page',
    parentNone: '— none (top-level) —',
    fieldOrder: 'Sort order (lower first, among siblings)',
    fieldTemplate: 'Template',
    templateStandard: 'Standard',
    templateWide: 'Wide',
    templateSidebar: 'With sidebar',
    fieldEditor: 'Editor',
    editorMarkdown: 'Markdown',
    editorRichtext: 'WYSIWYG (rich text)',
    editorNotAllowed: 'This relay does not currently allow this editor.',
    styleToggle: 'Customize local style',
    styleBackground: 'Background color',
    styleText: 'Text color',
    styleAccent: 'Accent color',
    styleColorHint: 'A hex color, e.g. #223344. Leave empty to inherit from the template.',
    styleFont: 'Font',
    styleMaxWidth: 'Max width',
    styleInherit: '— inherit —',
    fontSans: 'Sans-serif',
    fontSerif: 'Serif',
    fontMono: 'Monospace',
    widthNarrow: 'Narrow',
    widthNormal: 'Normal',
    widthWide: 'Wide',
    widthFull: 'Full',
    manageTemplates: 'Manage templates',
    templates: 'Templates',
    newTemplate: 'New template',
    templateLabelField: 'Label',
    templateLayoutField: 'Layout',
    templateNoneYet: 'No custom templates in this space yet.',
    editorSettings: 'Editor settings',
    preferredEditor: 'My preferred editor',
    preferredEditorHint: 'Used as the default whenever you create a new page - constrained to whatever this relay currently allows.',
  },
  de: {
    title: 'CMS',
    mine: 'Meine Seiten',
    global: 'Global',
    pages: 'Seiten',
    home: 'Startseite',
    untitled: '(ohne Titel)',
    newPage: 'Neue Seite',
    edit: 'Bearbeiten',
    save: 'Speichern',
    cancel: 'Abbrechen',
    saving: 'Speichert…',
    saveFailed: 'Speichern fehlgeschlagen: {error}',
    notAuthorized: 'Du darfst diesen Bereich nicht bearbeiten.',
    notFound: 'Diese Seite existiert nicht mehr.',
    emptyMine: 'Du hast noch keine Seiten.',
    emptyGlobal: 'Noch keine globalen Seiten.',
    createFirst: 'Erste Seite anlegen.',
    subpages: 'Unterseiten',
    fieldTitle: 'Titel',
    fieldRoute: 'Route',
    routeHint: 'Ein durch Schrägstriche getrennter Pfad innerhalb dieses Space, z. B. "about-me" oder "blog/2026-08-28/mein-beitrag". Leer lassen für die Startseite dieses Space.',
    routeCollision: 'Eine andere Seite verwendet diese Route bereits.',
    fieldParent: 'Übergeordnete Seite',
    parentNone: '— keine (oberste Ebene) —',
    fieldOrder: 'Sortierung (niedriger zuerst, unter Geschwisterseiten)',
    fieldTemplate: 'Vorlage',
    templateStandard: 'Standard',
    templateWide: 'Breit',
    templateSidebar: 'Mit Seitenleiste',
    fieldEditor: 'Editor',
    editorMarkdown: 'Markdown',
    editorRichtext: 'WYSIWYG (Rich-Text)',
    editorNotAllowed: 'Dieser Editor ist auf diesem Relay derzeit nicht erlaubt.',
    styleToggle: 'Lokalen Stil anpassen',
    styleBackground: 'Hintergrundfarbe',
    styleText: 'Textfarbe',
    styleAccent: 'Akzentfarbe',
    styleColorHint: 'Ein Hex-Farbwert, z. B. #223344. Leer lassen, um die Vorlage zu übernehmen.',
    styleFont: 'Schriftart',
    styleMaxWidth: 'Maximale Breite',
    styleInherit: '— übernehmen —',
    fontSans: 'Serifenlos',
    fontSerif: 'Serif',
    fontMono: 'Monospace',
    widthNarrow: 'Schmal',
    widthNormal: 'Normal',
    widthWide: 'Breit',
    widthFull: 'Voll',
    manageTemplates: 'Vorlagen verwalten',
    templates: 'Vorlagen',
    newTemplate: 'Neue Vorlage',
    templateLabelField: 'Bezeichnung',
    templateLayoutField: 'Layout',
    templateNoneYet: 'Noch keine eigenen Vorlagen in diesem Space.',
    editorSettings: 'Editor-Einstellungen',
    preferredEditor: 'Mein bevorzugter Editor',
    preferredEditorHint: 'Voreinstellung für neue Seiten - eingeschränkt auf das, was dieses Relay aktuell erlaubt.',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-cms-style';
const STYLE = `
  .qu-cms-empty { opacity: 0.7; padding: 1rem 0; }
  .qu-cms-empty a { margin-left: 0.4em; }
  .qu-cms-page-surface { background: var(--cms-bg, transparent); color: var(--cms-text, inherit); font-family: var(--cms-font, inherit); padding: 0.2rem 0; }
  .qu-cms-page-surface.qu-cms-layout-standard, .qu-cms-page-surface.qu-cms-layout-wide { max-width: var(--cms-maxwidth, 48rem); margin: 0 auto; }
  .qu-cms-page-surface.qu-cms-layout-wide { max-width: var(--cms-maxwidth, 100%); }
  .qu-cms-page-surface.qu-cms-layout-sidebar { display: flex; gap: 1.5rem; max-width: var(--cms-maxwidth, 64rem); margin: 0 auto; flex-wrap: wrap; }
  .qu-cms-page-main { flex: 1; min-width: 0; }
  .qu-cms-page-subnav { flex: 0 0 14rem; }
  .qu-cms-page-edit-link { display: inline-block; margin-bottom: 0.6rem; }
  .qu-cms-page-body :is(h1, h2, h3):first-child { margin-top: 0; }
  .qu-cms-subpages { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .qu-cms-subpages a { color: var(--cms-accent, var(--qu-color-accent, #5b5bd6)); text-decoration: none; }
  .qu-cms-subpages a:hover { text-decoration: underline; }
  .qu-cms-form { display: flex; flex-direction: column; gap: 0.7rem; max-width: 40rem; }
  .qu-cms-form label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.92em; }
  .qu-cms-form input[type="text"], .qu-cms-form input[type="number"], .qu-cms-form select, .qu-cms-form textarea { font: inherit; padding: 0.4rem 0.55rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); box-sizing: border-box; }
  .qu-cms-form textarea { min-height: 10rem; resize: vertical; }
  .qu-cms-form-hint { font-size: 0.8em; opacity: 0.7; margin: 0; }
  .qu-cms-form-actions { display: flex; gap: 0.5rem; align-items: center; }
  .qu-cms-form-actions button { padding: 0.45rem 0.9rem; border-radius: var(--qu-radius-md, 0.4rem); border: 1px solid var(--qu-color-border, #8884); background: none; cursor: pointer; font: inherit; }
  .qu-cms-form-actions button[type="submit"] { border: none; background: var(--qu-color-accent, #5b5bd6); color: #fff; }
  .qu-cms-form-error { color: var(--qu-color-danger, #d64545); font-size: 0.85em; }
  .qu-cms-style-fieldset { display: flex; flex-direction: column; gap: 0.5rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); padding: 0.6rem 0.7rem; }
  .qu-cms-template-list { list-style: none; margin: 0 0 1rem; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .qu-cms-template-list li { display: flex; justify-content: space-between; gap: 0.5rem; padding: 0.4rem 0.6rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); }
`;

// ===========================================================================
// Pure helpers - route/tree/style. Exported for direct unit testing.
// ===========================================================================

/** Turns free-typed input into a stable route path (lowercase, `[a-z0-9-]` segments, no leading/trailing/double slashes). `''` stays `''` (the space's own home page). */
export function normalizeRoute(raw) {
  return String(raw ?? '')
    .split('/')
    .map((seg) => seg.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join('/');
}

/**
 * Groups a space's `'page'` entities into a navigation tree purely from
 * their `route` field (see class doc comment - no separate `parentId`).
 * @param {Array<object>} pages - Raw `'page'` entities (`_id`, `title`, `route`, `order`, ...).
 * @returns {{home: object|null, roots: Array<object>, byId: Map<string, object>}}
 *   Each tree node is `{...page, depth, children: []}`. `home` is the page
 *   whose route is `''`, if any - never part of `roots` (roots are every
 *   OTHER top-level page). `byId` flattens every node (home included) for
 *   O(1) lookup by `_id`.
 */
export function buildPageTree(pages) {
  const nodes = pages.map((p) => ({ ...p, route: normalizeRoute(p.route), children: [] }));
  const byRoute = new Map(nodes.map((n) => [n.route, n]));
  const byId = new Map(nodes.map((n) => [n._id, n]));
  const roots = [];
  for (const node of nodes) {
    node.depth = node.route === '' ? 0 : node.route.split('/').length;
    if (node.route === '') continue; // the home page is never its own child/root entry
    const lastSlash = node.route.lastIndexOf('/');
    if (lastSlash === -1) { roots.push(node); continue; } // a single-segment route is always a root - "home" (route '') is a separate concept, never treated as its implicit parent
    const parentRoute = node.route.slice(0, lastSlash);
    const parent = byRoute.get(parentRoute);
    if (parent) parent.children.push(node);
    else roots.push(node); // no page owns the intermediate route (yet) - surface it as its own top-level entry rather than hiding it
  }
  const byOrderThenTitle = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.title ?? '').localeCompare(b.title ?? '');
  (function sortRec(list) {
    list.sort(byOrderThenTitle);
    for (const n of list) sortRec(n.children);
  })(roots);
  const home = byRoute.get('') ?? null;
  if (home) home.children.sort(byOrderThenTitle);
  return { home, roots, byId };
}

/** Flattens a tree (as `buildPageTree()` returns) into `{node, depth}` rows, home first, for a flat chrome nav list. */
function flattenTree({ home, roots }) {
  const rows = [];
  if (home) rows.push({ node: home, depth: 0 });
  (function walk(list, depth) {
    for (const n of list) {
      rows.push({ node: n, depth });
      walk(n.children, depth + 1);
    }
  })(roots, 1);
  return rows;
}

/** @returns {{background?: string, text?: string, accent?: string, font?: string, maxWidth?: string}} Only the recognized, validated keys - anything else is silently dropped, never thrown (cosmetics, not a hard user input boundary). */
function sanitizeStyle(style = {}) {
  const out = {};
  if (HEX_COLOR_RE.test(style?.background ?? '')) out.background = style.background;
  if (HEX_COLOR_RE.test(style?.text ?? '')) out.text = style.text;
  if (HEX_COLOR_RE.test(style?.accent ?? '')) out.accent = style.accent;
  if (style?.font in FONT_STACKS) out.font = style.font;
  if (style?.maxWidth in MAX_WIDTHS) out.maxWidth = style.maxWidth;
  return out;
}

/** Applies a (template-default, then page-override) merged style as CSS custom properties on `el` - never a `<style>` tag, never raw CSS text (see class doc comment). */
export function applyPageStyle(el, mergedStyle) {
  const s = sanitizeStyle(mergedStyle);
  el.style.setProperty('--cms-bg', s.background ?? '');
  el.style.setProperty('--cms-text', s.text ?? '');
  el.style.setProperty('--cms-accent', s.accent ?? '');
  el.style.setProperty('--cms-font', s.font ? FONT_STACKS[s.font] : '');
  el.style.setProperty('--cms-maxwidth', s.maxWidth ? MAX_WIDTHS[s.maxWidth] : '');
}

/** `renderContent()` (`@qu/services`) for plain/markdown; the browser-only richtext sanitizer for `'richtext'` - `content.js`'s own `renderContent()` stays untouched/DOM-free, see class doc comment. */
function renderPageContent(content) {
  if (!content) return '';
  if (content.format === 'richtext') return sanitizeRichTextHtml(content.text);
  return renderContent(content);
}

/** `STANDARD_TEMPLATES` first, then a `'cms-template'` entity in the same space - see class doc comment's "TEMPLATES/STYLE" section. */
function resolveTemplate(templateId, templatesInSpace) {
  const standard = STANDARD_TEMPLATES.find((s) => s.id === templateId);
  if (standard) return { layout: standard.layout, style: {} };
  const custom = templatesInSpace.find((tpl) => tpl._id === templateId);
  if (custom) return { layout: custom.layout ?? 'standard', style: custom.style ?? {} };
  return { layout: 'standard', style: {} };
}

// ===========================================================================
// mount()
// ===========================================================================

export function mount(container, { qu, services, segments = [], subscribe, syncFetch, chrome = { set() {} } }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  let off = null;
  let myPub = null;
  let isAdmin = false;
  let adminPubs = [];
  let cmsSettings = { allowedEditors: ['markdown'], defaultEditor: 'markdown' };

  const scopeSpaceId = (scope) => (scope === 'global' ? GLOBAL_SPACE_ID : paths.cmsUserSpaceId(myPub));

  /** @returns {Promise<{pages: object[], templates: object[]}>} */
  async function loadSpaceEntities(spaceId) {
    const entries = await qu.getChildren(paths.entitiesParentPath(spaceId));
    const all = entries.map((e) => e.quBit?.val).filter(Boolean);
    return { pages: all.filter((v) => v._type === 'page'), templates: all.filter((v) => v._type === 'cms-template') };
  }

  function setChrome(scope, canWrite, pages, activeId) {
    const tree = buildPageTree(pages);
    const items = flattenTree(tree).map(({ node, depth }) => ({
      id: node._id,
      label: `${'  '.repeat(depth)}${depth > 0 ? '– ' : ''}${node.title || t('untitled')}`,
      href: `#/cms/${scope}/p/${node._id}`,
    }));
    if (tree.home) items.unshift({ id: tree.home._id, label: `🏠 ${t('home')}`, href: `#/cms/${scope}` });
    chrome.set({
      views: {
        items: [
          { id: 'mine', label: t('mine'), href: '#/cms/mine' },
          { id: 'global', label: t('global'), href: '#/cms/global' },
        ],
        activeId: scope,
      },
      navigation: items.length > 0 ? { items, activeId, heading: t('pages') } : undefined,
      primaryAction: canWrite ? { label: t('newPage'), href: `#/cms/${scope}/new`, icon: '✏️' } : undefined,
      settings: {
        items: [
          ...(canWrite ? [{ label: t('manageTemplates'), href: `#/cms/${scope}/templates` }] : []),
          { label: t('editorSettings'), href: '#/cms/settings' },
        ],
      },
    });
  }

  function watchScope(spaceId, onChange) {
    off?.();
    subscribe?.(paths.spacePath(spaceId)); // defense in depth - see docs/building-an-app.md §5.2
    off = watchChildren(qu, paths.entitiesParentPath(spaceId), onChange, { syncFetch });
  }

  // ---------------------------------------------------------------------
  // Home / single-page view - #/cms/<scope> or #/cms/<scope>/p/<id>
  // ---------------------------------------------------------------------
  let renderToken = 0;
  // Sets up the live watcher exactly ONCE per call (never from inside its
  // own callback - `watchScope()` itself tears down and recreates a watcher,
  // and `watchChildren()`'s own `initial: true` default fires its callback
  // immediately on creation, so a callback that re-called `watchScope()`
  // would perpetually restart-and-immediately-refire itself, never settling).
  // Every real navigation is a FRESH `mount()` anyway (the shell remounts on
  // every `hashchange` - `apps/shell/client.js`'s own `renderRoute()`), so
  // this only ever needs subscribing once per mount; the callback re-runs
  // just the render body below, keyed to the SAME `scope`/`pageId` this
  // mount was routed to.
  async function renderPageOrHome(scope, pageId) {
    const spaceId = scopeSpaceId(scope);
    watchScope(spaceId, () => renderPageOrHomeBody(scope, pageId, spaceId));
    await renderPageOrHomeBody(scope, pageId, spaceId);
  }

  async function renderPageOrHomeBody(scope, pageId, spaceId) {
    const token = ++renderToken;
    const canWrite = scope === 'global' ? isAdmin : true; // "mine" always means YOUR OWN space - see class doc comment

    const { pages, templates } = await loadSpaceEntities(spaceId);
    if (stopped || token !== renderToken) return;

    const tree = buildPageTree(pages);
    const page = pageId ? tree.byId.get(pageId) : tree.home;
    setChrome(scope, canWrite, pages, page?._id);

    container.textContent = '';
    if (pageId && !page) {
      const p = document.createElement('p');
      p.textContent = t('notFound');
      container.appendChild(p);
      return;
    }
    if (!page) {
      const empty = document.createElement('p');
      empty.className = 'qu-cms-empty';
      empty.textContent = scope === 'global' ? t('emptyGlobal') : t('emptyMine');
      if (canWrite) {
        const link = document.createElement('a');
        link.href = `#/cms/${scope}/new`;
        link.textContent = t('createFirst');
        empty.appendChild(link);
      }
      container.appendChild(empty);
      return;
    }

    const { layout, style: templateStyle } = resolveTemplate(page.templateId ?? DEFAULT_TEMPLATE_ID, templates);
    const surface = document.createElement('div');
    surface.className = `qu-cms-page-surface qu-cms-layout-${layout}`;
    applyPageStyle(surface, { ...templateStyle, ...sanitizeStyle(page.style) });

    const main = document.createElement('div');
    main.className = 'qu-cms-page-main';
    if (canWrite) {
      const editLink = document.createElement('a');
      editLink.className = 'qu-cms-page-edit-link';
      editLink.href = `#/cms/${scope}/e/${page._id}`;
      editLink.textContent = `✏️ ${t('edit')}`;
      main.appendChild(editLink);
    }
    const h1 = document.createElement('h1');
    h1.textContent = page.title || t('untitled');
    const body = document.createElement('div');
    body.className = 'qu-cms-page-body';
    body.innerHTML = renderPageContent(page.content);
    main.append(h1, body);

    if (page.children.length > 0) {
      const nav = document.createElement('nav');
      const heading = document.createElement('h2');
      heading.textContent = t('subpages');
      const ul = document.createElement('ul');
      ul.className = 'qu-cms-subpages';
      for (const child of page.children) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `#/cms/${scope}/p/${child._id}`;
        a.textContent = child.title || t('untitled');
        li.appendChild(a);
        ul.appendChild(li);
      }
      nav.append(heading, ul);
      main.appendChild(nav);
    }

    surface.appendChild(main);
    if (layout === 'sidebar' && tree.roots.length > 0) {
      const sidebar = document.createElement('nav');
      sidebar.className = 'qu-cms-page-subnav';
      const ul = document.createElement('ul');
      ul.className = 'qu-cms-subpages';
      for (const { node, depth } of flattenTree(tree)) {
        const li = document.createElement('li');
        li.style.paddingLeft = `${depth}rem`;
        const a = document.createElement('a');
        a.href = `#/cms/${scope}/p/${node._id}`;
        a.textContent = node.title || t('untitled');
        li.appendChild(a);
        ul.appendChild(li);
      }
      sidebar.appendChild(ul);
      surface.appendChild(sidebar);
    }
    container.appendChild(surface);
  }

  // ---------------------------------------------------------------------
  // Create/edit form - #/cms/<scope>/new or #/cms/<scope>/e/<id>
  // ---------------------------------------------------------------------
  async function renderPageForm(scope, pageId) {
    const spaceId = scopeSpaceId(scope);
    const canWrite = scope === 'global' ? isAdmin : true;
    renderSubpage(container, {
      showBackLink: false,
      render: (content) => {
        if (!canWrite) {
          const p = document.createElement('p');
          p.textContent = t('notAuthorized');
          content.appendChild(p);
          return;
        }
        renderPageFormBody(content, scope, spaceId, pageId);
      },
    });
  }

  async function renderPageFormBody(content, scope, spaceId, pageId) {
    const { pages, templates } = await loadSpaceEntities(spaceId);
    if (stopped) return;
    const existing = pageId ? pages.find((p) => p._id === pageId) : null;
    if (pageId && !existing) {
      const p = document.createElement('p');
      p.textContent = t('notFound');
      content.appendChild(p);
      return;
    }

    const heading = document.createElement('h1');
    heading.textContent = existing ? t('edit') : t('newPage');

    const form = document.createElement('form');
    form.className = 'qu-cms-form';

    const titleLabel = document.createElement('label');
    titleLabel.textContent = t('fieldTitle');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.required = true;
    titleInput.value = existing?.title ?? '';
    titleLabel.appendChild(titleInput);

    const parentLabel = document.createElement('label');
    parentLabel.textContent = t('fieldParent');
    const parentSelect = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = t('parentNone');
    parentSelect.appendChild(noneOpt);
    for (const p of pages) {
      if (p._id === existing?._id) continue; // a page can't be its own parent
      const opt = document.createElement('option');
      opt.value = normalizeRoute(p.route);
      opt.textContent = `${p.title || t('untitled')} (/${opt.value})`;
      parentSelect.appendChild(opt);
    }
    parentLabel.appendChild(parentSelect);

    const routeLabel = document.createElement('label');
    routeLabel.textContent = t('fieldRoute');
    const routeInput = document.createElement('input');
    routeInput.type = 'text';
    routeInput.value = existing ? normalizeRoute(existing.route) : '';
    routeLabel.appendChild(routeInput);
    const routeHint = document.createElement('p');
    routeHint.className = 'qu-cms-form-hint';
    routeHint.textContent = t('routeHint');
    parentSelect.addEventListener('change', () => {
      const lastSeg = routeInput.value.split('/').pop() || '';
      routeInput.value = parentSelect.value ? `${parentSelect.value}/${lastSeg}` : lastSeg;
    });

    const orderLabel = document.createElement('label');
    orderLabel.textContent = t('fieldOrder');
    const orderInput = document.createElement('input');
    orderInput.type = 'number';
    orderInput.value = String(existing?.order ?? 0);
    orderLabel.appendChild(orderInput);

    const templateLabel = document.createElement('label');
    templateLabel.textContent = t('fieldTemplate');
    const templateSelect = document.createElement('select');
    for (const std of STANDARD_TEMPLATES) {
      const opt = document.createElement('option');
      opt.value = std.id;
      opt.textContent = t(std.labelKey);
      templateSelect.appendChild(opt);
    }
    for (const tpl of templates) {
      const opt = document.createElement('option');
      opt.value = tpl._id;
      opt.textContent = tpl.label || t('untitled');
      templateSelect.appendChild(opt);
    }
    templateSelect.value = existing?.templateId ?? DEFAULT_TEMPLATE_ID;
    templateLabel.appendChild(templateSelect);

    const editorLabel = document.createElement('label');
    editorLabel.textContent = t('fieldEditor');
    const editorSelect = document.createElement('select');
    const editorOptions = [
      { id: 'markdown', labelKey: 'editorMarkdown' },
      { id: 'richtext', labelKey: 'editorRichtext' },
    ];
    for (const { id, labelKey } of editorOptions) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = t(labelKey) + (cmsSettings.allowedEditors.includes(id) ? '' : ` (${t('editorNotAllowed')})`);
      opt.disabled = !cmsSettings.allowedEditors.includes(id);
      editorSelect.appendChild(opt);
    }
    editorSelect.value = existing?.editor && cmsSettings.allowedEditors.includes(existing.editor)
      ? existing.editor
      : (cmsSettings.allowedEditors.includes(cmsSettings.defaultEditor) ? cmsSettings.defaultEditor : cmsSettings.allowedEditors[0]);
    editorLabel.appendChild(editorSelect);

    // ---- content editor - re-mounted whenever `editorSelect` changes, ----
    // carrying the current raw text/HTML over as-is (no format conversion -
    // see class doc comment's "EDITOR CHOICE" section).
    const editorRoot = document.createElement('div');
    let editorHandle = null;
    function mountEditorFor(kind, initialText) {
      editorHandle?.stop?.();
      editorRoot.textContent = '';
      if (kind === 'richtext') {
        const rt = mountRichTextEditor(editorRoot, { initialHtml: initialText ?? '' });
        editorHandle = { getText: () => rt.getHtml(), stop: rt.stop };
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = initialText ?? '';
        editorRoot.appendChild(textarea);
        editorHandle = { getText: () => textarea.value, stop: () => {} };
      }
    }
    mountEditorFor(editorSelect.value, existing?.content?.text ?? '');
    editorSelect.addEventListener('change', () => mountEditorFor(editorSelect.value, editorHandle.getText()));

    // ---- local style override ----
    const styleDetails = document.createElement('details');
    const styleSummary = document.createElement('summary');
    styleSummary.textContent = t('styleToggle');
    const styleFieldset = document.createElement('div');
    styleFieldset.className = 'qu-cms-style-fieldset';
    const existingStyle = existing?.style ?? {};

    function colorField(labelKey, value) {
      const label = document.createElement('label');
      label.textContent = t(labelKey);
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '#223344';
      input.value = value ?? '';
      label.appendChild(input);
      return { label, input };
    }
    const bg = colorField('styleBackground', existingStyle.background);
    const textColor = colorField('styleText', existingStyle.text);
    const accent = colorField('styleAccent', existingStyle.accent);
    const colorHint = document.createElement('p');
    colorHint.className = 'qu-cms-form-hint';
    colorHint.textContent = t('styleColorHint');

    const fontLabel = document.createElement('label');
    fontLabel.textContent = t('styleFont');
    const fontSelect = document.createElement('select');
    const fontNone = document.createElement('option');
    fontNone.value = '';
    fontNone.textContent = t('styleInherit');
    fontSelect.appendChild(fontNone);
    for (const key of Object.keys(FONT_STACKS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = t(`font${key.charAt(0).toUpperCase()}${key.slice(1)}`);
      fontSelect.appendChild(opt);
    }
    fontSelect.value = FONT_STACKS[existingStyle.font] ? existingStyle.font : '';
    fontLabel.appendChild(fontSelect);

    const widthLabel = document.createElement('label');
    widthLabel.textContent = t('styleMaxWidth');
    const widthSelect = document.createElement('select');
    const widthNone = document.createElement('option');
    widthNone.value = '';
    widthNone.textContent = t('styleInherit');
    widthSelect.appendChild(widthNone);
    for (const key of Object.keys(MAX_WIDTHS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = t(`width${key.charAt(0).toUpperCase()}${key.slice(1)}`);
      widthSelect.appendChild(opt);
    }
    widthSelect.value = MAX_WIDTHS[existingStyle.maxWidth] ? existingStyle.maxWidth : '';
    widthLabel.appendChild(widthSelect);

    styleFieldset.append(bg.label, textColor.label, accent.label, colorHint, fontLabel, widthLabel);
    styleDetails.append(styleSummary, styleFieldset);
    if (Object.keys(sanitizeStyle(existingStyle)).length > 0) styleDetails.open = true;

    const errorEl = document.createElement('p');
    errorEl.className = 'qu-cms-form-error';
    errorEl.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'qu-cms-form-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = t('save');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => {
      window.location.hash = existing ? `#/cms/${scope}/p/${existing._id}` : `#/cms/${scope}`;
    });
    actions.append(saveBtn, cancelBtn);

    form.append(titleLabel, parentLabel, routeLabel, routeHint, orderLabel, templateLabel, editorLabel, editorRoot, styleDetails, errorEl, actions);
    content.append(heading, form);

    let submitting = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;
      const title = titleInput.value.trim();
      if (!title) return;
      const route = normalizeRoute(routeInput.value);
      const { pages: freshPages } = await loadSpaceEntities(spaceId);
      if (freshPages.some((p) => p._id !== existing?._id && normalizeRoute(p.route) === route)) {
        errorEl.textContent = t('routeCollision');
        errorEl.hidden = false;
        return;
      }
      submitting = true;
      saveBtn.disabled = true;
      errorEl.hidden = true;
      try {
        const fields = {
          title,
          route,
          order: Number(orderInput.value) || 0,
          templateId: templateSelect.value,
          editor: editorSelect.value,
          style: sanitizeStyle({ background: bg.input.value.trim(), text: textColor.input.value.trim(), accent: accent.input.value.trim(), font: fontSelect.value, maxWidth: widthSelect.value }),
          content: createContent({ text: editorHandle.getText(), format: editorSelect.value }),
        };
        if (existing) {
          if (scope === 'global') await services.access.protect(spaceId, 'entities', existing._id, { writers: adminPubs });
          const writeOptions = await services.access.writeOptionsFor(spaceId, 'entities', existing._id);
          await services.entities.updateEntity(spaceId, existing._id, fields, { writeOptions });
          window.location.hash = `#/cms/${scope}/p/${existing._id}`;
        } else {
          const id = crypto.randomUUID();
          const writers = scope === 'global' ? adminPubs : [myPub];
          await services.access.protect(spaceId, 'entities', id, { writers });
          const writeOptions = await services.access.writeOptionsFor(spaceId, 'entities', id);
          await services.entities.createEntity(spaceId, 'page', fields, { id, writeOptions });
          window.location.hash = `#/cms/${scope}/p/${id}`;
        }
      } catch (err) {
        errorEl.textContent = t('saveFailed', { error: err.message });
        errorEl.hidden = false;
        submitting = false;
        saveBtn.disabled = false;
      }
    });

    setChrome(scope, true, pages, existing?._id);
  }

  // ---------------------------------------------------------------------
  // Templates - #/cms/<scope>/templates
  // ---------------------------------------------------------------------
  async function renderTemplatesView(scope) {
    const spaceId = scopeSpaceId(scope);
    const canWrite = scope === 'global' ? isAdmin : true;
    renderSubpage(container, {
      showBackLink: false,
      render: async (content) => {
        if (!canWrite) {
          const p = document.createElement('p');
          p.textContent = t('notAuthorized');
          content.appendChild(p);
          return;
        }
        const { pages, templates } = await loadSpaceEntities(spaceId);
        if (stopped) return;
        setChrome(scope, canWrite, pages, undefined);

        const heading = document.createElement('h1');
        heading.textContent = t('templates');
        content.appendChild(heading);

        const list = document.createElement('ul');
        list.className = 'qu-cms-template-list';
        if (templates.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'qu-cms-empty';
          empty.textContent = t('templateNoneYet');
          content.appendChild(empty);
        } else {
          for (const tpl of templates) {
            const li = document.createElement('li');
            const label = document.createElement('span');
            label.textContent = `${tpl.label || t('untitled')} — ${tpl.layout}`;
            li.appendChild(label);
            list.appendChild(li);
          }
          content.appendChild(list);
        }

        const formHeading = document.createElement('h2');
        formHeading.textContent = t('newTemplate');
        const form = document.createElement('form');
        form.className = 'qu-cms-form';

        const labelLabel = document.createElement('label');
        labelLabel.textContent = t('templateLabelField');
        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.required = true;
        labelLabel.appendChild(labelInput);

        const layoutLabel = document.createElement('label');
        layoutLabel.textContent = t('templateLayoutField');
        const layoutSelect = document.createElement('select');
        for (const std of STANDARD_TEMPLATES) {
          const opt = document.createElement('option');
          opt.value = std.layout;
          opt.textContent = t(std.labelKey);
          layoutSelect.appendChild(opt);
        }
        layoutLabel.appendChild(layoutSelect);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.textContent = t('save');

        form.append(labelLabel, layoutLabel, saveBtn);
        content.append(formHeading, form);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const label = labelInput.value.trim();
          if (!label) return;
          saveBtn.disabled = true;
          try {
            const id = crypto.randomUUID();
            const writers = scope === 'global' ? adminPubs : [myPub];
            await services.access.protect(spaceId, 'entities', id, { writers });
            const writeOptions = await services.access.writeOptionsFor(spaceId, 'entities', id);
            await services.entities.createEntity(spaceId, 'cms-template', { label, layout: layoutSelect.value }, { id, writeOptions });
            window.location.hash = `#/cms/${scope}/templates`;
          } catch (err) {
            saveBtn.disabled = false;
            console.error('[cms] failed to create template:', err);
          }
        });
      },
    });
  }

  // ---------------------------------------------------------------------
  // Per-identity editor preference - #/cms/settings
  // ---------------------------------------------------------------------
  async function renderSettingsView() {
    renderSubpage(container, {
      showBackLink: false,
      render: async (content) => {
        const mySpaceId = paths.cmsUserSpaceId(myPub);
        const path = paths.documentPath(mySpaceId, 'settings');
        const existing = await qu.get(path);
        if (stopped) return;

        const heading = document.createElement('h1');
        heading.textContent = t('editorSettings');
        const form = document.createElement('form');
        form.className = 'qu-cms-form';

        const label = document.createElement('label');
        label.textContent = t('preferredEditor');
        const select = document.createElement('select');
        for (const id of cmsSettings.allowedEditors) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = id === 'richtext' ? t('editorRichtext') : t('editorMarkdown');
          select.appendChild(opt);
        }
        const currentPref = existing?.val?.preferredEditor;
        select.value = cmsSettings.allowedEditors.includes(currentPref) ? currentPref : cmsSettings.defaultEditor;
        label.appendChild(select);
        const hint = document.createElement('p');
        hint.className = 'qu-cms-form-hint';
        hint.textContent = t('preferredEditorHint');

        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.textContent = t('save');

        form.append(label, hint, saveBtn);
        content.append(heading, form);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          saveBtn.disabled = true;
          try {
            await services.access.protect(mySpaceId, 'docs', 'settings', { writers: [myPub] });
            const writeOptions = await services.access.writeOptionsFor(mySpaceId, 'docs', 'settings');
            await qu.put(path, { preferredEditor: select.value }, writeOptions);
          } finally {
            saveBtn.disabled = false;
          }
        });
      },
    });
  }

  // ---------------------------------------------------------------------
  // Routing - segments[0] === 'cms' always (see docs/building-an-app.md §4.2)
  // ---------------------------------------------------------------------
  function route() {
    if (stopped) return;
    if (segments[1] === 'settings') return renderSettingsView();
    const scope = segments[1] === 'global' ? 'global' : 'mine';
    const sub = segments[1] === 'global' || segments[1] === 'mine' ? segments.slice(2) : segments.slice(1);
    if (sub[0] === 'new') return renderPageForm(scope, null);
    if (sub[0] === 'e' && sub[1]) return renderPageForm(scope, sub[1]);
    if (sub[0] === 'templates') return renderTemplatesView(scope);
    if (sub[0] === 'p' && sub[1]) return renderPageOrHome(scope, sub[1]);
    return renderPageOrHome(scope, null);
  }

  (async () => {
    myPub = await services.actors.whoAmI();
    if (stopped) return;
    try {
      const res = await fetch('/config.json');
      if (res.ok) {
        const config = await res.json();
        adminPubs = config.adminPubs ?? [];
        cmsSettings = { allowedEditors: ['markdown'], defaultEditor: 'markdown', ...config.settings?.cms };
        if (!Array.isArray(cmsSettings.allowedEditors) || cmsSettings.allowedEditors.length === 0) cmsSettings.allowedEditors = ['markdown'];
      }
    } catch { /* offline/unreachable - same "nothing this identity could do right now anyway" posture apps/relay-admin/client.js's own mount() already takes */ }
    isAdmin = adminPubs.includes(myPub);
    if (stopped) return;
    route();
  })();

  return () => {
    stopped = true;
    off?.();
  };
}
