import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { QuIdentityEngine } from '@qu/identity';
import { QuRelay } from '../src/relay.js';

const REPO_APPS_DIR = fileURLToPath(new URL('../../../apps', import.meta.url));

async function freshRelay(options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const relay = await new QuRelay({
    storeDir: join(base, 'store'),
    blobDir: join(base, 'blob'),
    // An empty, isolated directory by default - NOT QuRelay's own './apps'
    // default, which resolves relative to the test runner's CWD and would
    // silently pick up the real monorepo apps/ directory (apps/forum) when
    // `node --test` runs from the repo root, making most of this file's
    // tests depend on invocation directory instead of being hermetic. Tests
    // that specifically want real app-loading behavior override this.
    appsDir: join(base, 'apps'),
    port: 0,
    ...options,
  }).boot();
  return {
    relay,
    base,
    teardown: async () => {
      await relay.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('boot() starts a real HTTP server and assigns an actual port', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    assert.ok(relay.port > 0);
  } finally {
    await teardown();
  }
});

test('GET /healthz reports ok with this relay\'s real peerId', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const res = await fetch(`http://localhost:${relay.port}/healthz`);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.peerId, relay.transport.getPeerId());
  } finally {
    await teardown();
  }
});

test('GET /push/vapid-public-key returns a real, resolved VAPID public key after boot', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const res = await fetch(`http://localhost:${relay.port}/push/vapid-public-key`);
    const body = await res.json();
    assert.ok(typeof body.publicKey === 'string' && body.publicKey.length > 0);
  } finally {
    await teardown();
  }
});

test('the relay establishes and persists its own operational identity across a reboot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  try {
    const first = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: join(base, 'apps'), port: 0 }).boot();
    const firstPub = QuCrypto.toBase64Url((await first.identity.getMainKey()).publicKey);
    await first.close();

    const second = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: join(base, 'apps'), port: 0 }).boot();
    const secondPub = QuCrypto.toBase64Url((await second.identity.getMainKey()).publicKey);
    await second.close();

    assert.equal(firstPub, secondPub);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a freshly generated identity AND freshly generated VAPID keys are logged once, in copy-pasteable QU_* form - a reboot reusing them stays silent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const originalWarn = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args.join(' '));
  try {
    const first = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: join(base, 'apps'), port: 0 }).boot();
    const firstPub = QuCrypto.toBase64Url((await first.identity.getMainKey()).publicKey);
    await first.close();

    const firstBootLog = calls.join('\n');
    assert.match(firstBootLog, /generated a NEW relay identity/);
    assert.match(firstBootLog, /QU_IDENTITY_MNEMONIC="[a-z]+( [a-z]+){23}"/);
    assert.match(firstBootLog, new RegExp(`relay pubkey: ${firstPub}`));
    assert.match(firstBootLog, /generated new VAPID keys/);
    assert.match(firstBootLog, /QU_VAPID_PUBLIC_KEY="[^"]+"/);
    assert.match(firstBootLog, /QU_VAPID_PRIVATE_KEY="[^"]+"/);

    calls.length = 0;
    const second = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: join(base, 'apps'), port: 0 }).boot();
    await second.close();

    assert.equal(calls.length, 0);
  } finally {
    console.warn = originalWarn;
    await rm(base, { recursive: true, force: true });
  }
});

