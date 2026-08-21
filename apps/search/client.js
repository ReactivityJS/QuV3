/**
 * SEARCH — a context-aware header search, built as its OWN module rather
 * than a per-app feature: this file never imports Forum/Chat/whatever else
 * ships searchable content, and none of THEM import this file either - the
 * two sides only agree on two extension points this app itself defines
 * (`content.search`/`content.searchResultTemplate`, see manifest.quapp's
 * own doc comment for the full payload contract), the exact same "host
 * defines, contributor implements" shape `apps/forum`'s own
 * `content.messageActions`/`content.messageReactions` already establish for
 * Bookmarks/Reactions/Pins.
 *
 * NO SEPARATE INDEX: `content.search` is a QUERY-TIME fan-out, not a
 * maintained write-time index this app owns - every real app already
 * stores its own content locally (Forum/Chat messages already sit in this
 * identity's own IndexedDB via `MessageService`), so a contributor's own
 * `search(payload)` just filters what it already has. This is deliberately
 * simpler and more robust than a second, separately-written index that
 * could drift out of sync with the real data (no upsert-on-write path to
 * keep correct, no tombstone/edit consistency to maintain) - see the
 * conversation this app was designed from for the full reasoning. If data
 * volume ever makes a live scan too slow, a contributor can swap its OWN
 * `search()` implementation for an index-backed one without this app (or
 * any other contributor) ever needing to change - the payload/return
 * contract doesn't care how a contributor finds its results.
 *
 * SCOPE, DERIVED FROM THE ROUTE, NOT A SEPARATE STATE STORE: `#/search/
 * <scope>/<contextAppId>/<...rest>` - `contextAppId` + `rest` are always
 * THAT app's own `ctx.segments` shape (e.g. `rest = ['t', '<topicId>']` for
 * Forum, reconstructed here as `[contextAppId, ...rest]` before being
 * handed to that app's own `content.search` contributor, so it can parse
 * them exactly the same way its own `mount()` already does - no shared
 * "subpage" schema needed across apps, see this app's own design
 * discussion). `scope` alone decides the query behavior:
 *   - 'global'  - every contributor is called (`ExtensionPointHost.
 *     collect('content.search', payload)`), `segments` is not sent.
 *   - 'app'/'subpage' - ONLY `contextAppId`'s own contributor is called
 *     (`collect(point, payload, {onlyAppId: contextAppId})`); `'subpage'`
 *     additionally sends `segments` so that ONE contributor can narrow
 *     further (a single board/topic/chat) - `'app'` still calls the same
 *     contributor but expects it to search everything it owns.
 * The QUERY TEXT and the TYPE FILTER CHIPS are deliberately NOT part of the
 * URL (same "plain post-render filter, not a new reactive primitive"
 * precedent `apps/user-list`/`apps/contact-list`'s own in-page search
 * already set, see docs/v3-technical-concept.md) - only WHERE to search
 * needs to be shareable/bookmarkable, not WHAT was typed.
 */
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, mountAppTemplate } from '@qu/ui';

const DICT = {
  en: {
    title: 'Search',
    placeholder: 'Search…',
    scopeGlobal: 'Everywhere',
    scopeApp: 'In {app}',
    scopeSubpage: 'Here',
    filterPost: 'Text',
    filterImage: 'Images',
    filterVideo: 'Videos',
    filterAudio: 'Audio',
    filterFile: 'Files',
    filterLink: 'Links',
    typeToSearch: 'Type to search.',
    searching: 'Searching…',
    noResults: 'No results.',
    searchIconTitle: 'Search',
  },
  de: {
    title: 'Suche',
    placeholder: 'Suchen…',
    scopeGlobal: 'Überall',
    scopeApp: 'In {app}',
    scopeSubpage: 'Hier',
    filterPost: 'Text',
    filterImage: 'Bilder',
    filterVideo: 'Videos',
    filterAudio: 'Audio',
    filterFile: 'Dateien',
    filterLink: 'Links',
    typeToSearch: 'Suchbegriff eingeben.',
    searching: 'Suche läuft…',
    noResults: 'Keine Treffer.',
    searchIconTitle: 'Suche',
  },
};
const { t } = createI18n(DICT);

const TYPES = ['post', 'image', 'video', 'audio', 'file', 'link'];

