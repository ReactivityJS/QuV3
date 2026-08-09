/**
 * AVATAR — one shared renderer for a profile's `avatar` field (an
 * emoji/short string, an `https://` image URL, or unset) used everywhere an
 * identity shows up: a shell header, Profile, User List, Contact List,
 * Chat. An image URL always renders as an actual `<img>` (never as raw
 * link/URL text) filling a colored, circular badge sized via `size`; a
 * short string (emoji) renders as text in that same badge; nothing set
 * falls back to the label's first letter. The badge color is derived from
 * `seed` (a pub or group id) so it stays stable across re-renders without
 * needing to persist a color anywhere.
 *
 * Also exports `renderAvatarOrAsset()` (see its own doc comment below) - the
 * SAME rendering, plus a fourth `asset:<assetId>` shape for an uploaded
 * avatar image, over `<qu-asset>` (`./asset-components.js`).
 *
 * Fixed while porting: QuV2's version hand-rolled its own local
 * `ensureStyle()`/`STYLE_ID` pair instead of using `injectStyle()` from
 * `./style.js` - the exact duplicate boilerplate that function exists to
 * replace, left over in the one file that, being in the SAME package,
 * had the least excuse to still have it. No behavior change, just the
 * duplication removed.
 *
 * The badge palette below is deliberately NOT one of `theme.js`'s shared
 * tokens: it's a per-IDENTITY color (derived from `seed`, different for
 * every avatar on screen at once), not a shared UI accent/border color a
 * host would ever want to reskin in one place - a different kind of color
 * than what `ensureTheme()` covers.
 */
import { injectStyle } from './style.js';

const PALETTE = ['#e17076', '#faa774', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae', '#f2c94c'];

const STYLE_ID = 'qu-avatar-style';
const STYLE = `
  .qu-avatar { position: relative; display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: var(--qu-avatar-size, 2rem); height: var(--qu-avatar-size, 2rem); border-radius: 50%; overflow: hidden; color: #fff; font-weight: 600; line-height: 1; user-select: none; font-size: calc(var(--qu-avatar-size, 2rem) * 0.42); }
  .qu-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .qu-avatar-asset qu-asset { display: block; width: 100%; height: 100%; }
  .qu-avatar-asset img, .qu-avatar-asset video { width: 100%; height: 100%; object-fit: cover; display: block; }
`;

function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function initialsOf(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

/**
 * @param {string} seed - Stable identity for badge color (a pub, or a group id).
 * @param {string} label - Display name/alias to derive the letter fallback from.
 * @param {string|null|undefined} avatarValue - Profile `avatar` field: an emoji/short string, an image URL, or unset.
 * @param {{size?: string}} [opts] - Any valid CSS length for the badge's diameter (default `2rem`).
 * @returns {HTMLElement}
 */
export function renderAvatar(seed, label, avatarValue, { size = '2rem' } = {}) {
  injectStyle(STYLE_ID, STYLE);
  const el = document.createElement('div');
  el.className = 'qu-avatar';
  el.style.setProperty('--qu-avatar-size', size);
  el.style.background = colorFor(seed || label || '');
  if (avatarValue && /^https?:\/\//.test(avatarValue)) {
    const img = document.createElement('img');
    img.src = avatarValue;
    img.alt = '';
    el.appendChild(img);
  } else if (avatarValue) {
    el.textContent = avatarValue;
  } else {
    el.textContent = initialsOf(label);
  }
  return el;
}

// Exported (not just used internally) so a WRITER of this shape - currently
// only `apps/profile/client.js`'s own upload handler - can prefix an
// assetId with the exact same string this file's own reader checks for,
// without either side risking drift by re-declaring the literal twice.
export const ASSET_AVATAR_PREFIX = 'asset:';

/**
 * Same as `renderAvatar()`, but also understands the THIRD shape a profile's
 * `avatar` field can hold: `asset:<assetId>`, an uploaded file
 * (`<qu-asset-upload>`/`@qu/services`' `AssetService` - see
 * `apps/profile/client.js`'s own top doc comment for how that gets written).
 * Renders a real `<qu-asset kind="image">` instead of falling through to the
 * URL/emoji/initials badge; any OTHER shape (or unset) falls straight
 * through to `renderAvatar()` unchanged.
 *
 * Originally `apps/profile/client.js`'s own private `renderAvatarOrAsset()`
 * (kept local there on purpose, "a Service-dependent, async rendering path
 * every OTHER caller would then have to support too") - promoted here once
 * `user-list`/`contact-list`/`forum` needed it for real: an actor who
 * uploaded an asset avatar showed correctly on their OWN profile page, but
 * fell back to the plain initials badge everywhere else another app
 * rendered them (search results, message authors, contact rows) - the SAME
 * "hook built, no second caller yet" gap this codebase has closed for
 * `ProfileService`'s `syncFetch`, `DirectoryService.setVisible()`, and
 * others, just for a render helper instead of a data one.
 *
 * Needs an `AssetService` reachable via `findAssetService()`
 * (`./asset-components.js`) on this element or an ancestor - `<qu-asset>`
 * requires that regardless of who creates it, same ".assetService on an
 * ancestor, before children connect" discipline `.qu` already requires
 * everywhere else in this package. `seed` doubles as the asset's
 * `space-id`: avatars are always uploaded under their OWNING identity's own
 * pub (see `AssetService`'s own doc comment on that convention), so `seed`
 * (already a pub at every call site) is exactly right here too.
 *
 * @param {string} seed @param {string} label
 * @param {string|null|undefined} avatarValue
 * @param {{size?: string}} [opts]
 * @returns {HTMLElement}
 */
export function renderAvatarOrAsset(seed, label, avatarValue, { size = '2rem' } = {}) {
  if (avatarValue && avatarValue.startsWith(ASSET_AVATAR_PREFIX)) {
    injectStyle(STYLE_ID, STYLE);
    const wrap = document.createElement('div');
    wrap.className = 'qu-avatar qu-avatar-asset';
    wrap.style.setProperty('--qu-avatar-size', size);
    const assetEl = document.createElement('qu-asset');
    assetEl.setAttribute('space-id', seed);
    assetEl.setAttribute('asset-id', avatarValue.slice(ASSET_AVATAR_PREFIX.length));
    assetEl.setAttribute('kind', 'image');
    wrap.appendChild(assetEl);
    return wrap;
  }
  return renderAvatar(seed, label, avatarValue, { size });
}
