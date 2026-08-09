/**
 * CONTACT LIST — everyone this identity has starred as a contact (see
 * `@qu/services`' `ContactsService`/`FlagService`), the User List app's
 * counterpart - that app ADDS contacts, this one just shows/removes them,
 * each with their CURRENT public profile resolved live (not a snapshot
 * taken at contact-time).
 *
 * Built on `<qu-list parent="...">` (`@qu/ui`) pointed at
 * `createPrivateStore(qu, identity)` (`@qu/services`) instead of the raw
 * `qu` - contacts are a PRIVATE derived list (§4.2's derived-list shape,
 * self-encrypted per entry, see `FlagService`'s own doc comment), and that
 * facade is what lets `watchChildren()`/`<qu-list>` decrypt each entry
 * transparently with zero changes to either. Removing a contact updates
 * this list live, with no manual refresh needed - unlike the previous
 * imperative version, which had to re-fetch the whole list itself after
 * every remove.
 *
 * Each row's action links (Chat, or anything else that plugs in later) are
 * NOT hardcoded here - this app exposes a "contact-row" SLOT, and renders
 * whatever OTHER apps declared for it in their own manifest's `actions`
 * field (see `@qu/foundation`'s `actionsForSlot()`).
 *
 * Avatar/name resolution and the action-slot links stay imperative in
 * `onItemStamped`, same reasoning as `apps/user-list`: a profile document
 * is a signed, wrapped envelope only `services.profile.getPublicProfile()`
 * can safely unwrap, and `renderAvatarOrAsset()` composes a DOM subtree a
 * `<qu-view>` can't mirror. Search is a plain post-render visibility
 * toggle over the rendered rows' own text.
 */
import { createI18n } from '@qu/i18n';
import { formatActorLabel, paths, createPrivateStore } from '@qu/services';
import { actionsForSlot, resolveActionHref } from '@qu/foundation';
import { renderAvatarOrAsset, injectStyle, ensureTheme } from '@qu/ui';
import { QuCrypto } from '@qu/core';

const DICT = {
  en: { title: 'Contacts', searchPlaceholder: 'Search by alias or FP…', remove: 'Remove' },
  de: { title: 'Kontakte', searchPlaceholder: 'Suche nach Alias oder FP…', remove: 'Entfernen' },
};
const { t } = createI18n(DICT);

const STYLE_ID = 'qu-contact-list-style';
const STYLE = `
  .qu-contact-search { width: 100%; box-sizing: border-box; margin: 0 0 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); font: inherit; }
  .qu-contact-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .qu-contact-list li { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.7rem; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-md, 0.4rem); }
  /* Without this, search filtering below (\`li.hidden = ...\`) would have no
     visual effect - a plain author-stylesheet class selector beats the UA's
     own [hidden] rule at equal specificity, so every row would stay
     visible regardless of the search query. */
  .qu-contact-list li[hidden] { display: none; }
  .qu-contact-name { flex: 1; font-family: var(--qu-font-mono, ui-monospace, monospace); text-decoration: none; color: inherit; }
  .qu-contact-name:hover { text-decoration: underline; }
  .qu-contact-list button { background: none; border: 1px solid var(--qu-color-border, #8884); border-radius: var(--qu-radius-sm, 0.3rem); cursor: pointer; padding: 0.2rem 0.5rem; }
  .qu-contact-action { text-decoration: none; font-size: 1.1em; }
`;

const CONTACT_ROW_SLOT = 'contact-row';

export function mount(container, { qu, identity, services, apps, syncFetch }) {
  ensureTheme();
  injectStyle(STYLE_ID, STYLE);
  let stopped = false;
  // Same "set on an ancestor before descendant Custom Elements connect"
  // discipline `.qu` already requires elsewhere in `@qu/ui` -
  // `renderAvatarOrAsset()` below resolves this via `<qu-asset>`'s own
  // `findAssetService()` ancestor walk, for any actor who uploaded a real
  // image avatar (see @qu/ui/avatar.js's own doc comment).
  container.assetService = services.assets;
  const rowActions = actionsForSlot(apps, CONTACT_ROW_SLOT);

  const heading = document.createElement('h1');
  heading.textContent = t('title');

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'qu-contact-search';
  search.placeholder = t('searchPlaceholder');
  search.addEventListener('input', () => applyFilter(search.value));

  const listRoot = document.createElement('div');
  container.append(heading, search, listRoot);

  function applyFilter(query) {
    const q = query.trim().toLowerCase();
    for (const li of listRoot.querySelectorAll('li')) {
      li.hidden = q.length > 0 && !li.textContent.toLowerCase().includes(q);
    }
  }

  (async () => {
    const mainKey = await identity.getMainKey();
    const selfPub = QuCrypto.toBase64Url(mainKey.publicKey);
    if (stopped) return;

    listRoot.qu = createPrivateStore(qu, identity);
    // Backfills contacts added from a DIFFERENT session/device before this
    // one connected (see <qu-list>'s own `.syncFetch` doc comment) -
    // encryption is transparent to sync itself, which only ever replicates
    // raw QuBits; createPrivateStore()'s getChildren() still decrypts them.
    if (syncFetch) listRoot.syncFetch = syncFetch;
    listRoot.innerHTML = `
      <qu-list class="qu-contact-list" parent="${paths.privateFlagParentPath(selfPub, 'favorite', 'user')}">
        <template>
          <li>
            <span class="qu-contact-avatar-slot"></span>
            <a class="qu-contact-name"></a>
            <span class="qu-contact-actions-slot"></span>
            <button type="button" class="qu-contact-remove">${t('remove')}</button>
          </li>
        </template>
      </qu-list>`;

    const list = listRoot.querySelector('qu-list');
    list.onItemStamped = (els, contactPub) => {
      const li = els[0];
      li.querySelector('.qu-contact-name').href = `#/~${contactPub}`;

      (async () => {
        const profile = await services.profile.getPublicProfile(contactPub);
        if (stopped) return;
        const alias = formatActorLabel(contactPub, profile);
        li.querySelector('.qu-contact-avatar-slot').replaceChildren(renderAvatarOrAsset(contactPub, alias, profile?.avatar, { size: '2.2rem' }));
        li.querySelector('.qu-contact-name').textContent = alias;
        applyFilter(search.value);
      })();

      const actionsSlot = li.querySelector('.qu-contact-actions-slot');
      for (const action of rowActions) {
        const link = document.createElement('a');
        link.className = 'qu-contact-action';
        link.href = resolveActionHref(action, { pub: contactPub });
        link.title = action.label;
        link.textContent = action.icon ?? action.label;
        actionsSlot.appendChild(link);
      }

      li.querySelector('.qu-contact-remove').addEventListener('click', () => {
        services.contacts.removeContact(contactPub); // <qu-list> picks up the removal live - no manual refresh needed
      });
    };
  })();

  return () => { stopped = true; };
}
