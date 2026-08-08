/**
 * APP LIST — every currently loaded, enabled app (from
 * `/store/apps/catalog`, `@qu/relay`'s `apps-catalog-store.js`), each with
 * a Favorite toggle - favoriting here is the mechanism a future shell's
 * header dropdown menu would read to decide which apps to pin.
 *
 * Built on `<qu-list parent="...">` (`@qu/ui`) - the app catalog is a
 * derived list, one signed QuBit per app, exactly the shape that primitive
 * was extended for. Two things pure `<qu-list>`/`<qu-view>` genuinely can't
 * express, handled via its `onItemStamped` escape hatch:
 *   - SIGNER VERIFICATION: the catalog isn't `AccessEngine`-ACL-protected
 *     (see `apps-catalog-store.js`'s own doc comment for why) - a reader
 *     must check each entry's signer against this specific relay's own
 *     `relayPub` (`/config.json`) before trusting it. Done by wrapping
 *     `getChildren()` itself (`createTrustedCatalogQu()` below), so an
 *     untrusted entry never reaches `<qu-list>`'s rendering at all - not a
 *     per-row hide-after-render check.
 *   - The Favorite STAR: reuses the existing, already-correct
 *     `renderFlagToggle()` (`@qu/ui`) rather than reimplementing its
 *     encrypt/tombstone semantics declaratively - a private flag's "off"
 *     state is a PLAIN `null` write, not a boolean, which a generic
 *     `<qu-bind attr="checked">` has no way to express correctly.
 */
import { createI18n } from '@qu/i18n';
import { injectStyle, ensureTheme, renderFlagToggle } from '@qu/ui';
import { paths } from '@qu/services';
import { QuCrypto } from '@qu/core';

const DICT = {
  en: {
    title: 'App List',
    empty: 'No mountable apps loaded on this relay yet.',
    favoriteAdd: 'Add to favorites',
    favoriteRemove: 'Remove from favorites',
  },
  de: {
    title: 'App-Liste',
    empty: 'Noch keine startbaren Apps auf diesem Relay geladen.',
    favoriteAdd: 'Zu Favoriten hinzufügen',
    favoriteRemove: 'Aus Favoriten entfernen',
  },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-app-list-style';
const STYLE = `
  .qu-app-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-app-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  .qu-app-list a { flex: 1; text-decoration: none; color: inherit; }
  .qu-app-list button { background: none; border: none; cursor: pointer; font-size: 1.1em; }
`;

/**
 * Wraps the real `qu` so `<qu-list parent="/store/apps/catalog">` only ever
 * sees entries actually signed by THIS relay - "path is addressing, signer
 * is truth", the same convention every derived list in this codebase
 * relies on (see `apps-catalog-store.js`). Also filters out
 * admin-disabled apps here (same job QuV2's own `mountableApps()` did) -
 * one filtering pass, not two.
 */
function createTrustedCatalogQu(qu, relayPub) {
  return {
    get: (path) => qu.get(path),
    put: (path, value) => qu.put(path, value),
    async getChildren(parentPath, options) {
      const entries = await qu.getChildren(parentPath, options);
      return entries.filter((e) => {
        const pub = e.quBit?.pub;
        const signer = pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(pub)) : null;
        return signer === relayPub && e.quBit.val?.enabled !== false;
      });
    },
    onStorageChange: (handler) => qu.onStorageChange(handler),
  };
}

export function mount(container, { qu, services }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  const heading = document.createElement('h1');
  heading.textContent = t('title');
  const listRoot = document.createElement('div');
  container.append(heading, listRoot);

  (async () => {
    const res = await fetch('/config.json');
    const relayPub = res.ok ? (await res.json()).relayPub : null;
    if (stopped || !relayPub) return;

    listRoot.qu = createTrustedCatalogQu(qu, relayPub);
    listRoot.innerHTML = `
      <qu-list class="qu-app-list" parent="${paths.appCatalogParentPath()}">
        <template>
          <li>
            <a class="qu-app-list-link"><qu-view field="icon"></qu-view> <qu-view field="label"></qu-view></a>
            <span class="qu-app-fav-slot"></span>
          </li>
        </template>
      </qu-list>`;

    const list = listRoot.querySelector('qu-list');
    list.onItemStamped = (els, itemId) => {
      const link = els[0].querySelector('.qu-app-list-link');
      link.href = `#/${itemId}`;

      const slot = els[0].querySelector('.qu-app-fav-slot');
      // renderFlagToggle() already broadcasts qu:flag-changed itself on
      // click (see its own doc comment) - a future shell's header menu (or
      // any other app) picks that up directly, nothing extra to wire here.
      const toggle = renderFlagToggle({
        flags: {
          hasPrivate: () => services.favorites.isFavorite(itemId),
          setPrivate: (_flagType, _entityKind, _entityRef, on) => (on ? services.favorites.add(itemId) : services.favorites.remove(itemId)),
        },
        flagType: 'favorite',
        entityKind: 'app',
        entityRef: itemId,
        icon: '☆',
        activeIcon: '★',
        title: t('favoriteAdd'),
        activeTitle: t('favoriteRemove'),
      });
      slot.replaceWith(toggle);
    };
  })();

  return () => { stopped = true; };
}