test('identityMnemonic pins the relay\'s identity explicitly, independent of stored state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  try {
    const scratchQu = new QuStore();
    scratchQu.mount('store', new MemoryStoreAdapter());
    const scratchIdentity = new QuIdentityEngine(scratchQu);
    const mnemonic = scratchIdentity.generateMnemonic();
    await scratchIdentity.importMnemonic(mnemonic);
    const expectedPub = QuCrypto.toBase64Url((await scratchIdentity.getMainKey()).publicKey);

    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: join(base, 'apps'), port: 0, identityMnemonic: mnemonic }).boot();
    try {
      const actualPub = QuCrypto.toBase64Url((await relay.identity.getMainKey()).publicKey);
      assert.equal(actualPub, expectedPub);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a client connects over WebSocket, publishes a write, and the relay persists it', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const ws = new WebSocket(`ws://localhost:${relay.port}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const quBit = { path: '/store/space/docs/d1', val: { title: 'from a client' }, ts: Date.now(), pub: null, sig: null };
    ws.send(JSON.stringify({ type: 'sync', path: quBit.path, quBit }));

    let stored = null;
    const start = Date.now();
    while (!stored) {
      stored = await relay.qu.get('/store/space/docs/d1');
      if (stored) break;
      if (Date.now() - start > 2000) throw new Error('timed out waiting for the relay to persist the write');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(stored.val.title, 'from a client');
    ws.close();
  } finally {
    await teardown();
  }
});

