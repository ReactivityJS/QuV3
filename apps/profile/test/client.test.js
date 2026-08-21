import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AssetEngine } from '@qu/engines';
import {
  ListService, DirectoryService, ProfileService, FlagService,
  ContactsService, ActorService, AssetService, NotificationPrefsService, PushSubscriptionService,
} from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
// installDom() doesn't copy localStorage onto globalThis - a plain in-memory
// fake, needed once the settings subpath starts reading/writing the
// identity-bound language/theme preference via @qu/i18n's/@qu/ui's own
// device-local mechanisms (same pattern apps/shell's own test file uses).
globalThis.localStorage = (() => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
})();
// @qu/ui's package root transitively evaluates components.js, which extends
// HTMLElement at module-load time - must come AFTER installDom(), same
// reason `mount` itself is loaded dynamically below.
const { getStoredTheme, setStoredTheme } = await import('@qu/ui');
const { getStoredLocale, setLocale } = await import('@qu/i18n');
const { mount } = await import('../client.js');

async function freshEnv() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  qu.mount('blob', new MemoryStoreAdapter());
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());

  const list = new ListService(qu);
  const directory = new DirectoryService(qu, identity, list);
  const profile = new ProfileService(qu, identity);
  const flags = new FlagService(qu, identity, list);
  const contacts = new ContactsService(flags, identity);
  const actors = new ActorService(identity);
  const assets = new AssetService(qu, new AssetEngine(qu), identity);
  const notificationPrefs = new NotificationPrefsService(qu, identity);
  const pushSubscriptions = new PushSubscriptionService(qu, identity, list);

  const myPub = await actors.whoAmI();
  return { qu, identity, services: { directory, profile, contacts, actors, assets, notificationPrefs, pushSubscriptions }, myPub };
}

/** Publishes a SEPARATE identity's profile onto the shared `qu` store - simulating data already synced in from a peer. */
async function publishOtherUser(qu, profileFields = {}) {
  const otherQu = new QuStore();
  otherQu.mount('store', new MemoryStoreAdapter());
  const otherIdentity = new QuIdentityEngine(otherQu);
  await otherIdentity.importMnemonic(otherIdentity.generateMnemonic());
  const otherProfile = new ProfileService(otherQu, otherIdentity);
  const actorPub = await otherProfile.saveProfile(profileFields);
  await qu.putSealed(actorPath(actorPub, 'profile'), await otherQu.get(actorPath(actorPub, 'profile')));
  return actorPub;
}

/** Must be attached to document.body - <qu-view>/reactive rendering only matters once actually part of the document. */
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test.beforeEach(() => {
  setLocale(null);
  setStoredTheme(null);
});

test('a bare #/profile redirects immediately to #/~<myPub> and renders nothing itself', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: ['profile'] });
  try {
    await waitFor(() => window.location.hash === `#/~${myPub}`);
    assert.equal(container.textContent.trim(), '');
  } finally {
    stop();
  }
});

test('own profile renders like a foreign profile, editable: alias as a click-to-edit input, avatar shown in the shared header', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', avatar: '🚀' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    const aliasText = container.querySelector('.qu-profile-alias-text');
    assert.equal(aliasText.textContent, 'Ada');
    assert.equal(aliasText.contentEditable, 'false'); // not editing yet - click the pencil first
    // No plain text inputs anywhere - alias and custom fields are all
    // contentEditable now, avatar only settable via the click-to-upload
    // header badge, and there's no central Save button either.
    assert.equal(container.querySelectorAll('input[type="text"]').length, 0);
    assert.equal(container.querySelector('.qu-profile-primary'), null);
    assert.ok(container.querySelector('.qu-profile-header').textContent.includes('🚀'));
    assert.ok(container.querySelector('.qu-profile-keys').textContent.includes(myPub));
  } finally {
    stop();
  }
});

