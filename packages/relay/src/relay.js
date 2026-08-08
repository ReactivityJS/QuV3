import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { QuStore, QuCrypto } from '@qu/core';
import { FsAdapter } from '@qu/runtime/fs';
import { Registry, RuntimeContainer } from '@qu/foundation';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { AccessEngine, DocumentEngine, CollectionEngine, AssetEngine, ThreadEngine } from '@qu/engines';
import { ListService, AccessService, MessageService, NotificationPrefsService, PushSubscriptionService } from '@qu/services';
import { QuLoader, discoverLocalPackages } from '@qu/loader';
import { createLogger } from '@qu/log';

import { WebSocketServerTransport } from './transports/websocket-server-transport.js';
import { PresenceTracker } from './presence-tracker.js';
import { setupVapidKeys } from './vapid-key-store.js';
import { PushDeliveryService } from './push-delivery.js';
import { AdminHttp } from './admin-http.js';
import { HttpRouter } from './http-router.js';
import { getSettings } from './relay-settings.js';
import { publishAppsCatalog } from './apps-catalog-store.js';

/**
 * QU RELAY — a Node.js peer that persists to disk, syncs with other peers,
 * delivers push notifications, and loads/serves Engines, Services and Apps
 * via `@qu/loader`. This is the concrete "one server process" composition
 * root every other module in this package plugs into.
 *
 * BUILT USING `RuntimeContainer` (docs/v3-technical-concept.md §2.1) FROM
 * DAY ONE — the exact fix that section's own "god object" finding
 * describes (a 894-line `relay.js` in the prototype this is rebuilt from,
 * accumulating HTTP+WS+push+admin+static serving as methods on one class)
 * is applied here as the STARTING shape, not something refactored in
 * later: every cross-cutting concern (`presence`, `vapidKeys`, `pushDelivery`,
 * `adminHttp`, `httpRouter`) is its own small, independently testable
 * module, constructed lazily by `this.runtime.resolve(name)`, wired
 * together by name rather than by this class reaching into each other
 * module's internals. `QuRelay` itself only ever does ONE thing: decide
 * what's registered, and call `boot()`/`close()`.
 *
 * `boot()` always loads this relay's own local `appsDir` (auto-discovered,
 * dependency-ordered via `@qu/loader`'s `QuLoader`) and, if configured, any
 * `remoteApps` from trusted manifest URLs - the exact "a relay always loads
 * its own local apps, and optionally loads additional ones from remote
 * manifest URLs" shape `@qu/loader`'s own doc comment describes. `apps/shell`
 * is served separately from that pipeline (`serveShell`/`shellDir` options,
 * see `static-shell.js`) - it's a fixed, always-known special case (the one
 * page that boots itself, not a loaded/mountable app with a manifest), not
 * discovered/loaded through `@qu/loader` at all. PWA/service-worker/offline
 * update flow is NOT part of that - see `apps/shell`'s own doc comment for
 * what's deliberately deferred.
 */
const log = createLogger('QuRelay');

