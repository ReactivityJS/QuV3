import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import {
  ListService, DirectoryService, ProfileService, FlagService,
  ContactsService, ActorService,
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
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());

  const list = new ListService(qu);
  const directory = new DirectoryService(qu, identity, list);
  const profile = new ProfileService(qu, identity);
  const flags = new FlagService(qu, identity, list);
  const contacts = new ContactsService(flags, identity);
  const actors = new ActorService(identity);

  const myPub = await actors.whoAmI();
  return { qu, identity, services: { directory, profile, contacts, actors }, myPub };
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

test('own profile renders an editable form pre-filled with the current alias/avatar', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', avatar: '🚀' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    const inputs = container.querySelectorAll('input[type="text"]');
    assert.equal(inputs[0].value, 'Ada');
    assert.equal(inputs[1].value, '🚀');
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
    const addFieldButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Add field');
    assert.equal(addFieldButtons.length, 1, 'exactly one "Add field" button, never duplicated');
  } finally {
    stop();
  }
});

test('editing and saving the own-profile form persists alias/avatar/template/style', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    const inputs = container.querySelectorAll('input[type="text"]');
    inputs[0].value = 'Ada Lovelace';
    const selects = container.querySelectorAll('select');
    selects[0].value = 'compact'; // template
    selects[1].value = 'ocean'; // style
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    saveBtn.click();

    // Optional chaining is load-bearing here, not defensive style: render()
    // clears `root` synchronously before its async re-fetch on EVERY call
    // (including the one this save triggers via watch()), so a poll can
    // legitimately land in the gap where `.qu-profile-status` doesn't exist
    // at all yet - `?.textContent` on that moment is `undefined` (falsy,
    // keep polling), not a thrown TypeError.
    await waitFor(() => container.querySelector('.qu-profile-status')?.textContent === 'Saved!');
    const own = await services.profile.getOwnProfile();
    assert.equal(own.alias, 'Ada Lovelace');
    assert.equal(own.template, 'compact');
    assert.equal(own.style, 'ocean');
  } finally {
    stop();
  }
});

test('adding a custom field (public and private) round-trips through saveProfile()', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    const addBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Add field');
    addBtn.click();
    addBtn.click();

    const rows = container.querySelectorAll('.qu-profile-field-row');
    assert.equal(rows.length, 2);
    rows[0].qu_key.value = 'Website';
    rows[0].qu_value.value = 'https://example.com';
    rows[0].qu_visibility.value = 'public';
    rows[1].qu_key.value = 'Secret';
    rows[1].qu_value.value = 'shh';
    rows[1].qu_visibility.value = 'private';

    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    saveBtn.click();
    // Optional chaining is load-bearing here, not defensive style: render()
    // clears `root` synchronously before its async re-fetch on EVERY call
    // (including the one this save triggers via watch()), so a poll can
    // legitimately land in the gap where `.qu-profile-status` doesn't exist
    // at all yet - `?.textContent` on that moment is `undefined` (falsy,
    // keep polling), not a thrown TypeError.
    await waitFor(() => container.querySelector('.qu-profile-status')?.textContent === 'Saved!');

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

test('removing a custom field via its "Remove" button drops it on save', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', fields: [{ key: 'Website', value: 'x', visibility: 'public' }] });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-field-row') !== null);
    container.querySelector('.qu-profile-field-row button').click(); // "Remove"
    assert.equal(container.querySelectorAll('.qu-profile-field-row').length, 0);

    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    saveBtn.click();
    // Optional chaining is load-bearing here, not defensive style: render()
    // clears `root` synchronously before its async re-fetch on EVERY call
    // (including the one this save triggers via watch()), so a poll can
    // legitimately land in the gap where `.qu-profile-status` doesn't exist
    // at all yet - `?.textContent` on that moment is `undefined` (falsy,
    // keep polling), not a thrown TypeError.
    await waitFor(() => container.querySelector('.qu-profile-status')?.textContent === 'Saved!');

    const own = await services.profile.getOwnProfile();
    assert.deepEqual(own.fields, []);
  } finally {
    stop();
  }
});

test('toggling the directory-visibility checkbox calls setVisible()', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada' });
  assert.equal(await services.directory.isVisible(myPub), false);

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own input[type="checkbox"]') !== null);
    const checkbox = container.querySelector('.qu-profile-own input[type="checkbox"]');
    assert.equal(checkbox.checked, false);
    checkbox.click();
    await waitFor(async () => (await services.directory.isVisible(myPub)) === true);
  } finally {
    stop();
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

test('the contact toggle on a foreign profile adds/removes a contact', async () => {
  const { qu, identity, services } = await freshEnv();
  const otherPub = await publishOtherUser(qu, { alias: 'Grace' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${otherPub}`] });
  try {
    await waitFor(() => container.querySelector('button') !== null);
    const toggle = container.querySelector('button');
    await waitFor(() => toggle.textContent === '☆');
    toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => toggle.textContent === '★');
    assert.equal(await services.contacts.isContact(otherPub), true);
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

test('own #/~<pub>/settings saves the preference AND applies it immediately via setLocale()/setStoredTheme()', async () => {
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
    await waitFor(() => container.querySelector('.qu-profile-status')?.textContent === 'Saved!');
    const own = await services.profile.getOwnProfile();
    assert.equal(own.preferredLocale, 'de');
    assert.equal(own.preferredTheme, 'sunset');
    assert.equal(getStoredLocale(), 'de');
    assert.equal(getStoredTheme(), 'sunset');
  } finally {
    stop();
  }
});

test('saving the own-profile edit form leaves an already-set language/theme preference untouched', async () => {
  const { qu, identity, services, myPub } = await freshEnv();
  await services.profile.saveProfile({ alias: 'Ada', preferredLocale: 'de', preferredTheme: 'forest' });

  const container = makeContainer();
  const stop = mount(container, { qu, identity, services, segments: [`~${myPub}`] });
  try {
    await waitFor(() => container.querySelector('.qu-profile-own') !== null);
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    saveBtn.click();
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