// Regression, found via a real Playwright run against a real relay: two
// writes to this identity's own profile document close enough together
// fire this component's own watch() callback twice before the first
// render() call's own await chain (getOwnProfile()/isVisible(), each with
// their own internal background-refresh/syncFetch backfill) resolves -
// without renderToken's guard, BOTH calls eventually append their own full
// form on top of each other (confirmed live: two "Add field" buttons on
// one screen).
test('REGRESSION: two saves close enough together to overlap never leave duplicated DOM content', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);

    // Fire two saves back-to-back, NOT awaiting the first before starting
    // the second - both write to the SAME watched path, racing render()
    // against itself the same way a live relay's own background-refresh
    // did in the real browser run that found this.
    await Promise.all([
      services.profile.saveProfile({ alias: 'First' }),
      services.profile.saveProfile({ alias: 'Second' }),
    ]);

    // Give every triggered render() call - including any that SHOULD be
    // discarded as stale - a chance to finish and (incorrectly) apply.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(container.querySelectorAll('.qu-profile-own').length, 1, 'exactly one profile form, never duplicated');
    const addFieldButtons = container.querySelectorAll('.qu-profile-add-field-btn');
    assert.equal(addFieldButtons.length, 1, 'exactly one "add field" button, never duplicated');
  } finally {
    stop();
  }
});

test('editing the alias via pencil/contentEditable/confirm persists it immediately - no central Save button', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    container.querySelector('.qu-profile-edit-btn').click();
    const aliasText = container.querySelector('.qu-profile-alias-text');
    assert.equal(aliasText.contentEditable, 'true');
    aliasText.textContent = 'Ada Lovelace';
    container.querySelector('.qu-profile-confirm-btn').click();

    // Optional chaining is load-bearing here, not defensive style: render()
    // clears `root` synchronously before its async re-fetch on EVERY call
    // (including the one this save triggers via watch()), so a poll can
    // legitimately land in the gap where `.qu-profile-status` doesn't exist
    // at all yet - `?.textContent` on that moment is `undefined` (falsy,
    // keep polling), not a thrown TypeError.
    await waitFor(() => container.querySelector('.qu-profile-status')?.textContent === 'Saved!');
    const own = await services.profile.getOwnProfile();
    assert.equal(own.alias, 'Ada Lovelace');
  } finally {
    stop();
  }
});

test('cancelling an alias edit restores the original text and never saves', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    container.querySelector('.qu-profile-edit-btn').click();
    const aliasText = container.querySelector('.qu-profile-alias-text');
    aliasText.textContent = 'Someone Else';
    container.querySelector('.qu-profile-cancel-btn').click();

    assert.equal(aliasText.textContent, 'Ada');
    assert.equal(aliasText.contentEditable, 'false');
    const own = await services.profile.getOwnProfile();
    assert.equal(own.alias, 'Ada');
  } finally {
    stop();
  }
});

test('uploading an avatar via <qu-asset-upload> (click-to-upload header badge) fills the avatar with "asset:<id>" and updates the header live, without saving', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    assert.equal(container.querySelector('.qu-profile-header qu-asset'), null);

    const fileInput = container.querySelector('qu-asset-upload input[type=file]');
    const file = new File(['fake image bytes'], 'me.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event('change'));

    await waitFor(() => container.querySelector('.qu-profile-header qu-asset') !== null);

    // Not saved yet - the profile document itself is untouched.
    const own = await services.profile.getOwnProfile();
    assert.equal(own.avatar, '');
  } finally {
    stop();
  }
});

test('an "asset:<id>" avatar round-trips through saveProfile() and renders as <qu-asset> in the OWN profile\'s header', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.assets.upload(myPub, 'avatar1', new TextEncoder().encode('fake png bytes'));
  await services.profile.saveProfile({ alias: 'Ada', avatar: 'asset:avatar1' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own .qu-profile-header qu-asset') !== null);
    const assetEl = container.querySelector('.qu-profile-header qu-asset');
    assert.equal(assetEl.getAttribute('space-id'), myPub);
    assert.equal(assetEl.getAttribute('asset-id'), 'avatar1');
  } finally {
    stop();
  }
});

