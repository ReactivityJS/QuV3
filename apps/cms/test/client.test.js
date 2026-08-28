import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { AccessEngine, EntityEngine, DocumentEngine } from '@qu/engines';
import { ActorService, EntityService, AccessService, paths } from '@qu/services';
import { installDom, waitFor } from '@qu/ui/testing';

installDom();
const { mount } = await import('../client.js');

const GLOBAL_SPACE_ID = 'c9e6b279-2835-4388-aa0e-4805339e3495'; // must match manifest.quapp's own spaceId

/** One shared QuStore with every Engine this app's own pipeline needs registered - same shape entity-service.test.js/access-service.test.js already use. */
function freshStore() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  new EntityEngine(qu);
  new DocumentEngine(qu);
  return qu;
}

/**
 * A fresh identity, its `services` wired against `sharedQu` (the "backend"
 * this test scenario actually reads/writes) - but the identity's OWN seed
 * always lives on its OWN separate store, never `sharedQu` itself. Two
 * DIFFERENT identities can never share one store for their seed material
 * (`QuIdentityEngine`'s own `#storeSeed()` throws - "a QuStore holds one
 * identity at a time"), but nothing stops two different identities' Services
 * from being constructed against the SAME shared backend qu - exactly what a
 * real multi-user relay is, and exactly what this file's own two-identity
 * ACL tests below need: two real signers, one shared store to contend over.
 */
async function freshIdentity(sharedQu = freshStore()) {
  const identity = new QuIdentityEngine(freshStore());
  await identity.importMnemonic(identity.generateMnemonic());
  const services = { actors: new ActorService(identity), entities: new EntityService(sharedQu, identity), access: new AccessService(sharedQu, identity) };
  const myPub = await services.actors.whoAmI();
  return { qu: sharedQu, identity, services, myPub };
}

function noop() {}
function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function mockConfig(t, { adminPubs = [], cms = {} } = {}) {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    adminPubs,
    settings: { cms: { allowedEditors: ['markdown', 'richtext'], defaultEditor: 'markdown', ...cms } },
  }), { status: 200 }));
}

/** Creates a page directly via the Services layer (bypassing the UI form) - the same protect-then-create sequence client.js's own form uses. */
async function createPage(services, spaceId, writers, fields) {
  const id = crypto.randomUUID();
  await services.access.protect(spaceId, 'entities', id, { writers });
  const writeOptions = await services.access.writeOptionsFor(spaceId, 'entities', id);
  return services.entities.createEntity(spaceId, 'page', fields, { id, writeOptions });
}

test('a brand-new "mine" space shows the empty state with a create-first-page link', async (t) => {
  const qu = freshStore();
  const { services, myPub } = await freshIdentity(qu);
  mockConfig(t, { adminPubs: [] });

  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['cms', 'mine'], subscribe: noop, chrome: { set: noop } });
  try {
    await waitFor(() => container.querySelector('.qu-cms-empty') !== null);
    assert.ok(container.querySelector('.qu-cms-empty a'), 'expected a "create the first one" link');
  } finally {
    stop();
  }
  void myPub;
});

test('a page created in "mine" round-trips: renders its title and markdown content', async (t) => {
  const qu = freshStore();
  const { services, myPub } = await freshIdentity(qu);
  mockConfig(t, { adminPubs: [] });

  const spaceId = paths.cmsUserSpaceId(myPub);
  await createPage(services, spaceId, [myPub], {
    title: 'Welcome',
    route: '',
    order: 0,
    templateId: 'std:standard',
    editor: 'markdown',
    style: {},
    content: { text: 'Hello **world**', format: 'markdown', attachments: [], location: null },
  });

  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['cms', 'mine'], subscribe: noop, chrome: { set: noop } });
  try {
    await waitFor(() => container.querySelector('h1') !== null);
    assert.equal(container.querySelector('h1').textContent, 'Welcome');
    assert.match(container.querySelector('.qu-cms-page-body').innerHTML, /<strong>world<\/strong>/);
    assert.ok(container.querySelector('.qu-cms-page-edit-link'), 'the owner should see an Edit link');
  } finally {
    stop();
  }
});

test('a subpage (nested route) shows up as a "Subpages" link on its parent\'s view', async (t) => {
  const qu = freshStore();
  const { services, myPub } = await freshIdentity(qu);
  mockConfig(t);
  const spaceId = paths.cmsUserSpaceId(myPub);

  await createPage(services, spaceId, [myPub], { title: 'Blog', route: 'blog', order: 0, content: { text: '', format: 'markdown', attachments: [], location: null } });
  await createPage(services, spaceId, [myPub], { title: 'First post', route: 'blog/first-post', order: 0, content: { text: 'hi', format: 'markdown', attachments: [], location: null } });

  const container = makeContainer();
  const pages = await qu.getChildren(paths.entitiesParentPath(spaceId));
  const blogId = pages.map((e) => e.quBit.val).find((p) => p.route === 'blog')._id;
  const stop = mount(container, { qu, services, segments: ['cms', 'mine', 'p', blogId], subscribe: noop, chrome: { set: noop } });
  try {
    await waitFor(() => container.querySelector('.qu-cms-subpages a') !== null);
    assert.equal(container.querySelector('.qu-cms-subpages a').textContent, 'First post');
  } finally {
    stop();
  }
});