const STYLE_ID = 'qu-search-style';
const STYLE = `
  .qu-search-tabs { display: flex; gap: 0.4rem; margin: 0.6rem 0; }
  .qu-search-tab { padding: 0.3rem 0.7rem; border-radius: 999px; text-decoration: none; color: inherit; background: var(--qu-color-surface, #8882); font-size: 0.9em; }
  .qu-search-tab-active { background: var(--qu-color-accent, #5b5bd6); color: white; }
  .qu-search-controls { display: flex; flex-direction: column; gap: 0.5rem; max-width: 34rem; margin-bottom: 0.8rem; }
  .qu-search-input { font: inherit; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-search-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .qu-search-chip { border: 1px solid var(--qu-color-border, #8884); background: transparent; border-radius: 999px; padding: 0.15rem 0.6rem; font: inherit; font-size: 0.85em; cursor: pointer; color: inherit; }
  .qu-search-chip-active { background: color-mix(in srgb, var(--qu-color-accent, #5b5bd6) 20%, transparent); border-color: var(--qu-color-accent, #5b5bd6); }
  .qu-search-results { display: flex; flex-direction: column; gap: 0.5rem; max-width: 40rem; }
  .qu-search-hint { padding: 1.5rem; text-align: center; opacity: 0.7; }
`;

/**
 * @param {HTMLElement} container
 * @param {{services: object, qu: object, syncFetch?: Function, apps: object[], segments?: string[], extensionPoints: import('@qu/foundation').ExtensionPointHost}} ctx
 * @returns {() => void} A stop function.
 */
export function mount(container, ctx) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  const { services, qu, syncFetch, apps, segments = [], extensionPoints } = ctx;
  let stopped = false;

  // A result row's own `<qu-asset>` (rendered by a contributor's
  // `content.searchResultTemplate` - see e.g. apps/forum/client.js's own
  // `renderSearchResult()`) resolves this via an ancestor walk - same "set
  // on an ancestor before children connect" discipline `@qu/ui` requires
  // everywhere else. This app never renders an asset itself; it only ever
  // hosts one, for whichever contributor's template needs it.
  container.assetService = services.assets;

  const [, scopeSeg, contextAppId = null, ...rest] = segments;
  let scope = 'global';
  if (scopeSeg === 'app' && contextAppId) scope = 'app';
  else if (scopeSeg === 'subpage' && contextAppId && rest.length > 0) scope = 'subpage';
  const contextLabel = contextAppId ? (apps?.find((a) => a.name === contextAppId)?.label ?? contextAppId) : null;
  const contextSuffix = contextAppId ? `/${[contextAppId, ...rest].map(encodeURIComponent).join('/')}` : '';

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const tabs = document.createElement('div');
  tabs.className = 'qu-search-tabs';
  function addTab(scopeName, href, label) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    a.className = 'qu-search-tab' + (scope === scopeName ? ' qu-search-tab-active' : '');
    tabs.appendChild(a);
  }
  addTab('global', `#/search/global${contextSuffix}`, t('scopeGlobal'));
  if (contextAppId) {
    addTab('app', `#/search/app${contextSuffix}`, t('scopeApp', { app: contextLabel }));
    if (rest.length > 0) addTab('subpage', `#/search/subpage${contextSuffix}`, t('scopeSubpage'));
  }

  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = t('placeholder');
  input.className = 'qu-search-input';

  const chipsRoot = document.createElement('div');
  chipsRoot.className = 'qu-search-chips';
  const activeTypes = new Set();
  for (const type of TYPES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'qu-search-chip';
    chip.textContent = t(`filter${type[0].toUpperCase()}${type.slice(1)}`);
    chip.addEventListener('click', () => {
      if (activeTypes.has(type)) activeTypes.delete(type); else activeTypes.add(type);
      chip.classList.toggle('qu-search-chip-active', activeTypes.has(type));
      runSearch();
    });
    chipsRoot.appendChild(chip);
  }

  const controls = document.createElement('div');
  controls.className = 'qu-search-controls';
  controls.append(input, chipsRoot);

  const resultsRoot = document.createElement('div');
  resultsRoot.className = 'qu-search-results';

  // Rule 5 (docs/app-navigation-standard.md) - the app's one, chrome-less
  // main view still routes through `mountAppTemplate()`, same as every other
  // app's MAIN view: none of `navigation`/`views`/`primaryAction`/`settings`
  // fit this single-view, tab-switched-via-hash-route app, so `render` is
  // all that's passed - zero visible chrome change, content still gets 100%
  // of the container.
  mountAppTemplate(container, {
    render: (content) => {
      content.append(heading, tabs, controls, resultsRoot);
    },
  });

  function renderHint(text) {
    resultsRoot.textContent = '';
    const p = document.createElement('p');
    p.className = 'qu-search-hint';
    p.textContent = text;
    resultsRoot.appendChild(p);
  }

  let myPub = null;
  let searchToken = 0;
  let debounceTimer = null;

  async function runSearch() {
    const token = ++searchToken;
    const query = input.value.trim();
    // A type filter with no text at all is a real search on its own -
    // "every image here" - not something requiring a query to anchor to;
    // see e.g. apps/chat's/apps/forum's own searchChat()/searchForum() doc
    // comments for the contributor side of this same relaxation.
    if (!query && activeTypes.size === 0) { renderHint(t('typeToSearch')); return; }
    renderHint(t('searching'));

    if (!myPub) myPub = await services.actors.whoAmI();
    if (stopped || token !== searchToken) return;

    const payload = {
      services, qu, syncFetch, apps, myPub, query,
      types: activeTypes.size ? [...activeTypes] : null,
      scope, segments: scope === 'global' ? [] : [contextAppId, ...rest],
    };
    const entries = scope === 'global'
      ? await extensionPoints.collect('content.search', payload)
      : await extensionPoints.collect('content.search', payload, { onlyAppId: contextAppId });
    if (stopped || token !== searchToken) return;

    entries.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    resultsRoot.textContent = '';
    if (entries.length === 0) { renderHint(t('noResults')); return; }
    for (const entry of entries) {
      const row = document.createElement('div');
      resultsRoot.appendChild(row);
      extensionPoints.renderFrom('content.searchResultTemplate', entry.appId, row, { entry, services });
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 300);
  });

  renderHint(t('typeToSearch'));

  return () => {
    stopped = true;
    clearTimeout(debounceTimer);
  };
}