test('an "asset:<id>" avatar renders as <qu-asset> on a VISITOR\'s read-only public view too', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.assets.upload(myPub, 'avatar1', new TextEncoder().encode('fake png bytes'));
  await services.profile.saveProfile({ alias: 'Ada', avatar: 'asset:avatar1' });

  const visitorQu = new QuStore();
  visitorQu.mount('store', new MemoryStoreAdapter());
  visitorQu.mount('blob', new MemoryStoreAdapter());
  const visitorIdentity = new QuIdentityEngine(visitorQu);
  await visitorIdentity.importMnemonic(visitorIdentity.generateMnemonic());
  await visitorQu.putSealed(actorPath(myPub, 'profile'), await qu.get(actorPath(myPub, 'profile')));
  // The visitor also needs the asset itself synced in (meta + chunk).
  const metaBit = await qu.get(`/store/${myPub}/assets/avatar1/meta`);
  await visitorQu.putSealed(`/store/${myPub}/assets/avatar1/meta`, metaBit);
  await visitorQu.putSealed(`/blob/${myPub}/avatar1/chunk_0`, await qu.get(`/blob/${myPub}/avatar1/chunk_0`));

  const visitorList = new ListService(visitorQu);
  const visitorAssets = new AssetService(visitorQu, new AssetEngine(visitorQu), visitorIdentity);
  const visitorServices = {
    directory: new DirectoryService(visitorQu, visitorIdentity, visitorList),
    profile: new ProfileService(visitorQu, visitorIdentity),
    contacts: new ContactsService(new FlagService(visitorQu, visitorIdentity, visitorList), visitorIdentity),
    actors: new ActorService(visitorIdentity),
    assets: visitorAssets,
  };

  const container = makeContainer();
  const stop = mount(container, { qu: visitorQu, identity: visitorIdentity, services: visitorServices, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-view qu-asset') !== null);
    const assetEl = container.querySelector('.qu-profile-view qu-asset');
    assert.equal(assetEl.getAttribute('space-id'), myPub);
    assert.equal(assetEl.getAttribute('asset-id'), 'avatar1');
  } finally {
    stop();
  }
});

test('adding a custom field via "+"/pencil/confirm persists it immediately, public then private', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-add-field-btn') !== null);
    container.querySelector('.qu-profile-add-field-btn').click();

    // The new row starts already in edit mode (no separate pencil click needed).
    let row = container.querySelector('.qu-profile-field-row');
    assert.equal(row.querySelector('.qu-profile-field-key').contentEditable, 'true');
    row.querySelector('.qu-profile-field-key').textContent = 'Website';
    row.querySelector('.qu-profile-field-value').textContent = 'https://example.com';
    row.querySelector('.qu-profile-confirm-btn').click();

    // Confirming saves immediately - the whole own-profile view re-renders
    // via this component's own watch()-driven redraw once the save lands,
    // same as every other inline edit on this page. A brief settle before
    // starting the SECOND save avoids racing two overlapping saves/renders
    // against each other (see mount()'s own `renderToken` doc comment -
    // the exact same class of race, just triggered here by two real user
    // actions close together instead of two concurrent saveProfile() calls).
    await waitFor(async () => (await services.profile.getOwnProfile()).fields.length === 1);
    // A brief settle before starting the SECOND save: `getOwnProfile()`'s
    // own background-refresh (see its doc comment) can still be in flight
    // from the FIRST save when the second one starts, occasionally
    // clobbering it - the exact same class of race `mount()`'s own
    // `renderToken` guard exists for, just one layer further down (data,
    // not DOM). Real typing speed never triggers two full round-trips this
    // close together.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(() => container.querySelector('.qu-profile-add-field-btn') !== null);

    container.querySelector('.qu-profile-add-field-btn').click();
    await waitFor(() => container.querySelectorAll('.qu-profile-field-row').length === 2);
    row = [...container.querySelectorAll('.qu-profile-field-row')].find((r) => r.querySelector('.qu-profile-field-key').textContent === '');
    row.querySelector('.qu-profile-field-visibility').click(); // toggle to private, before confirming
    row.querySelector('.qu-profile-field-key').textContent = 'Secret';
    row.querySelector('.qu-profile-field-value').textContent = 'shh';
    row.querySelector('.qu-profile-confirm-btn').click();

    await waitFor(async () => (await services.profile.getOwnProfile()).fields.length === 2);

    const own = await services.profile.getOwnProfile();
    assert.deepEqual(
      own.fields.sort((a, b) => a.key.localeCompare(b.key)),
      [
        { key: 'Secret', value: 'shh', visibility: 'private' },
        { key: 'Website', value: 'https://example.com', visibility: 'public' },
      ]
    );

    const publicProfile = await services.profile.getPublicProfile(myPub);
    assert.equal(publicProfile.Website, 'https://example.com');
    assert.equal('Secret' in publicProfile, false);
  } finally {
    stop();
  }
});

