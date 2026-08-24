import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { ListService, AccessService, SharingService, MessageService, FlagService, ActorService, ContactsService, ProfileService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';
import { listMyGames } from '../src/game-service.js';

installFakeRTCPeerConnection();
installDom();
const { mount } = await import('../client.js');
const { mountAppTemplate } = await import('@qu/ui');

const SPACE_ID = '65a3739c-e0a5-443b-a5ef-4005c8412659'; // real UUID from apps/geochase/manifest.quapp
const APPS = [{ name: 'geochase', spaceId: SPACE_ID }];

function installGeolocationMock(coords = { latitude: 52.52, longitude: 13.405, heading: null, speed: null }) {
  navigator.geolocation = {
    watchPosition: (success) => { success({ coords }); return 1; },
    clearWatch: () => {},
  };
}

async function freshEnv(alias = 'Me') {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new ThreadEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });

  const list = new ListService(qu);
  const access = new AccessService(qu, identity);
  const messages = new MessageService(qu, identity, list, access);
  const flags = new FlagService(qu, identity, list);
  const services = {
    actors: new ActorService(identity),
    access,
    messages,
    flags,
    sharing: new SharingService(qu, identity, access, messages, flags),
    contacts: new ContactsService(flags, identity),
    profile: new ProfileService(qu, identity),
  };
  const myPub = await services.actors.whoAmI();
  return { qu, identity, services, myPub };
}

/** A full second, independent identity+services bundle sharing the SAME store - mirrors apps/todo/test's own createPeer(). */
async function createPeer(ownerQu, { alias } = {}) {
  const peerQu = new QuStore();
  peerQu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(peerQu);
  new ThreadEngine(peerQu);
  const identity = new QuIdentityEngine(peerQu);
  await identity.importMnemonic(identity.generateMnemonic());
  await identity.publishMainProfile({ alias });
  const list = new ListService(peerQu);
  const access = new AccessService(peerQu, identity);
  const messages = new MessageService(peerQu, identity, list, access);
  const flags = new FlagService(peerQu, identity, list);
  const services = {
    actors: new ActorService(identity), access, messages, flags,
    sharing: new SharingService(peerQu, identity, access, messages, flags),
    contacts: new ContactsService(flags, identity),
    profile: new ProfileService(peerQu, identity),
  };
  const myPub = await services.actors.whoAmI();
  await ownerQu.putSealed(actorPath(myPub, 'profile'), await peerQu.get(actorPath(myPub, 'profile')));
  return { qu: peerQu, identity, services, myPub };
}