export class QuRelay {
  /**
   * @param {object} [options]
   * @param {string} [options.storeDir='./relay-data/store']
   * @param {string} [options.blobDir='./relay-data/blob']
   * @param {string} [options.appsDir='./apps'] - Local apps this relay hosts,
   *   auto-loaded at boot (see `@qu/loader`'s `discoverLocalPackages()`/
   *   `QuLoader.loadLocal()`) and served back out over HTTP (see
   *   `static-apps.js`) for other relays to consume.
   * @param {number} [options.port=8080]
   * @param {boolean} [options.serveShell=true] - Serve `apps/shell` (see
   *   `static-shell.js`) at `/`, `/index.html`, `/shell-bundle.js`. `false`
   *   disables it (e.g. a relay meant purely as a headless sync peer, or a
   *   deployment fronting its own separately-hosted shell).
   * @param {string} [options.shellDir='./apps/shell']
   * @param {string} [options.identityMnemonic] - Pin the relay's own operational identity
   *   across restarts. Without it, a fresh one is generated on first boot and then reused.
   * @param {string[]} [options.adminPubs=[]] - base64url actor pubkeys treated as relay admins.
   * @param {string} [options.vapidPublicKey] - Pin the relay's Web Push VAPID keypair across
   *   restarts (see `@qu/push`) - both this and `vapidPrivateKey` must be given together, or
   *   neither. Without them, a fresh keypair is generated on first boot and persisted (never synced).
   * @param {string} [options.vapidPrivateKey]
   * @param {string} [options.vapidSubject='mailto:admin@example.com']
   * @param {(spaceId: string|number, threadId: string, context: object) => object|null} [options.resolveNotification] -
   *   See `push-delivery.js`'s own doc comment (docs/v3-technical-concept.md §6.2).
   * @param {Array<{manifestUrl: string, trustedPublisherPubs?: string[]}>} [options.remoteApps=[]] -
   *   Additional apps to load from remote manifest URLs at boot (see
   *   `@qu/loader`'s `RemoteLoader.loadRemote()` for the integrity/signature
   *   guarantees this goes through).
   */
  constructor(options = {}) {
    this.options = {
      storeDir: './relay-data/store',
      blobDir: './relay-data/blob',
      appsDir: './apps',
      port: 8080,
      serveShell: true,
      shellDir: './apps/shell',
      adminPubs: [],
      vapidSubject: 'mailto:admin@example.com',
      resolveNotification: null,
      remoteApps: [],
      ...options,
    };

    this.qu = new QuStore();
    this.qu.mount('store', new FsAdapter(this.options.storeDir));
    this.qu.mount('blob', new FsAdapter(this.options.blobDir));

    this.registry = new Registry();
    this.runtime = new RuntimeContainer();

    for (const [name, EngineClass] of [
      ['access-engine', AccessEngine],
      ['document-engine', DocumentEngine],
      ['collection-engine', CollectionEngine],
      ['asset-engine', AssetEngine],
      ['thread-engine', ThreadEngine],
    ]) {
      this.registry.registerEngine(name, new EngineClass(this.qu));
    }

    // The relay's OWN identity (for signing relay-authored data, e.g.
    // in-app notifications). This is NOT where end users' identities live -
    // see @qu/identity's importMnemonic() doc: one QuStore holds at most
    // one identity. End users run their own Qu instance (browser, device)
    // with their own seed; the relay only ever sees their already-signed
    // QuBits arriving via sync.
    this.identity = new QuIdentityEngine(this.qu);

    const list = new ListService(this.qu);
    const access = new AccessService(this.qu, this.identity);
    this.messages = new MessageService(this.qu, this.identity, list, access);
    this.notificationPrefs = new NotificationPrefsService(this.qu, this.identity);
    this.pushSubscriptions = new PushSubscriptionService(this.qu, this.identity, list);
    this.registry.registerService('list-service', list);
    this.registry.registerService('access-service', access);
    this.registry.registerService('message-service', this.messages);
    this.registry.registerService('notification-prefs-service', this.notificationPrefs);
    this.registry.registerService('push-subscription-service', this.pushSubscriptions);

    // The one loader instance for this relay's whole lifetime - `boot()`
    // drives its `loadLocal()`/`loadRemote()` calls; `httpRouter` (via
    // `apps-catalog.js`) reads its live `listManifests()` for `/apps.json`.
    this.loader = new QuLoader(this.qu, this.registry);

    // Shared, mutable state `AdminHttp`/`HttpRouter` read fresh on every
    // request - `transport`/`vapidKeys`/`relayPub` aren't known until
    // partway through `boot()` (see below), and by construction time here
    // neither module's factory has run yet either (RuntimeContainer
    // factories are lazy).
    this._state = { transport: null, vapidKeys: null, relayPub: null };

    this.runtime.register('presence', () => new PresenceTracker());
    this.runtime.register('adminHttp', () => new AdminHttp(this.qu, { adminPubs: this.options.adminPubs, storeDir: this.options.storeDir, blobDir: this.options.blobDir, identity: this.identity, loader: this.loader }, this._state));
    this.runtime.register('httpRouter', (rt) => new HttpRouter(this.qu, rt.resolve('adminHttp'), this.loader, {
      adminPubs: this.options.adminPubs,
      appsDir: this.options.appsDir,
      serveShell: this.options.serveShell,
      shellDir: this.options.shellDir,
      state: this._state,
    }));
    this.runtime.register('pushDelivery', (rt) => new PushDeliveryService({
      messages: this.messages,
      notificationPrefs: this.notificationPrefs,
      pushSubscriptions: this.pushSubscriptions,
      presence: rt.resolve('presence'),
      vapidKeys: this._state.vapidKeys, // resolved lazily, AFTER boot()'s #setupVapidKeys() - see boot()'s own resolve() ordering
      resolveNotification: this.options.resolveNotification,
    }));

    this._httpServer = null;
    this._wss = null;
    this.sync = null;
    this.transport = null;
  }

