/**
 * USER LIST — every identity that opted into `DirectoryService`'s public
 * "listed" collection, each showing avatar/alias/pub (the pub links to
 * `#/~<pub>`) with a Contact toggle - favoriting a user HERE is exactly
 * what turns them into a Contact (`ContactsService`). Excludes the
 * viewer's own entry - you can't "contact" yourself.
 *
 * Built on `<qu-list parent="/store/directory/entries">` (`@qu/ui`) - the
 * directory is a derived list, exactly the shape that primitive supports.
 * Avatar/alias/contact-toggle are resolved imperatively in `onItemStamped`,
 * for two independent reasons, not because `<qu-list>` doesn't work:
 *   - A profile document is NOT a plain readable value - it's a signed,
 *     WRAPPED envelope (`{profile: {...}, signature}`, see
 *     `@qu/identity`'s `publishMainProfile()`/`getProfile()`), verified and
 *     unwrapped only by `identity.getProfile()` (here, via
 *     `services.profile.getPublicProfile()` - the exact same call the
 *     "not listed" lookup below already needed). A `<qu-view
 *     related="profile" field="alias">` would show raw, UNVERIFIED
 *     envelope garbage, not an alias - `related`/`relatedPaths` genuinely
 *     don't fit here, there's no path a plain `<qu-view>` could safely
 *     read this from directly.
 *   - `renderAvatarOrAsset()` composes a whole DOM subtree from resolved values,
 *     not a single field a `<qu-view>` could mirror, and a manual `watch()`
 *     call here would have no lifecycle hook to unsubscribe from when a
 *     row is later removed (`<qu-list>` only self-cleans ITS OWN
 *     `<qu-view>`/`<qu-bind>` descendants). Accepted tradeoff: a live
 *     rename doesn't update an already-rendered row's avatar/alias without
 *     a fresh mount - profiles change rarely, and the LIST STRUCTURE
 *     itself (who's listed at all) stays fully live either way.
 *   - The exact-FP "not listed" lookup is inherently not list-shaped (one
 *     ad-hoc network lookup for a single pubkey), same as before.
 *   - Search is a plain post-render visibility toggle over the already-
 *     rendered rows' own text - a standard technique, not a hand-rolled
 *     list-diffing workaround (the list itself is still 100% `<qu-list>`).
 *
 * SIGNER VERIFICATION: `/store/directory/entries` isn't `AccessEngine`-ACL-
 * protected (same reasoning as the app catalog - see
 * `DirectoryService`'s own doc comment: "trust comes only from the QuBit's
 * own verified signer, never the path segment"). `DirectoryService.
 * listVisible()` already does this check internally; binding `<qu-list>`
 * straight to the raw path bypasses that Service, so this file re-does the
 * SAME check itself (`createVerifiedDirectoryQu()` below) rather than
 * silently trusting whoever wrote to a given path.
 */
import { createI18n } from '@qu/i18n';
import { formatActorLabel, paths } from '@qu/services';
import { renderAvatarOrAsset, injectStyle, ensureTheme, renderFlagToggle } from '@qu/ui';
import { QuCrypto } from '@qu/core';

const DICT = {
  en: {
    title: 'User List',
    searchPlaceholder: 'Search by alias or FP…',
    unlisted: 'Not listed',
    contactAdd: 'Add contact',
    contactRemove: 'Remove contact',
  },
  de: {
    title: 'Nutzerliste',
    searchPlaceholder: 'Suche nach Alias oder FP…',
    unlisted: 'Nicht gelistet',
    contactAdd: 'Kontakt hinzufügen',
    contactRemove: 'Kontakt entfernen',
  },
};
const { t } = createI18n(DICT);

// Base64url encoding of a raw 32-byte Ed25519 pub is always 43 chars (see
// QuCrypto.toBase64Url) - below this, a query can't possibly be a full FP,
// so there's no point spending a network round-trip probing for one.
const FP_LENGTH = 43;

