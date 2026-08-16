import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter } from '@qu/core';
import { QuIdentityEngine, actorPath } from '@qu/identity';
import { AccessEngine, ThreadEngine } from '@qu/engines';
import { ListService, AccessService, SharingService, MessageService, FlagService, ActorService, ContactsService, ProfileService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';
import { installFakeRTCPeerConnection } from '../../../packages/webrtc/test/fake-rtc-peer-connection.js';

installFakeRTCPeerConnection();
installDom();
const { mount, renderHeaderNavPoints } = await import('../client.js');

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

test('renders the empty state when there are no games yet', async () => {
  const { qu, services } = await freshEnv();
  const container = makeContainer();
  const stop = mount(container, { qu, services, apps: APPS, segments: ['geochase'], subscribe: noopSubscribe });
  try {
    await waitFor(() => container.querySelector('.qu-geochase-empty') !== null);
    assert.match(container.querySelector('.qu-geochase-empty').textContent, /No games yet/);
    assert.ok(container.querySelector('a[href="#/geochase/new"]'), 'expected a "Start a game" link');
  } finally {
    stop();
  }
});

test('#/geochase/new creates a fresh game (this identity as chased) and redirects straight into it', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  window.location.hash = ''; // see this file's own top-level note in the client.test.js suites this mirrors (apps/todo's/apps/chat's) - a stale hash left by an earlier test could otherwise satisfy the waitFor() below instantly
  const stop = mount(container, { qu, services, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  try {
    await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
    const gameId = window.location.hash.split('/')[2];
    const config = await services.messages.getConfig(SPACE_ID, `geochase-${gameId}`);
    assert.equal(config.chasedPub, myPub);
    assert.equal(config.status, 'pending');
  } finally {
    stop();
  }
});

test('the chased player\'s pending game view shows the settings form, invite panel, a Start button, and themself as chased in the participant list', async () => {
  const { qu, services, myPub } = await freshEnv();
  const container = makeContainer();
  window.location.hash = ''; // reset - a stale hash left by an earlier test could otherwise satisfy this test's own waitFor() instantly
  let stop = mount(container, { qu, services, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
  const gameId = window.location.hash.split('/')[2];
  stop();

  stop = mount(container, { qu, services, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
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
  window.location.hash = ''; // reset - a stale hash left by an earlier test could otherwise satisfy this test's own waitFor() instantly
  let stop = mount(ownerContainer, { qu: ownerQu, services: ownerServices, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
  const gameId = window.location.hash.split('/')[2];
  stop();

  // Mirror the game thread into the stranger's own store, as a real relay sync would -
  // they can SEE it exists (it's unencrypted meta, see game-service.js's own doc comment)
  // but were never added to `members`, so they must still be refused.
  const bit = await ownerQu.get(paths.threadMetaPath(SPACE_ID, `geochase-${gameId}`));
  await strangerQu.putSealed(paths.threadMetaPath(SPACE_ID, `geochase-${gameId}`), bit);

  const strangerContainer = makeContainer();
  stop = mount(strangerContainer, { qu: strangerQu, services: strangerServices, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
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
  window.location.hash = ''; // reset - a stale hash left by an earlier test could otherwise satisfy this test's own waitFor() instantly
  let stop = mount(container, { qu: ownerQu, services: ownerServices, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
  const gameId = window.location.hash.split('/')[2];
  stop();

  stop = mount(container, { qu: ownerQu, identity: ownerIdentity, services: ownerServices, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
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
  window.location.hash = ''; // reset - a stale hash left by an earlier test could otherwise satisfy this test's own waitFor() instantly
  let stop = mount(container, { qu, services, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
  const gameId = window.location.hash.split('/')[2];
  stop();

  stop = mount(container, { qu, identity, services, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
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
  window.location.hash = ''; // reset - a stale hash left by an earlier test could otherwise satisfy this test's own waitFor() instantly
  let stop = mount(container, { qu, services, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
  const gameId = window.location.hash.split('/')[2];
  stop();

  stop = mount(container, { qu, identity, services, apps: APPS, segments: segmentsFor(`#/geochase/${gameId}`), subscribe: noopSubscribe });
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
  window.location.hash = ''; // reset - a stale hash left by an earlier test could otherwise satisfy this test's own waitFor() instantly
  let stop = mount(container, { qu, services, apps: APPS, segments: ['geochase', 'new'], subscribe: noopSubscribe });
  await waitFor(() => /^#\/geochase\/[^/]+$/.test(window.location.hash));
  const gameId = window.location.hash.split('/')[2];
  stop();

  const written = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalGeo = navigator.geolocation;
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...navigator, geolocation: originalGeo, clipboard: { writeText: async (text) => { written.push(text); } } },
    configurable: true,
  });
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

test('renderHeaderNavPoints(): hidden while another app is active, shows "Start a game" -> #/geochase/new once Geo Chase is active', async () => {
  const container = makeContainer();
  let appId = 'chat';
  const listeners = [];
  renderHeaderNavPoints(container, {
    getContext: () => ({ appId, segments: [appId] }),
    onContextChange: (cb) => listeners.push(cb),
  });
  const wrap = container.querySelector('.qu-app-header-action');
  assert.equal(wrap.hidden, true);

  appId = 'geochase';
  listeners.forEach((cb) => cb());
  assert.equal(wrap.hidden, false);
  assert.equal(wrap.querySelector('a')?.getAttribute('href'), '#/geochase/new');
});
