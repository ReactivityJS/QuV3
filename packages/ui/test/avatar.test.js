import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from '../src/testing.js';

installDom();
// @qu/ui's package root transitively evaluates asset-components.js, which
// registers <qu-asset> at module-load time - must come AFTER installDom(),
// same reason every app's own client.js test dynamically imports rather
// than statically importing at the top of the file.
const { renderAvatar, renderAvatarOrAsset, ASSET_AVATAR_PREFIX } = await import('../src/avatar.js');
await import('../src/asset-components.js'); // registers <qu-asset> - renderAvatarOrAsset()'s asset: path creates one

test('an https:// avatarValue renders as an actual <img>, never as raw text', () => {
  const el = renderAvatar('pub123', 'Ada', 'https://example.com/a.png');
  const img = el.querySelector('img');
  assert.ok(img);
  assert.equal(img.src, 'https://example.com/a.png');
  assert.equal(el.textContent, '');
});

test('a short non-URL avatarValue (emoji) renders as text', () => {
  const el = renderAvatar('pub123', 'Ada', '🚀');
  assert.equal(el.textContent, '🚀');
  assert.equal(el.querySelector('img'), null);
});

test('an unset avatarValue falls back to the label\'s first letter, uppercased', () => {
  const el = renderAvatar('pub123', 'ada', null);
  assert.equal(el.textContent, 'A');
});

test('an unset avatarValue AND label falls back to "?"', () => {
  const el = renderAvatar('', '', null);
  assert.equal(el.textContent, '?');
});

test('the same seed always produces the same badge color (stable across re-renders)', () => {
  const a = renderAvatar('same-seed', 'A', null);
  const b = renderAvatar('same-seed', 'B', null);
  assert.equal(a.style.background, b.style.background);
});

test('size option sets the --qu-avatar-size custom property', () => {
  const el = renderAvatar('pub', 'A', null, { size: '3rem' });
  assert.equal(el.style.getPropertyValue('--qu-avatar-size'), '3rem');
});

test('renderAvatar injects its stylesheet exactly once across multiple calls (uses the shared injectStyle, not a duplicate local copy)', () => {
  document.getElementById('qu-avatar-style')?.remove();
  renderAvatar('a', 'A', null);
  renderAvatar('b', 'B', null);
  assert.equal(document.querySelectorAll('#qu-avatar-style').length, 1);
});

test('renderAvatarOrAsset(): a plain URL/emoji/unset avatarValue behaves exactly like renderAvatar() - no <qu-asset> involved', () => {
  const url = renderAvatarOrAsset('pub123', 'Ada', 'https://example.com/a.png');
  assert.ok(url.querySelector('img'));
  assert.equal(url.querySelector('qu-asset'), null);

  const emoji = renderAvatarOrAsset('pub123', 'Ada', '🚀');
  assert.equal(emoji.textContent, '🚀');

  const unset = renderAvatarOrAsset('pub123', 'ada', null);
  assert.equal(unset.textContent, 'A');
});

test('renderAvatarOrAsset(): an "asset:<id>" avatarValue renders a real <qu-asset kind="image"> - the bug this closes', () => {
  // Regression test: user-list/contact-list/forum used to call the plain
  // renderAvatar() directly, which has no idea what an "asset:" prefix
  // means - it would fall into the truthy-string branch and print the
  // raw "asset:<uuid>" text instead of an avatar. Reported live: an
  // unlisted user found via exact FP/pub search showed no avatar at all,
  // even though the SAME uploaded image rendered correctly on their own
  // profile page (apps/profile/client.js, which always had this asset-
  // aware branch - see this file's own top doc comment).
  const el = renderAvatarOrAsset('pub123', 'Ada', 'asset:abc-123', { size: '2.2rem' });
  const assetEl = el.querySelector('qu-asset');
  assert.ok(assetEl, 'expected a <qu-asset> element, not raw "asset:..." text');
  assert.equal(assetEl.getAttribute('space-id'), 'pub123'); // avatars live under their OWNER's own pub
  assert.equal(assetEl.getAttribute('asset-id'), 'abc-123'); // prefix stripped
  assert.equal(assetEl.getAttribute('kind'), 'image');
  assert.equal(el.textContent, ''); // never the raw "asset:abc-123" string as visible text
});

test('renderAvatarOrAsset(): the "asset:" shape still gets the same circular --qu-avatar-size sizing as every other avatar', () => {
  const el = renderAvatarOrAsset('pub123', 'Ada', 'asset:abc-123', { size: '3rem' });
  assert.equal(el.style.getPropertyValue('--qu-avatar-size'), '3rem');
  assert.ok(el.classList.contains('qu-avatar'));
});

test('ASSET_AVATAR_PREFIX is the exact string apps/profile/client.js\'s own upload handler prefixes a fresh assetId with', () => {
  assert.equal(ASSET_AVATAR_PREFIX, 'asset:');
});
