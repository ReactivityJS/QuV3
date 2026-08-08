/**
 * APP LIST — browser half. Every currently loaded app (from the relay's
 * `/apps.json`, see @qu/relay's `apps-catalog.js`), each with a Favorite
 * toggle - favoriting here is the mechanism a future shell's header
 * dropdown menu would read to decide which apps to pin; this app and that
 * menu would both just read/write `FavoritesService`, neither owns the
 * favorite list.
 *
 * Stays IMPERATIVE, not built on `@qu/ui`'s `<qu-list>`: the rendered rows
 * combine `/apps.json` (an HTTP fetch, not a Qu path at all) with
 * `FavoritesService.list()` (a second, independent read) - not the
 * "one watched Qu path -> one array" shape `<qu-list>` expects. See
 * docs/v3-technical-concept.md §5 for the resolved open question this is
 * part of.
 */
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme } from '@qu/ui';

const DICT = {
  en: { title: 'App List', empty: 'No mountable apps loaded on this relay yet.' },
  de: { title: 'App-Liste', empty: 'Noch keine startbaren Apps auf diesem Relay geladen.' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-app-list-style';
const STYLE = `
  .qu-app-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-app-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-app-list a { flex: 1; text-decoration: none; color: inherit; }
  .qu-app-list button { background: none; border: none; cursor: pointer; font-size: 1.1em; }
`;

/** Same "mountable, not explicitly disabled" filter + navOrder sort a future shell's own nav would use - small enough to keep local rather than importing across an app boundary. */
function mountableApps(manifests) {
  return manifests
    .filter((m) => m.enabled !== false && !!m.clientMainUrl)
    .sort((a, b) => (a.navOrder ?? Infinity) - (b.navOrder ?? Infinity) || (a.label ?? a.name).localeCompare(b.label ?? b.name));
}

export function mount(container, { services }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  (async () => {
    const res = await fetch('/apps.json');
    const apps = mountableApps(res.ok ? await res.json() : []);
    const favoriteIds = new Set(await services.favorites.list());
    if (stopped) return;

    const heading = document.createElement('h1');
    heading.textContent = t('title');

    if (apps.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('empty');
      container.append(heading, empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'qu-app-list';
    for (const app of apps) list.appendChild(row(app, favoriteIds.has(app.name), services));

    container.append(heading, list);
  })();

  return () => { stopped = true; };
}

function row(app, isFavorite, services) {
  const li = document.createElement('li');
  const link = document.createElement('a');
  link.href = `#/${app.name}`;
  link.textContent = `${app.icon ?? ''} ${app.label ?? app.name}`.trim();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = isFavorite ? '★' : '☆';
  toggle.addEventListener('click', async () => {
    const nowFavorite = toggle.textContent === '★';
    if (nowFavorite) await services.favorites.remove(app.name);
    else await services.favorites.add(app.name);
    toggle.textContent = nowFavorite ? '☆' : '★';
    // Notifies a future shell's header menu (or any other app) to refresh -
    // same "mounted independently, no direct reference to a host object"
    // reasoning as @qu/ui's renderFlagToggle().
    window.dispatchEvent(new CustomEvent('qu:flag-changed', { detail: { flagType: 'favorite', entityKind: 'app', entityRef: app.name, on: !nowFavorite } }));
  });

  li.append(link, toggle);
  return li;
}