function noopSubscribe() {}
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}
function segmentsFor(hash) {
  return hash.replace(/^#\//, '').split('/');
}

function fakeChrome(chromeRoot) {
  let current = {};
  const stopTemplate = mountAppTemplate(chromeRoot, { render: () => {} });
  return {
    get current() { return current; },
    set(partial) {
      current = { ...current, ...partial };
      stopTemplate.update(current);
    },
  };
}

/**
 * Mounts `#/geochase/new` (the draft settings form - see client.js's own
 * `renderNewGamePage()` doc comment: NOTHING is written to the store just
 * from mounting this route, req. 2), submits it with the prefilled
 * defaults, and waits for the resulting redirect into the freshly created
 * game. Mirrors what every test that used to rely on the old
 * create-and-redirect-on-mount behavior now has to do explicitly.
 * @returns {Promise<string>} The new game's own id.
 */
async function createGameViaNewPage(container, mountOptions) {
  window.location.hash = ''; // a stale hash left by an earlier test could otherwise satisfy the waitFor() below instantly
  // Mirrors apps/shell/client.js's own renderRoute() ordering (stop the
  // previous mount, THEN clear the screen, before mounting again) - without
  // this, a caller that already mounted+stopped 'new' once on this SAME
  // container (e.g. to assert nothing was persisted yet) leaves that stale
  // form's DOM (and its now-stopped closure's event listeners) sitting in
  // `container` until THIS mount's own async chain gets around to
  // `renderSubpage()`'s own container.textContent = '' - a real race the
  // production shell never hits (it clears synchronously, before ever
  // awaiting into `mod.mount()`), but a bare `mount()` call here otherwise
  // would: this helper's own waitFor() below could see the STALE form and
  // click its long-stopped submit button instead of the new one.
  container.textContent = '';
  const stop = mount(container, { ...mountOptions, segments: ['geochase', 'new'] });
  await waitFor(() => container.querySelector('.qu-geochase-form') !== null);
  const submitBtn = [...container.querySelectorAll('button[type="submit"]')].find((b) => b.textContent === 'Create game');
  submitBtn.click();
  await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
  stop();
  container.textContent = ''; // see this function's own top doc comment - leaves `container` clean for whatever the caller mounts into it next
  return window.location.hash.split('/')[2];
}

test('renders the empty state when there are no games yet', async () => {
  const { qu, services } = await freshEnv();
  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const container = makeContainer();
  const stop = mount(container, { qu, services, apps: APPS, segments: ['geochase'], subscribe: noopSubscribe, chrome });
  try {
    await waitFor(() => container.querySelector('.qu-geochase-empty') !== null);
    assert.match(container.querySelector('.qu-geochase-empty').textContent, /No games yet/);
    assert.ok(chromeRoot.querySelector('a[href="#/geochase/new"]'), 'expected a "Start a game" link');
  } finally {
    stop();
  }
});

test('#/geochase/new renders a draft form that writes NOTHING to the store until submitted, then creates the game on submit', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  window.location.hash = '';
  const stop = mount(container, { qu, services, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-geochase-form') !== null);
    // req. 2 - merely viewing the draft page must not have created a game yet.
    const mine = await listMyGames(services);
    assert.deepEqual(mine, []);
  } finally {
    stop();
  }

  const gameId = await createGameViaNewPage(container, { qu, services, apps: APPS, subscribe: noopSubscribe });
  const config = await services.messages.getConfig(SPACE_ID, `geochase-${gameId}`);
  assert.equal(config.chasedPub, myPub);
  assert.equal(config.status, 'pending');
});

test('the chased player\'s pending game view shows the settings form, invite panel, a Start button, and themself as chased in the participant list', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const gameId = await createGameViaNewPage(container, { qu, services, apps: APPS, subscribe: noopSubscribe });

  const stop = mount(container, { qu, services, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-geochase-form') !== null);
    assert.ok(container.querySelector('.qu-actor-picker input'), 'expected the invite panel\'s actor picker');
    assert.ok([...container.querySelectorAll('button')].some((b) => b.textContent === 'Start the chase'));
    const participantRow = container.querySelector('.qu-geochase-players li');
    assert.match(participantRow.textContent, /you.*Chased/i);
  } finally {
    stop();
  }
});

test('a random gameId that was never created shows the invalid-link message', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, apps: APPS, segments: segmentsFor('#/geochase/never-existed'), subscribe: noopSubscribe });
  try {
    await waitFor(() => container.textContent.includes('invalid'));
  } finally {
    stop();
  }
});