const STYLE_ID = 'qu-user-list-style';
const STYLE = `
  .qu-user-search { width: 100%; box-sizing: border-box; margin: 0 0 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); font: inherit; }
  .qu-user-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-user-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  /* Without this, search filtering below (\`li.hidden = ...\`) would have no
     visual effect - a plain author-stylesheet class selector beats the UA's
     own [hidden] rule at equal specificity, so every row would stay
     visible regardless of the search query. */
  .qu-user-list li[hidden] { display: none; }
  .qu-user-list li.qu-user-unlisted { border-style: dashed; }
  .qu-user-info { flex: 1; min-width: 0; display: flex; flex-direction: column; text-decoration: none; color: inherit; }
  .qu-user-info:hover .qu-user-alias { text-decoration: underline; }
  .qu-user-alias-row { display: flex; align-items: center; gap: 0.4rem; }
  .qu-user-alias { font-weight: 600; }
  .qu-user-badge { font-size: 0.7em; font-weight: 600; text-transform: uppercase; opacity: 0.7; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); padding: 0.05rem 0.35rem; }
  .qu-user-pub { font-family: var(--qu-font-mono, ui-monospace, monospace); font-size: 0.8em; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qu-user-list button { background: none; border: none; cursor: pointer; font-size: 1.1em; flex-shrink: 0; }
`;

/**
 * Wraps `qu` so `<qu-list parent="/store/directory/entries">` only ever
 * sees entries actually self-signed by the actor whose path they live at
 * (the same check `DirectoryService.listVisible()` does internally), and
 * excludes `selfPub`'s own entry - you can't "contact" yourself.
 */
function createVerifiedDirectoryQu(qu, selfPub) {
  return {
    get: (path) => qu.get(path),
    put: (path, value) => qu.put(path, value),
    async getChildren(parentPath, options) {
      const entries = await qu.getChildren(parentPath, options);
      return entries.filter((e) => {
        const claimedId = e.path.slice(e.path.lastIndexOf('/') + 1);
        if (claimedId === selfPub) return false;
        const pub = e.quBit?.pub;
        const signer = pub ? QuCrypto.toBase64Url(QuCrypto.fromBase64(pub)) : null;
        return signer === claimedId;
      });
    },
    onStorageChange: (handler) => qu.onStorageChange(handler),
  };
}