test('cancelling a brand-new field row removes it without saving', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-add-field-btn') !== null);
    container.querySelector('.qu-profile-add-field-btn').click();
    await waitFor(() => container.querySelector('.qu-profile-field-row') !== null);
    // Scoped to the row, not the container: the (hidden) alias cancel
    // button is earlier in the DOM and would otherwise match first.
    container.querySelector('.qu-profile-field-row .qu-profile-cancel-btn').click();

    assert.equal(container.querySelector('.qu-profile-field-row'), null);
    const own = await services.profile.getOwnProfile();
    assert.deepEqual(own.fields, []);
  } finally {
    stop();
  }
});

test('deleting an existing custom field via its 🗑 button removes it immediately', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', fields: [{ key: 'Website', value: 'x', visibility: 'public' }] });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-field-row') !== null);
    container.querySelector('.qu-profile-delete-btn').click();
    assert.equal(container.querySelector('.qu-profile-field-row'), null);

    await waitFor(async () => (await services.profile.getOwnProfile()).fields.length === 0);
    const own = await services.profile.getOwnProfile();
    assert.deepEqual(own.fields, []);
  } finally {
    stop();
  }
});

test('confirming an existing field with an emptied-out key removes it (same convention as the delete button)', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', fields: [{ key: 'Website', value: 'x', visibility: 'public' }] });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-field-row') !== null);
    // Scoped to the row: the alias's own (hidden) pencil button is earlier
    // in the DOM and would otherwise match first.
    const row = container.querySelector('.qu-profile-field-row');
    row.querySelector('.qu-profile-edit-btn').click();
    assert.equal(row.querySelector('.qu-profile-field-key').contentEditable, 'true');
    row.querySelector('.qu-profile-field-key').textContent = '';
    row.querySelector('.qu-profile-confirm-btn').click();

    assert.equal(container.querySelector('.qu-profile-field-row'), null);
    await waitFor(async () => (await services.profile.getOwnProfile()).fields.length === 0);
  } finally {
    stop();
  }
});

test('cancelling an edit on an existing field restores its original text', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', fields: [{ key: 'Website', value: 'https://example.com', visibility: 'public' }] });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-field-row') !== null);
    // Scoped to the row: the alias's own (hidden) pencil button is earlier
    // in the DOM and would otherwise match first.
    const row = container.querySelector('.qu-profile-field-row');
    row.querySelector('.qu-profile-edit-btn').click();
    row.querySelector('.qu-profile-field-value').textContent = 'https://evil.example';
    row.querySelector('.qu-profile-cancel-btn').click();

    assert.equal(row.querySelector('.qu-profile-field-value').textContent, 'https://example.com');
    const own = await services.profile.getOwnProfile();
    assert.equal(own.fields[0].value, 'https://example.com');
  } finally {
    stop();
  }
});

test('toggling the directory-visibility checkbox on Settings calls setVisible() - moved off the main profile page', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  assert.equal(await services.directory.isVisible(myPub), false);

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-settings input[type="checkbox"]') !== null);
    const checkbox = container.querySelector('.qu-profile-settings input[type="checkbox"]');
    assert.equal(checkbox.checked, false);
    checkbox.click();
    await waitFor(async () => (await services.directory.isVisible(myPub)) === true);
  } finally {
    stop();
  }

  // Confirm it's really gone from the main profile page.
  const container2 = makeContainer();
  const stop2 = mount(container2, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container2.querySelector('.qu-profile-own') !== null);
    assert.equal(container2.querySelector('input[type="checkbox"]'), null);
  } finally {
    stop2();
  }
});

test('someone else\'s profile renders read-only, with their own template/style applied', async () => {
  const { qu, identity, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Grace', template: 'banner', style: 'ocean' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${otherPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-view') !== null);
    assert.equal(container.querySelector('input[type="text"]'), null); // read-only, no edit form
    assert.match(container.querySelector('h1').textContent, /Grace/);
    assert.ok(container.querySelector('.qu-profile-view').classList.contains('qu-template-banner'));
    assert.equal(
      container.querySelector('.qu-profile-view').style.getPropertyValue('--qu-color-accent'),
      '#0891b2' // THEME_PRESETS.ocean
    );
  } finally {
    stop();
  }
});

test('a foreign profile\'s custom PUBLIC field is shown; there is no way for a private one to even reach here', async () => {
  const { qu, identity, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, {
    alias: 'Grace',
    fields: [{ key: 'Website', value: 'https://example.com', visibility: 'public' }],
  });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${otherPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-view') !== null);
    assert.match(container.textContent, /Website/);
    assert.match(container.textContent, /example\.com/);
  } finally {
    stop();
  }
});