  /** @returns {number} The actual listening port (resolves `options.port: 0` to the OS-assigned port). Only valid after boot(). */
  get port() {
    return this._httpServer.address().port;
  }

  /**
   * Boots the relay: establishes its own identity, resolves VAPID keys,
   * starts the HTTP/WebSocket server, and wires push delivery to every
   * thread message write this relay ever sees.
   * @returns {Promise<QuRelay>} this
   * @throws {Error} If any step fails (most likely app loading - see the
   *   `requires`-resolution error `@qu/loader` throws) - whatever was
   *   already started (HTTP/WS server, ...) is torn down via `close()`
   *   first, so a failed `boot()` never leaks an open port behind it.
   */
  async boot() {
    try {
      return await this.#bootInner();
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async #bootInner() {
    // Captured only on the branch that actually calls generateMnemonic() -
    // `null` on every other boot (pinned via options, or already persisted
    // from a previous boot) - what gates the one-time log below. A restart
    // that just reuses an already-persisted identity must stay silent here.
    let freshMnemonic = null;
    if (this.options.identityMnemonic) {
      await this.identity.importMnemonic(this.options.identityMnemonic);
    } else if (!(await this.identity.hasIdentity())) {
      freshMnemonic = this.identity.generateMnemonic();
      await this.identity.importMnemonic(freshMnemonic);
    }

    // A published profile is what makes this identity's X25519 key
    // resolvable by anyone else - see MessageService's `#resolveReaderXKeys()`/
    // `#decryptMessage()`, which both fail closed for a signer with no
    // profile. Without this, `#writeInAppNotification()` (which signs+
    // encrypts nothing here, but future reader-restricted use of this
    // identity would need it) would be silently broken.
    const ownPub = QuCrypto.toBase64Url((await this.identity.getMainKey()).publicKey);
    if (!(await this.identity.getProfile(ownPub))) {
      await this.identity.publishMainProfile({});
    }
    // Public via /config.json (see http-router.js) - what a client checks
    // an app-catalog entry's signer against before trusting it (see
    // apps-catalog-store.js's own doc comment for the full reasoning).
    this._state.relayPub = ownPub;

    // A freshly generated identity already persists in `storeDir` (see
    // constructor) for as long as that volume survives - this log is an
    // ESCAPE HATCH, not a requirement: the ONLY way to recover this exact
    // identity if the volume is ever lost, and the only way to give every
    // replica in a multi-instance/ephemeral deployment (no shared volume)
    // the SAME identity instead of each generating its own independently.
    // Fires exactly once, on the boot that generated it - never on a
    // restart that reuses an already-persisted or explicitly pinned one.
    if (freshMnemonic) {
      log.warn(
        'generated a NEW relay identity (no QU_IDENTITY_MNEMONIC set, none persisted yet).',
        'This is the ONLY time this mnemonic is shown - copy it now if you want to pin this identity',
        '(backup, or a multi-replica/ephemeral deployment where every instance must share one identity):'
      );
      log.warn(`  QU_IDENTITY_MNEMONIC="${freshMnemonic}"`);
      log.warn(`  (relay pubkey: ${ownPub})`);
    }

    // Resolved BEFORE `pushDelivery` is ever resolved - see that module's
    // registration above, which captures `this._state.vapidKeys` at
    // resolve() time. RuntimeContainer factories run at most once, so this
    // ordering is what makes push delivery see the real keys instead of
    // whatever `this._state.vapidKeys` happened to be (still `null`) if it
    // were resolved any earlier.
    this._state.vapidKeys = await setupVapidKeys(this.qu, {
      publicKey: this.options.vapidPublicKey,
      privateKey: this.options.vapidPrivateKey,
      subject: this.options.vapidSubject,
    });
    // Same one-time, copy-pasteable escape hatch as the identity mnemonic
    // above - `setupVapidKeys()`'s own `generated` flag is exactly "did
    // generateVapidKeys() run THIS boot", never true again once persisted.
    if (this._state.vapidKeys.generated) {
      log.warn('generated new VAPID keys (no QU_VAPID_PUBLIC_KEY/QU_VAPID_PRIVATE_KEY set). To pin them (backup, multi-replica):');
      log.warn(`  QU_VAPID_PUBLIC_KEY="${this._state.vapidKeys.publicKey}"`);
      log.warn(`  QU_VAPID_PRIVATE_KEY="${this._state.vapidKeys.privateKey}"`);
    }

    const httpRouter = this.runtime.resolve('httpRouter');
    this._httpServer = createServer((req, res) => httpRouter.handle(req, res));
    this._wss = new WebSocketServer({ server: this._httpServer });
    await new Promise((resolve) => this._httpServer.listen(this.options.port, resolve));

    const settings = await getSettings(this.qu);
    this.transport = new WebSocketServerTransport(this._wss, { maxMessagesPerMinute: settings.rateLimits.maxMessagesPerMinute });
    this._state.transport = this.transport;

    const presence = this.runtime.resolve('presence');
    this.sync = new SyncEngine(this.qu, this.transport, {
      onPeerIdentified: (_peerId, actorPub) => presence.recordSeen(actorPub),
    });

    // Push delivery fires for EVERY thread message write this relay ever
    // sees, whether authored locally (rare - the relay itself is never a
    // Thread participant in practice) or arriving via sync (the normal
    // case, since a browser client's messages sync TO this relay via
    // `publishAllTo`). Deliberately a plain `onStorageChange` listener
    // here, NOT inside SyncEngine - this has nothing to do with
    // replication, it's the relay noticing its own data changed, same as
    // any other reactive consumer.
    const pushDelivery = this.runtime.resolve('pushDelivery');
    this.qu.onStorageChange(({ path, quBit }) => {
      const match = path.match(/^\/store\/([^/]+)\/threads\/([^/]+)\/msgs\/([^/]+)$/);
      if (!match) return;
      const [, spaceId, threadId] = match;
      pushDelivery.deliverThreadMessage(spaceId, threadId, quBit).catch((err) => {
        log.error(`push delivery failed for ${path}:`, err);
      });
    });

    // Local apps first (dependency-ordered against each other via
    // discoverLocalPackages()'s pool - see QuLoader.loadLocal()), then any
    // configured remote apps - same order @qu/loader's own doc comment
    // describes ("a relay always loads its own local apps... and optionally
    // loads additional apps from remote manifest URLs").
    const localApps = await discoverLocalPackages(this.options.appsDir);
    for (const app of localApps) {
      await this.loader.loadLocal(app.dir, { availableManifests: localApps });
    }
    for (const remote of this.options.remoteApps) {
      await this.loader.loadRemote(remote.manifestUrl, { trustedPublisherPubs: remote.trustedPublisherPubs ?? [] });
    }

    // Publishes into the store what /apps.json has always served over
    // HTTP, so `apps/app-list` can watch it live via `<qu-list parent=...>`
    // instead of a one-shot fetch. Same `settings` already read above for
    // the rate limit - `disabledApps` can't have changed mid-boot.
    await publishAppsCatalog(this.qu, this.identity, this.loader, settings);

    log.info(`listening on http://localhost:${this.port} (peer ${this.transport.getPeerId()})`);
    log.info(`loaded apps: ${this.loader.listLoaded().join(', ') || '(none)'}`);
    return this;
  }

  /** Shuts down the HTTP/WebSocket server. */
  async close() {
    this.sync?.close();
    // Must terminate live connections before closing the servers - both
    // WebSocketServer.close() and http.Server.close() wait indefinitely for
    // existing connections to end on their own otherwise, so a single
    // still-connected peer would hang shutdown forever.
    this.transport?.closeAllPeers();
    await new Promise((resolve) => this._wss?.close(resolve));
    await new Promise((resolve) => this._httpServer?.close(resolve));
  }
}