export function mount(container, { qu, services, subscribe, syncFetch }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;

  // Same "set on an ancestor before descendant Custom Elements connect"
  // discipline `.qu` already requires elsewhere in `@qu/ui` -
  // `renderAvatarOrAsset()` below resolves this via `<qu-asset>`'s own
  // `findAssetService()` ancestor walk, for any actor who uploaded a real
  // image avatar (see @qu/ui/avatar.js's own doc comment).
  container.assetService = services.assets;

  // Defense in depth - a future shell would already subscribe to
  // '/store/directory' by default, but this app shouldn't silently depend
  // on that staying true.
  subscribe?.('/store/directory');

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'qu-user-search';
  search.placeholder = t('searchPlaceholder');

  const listRoot = document.createElement('div');
  const unlistedRoot = document.createElement('div');
  container.append(heading, search, listRoot, unlistedRoot);

  let debounceTimer = null;
  search.addEventListener('input', () => {
    applyFilter(search.value);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => resolveUnlisted(search.value), 300);
  });

  function applyFilter(query) {
    const q = query.trim().toLowerCase();
    for (const li of listRoot.querySelectorAll('li')) {
      li.hidden = q.length > 0 && !li.textContent.toLowerCase().includes(q);
    }
  }

  let unlistedToken = 0;
  async function resolveUnlisted(query) {
    const token = ++unlistedToken;
    const trimmed = query.trim();
    unlistedRoot.textContent = '';
    if (trimmed.length !== FP_LENGTH) return;
    if (listRoot.querySelector(`[data-pub="${trimmed}"]`)) return; // already a visible row

    const profile = await services.profile.getPublicProfile(trimmed);
    if (stopped || token !== unlistedToken || !profile) return;

    const alias = formatActorLabel(trimmed, profile);
    const li = document.createElement('li');
    li.className = 'qu-user-unlisted';
    li.appendChild(renderAvatarOrAsset(trimmed, alias, profile.avatar, { size: '2.2rem' }));

    const info = document.createElement('a');
    info.className = 'qu-user-info';
    info.href = `#/~${trimmed}`;
    const aliasRow = document.createElement('span');
    aliasRow.className = 'qu-user-alias-row';
    const aliasEl = document.createElement('span');
    aliasEl.className = 'qu-user-alias';
    aliasEl.textContent = alias;
    const badge = document.createElement('span');
    badge.className = 'qu-user-badge';
    badge.textContent = t('unlisted');
    aliasRow.append(aliasEl, badge);
    const pubEl = document.createElement('span');
    pubEl.className = 'qu-user-pub';
    pubEl.textContent = trimmed;
    info.append(aliasRow, pubEl);
    li.appendChild(info);

    li.appendChild(renderFlagToggle({
      flags: {
        hasPrivate: () => services.contacts.isContact(trimmed),
        setPrivate: (_ft, _ek, _er, on) => (on ? services.contacts.addContact(trimmed) : services.contacts.removeContact(trimmed)),
      },
      flagType: 'favorite', entityKind: 'user', entityRef: trimmed,
      icon: '☆', activeIcon: '★', title: t('contactAdd'), activeTitle: t('contactRemove'),
    }));

    unlistedRoot.appendChild(li);
  }

  (async () => {
    const myPub = await services.actors.whoAmI();
    if (stopped) return;

    listRoot.qu = createVerifiedDirectoryQu(qu, myPub);
    // Backfills directory entries written before this session connected
    // (see <qu-list>'s own `.syncFetch` doc comment) - subscribe() above
    // only ever delivers FUTURE writes.
    if (syncFetch) listRoot.syncFetch = syncFetch;
    listRoot.innerHTML = `
      <qu-list class="qu-user-list" parent="${paths.directoryEntriesParentPath()}">
        <template>
          <li>
            <span class="qu-user-avatar-slot"></span>
            <a class="qu-user-info">
              <span class="qu-user-alias-row"><span class="qu-user-alias"></span></span>
              <span class="qu-user-pub"></span>
            </a>
            <span class="qu-user-fav-slot"></span>
          </li>
        </template>
      </qu-list>`;

    const list = listRoot.querySelector('qu-list');
    list.onItemStamped = (els, pub) => {
      const li = els[0];
      li.dataset.pub = pub;
      li.querySelector('.qu-user-info').href = `#/~${pub}`;
      li.querySelector('.qu-user-pub').textContent = pub;

      (async () => {
        const profile = await services.profile.getPublicProfile(pub);
        if (stopped) return;
        li.querySelector('.qu-user-avatar-slot').replaceChildren(renderAvatarOrAsset(pub, formatActorLabel(pub, profile), profile?.avatar, { size: '2.2rem' }));
        li.querySelector('.qu-user-alias').textContent = formatActorLabel(pub, profile);
        applyFilter(search.value); // a freshly resolved alias might newly match (or no longer match) the current search
      })();

      const slot = li.querySelector('.qu-user-fav-slot');
      const toggle = renderFlagToggle({
        flags: {
          hasPrivate: () => services.contacts.isContact(pub),
          setPrivate: (_ft, _ek, _er, on) => (on ? services.contacts.addContact(pub) : services.contacts.removeContact(pub)),
        },
        flagType: 'favorite', entityKind: 'user', entityRef: pub,
        icon: '☆', activeIcon: '★', title: t('contactAdd'), activeTitle: t('contactRemove'),
      });
      slot.replaceWith(toggle);
    };
  })();

  return () => {
    stopped = true;
    clearTimeout(debounceTimer);
  };
}