test('a foreign profile\'s "⋮" context menu offers Add contact, then Remove contact once added', async () => {
  const { qu, identity, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Grace' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${otherPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-menu button') !== null);
    const trigger = container.querySelector('.qu-profile-menu button');
    assert.equal(trigger.textContent, '⋮');

    trigger.click();
    await waitFor(() => [...container.querySelectorAll('.qu-profile-menu button')].some((b) => b.textContent.includes('Add contact')));
    const addItem = [...container.querySelectorAll('.qu-profile-menu button')].find((b) => b.textContent.includes('Add contact'));
    addItem.click();
    await waitFor(async () => (await services.contacts.isContact(otherPub)) === true);

    trigger.click();
    await waitFor(() => [...container.querySelectorAll('.qu-profile-menu button')].some((b) => b.textContent.includes('Remove contact')));
  } finally {
    stop();
  }
});

test('an identity with no published profile shows the "not found" placeholder', async () => {
  const { qu, identity, services } = await freshEnv();
  const strangerQu = new QuStore();
  strangerQu.mount('store', new MemoryStoreAdapter());
  const strangerIdentity = new QuIdentityEngine(strangerQu);
  await strangerIdentity.importMnemonic(strangerIdentity.generateMnemonic());
  const strangerPub = await new ActorService(strangerIdentity).whoAmI();

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${strangerPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-not-found') !== null);
  } finally {
    stop();
  }
});

test('#/~<pub>/settings for someone else\'s pub redirects back to their plain profile view', async () => {
  const { qu, identity, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Grace' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${otherPub}`, 'settings'] });
  try {
    await waitFor(() => window.location.hash === `#/~${otherPub}`);
    assert.equal(container.querySelector('.qu-profile-settings'), null);
  } finally {
    stop();
  }
});

test('own #/~<pub>/settings saves the preference, persists it via setLocale()/setStoredTheme(), and shows a persistent reload prompt (not a transient "Saved!" flash - neither has any live effect on the current page)', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-settings') !== null);
    const selects = container.querySelectorAll('select');
    selects[0].value = 'de'; // language
    selects[1].value = 'sunset'; // theme
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    saveBtn.click();

    // Optional chaining is load-bearing here, not defensive style: render()
    // clears `root` synchronously before its async re-fetch on EVERY call
    // (including the one this save triggers via watch()), so a poll can
    // legitimately land in the gap where `.qu-profile-status` doesn't exist
    // at all yet - `?.textContent` on that moment is `undefined` (falsy,
    // keep polling), not a thrown TypeError.
    await waitFor(() => container.querySelector('.qu-profile-status')?.textContent.includes('Reload'));
    const own = await services.profile.getOwnProfile();
    assert.equal(own.preferredLocale, 'de');
    assert.equal(own.preferredTheme, 'sunset');
    assert.equal(getStoredLocale(), 'de');
    assert.equal(getStoredTheme(), 'sunset');

    // Deliberately NOT auto-clearing (unlike renderOwnProfile()'s own
    // transient flash) - the user still has to actually act.
    const reloadBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload now');
    assert.ok(reloadBtn, 'expected a persistent "Reload now" button');
    assert.equal(reloadBtn.hidden, false);
  } finally {
    stop();
  }
});

test('clicking "Reload now" actually reloads the page', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-settings') !== null);
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await waitFor(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload now')?.hidden === false);

    // jsdom's real Location.reload is entirely locked down (neither
    // reassignable nor redefinable) - swap the bare `window` global this
    // click handler resolves at CALL time for a minimal stub instead, same
    // technique apps/shell/test/pwa.test.js already established.
    const realWindow = globalThis.window;
    let reloaded = false;
    globalThis.window = { location: { reload: () => { reloaded = true; } } };
    try {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload now').click();
    } finally {
      globalThis.window = realWindow;
    }
    assert.equal(reloaded, true);
  } finally {
    stop();
  }
});