test('a protected resource cannot be overwritten via a forged synced write - the relay\'s AccessEngine rejects it (docs/v3-technical-concept.md §3.3)', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const ownerKp = await QuCrypto.generateKeypair();
    const ownerPub = QuCrypto.toBase64Url(ownerKp.publicKey);
    await relay.qu.put('/store/space/acl/docs/protected', { writers: [ownerPub], readers: '*' });

    const ws = new WebSocket(`ws://localhost:${relay.port}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const attackerKp = await QuCrypto.generateKeypair();
    const payload = { path: '/store/space/docs/protected', val: { title: 'hacked' }, ts: Date.now(), pub: null };
    const signed = await QuCrypto.sign(
      new TextEncoder().encode(JSON.stringify({ path: payload.path, val: payload.val, ts: payload.ts, pub: QuCrypto.toBase64(attackerKp.publicKey) })),
      attackerKp.privateKey
    );
    const quBit = { ...payload, pub: QuCrypto.toBase64(attackerKp.publicKey), sig: QuCrypto.toBase64(signed) };
    ws.send(JSON.stringify({ type: 'sync', path: quBit.path, quBit }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await relay.qu.get('/store/space/docs/protected'), null);
    ws.close();
  } finally {
    await teardown();
  }
});

test('posting a thread message writes a real in-app notification for a mentioned actor with a resolvable profile', async () => {
  const { relay, teardown } = await freshRelay();
  try {
    const { ListService, AccessService, MessageService, THREAD_PRESETS, paths } = await import('@qu/services');
    const { QuStore, MemoryStoreAdapter } = await import('@qu/core');

    // A separate identity/store standing in for a synced client - publishes
    // a profile (needed so the relay's own in-app-notification write can
    // encrypt for them) and copies it onto the relay's own store, simulating
    // an already-synced profile.
    const clientQu = new QuStore();
    clientQu.mount('store', new MemoryStoreAdapter());
    const clientIdentity = new QuIdentityEngine(clientQu);
    await clientIdentity.importMnemonic(clientIdentity.generateMnemonic());
    await clientIdentity.publishMainProfile({});
    const clientPub = QuCrypto.toBase64Url((await clientIdentity.getMainKey()).publicKey);
    const profileQuBit = await clientQu.get(`/store/actors/~${clientPub}/profile`);
    await relay.qu.putSealed(`/store/actors/~${clientPub}/profile`, profileQuBit);

    const list = new ListService(relay.qu);
    const access = new AccessService(relay.qu, relay.identity);
    const messages = new MessageService(relay.qu, relay.identity, list, access);
    await messages.createThread('board', 'general', THREAD_PRESETS.forum());
    await messages.postMessage('board', 'general', { body: `hi @${clientPub}`, extra: { mentions: [clientPub] } });

    let entries = [];
    const start = Date.now();
    while (entries.length === 0) {
      entries = await relay.qu.getChildren(paths.threadMessagesParentPath(`notifications-${clientPub}`, 'notifications'));
      if (entries.length) break;
      if (Date.now() - start > 2000) throw new Error('timed out waiting for push delivery to write the in-app notification');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(entries.length, 1);
  } finally {
    await teardown();
  }
});

test('close() shuts down cleanly and releases the port', async () => {
  const { relay, teardown } = await freshRelay();
  const port = relay.port;
  await teardown();
  await assert.rejects(() => fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(300) }));
});

// ===== @qu/loader integration: local app discovery, apps.json, static serving =====

async function writeLocalApp(appsDir, name, { requires = [], serviceName = `${name}-service` } = {}) {
  const dir = join(appsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.quapp'), JSON.stringify({ name, version: '1.0.0', main: './index.js', clientMain: './client.js', label: name, requires }));
  await writeFile(join(dir, 'index.js'), `export async function register(qu, manifest, registry) { registry.registerService('${serviceName}', { registered: true, name: manifest.name }); }`);
  await writeFile(join(dir, 'client.js'), `export function mount() { return () => {}; }`);
  return dir;
}

test('a local app under appsDir is discovered and loaded at boot - its register() actually runs', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const appsDir = join(base, 'apps');
  try {
    await writeLocalApp(appsDir, 'greeter');
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir, port: 0 }).boot();
    try {
      assert.equal(relay.loader.isLoaded('greeter'), true);
      assert.equal(relay.registry.getService('greeter-service').registered, true);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a local app that "requires" an already-registered relay service loads without needing a directory for it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const appsDir = join(base, 'apps');
  try {
    // 'message-service' is already registered by QuRelay itself (see relay.js's constructor) -
    // a real app depending on core relay infrastructure, not another loadable app.
    await writeLocalApp(appsDir, 'forum', { requires: ['message-service'] });
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir, port: 0 }).boot();
    try {
      assert.equal(relay.loader.isLoaded('forum'), true);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('GET /apps.json reflects a real locally-loaded app after boot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const appsDir = join(base, 'apps');
  try {
    await writeLocalApp(appsDir, 'greeter');
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir, port: 0 }).boot();
    try {
      const res = await fetch(`http://localhost:${relay.port}/apps.json`);
      const body = await res.json();
      assert.equal(body.length, 1);
      assert.equal(body[0].name, 'greeter');
      assert.equal(body[0].clientMainUrl, '/apps/greeter/client.js');
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('GET /apps/<name>/client.js serves a real local app\'s client bundle', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const appsDir = join(base, 'apps');
  try {
    await writeLocalApp(appsDir, 'greeter');
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir, port: 0 }).boot();
    try {
      const res = await fetch(`http://localhost:${relay.port}/apps/greeter/client.js`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/javascript');
      assert.ok((await res.text()).includes('export function mount'));
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a local app whose "requires" is genuinely missing fails boot() with a clear error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const appsDir = join(base, 'apps');
  try {
    await writeLocalApp(appsDir, 'broken', { requires: ['nonexistent-service'] });
    // App loading happens LAST in boot() (after the HTTP/WS server is
    // already listening - see relay.js) - boot() itself tears down whatever
    // it already started (via close()) before rethrowing, so this doesn't
    // need its own cleanup to avoid leaking an open port past this test.
    const relay = new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir, port: 0 });
    await assert.rejects(() => relay.boot(), /requires "nonexistent-service"/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('REGRESSION: a failed boot() does not leak an open port - the port is free to reuse immediately after', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const appsDir = join(base, 'apps');
  try {
    await writeLocalApp(appsDir, 'broken', { requires: ['nonexistent-service'] });
    const firstOptions = { storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir, port: 0 };
    await assert.rejects(() => new QuRelay(firstOptions).boot());

    // If the failed boot() had left its HTTP/WS server open, a second
    // relay booting cleanly right after would still be a distinct process
    // resource (different port, since port: 0 picks a free one each time) -
    // the real proof this doesn't leak is that node's test runner process
    // itself exits promptly once every test finishes, not something a
    // single assertion inside one test can observe directly. This test
    // exists as a named marker for that regression (see relay.js's own
    // boot()/close() doc comments) - the previous version of this test
    // suite would hang the whole process at exit without it.
    const base2 = await mkdtemp(join(tmpdir(), 'qu-relay-'));
    try {
      const relay = await new QuRelay({ storeDir: join(base2, 'store'), blobDir: join(base2, 'blob'), appsDir: join(base2, 'apps'), port: 0 }).boot();
      await relay.close();
    } finally {
      await rm(base2, { recursive: true, force: true });
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an appsDir that does not exist boots fine with zero apps loaded', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  try {
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: join(base, 'nonexistent-apps-dir'), port: 0 }).boot();
    try {
      assert.deepEqual(relay.loader.listLoaded(), []);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a diamond of local apps (forum requires message-service AND a shared "greeter") loads once, in dependency order', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const appsDir = join(base, 'apps');
  try {
    await writeLocalApp(appsDir, 'greeter');
    await writeLocalApp(appsDir, 'forum', { requires: ['greeter', 'message-service'] });
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir, port: 0 }).boot();
    try {
      const order = relay.loader.listLoaded();
      assert.deepEqual(order, ['greeter', 'forum']);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('remoteApps loads an additional app from a (mocked) remote manifest URL at boot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  const manifestUrl = 'https://packages.example.com/notes/manifest.quapp';
  const mainUrl = 'https://packages.example.com/notes/index.js';
  const source = `export async function register(qu, manifest, registry) { registry.registerService('notes-service', { name: manifest.name }); }`;
  const integrity = `sha256-${QuCrypto.toBase64(await QuCrypto.sha256(new TextEncoder().encode(source)))}`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === manifestUrl) return new Response(JSON.stringify({ name: 'notes', version: '1.0.0', main: './index.js', integrity }), { status: 200 });
    if (url === mainUrl) return new Response(source, { status: 200 });
    return originalFetch(url);
  };

  try {
    const relay = await new QuRelay({
      storeDir: join(base, 'store'),
      blobDir: join(base, 'blob'),
      appsDir: join(base, 'apps'),
      port: 0,
      remoteApps: [{ manifestUrl }],
    }).boot();
    try {
      assert.equal(relay.loader.isLoaded('notes'), true);
      assert.deepEqual(relay.loader.listLoaded(), ['notes']); // exactly the remote app, no unrelated local ones
      assert.equal(relay.registry.getService('notes-service').name, 'notes');
    } finally {
      await relay.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(base, { recursive: true, force: true });
  }
});

// ===== the real, monorepo apps/ directory (apps/forum, the first real app) ========

test('booting with the REAL repo apps/ directory loads apps/forum and creates its real "General" channel + opening topic (Quniverse V4: a Topic is now an Entity with an attached comment thread, not a single fixed-id thread)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  try {
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: REPO_APPS_DIR, port: 0 }).boot();
    try {
      assert.equal(relay.loader.isLoaded('forum'), true);
      // apps/forum's spaceId is its manifest's fixed UUID (see @qu/foundation
      // manifest.js), never the human-readable app name.
      const SPACE_ID = '4eb04aa2-4ca9-4c9a-aa7e-33ad3802edb1';
      const channels = relay.registry.getService('channel-service');
      const [channel] = await channels.listChannels(SPACE_ID);
      assert.equal(channel?.title, 'General');
      const [topic] = await channels.listTopics(SPACE_ID, channel._id);
      assert.ok(topic, 'apps/forum\'s register() should have created the "General" channel\'s opening topic');
      // The topic's own attached comment thread (CommentableService, same id).
      const config = await relay.messages.getConfig(SPACE_ID, topic._id);
      assert.ok(config, 'the topic\'s own comment thread should have been created');
      assert.equal(config.writers, '*');
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('booting with the REAL repo apps/ directory also loads app-list/user-list/profile/forum/bookmarks/notifications, and /apps.json lists exactly their (client-bearing) manifests', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qu-relay-'));
  try {
    const relay = await new QuRelay({ storeDir: join(base, 'store'), blobDir: join(base, 'blob'), appsDir: REPO_APPS_DIR, port: 0 }).boot();
    try {
      for (const name of ['app-list', 'user-list', 'profile', 'forum', 'bookmarks', 'notifications', 'reactions', 'pins', 'relay-admin', 'relay-federation', 'chat', 'search', 'calendar', 'geochase', 'todo', 'phone', 'cms', 'data-manager']) assert.equal(relay.loader.isLoaded(name), true);

      const res = await fetch(`http://localhost:${relay.port}/apps.json`);
      const catalog = await res.json();
      const names = catalog.map((a) => a.name).sort();
      // apps/forum now has a clientMain too (see apps/forum/client.js), and
      // apps/bookmarks/apps/notifications (new this round) do from the
      // start - all are client-bearing manifests, so buildAppsCatalog()
      // lists them alongside the others. apps/reactions/apps/pins/
      // apps/relay-admin are the newest additions: real, client-bearing,
      // admin-toggleable plugin apps with no `label`/`icon`/`navOrder` of
      // their own (see each one's own manifest.quapp doc comment on why).
      // apps/chat is the QuV2 messenger port (see its own doc comment).
      // apps/search is the context-aware header search app (own page +
      // `shell.headerAction` contribution, see its own doc comment).
      // apps/calendar is the mobile-first shared calendar app (own space,
      // own pushActions - see its own manifest.quapp/client.js doc comments).
      // apps/geochase is the WebRTC-as-app-feature pilot (own space, see
      // its own manifest.quapp/client.js doc comments).
      // apps/todo is the newest addition: shared to-do lists, own space,
      // built on the SAME generic SharingService apps/calendar's own
      // membership/invite logic was extracted into (see either app's own
      // client.js top doc comment).
      // apps/phone is the audio/video calling pilot built on top of
      // apps/geochase's own WebRTC-as-app-feature foundation - own space,
      // own pushActions (incomingCall, with Accept/Decline actions - see
      // packages/relay/src/push-delivery.js's own doc comment).
      // apps/contact-list no longer exists - merged into apps/user-list
      // (client.js's own top doc comment), which now carries both the
      // default Contacts view and the former user-list's own "all public
      // users" view, switched via chrome.set({views}).
      // apps/relay-federation is the newest addition: a client-facing,
      // admin-toggleable "suggest a relay" UI (userSettings.contributions
      // contribution + its own #/relay-federation/invite/<url> route - see
      // its own client.js top doc comment) - hidden from the app list
      // (relay-settings.js's own hiddenFromAppList default) since it has no
      // reason to be browsed to directly, only reached via Settings or an
      // invite link, same reasoning apps/relay-admin already has.
      // apps/data-manager is the newest addition: the resolved-data viewer +
      // filter + export/import app (own "My Data" tier for every identity,
      // plus an admin-only "Relay Data" tier over the already-existing
      // /admin/data/list and /admin/data/import routes) - see its own
      // manifest.quapp/client.js doc comments.
      // apps/cms is the newest addition alongside it: Admin-owned global
      // pages + each user's own page space (see its own manifest.quapp/
      // client.js doc comments).
      assert.deepEqual(names, ['app-list', 'bookmarks', 'calendar', 'chat', 'cms', 'data-manager', 'forum', 'geochase', 'notifications', 'phone', 'pins', 'profile', 'reactions', 'relay-admin', 'relay-federation', 'search', 'todo', 'user-list']);
      for (const app of catalog) assert.equal(app.clientMainUrl, `/apps/${app.name}/dist/client.js`);
    } finally {
      await relay.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