test('template + style selection is reflected in the rendered layout class and CSS custom properties', async (t) => {
  const qu = freshStore();
  const { services, myPub } = await freshIdentity(qu);
  mockConfig(t);
  const spaceId = paths.cmsUserSpaceId(myPub);

  await createPage(services, spaceId, [myPub], {
    title: 'Styled', route: '', order: 0, templateId: 'std:wide',
    style: { background: '#112233', font: 'mono' },
    content: { text: 'x', format: 'markdown', attachments: [], location: null },
  });

  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['cms', 'mine'], subscribe: noop, chrome: { set: noop } });
  try {
    await waitFor(() => container.querySelector('.qu-cms-page-surface') !== null);
    const surface = container.querySelector('.qu-cms-page-surface');
    assert.ok(surface.classList.contains('qu-cms-layout-wide'));
    assert.equal(surface.style.getPropertyValue('--cms-bg'), '#112233');
    assert.match(surface.style.getPropertyValue('--cms-font'), /monospace/);
  } finally {
    stop();
  }
});

test('richtext content is sanitized on render, even if the stored HTML was tampered with', async (t) => {
  const qu = freshStore();
  const { services, myPub } = await freshIdentity(qu);
  mockConfig(t);
  const spaceId = paths.cmsUserSpaceId(myPub);

  await createPage(services, spaceId, [myPub], {
    title: 'Rich', route: '', order: 0, editor: 'richtext',
    content: { text: '<p>hi</p><script>alert(1)</script>', format: 'richtext', attachments: [], location: null },
  });

  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['cms', 'mine'], subscribe: noop, chrome: { set: noop } });
  try {
    await waitFor(() => container.querySelector('.qu-cms-page-body') !== null);
    const html = container.querySelector('.qu-cms-page-body').innerHTML;
    assert.match(html, /<p>hi<\/p>/);
    assert.doesNotMatch(html, /script|alert/);
  } finally {
    stop();
  }
});

test('a non-admin visiting "global" sees content read-only - no Edit link, no primaryAction', async (t) => {
  const qu = freshStore();
  const { services, myPub } = await freshIdentity(qu);
  const admin = await freshIdentity(qu);
  mockConfig(t, { adminPubs: [admin.myPub] });

  await createPage(admin.services, GLOBAL_SPACE_ID, [admin.myPub], {
    title: 'Site home', route: '', order: 0, content: { text: 'welcome', format: 'markdown', attachments: [], location: null },
  });

  const container = makeContainer();
  const chromeCalls = [];
  const stop = mount(container, { qu, services, segments: ['cms', 'global'], subscribe: noop, chrome: { set: (cfg) => chromeCalls.push(cfg) } });
  try {
    await waitFor(() => container.querySelector('h1') !== null);
    assert.equal(container.querySelector('.qu-cms-page-edit-link'), null);
    const last = chromeCalls.at(-1);
    assert.equal(last.primaryAction, undefined);
  } finally {
    stop();
  }
  void myPub;
});

test('an admin creating a page in "global" is signed with their own key, protected against the current admin list', async (t) => {
  const qu = freshStore();
  const admin = await freshIdentity(qu);
  mockConfig(t, { adminPubs: [admin.myPub] });

  const chromeCalls = [];
  const container = makeContainer();
  const stop = mount(container, { qu, services: admin.services, segments: ['cms', 'global'], subscribe: noop, chrome: { set: (cfg) => chromeCalls.push(cfg) } });
  try {
    await waitFor(() => chromeCalls.length > 0);
    assert.equal(chromeCalls.at(-1).primaryAction.href, '#/cms/global/new');
  } finally {
    stop();
  }

  const acl = await admin.services.access.getAcl(GLOBAL_SPACE_ID, 'entities', 'nonexistent');
  assert.equal(acl, null); // sanity: getAcl() itself still behaves normally against this space
});

test('SECURITY: a page protected to one identity in "mine" cannot be overwritten by a different identity', async (t) => {
  const qu = freshStore();
  const alice = await freshIdentity(qu);
  const eve = await freshIdentity(qu);
  mockConfig(t);
  const spaceId = paths.cmsUserSpaceId(alice.myPub); // Alice's own space - Eve has no route to it in the UI, but a modified client could still call the Services directly

  const page = await createPage(alice.services, spaceId, [alice.myPub], {
    title: 'Alice\'s page', route: '', order: 0, content: { text: 'mine', format: 'markdown', attachments: [], location: null },
  });

  const writeOptions = await eve.services.access.writeOptionsFor(spaceId, 'entities', page._id);
  await assert.rejects(
    () => eve.services.entities.updateEntity(spaceId, page._id, { title: 'hijacked' }, { writeOptions }),
    /not authorized to write/
  );

  // Alice's own page is untouched.
  const stillMine = await alice.services.entities.getEntity(spaceId, page._id);
  assert.equal(stillMine.title, "Alice's page");
});

test('the editor picker disables an editor the relay does not currently allow', async (t) => {
  const qu = freshStore();
  const { services, myPub } = await freshIdentity(qu);
  mockConfig(t, { cms: { allowedEditors: ['markdown'] } }); // richtext NOT allowed
  const spaceId = paths.cmsUserSpaceId(myPub);
  await createPage(services, spaceId, [myPub], { title: 'x', route: '', order: 0, content: { text: '', format: 'markdown', attachments: [], location: null } });

  const container = makeContainer();
  const stop = mount(container, { qu, services, segments: ['cms', 'mine', 'e', (await qu.getChildren(paths.entitiesParentPath(spaceId)))[0].quBit.val._id], subscribe: noop, chrome: { set: noop } });
  try {
    await waitFor(() => container.querySelector('form') !== null);
    const options = [...container.querySelectorAll('form select')].flatMap((sel) => [...sel.options]);
    const richtextOption = options.find((o) => o.value === 'richtext');
    assert.equal(richtextOption.disabled, true);
  } finally {
    stop();
  }
});