const HEADER_BTN_STYLE_ID = 'qu-search-header-btn-style';
const HEADER_BTN_STYLE = `
  .qu-search-header-btn { display: inline-flex; background: none; border: none; cursor: pointer; text-decoration: none; color: inherit; font-size: 1.2em; padding: 0.35rem 0.55rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-search-header-btn:hover { background: var(--qu-color-surface, #8882); }
`;

/**
 * The `shell.headerAction` contributor - a single 🔍 icon linking straight
 * into `#/search/app/<currentAppId>/<...segments>` (always the fullest
 * context the header currently knows, so every tab on the search page
 * itself - including "Everywhere" - stays one click away; see this file's
 * own top doc comment on why `contextAppId`/`rest` ride along even on the
 * default landing scope). Mounted ONCE by the shell header (see
 * `apps/shell/src/header.js`), not re-rendered per navigation - `payload.
 * onContextChange` is how it learns about a route change instead, updating
 * only this one link's `href` (cheap: a plain object mutation + one DOM
 * attribute write, no DOM churn, no re-import).
 * @param {HTMLElement} container
 * @param {{getContext: () => {appId: string|null, segments: string[]}, onContextChange: (cb: () => void) => void}} payload
 */
export function renderHeaderSearch(container, { getContext, onContextChange }) {
  ensureTheme();
  injectStyle(HEADER_BTN_STYLE_ID, HEADER_BTN_STYLE);

  const link = document.createElement('a');
  link.className = 'qu-search-header-btn';
  link.textContent = '🔍';
  link.title = t('searchIconTitle');
  link.setAttribute('aria-label', t('searchIconTitle'));

  function updateHref() {
    const { appId, segments = [] } = getContext?.() ?? {};
    if (!appId || appId === 'search') {
      link.href = '#/search/global';
      return;
    }
    const rest = segments.slice(1); // drop the app's own id at segments[0] - the rest is that app's own sub-route
    const suffix = [appId, ...rest].map(encodeURIComponent).join('/');
    link.href = `#/search/app/${suffix}`;
  }
  updateHref();
  onContextChange?.(updateHref);

  container.appendChild(link);
}