test('a non-member sees "no access", not the game itself', async () => {
  const { qu: ownerQu, services: ownerServices } = await freshEnv('Owner');
  const { qu: strangerQu, services: strangerServices } = await createPeer(ownerQu, { alias: 'Stranger' });

  const ownerContainer = makeContainer();
  const gameId = await createGameViaNewPage(ownerContainer, { qu: ownerQu, services: ownerServices, apps: APPS, subscribe: noopSubscribe });

  // Mirror the game thread into the stranger's own store, as a real relay sync would -
  // they can SEE it exists (it's unencrypted meta, see game-service.js's own doc comment)
  // but were never added to `members`, so they must still be refused.
  const bit = await ownerQu.get(paths.threadMetaPath(SPACE_ID, `geochase-${gameId}`));
  await strangerQu.putSealed(paths.threadMetaPath(SPACE_ID, `geochase-${gameId}`), bit);

  const strangerContainer = makeContainer();
  const stop = mount(strangerContainer, { qu: strangerQu, services: strangerServices, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
  try {
    await waitFor(() => strangerContainer.textContent.includes('No access') || strangerContainer.textContent.includes('access'));
    assert.equal(strangerContainer.querySelector('.qu-geochase-form'), null);
  } finally {
    stop();
  }
});

test('inviting a chaser via the actor picker grows the participant list and their own game view shows the chaser badge', async () => {
  installGeolocationMock();
  const { qu: ownerQu, identity: ownerIdentity, services: ownerServices, myPub: chasedPub } = await freshEnv('Chased');
  const { qu: chaserQu, services: chaserServices, myPub: chaserPub } = await createPeer(ownerQu, { alias: 'Ada' });
  await ownerServices.contacts.addContact(chaserPub, {});

  const container = makeContainer();
  const gameId = await createGameViaNewPage(container, { qu: ownerQu, services: ownerServices, apps: APPS, subscribe: noopSubscribe });

  let stop = mount(container, { qu: ownerQu, identity: ownerIdentity, services: ownerServices, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-actor-picker input') !== null);
    const picker = container.querySelector('.qu-actor-picker input');
    picker.value = 'Ada';
    picker.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => container.querySelector('.qu-actor-picker-option') !== null);
    container.querySelector('.qu-actor-picker-option').click();

    await waitFor(() => container.querySelectorAll('.qu-geochase-players li').length === 2);
  } finally {
    stop();
  }

  const config = await ownerServices.messages.getConfig(SPACE_ID, `geochase-${gameId}`);
  assert.deepEqual(config.members.map((m) => m.role), ['chased', 'chaser']);
});

test('starting the game (chased, no chasers) flips it from pending to active - the settings form/invite panel are replaced by the live map + player list', async () => {
  installGeolocationMock();
  const { qu, identity, services, myPub } = await freshEnv();
  const container = makeContainer();
  const gameId = await createGameViaNewPage(container, { qu, services, apps: APPS, subscribe: noopSubscribe });

  const stop = mount(container, { qu, identity, services, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
  try {
    await waitFor(() => [...container.querySelectorAll('button')].some((b) => b.textContent === 'Start the chase'));
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Start the chase').click();

    await waitFor(() => container.querySelector('.qu-geochase-map-canvas') !== null);
    assert.equal(container.querySelector('.qu-geochase-form'), null);
    assert.ok(container.querySelector('.qu-geochase-players'), 'expected the live player list');

    // Self-reported position lands in the player list once the mesh/location loop ticks.
    await waitFor(() => container.querySelector('.qu-geochase-players li')?.textContent.includes('you'));
  } finally {
    stop();
  }
});

test('ending an active game shows "This game has ended."', async () => {
  installGeolocationMock();
  const { qu, identity, services } = await freshEnv();
  const container = makeContainer();
  const gameId = await createGameViaNewPage(container, { qu, services, apps: APPS, subscribe: noopSubscribe });

  const stop = mount(container, { qu, identity, services, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
  try {
    await waitFor(() => [...container.querySelectorAll('button')].some((b) => b.textContent === 'Start the chase'));
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Start the chase').click();
    await waitFor(() => [...container.querySelectorAll('button')].some((b) => b.textContent === 'End the game'));
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'End the game').click();
    await waitFor(() => container.textContent.includes('This game has ended.'));
  } finally {
    stop();
  }
});

test('the "Copy link" button copies an absolute, shareable game URL', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const gameId = await createGameViaNewPage(container, { qu, services, apps: APPS, subscribe: noopSubscribe });

  const written = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalGeo = navigator.geolocation;
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...navigator, geolocation: originalGeo, clipboard: { writeText: async (text) => { written.push(text); } } },
    configurable: true,
  });
  let stop;
  try {
    stop = mount(container, { qu, services, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
    await waitFor(() => container.querySelector('.qu-geochase-copy-link') !== null);
    container.querySelector('.qu-geochase-copy-link').click();
    await waitFor(() => written.length === 1);
    assert.equal(written[0], `http://localhost/#/geochase/${gameId}`);
  } finally {
    stop();
    Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  }
});

/**
 * "Start a game" now lives as the game-list view's own `ctx.chrome`
 * `primaryAction` (docs/app-navigation-standard.md Rule 5a) instead of a
 * `shell.headerNavPoints` contribution AND a duplicate inline link in the
 * page body - see client.js's own top doc comment. On mobile this renders as
 * a circular FAB (`.qu-apptpl-fab`); on desktop, a prominent link at the top
 * of the sidebar (`.qu-apptpl-primary-desktop`) - either is enough to prove
 * the action is wired up. Rendered into a `fakeChrome()` root, not
 * `container` - see that helper's own doc comment above.
 */
function primaryActionLink(chromeRoot) {
  return chromeRoot.querySelector('.qu-apptpl-fab, .qu-apptpl-primary-desktop');
}

test('the game list\'s own primaryAction is "Start a game", pointing at #/geochase/new', async () => {
  const { qu, services } = await freshEnv();
  const chromeRoot = makeContainer();
  const chrome = fakeChrome(chromeRoot);
  const container = makeContainer();
  const stop = mount(container, { qu, services, apps: APPS, segments: ['geochase'], subscribe: noopSubscribe, chrome });
  try {
    await waitFor(() => primaryActionLink(chromeRoot) !== null);
    assert.equal(primaryActionLink(chromeRoot).getAttribute('href'), '#/geochase/new');
  } finally {
    stop();
  }
});
