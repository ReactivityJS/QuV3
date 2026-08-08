import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { QuStore, QuCrypto } from '@qu/core';
import { FsAdapter } from '@qu/runtime/fs';
import { Registry, RuntimeContainer } from '@qu/foundation';
import { QuIdentityEngine } from '@qu/identity';
import { SyncEngine } from '@qu/sync';
import { AccessEngine, DocumentEngine, CollectionEngine, AssetEngine, ThreadEngine } from '@qu/engines';
import { ListService, AccessService, MessageService, NotificationPrefsService, PushSubscriptionService } from '@qu/services';

import { WebSocketServerTransport } from './transports/websocket-server-transport.js';
import { PresenceTracker } from './presence-tracker.js';
import { setupVapidKeys } from './vapid-key-store.js';
import { PushDeliveryService } from './push-delivery.js';
import { AdminHttp } from './admin-http.js';
import { HttpRouter } from './http-router.js';
import { getSettings } from './relay-settings.js';

/**
 * QU RELAY — a Node.js peer that persists to disk, syncs with other peers,
 * and delivers push notifications. This is the concrete "one server
 * process" composition root every other module in this package plugs into.
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
 * DELIBERATELY OUT OF SCOPE for this milestone (no `@qu/loader`/`apps/`
 * exist in V3 yet - see `http-router.js`'s own doc comment for the exact
 * routes this omits): app discovery/loading, static app serving, shell
 * serving, and the `apps.json` catalog. This relay stores data, replicates
 * it, and delivers push notifications - a real, complete slice, not a
 * placeholder waiting for those pieces.
 */
export class QuRelay {
  /**
   * @param {object} [options]
   * @param {string} [options.storeDir='./relay-data/store']
   * @param {string} [options.blobDir='./relay-data/blob']
   * @param {number} [options.port=8080]
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
   */
  constructor(options = {}) {
    this.options = {
      storeDir: './relay-data/store',
      blobDir: './relay-data/blob',
      port: 8080,
      adminPubs: [],
      vapidSubject: 'mailto:admin@example.com',
      resolveNotification: null,
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

    // Shared, mutable state `AdminHttp`/`HttpRouter` read fresh on every
    // request - `transport`/`vapidKeys` aren't known until partway through
    // `boot()` (see below), and by construction time here neither module's
    // factory has run yet either (RuntimeContainer factories are lazy).
    this._state = { transport: null, vapidKeys: null };

    this.runtime.register('presence', () => new PresenceTracker());
    this.runtime.register('adminHttp', () => new AdminHttp(this.qu, { adminPubs: this.options.adminPubs, storeDir: this.options.storeDir, blobDir: this.options.blobDir }, this._state));
    this.runtime.register('httpRouter', (rt) => new HttpRouter(this.qu, rt.resolve('adminHttp'), { adminPubs: this.options.adminPubs, state: this._state }));
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
   */
  async boot() {
    if (this.options.identityMnemonic) {
      await this.identity.importMnemonic(this.options.identityMnemonic);
    } else if (!(await this.identity.hasIdentity())) {
      await this.identity.importMnemonic(this.identity.generateMnemonic());
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
        console.error(`[QuRelay] push delivery failed for ${path}:`, err);
      });
    });

    console.log(`[QuRelay] listening on http://localhost:${this.port} (peer ${this.transport.getPeerId()})`);
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
