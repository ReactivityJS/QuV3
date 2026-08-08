import { paths, createTrustedCatalogStore } from '@qu/services';
import { injectStyle, ensureTheme } from '@qu/ui';
import { buildHash } from './router.js';

const STYLE_ID = 'qu-shell-nav-style';
const STYLE = `
  .qu-shell-nav { list-style: none; margin: 0; padding: 0.4rem 0.8rem; display: flex; gap: 0.6rem; flex-wrap: wrap; border-bottom: 1px solid var(--qu-color-border, #8884); }
  .qu-shell-nav a { display: inline-flex; align-items: center; gap: 0.3rem; text-decoration: none; color: inherit; padding: 0.3rem 0.6rem; border-radius: var(--qu-radius-sm, 0.3rem); }
  .qu-shell-nav a:hover { background: var(--qu-color-surface, #8882); }
`;

/**
 * Mounts a compact top nav, one entry per trusted, enabled app catalog
 * entry - the same `<qu-list parent="...">` + `createTrustedCatalogStore()`
 * (`@qu/services`, shared with `apps/app-list`'s own full-page list) that
 * every other reactive list in this codebase is built on, just a smaller
 * template. Live: an app enabled/disabled via Relay Admin updates this nav
 * immediately, same as `apps/app-list`.
 *
 * `syncFetch`, if given (from `connectToRelay()`'s `sync.fetchPrefix`, see
 * `client.js`), backfills catalog entries the relay wrote before this
 * session connected - without it, a fresh browser's local store starts
 * EMPTY and the nav would stay empty until some unrelated write happened to
 * trigger a re-read (see `<qu-list>`'s own `.syncFetch` doc comment).
 *
 * @param {HTMLElement} container
 * @param {{qu: import('@qu/core').QuStore, relayPub: string, syncFetch?: (prefix: string) => Promise<*>}} deps
 */
export function mountNav(container, { qu, relayPub, syncFetch }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);

  const nav = document.createElement('div');
  nav.qu = createTrustedCatalogStore(qu, relayPub);
  if (syncFetch) nav.syncFetch = syncFetch;
  nav.innerHTML = `
    <qu-list class="qu-shell-nav" parent="${paths.appCatalogParentPath()}">
      <template>
        <li><a class="qu-shell-nav-link"><qu-view field="icon"></qu-view> <qu-view field="label"></qu-view></a></li>
      </template>
    </qu-list>`;

  const list = nav.querySelector('qu-list');
  list.onItemStamped = (els, itemId) => {
    els[0].querySelector('.qu-shell-nav-link').href = buildHash(itemId);
  };

  container.appendChild(nav);
}