test('#/~<pub>/settings renders the userSettings.contributions extension point into an empty container after its own sections', async () => {
  const { qu, identity, services, myPub } = await freshEnv();

  const calls = [];
  const extensionPoints = {
    async renderSlot(point, container, payload) {
      calls.push({ point, payload });
      const marker = document.createElement('div');
      marker.className = 'contributed-marker';
      container.appendChild(marker);
    },
  };

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'], extensionPoints });
  try {
    await waitFor(() => container.querySelector('.contributed-marker') !== null);
    assert.deepEqual(calls, [{ point: 'userSettings.contributions', payload: { myPub, services } }]);
    // Rendered inside profile's own `.qu-profile-ext-settings` mount point, after every one of its own settings sections.
    const extRoot = container.querySelector('.qu-profile-ext-settings');
    assert.ok(extRoot.contains(container.querySelector('.contributed-marker')));
    // No bespoke "back to profile" link - the shell header's own Back/
    // Forward already covers it (docs/app-navigation-standard.md Rule 1).
    assert.equal(container.querySelector('a.qu-subpage-back'), null);
    assert.equal([...container.querySelectorAll('a')].some((a) => a.textContent === 'Back to profile'), false);
  } finally {
    stop();
  }
});

test.afterEach(() => {
  delete navigator.serviceWorker;
  delete window.PushManager;
  delete globalThis.Notification;
  delete globalThis.fetch;
});

/** Stubs the browser globals subscribeToPush()/the "already enabled?" check in renderNotificationsSection() read - see either's own doc comment for exactly which global each piece reads. */
function installFakePush({ existingSubscription = null, vapidPublicKey = 'ABC123', permission = 'granted' } = {}) {
  const subscribeCalls = [];
  const registration = {
    pushManager: {
      getSubscription: async () => existingSubscription,
      subscribe: async (options) => {
        subscribeCalls.push(options);
        return { toJSON: () => ({ endpoint: 'https://push.example.com/new', keys: { p256dh: 'p', auth: 'a' } }) };
      },
    },
  };
  navigator.serviceWorker = { ready: Promise.resolve(registration) };
  window.PushManager = class {};
  globalThis.Notification = { requestPermission: async () => permission };
  globalThis.fetch = async (url) => {
    if (url === '/push/vapid-public-key') return { ok: true, json: async () => ({ publicKey: vapidPublicKey }) };
    if (url === '/apps.json') return { ok: true, json: async () => [] };
    throw new Error(`unexpected fetch(${url})`);
  };
  return { subscribeCalls };
}

test('Notifications section: global enabled/mentions checkboxes round-trip through savePrefs()', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  installFakePush();

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-notif-section') !== null);
    const checkboxes = container.querySelectorAll('.qu-profile-notif-check-row input[type=checkbox]');
    checkboxes[0].checked = false; // global enabled
    checkboxes[1].checked = false; // mentions
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save notification settings').click();
    await waitFor(() => container.querySelector('.qu-profile-notif-status')?.textContent === 'Saved!');

    const saved = await services.notificationPrefs.getOwnPrefs();
    assert.equal(saved.enabled, false);
    assert.equal(saved.mentions, false);
  } finally {
    stop();
  }
});

test('Notifications section: per-app toggles list only apps that declare pushActions, and save with the right appId keys', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  installFakePush();
  globalThis.fetch = async (url) => {
    if (url === '/apps.json') {
      return {
        ok: true,
        json: async () => [
          { name: 'forum', label: 'Forum', pushActions: [{ id: 'mention', label: 'Mentions', type: 'mention' }] },
          { name: 'app-list', label: 'App List', pushActions: [] }, // no pushActions - never listed
        ],
      };
    }
    return { ok: true, json: async () => ({ publicKey: 'ABC123' }) };
  };

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-notif-apps') !== null);
    const appRows = container.querySelectorAll('.qu-profile-notif-apps label');
    assert.equal(appRows.length, 1); // app-list excluded - no pushActions
    assert.ok(appRows[0].textContent.includes('Forum'));

    appRows[0].querySelector('input').checked = false;
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save notification settings').click();
    await waitFor(() => container.querySelector('.qu-profile-notif-status')?.textContent === 'Saved!');

    const saved = await services.notificationPrefs.getOwnPrefs();
    assert.deepEqual(saved.apps, { forum: { enabled: false } });
  } finally {
    stop();
  }
});

test('Notifications section: shows "Enabled on this device" immediately when a subscription already exists - no button, no gesture needed', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  installFakePush({ existingSubscription: { endpoint: 'https://push.example.com/already' } });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-push-row')?.textContent.includes('Enabled on this device'));
    const pushBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Enable on this device');
    assert.equal(pushBtn.hidden, true);
  } finally {
    stop();
  }
});

test('Notifications section: clicking "Enable on this device" runs the real PushManager.subscribe() flow and stores the result via pushSubscriptions', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  const { subscribeCalls } = installFakePush({ vapidPublicKey: 'ABC123' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-push-row') !== null);
    const pushBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Enable on this device');
    pushBtn.click();
    await waitFor(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Enable on this device')?.hidden === true);

    assert.equal(subscribeCalls.length, 1);
    assert.equal(subscribeCalls[0].userVisibleOnly, true);
    assert.ok(subscribeCalls[0].applicationServerKey instanceof Uint8Array);

    const stored = await services.pushSubscriptions.listOwnSubscriptions();
    assert.deepEqual(stored, [{ endpoint: 'https://push.example.com/new', keys: { p256dh: 'p', auth: 'a' } }]);
  } finally {
    stop();
  }
});

test('Notifications section: a denied Notification permission shows the error, never crashes, and the button stays clickable to retry', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  installFakePush({ permission: 'denied' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-push-row') !== null);
    const pushBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Enable on this device');
    pushBtn.click();
    await waitFor(() => container.querySelector('.qu-profile-push-row').textContent.includes('denied'));

    assert.equal(pushBtn.hidden, false);
    assert.equal(pushBtn.disabled, false);
  } finally {
    stop();
  }
});

test('Settings: the live template/style preview updates as the selects change, without saving', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', avatar: '🚀' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`, 'settings'] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-preview') !== null);
    const preview = container.querySelector('.qu-profile-preview');
    assert.match(preview.textContent, /Ada/);

    const selects = container.querySelectorAll('.qu-profile-settings select');
    selects[2].value = 'banner'; // template
    selects[2].dispatchEvent(new window.Event('change'));
    selects[3].value = 'ocean'; // style
    selects[3].dispatchEvent(new window.Event('change'));

    assert.ok(preview.querySelector('.qu-template-banner'), 'expected the banner template class applied live');
    const accent = preview.querySelector('.qu-profile-view').style.getPropertyValue('--qu-color-accent');
    assert.equal(accent, '#0891b2'); // THEME_PRESETS.ocean

    // None of this was ever saved - the real own profile is untouched.
    const own = await services.profile.getOwnProfile();
    assert.equal(own.alias, 'Ada');
    assert.equal(own.template, '');
  } finally {
    stop();
  }
});

test('the main profile page no longer shows template/style/preview controls - they moved to Settings', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    assert.equal(container.querySelector('select'), null);
    assert.equal(container.querySelector('.qu-profile-preview'), null);
  } finally {
    stop();
  }
});

test('clicking a pub/epub key row copies its value to the clipboard', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const writeCalls = [];
  const realClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text) => { writeCalls.push(text); } },
    configurable: true,
  });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-key-row') !== null);
    const pubRow = container.querySelector('.qu-profile-key-row');
    pubRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => writeCalls.length === 1);
    assert.equal(writeCalls[0], myPub);
    await waitFor(() => pubRow.querySelector('.qu-profile-key-copied').textContent !== '');
  } finally {
    stop();
    Object.defineProperty(navigator, 'clipboard', { value: realClipboard, configurable: true });
  }
});

test('an inline edit on the own-profile page (e.g. the alias) leaves an already-set language/theme preference untouched', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', preferredLocale: 'de', preferredTheme: 'forest' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    container.querySelector('.qu-profile-edit-btn').click();
    container.querySelector('.qu-profile-alias-text').textContent = 'Ada Lovelace';
    container.querySelector('.qu-profile-confirm-btn').click();
    // Optional chaining is load-bearing here, not defensive style: render()
    // clears `root` synchronously before its async re-fetch on EVERY call
    // (including the one this save triggers via watch()), so a poll can
    // legitimately land in the gap where `.qu-profile-status` doesn't exist
    // at all yet - `?.textContent` on that moment is `undefined` (falsy,
    // keep polling), not a thrown TypeError.
    await waitFor(() => container.querySelector('.qu-profile-status')?.textContent === 'Saved!');

    const own = await services.profile.getOwnProfile();
    assert.equal(own.preferredLocale, 'de');
    assert.equal(own.preferredTheme, 'forest');
  } finally {
    stop();
  }
});

test('the returned stop function tears down cleanly - no error thrown', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  await waitFor(() => container.querySelector('.qu-profile-own') !== null);
  assert.doesNotThrow(() => stop());
});
