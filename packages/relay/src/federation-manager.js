import { QuCrypto } from '@qu/core';
import { LOCAL_ONLY_PREFIX } from '@qu/sync';
import { createLogger } from '@qu/log';
import { getSettings, saveSettings } from './relay-settings.js';
import { FederationTransport } from './transports/federation-transport.js';

const log = createLogger('FederationManager');

/**
 * FEDERATION MANAGER — relay-to-relay federation, built on the exact same
 * `@qu/sync` protocol client<->relay sync already uses (see this repo's own
 * design note: "relay-to-relay is nothing but client-to-relay, everything is
 * a peer, just with different roles"). Owns:
 *
 *   1. DIALING every admin-configured peer (`federation.peers[]` - see
 *      `relay-settings.js`) as an outbound WebSocket CLIENT of that peer's
 *      already-existing public sync endpoint - no separate federation port,
 *      no new server-side listener. See `FederationTransport`'s own doc
 *      comment for why this needs one `WebSocketClientTransport` per peer.
 *   2. The `relay-hello`/`relay-hello-ack` identity handshake (see
 *      `@qu/sync`'s `SyncEngine` constructor doc comment on those hooks) -
 *      trust-on-first-use pinning of a peer's `relayId` (its own already-
 *      public signing pubkey, the SAME one `/config.json`'s own `relayPub`
 *      already exposes - no new identity concept), persisted back into
 *      `federation.peers[].relayId` once learned so a later reconnect
 *      verifies against it instead of blindly re-trusting whoever answers.
 *      Symmetric: this also handles a peer relay DIALING INTO us (an
 *      ordinary inbound connection on the relay's own client-facing
 *      `SyncEngine` - see `handleRelayHello()`), since a federation link is
 *      just a WebSocket connection with `SyncEngine` on both ends, direction
 *      doesn't matter once it's open.
 *   3. Subscribing to each peer's configured `prefixes` + the reciprocal
 *      `fetchPrefix()` backfill on every (re)connect - eager replication,
 *      the exact "subscribe already implies an initial catch-up diff"
 *      pattern `SyncEngine.refreshSubscriptions()` already established for
 *      client<->relay, just driven per-peer here instead of generically
 *      (see `FederationTransport`'s own doc comment for why).
 *   4. Serving `SyncEngine`'s `onLocalMiss` hook - on-demand, hop-limited
 *      forwarding of a cache miss to whichever OTHER federation peers are
 *      currently connected (see `forward()`). Wired into BOTH this relay's
 *      client-facing engine (so an ordinary browser client's miss benefits
 *      from federation, not just relay-to-relay hops) and its own
 *      `federationSync` engine (so a forwarded miss can itself be forwarded
 *      one hop further, bounded by `hopLimit`).
 *   5. Reconciling live connections against `federation` settings changes -
 *      see `reconcile()`'s own doc comment for why this is a direct call
 *      from `admin-http.js`'s `handleSettings()`, not a storage-change
 *      watcher (no such pattern exists elsewhere in this codebase).
 *   6. Reconnect/backoff/dead-peer detection, and the client-learn flow
 *      (`probeRelayInfo()`/`suggestPeer()`) - see those methods' own doc
 *      comments.
 */
export class FederationManager {
  #qu;
  #identity;
  #federationTransport;
  #federationSync = null; // set via attachSyncEngine() - see its own doc comment for the circular-dependency ordering this resolves
  #peerConfigs = new Map(); // peerId (= url, for peers WE dial) -> {url, relayId, label, prefixes}
  #status = new Map(); // peerId -> {state: 'connecting'|'connected'|'backoff'|'dead'|'untrusted', attempts, lastError}
  #handshaked = new Map(); // peerId -> relayId - EITHER direction, populated by handleRelayHello() (inbound) or handleRelayHelloAck() (outbound)
  #hopLimit = 3;
  #hopTimeoutMs = 3000;
  #tryLimit = 10;
  #maxReconnectDelayMs = 30_000;

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('@qu/identity').QuIdentityEngine} identity - this relay's
   *   OWN identity (see `relay.js`) - its main Ed25519 key IS `relayId`
   *   (base64url pubkey, same value `/config.json`'s `relayPub` exposes),
   *   used to sign every `relay-hello`/`relay-hello-ack` this relay sends.
   */
  constructor(qu, identity) {
    this.#qu = qu;
    this.#identity = identity;
    this.#federationTransport = new FederationTransport();
  }

  /** @returns {FederationTransport} for `relay.js` to construct `federationSync` over (`new SyncEngine(qu, federationManager.transport, {...})`). */
  get transport() {
    return this.#federationTransport;
  }

  /**
   * Wires this manager to the `SyncEngine` constructed over its own
   * `transport` - a circular dependency (the engine needs `onLocalMiss`
   * bound to THIS instance to be constructed; this instance needs the
   * engine to actually call `subscribe()`/`fetchPrefix()`/`fetch()`)
   * resolved the same way `relay.js` resolves every other lazy pairing in
   * this codebase: construct the manager, construct the engine with
   * `onLocalMiss: (req) => manager.forward(req)`, then call this once.
   * @param {import('@qu/sync').SyncEngine} federationSync
   */
  attachSyncEngine(federationSync) {
    this.#federationSync = federationSync;
  }

  /**
   * Reconciles live federation connections against the current
   * `federation` settings (see `relay-settings.js`) - adds a
   * `WebSocketClientTransport` for every newly-configured peer, tears one
   * down for every removed one, updates `hopLimit`/`hopTimeoutMs`/`tryLimit`
   * live. Called directly from `admin-http.js`'s `handleSettings()` right
   * after a settings save that touched `federation` - this codebase has no
   * `qu.onStorageChange`-based settings-reconciliation pattern anywhere
   * (verified against the actual code, not assumed) - the real, only
   * precedent for "a settings change takes live effect" is exactly this
   * kind of direct call (see that same method's `rateLimits`/`disabledApps`
   * handling), so federation follows it rather than inventing a new
   * mechanism. Also called once at boot (see `relay.js`) with whatever
   * `federation` settings already exist.
   * @param {object} federationSettings - see `relay-settings.js`'s
   *   `DEFAULT_RELAY_SETTINGS.federation` for the shape.
   */
  async reconcile(federationSettings) {
    this.#hopLimit = federationSettings.hopLimit ?? 3;
    this.#hopTimeoutMs = federationSettings.hopTimeoutMs ?? 3000;
    this.#tryLimit = federationSettings.tryLimit ?? 10;

    const configuredUrls = new Set();
    for (const peer of federationSettings.peers ?? []) {
      if (typeof peer?.url !== 'string' || !peer.url) continue;
      configuredUrls.add(peer.url);
      const existing = this.#peerConfigs.get(peer.url);
      this.#peerConfigs.set(peer.url, {
        url: peer.url,
        relayId: peer.relayId ?? null,
        label: peer.label ?? peer.url,
        prefixes: Array.isArray(peer.prefixes) ? peer.prefixes : [],
      });
      // A peer already dialed keeps its live connection - only its config
      // (prefixes, pinned relayId) changed, not its identity as "a peer we
      // should be connected to". A brand new peer gets dialed for the first
      // time; new prefixes on an ALREADY-connected+handshaked peer are
      // subscribed immediately too, not just on the next reconnect.
      if (!existing) {
        this.#connectPeer(peer.url);
      } else if (this.#handshaked.has(peer.url)) {
        this.#subscribeConfiguredPrefixes(peer.url);
      }
    }

    for (const peerId of this.#federationTransport.peerIds()) {
      if (!configuredUrls.has(peerId)) this.#teardownPeer(peerId);
    }
  }

  /** @param {string} peerId (a url, for a peer we ourselves dial) */
  #teardownPeer(peerId) {
    this.#federationTransport.removePeer(peerId);
    this.#peerConfigs.delete(peerId);
    this.#status.delete(peerId);
    this.#handshaked.delete(peerId);
  }

  /**
   * Dials `peerId` (its configured url), and wires the reconnect/backoff/
   * dead-detection + handshake lifecycle onto the returned
   * `WebSocketClientTransport` directly - NOT through `SyncEngine`'s own
   * generic `onReconnect()` (see `FederationTransport`'s own doc comment for
   * why: that hook can't tell WHICH of potentially many peers reconnected).
   * @param {string} peerId
   */
  #connectPeer(peerId) {
    const config = this.#peerConfigs.get(peerId);
    const transport = this.#federationTransport.addPeer(peerId, config.url, { maxReconnectDelayMs: this.#maxReconnectDelayMs });
    this.#status.set(peerId, { state: 'connecting', attempts: 0, lastError: null });

    transport.onReconnect(() => {
      // A fresh (or re-established) connection has no memory of any
      // previous handshake on this peerId - see WebSocketClientTransport's
      // own doc comment on why a reconnect is a BRAND NEW connection as far
      // as the remote side is concerned. Re-handshake from scratch.
      this.#handshaked.delete(peerId);
      this.#status.set(peerId, { state: 'connecting', attempts: 0, lastError: null });
      this.#sendHello(peerId).catch((err) => log.warn(`failed to send relay-hello to ${peerId}:`, err.message));
    });

    transport.onReconnectAttempt((attempt) => {
      const dead = attempt >= this.#tryLimit;
      this.#status.set(peerId, { state: dead ? 'dead' : 'backoff', attempts: attempt, lastError: null });
      if (dead) {
        log.warn(`peer ${config.url} exceeded try-limit (${this.#tryLimit}) - marking dead, stopping auto-reconnect (see retryPeer() to re-arm)`);
        transport.close();
      }
    });

    transport.connect().catch((err) => {
      log.warn(`initial connect to ${config.url} failed (will retry with backoff):`, err.message);
    });
  }

  /**
   * Re-arms a `dead` peer (see `#connectPeer()`'s own `onReconnectAttempt`
   * handling) - re-dials it with a fresh attempt counter. A dead peer stays
   * fully CONFIGURED (never silently dropped from `federation.peers[]`) so
   * an admin can retry it later without re-entering its URL - see this
   * class's own top doc comment.
   * @param {string} peerId
   * @returns {boolean} Whether `peerId` is a currently-configured peer at all.
   */
  retryPeer(peerId) {
    if (!this.#peerConfigs.has(peerId)) return false;
    this.#connectPeer(peerId); // addPeer() closes+replaces the existing (dead) transport first - see FederationTransport
    return true;
  }

  /** @param {string} peerId */
  async #sendHello(peerId) {
    const hello = await this.#buildOwnHello();
    this.#federationTransport.sendTo(peerId, { type: 'relay-hello', ...hello });
  }

  /**
   * The `GET /relay-info` HTTP route's own payload (see `http-router.js`) -
   * this relay's own signed identity, so ANOTHER relay's `probeRelayInfo()`
   * can confirm "this URL is a genuine Qu relay" before an admin adds it
   * (or a client suggests it) as a peer. Deliberately unauthenticated on the
   * HTTP side (like `/config.json`) - `relayId` is public by definition
   * (this relay's own signing pubkey), and the signature only ever proves
   * "controls the matching private key", not that the caller should be
   * trusted (see `#verifyHelloSignature()`'s own doc comment).
   * @returns {Promise<{relayId: string, ts: number, sig: string, quProtocolVersion: number}>}
   */
  async getRelayInfo() {
    return { ...(await this.#buildOwnHello()), quProtocolVersion: 1 };
  }

  /** @returns {Promise<{relayId: string, ts: number, sig: string}>} This relay's own signed hello/probe payload - shared by `relay-hello`, `relay-hello-ack`, and the `/relay-info` HTTP probe (see `http-router.js`), all three sign the exact same `{relayId, ts}` shape. */
  async #buildOwnHello() {
    const mainKey = await this.#identity.getMainKey();
    const relayId = QuCrypto.toBase64Url(mainKey.publicKey);
    const ts = Date.now();
    const sig = QuCrypto.toBase64Url(await QuCrypto.sign(new TextEncoder().encode(JSON.stringify({ relayId, ts })), mainKey.privateKeyPkcs8));
    return { relayId, ts, sig };
  }

  /**
   * @param {{relayId?: string, ts?: number, sig?: string}} message
   * @returns {Promise<boolean>} Whether `sig` verifies as `relayId`'s own
   *   signature over `{relayId, ts}` - the same shape `#buildOwnHello()`
   *   signs. Shared by `relay-hello`, `relay-hello-ack`, AND
   *   `probeRelayInfo()`'s HTTP response - all three are "prove you control
   *   the private key for this relayId", nothing more (this does NOT mean
   *   the caller should be trusted - see `handleRelayHello()`'s own
   *   blacklist check and `handleRelayHelloAck()`'s own pinning check for
   *   the actual trust decisions built on top of a verified signature).
   */
  async #verifyHelloSignature({ relayId, ts, sig }) {
    if (typeof relayId !== 'string' || typeof ts !== 'number' || typeof sig !== 'string') return false;
    try {
      return await QuCrypto.verify(
        new TextEncoder().encode(JSON.stringify({ relayId, ts })),
        QuCrypto.fromBase64Url(sig),
        QuCrypto.fromBase64Url(relayId)
      );
    } catch {
      return false; // malformed base64/signature - treat exactly like "did not verify", same convention as isAuthentic()/#verifyAdmin() elsewhere in this codebase
    }
  }

  /**
   * Handles an incoming `relay-hello` - wired as the relay's CLIENT-FACING
   * `SyncEngine`'s (`this.sync` in `relay.js`) `onRelayHello` hook, so this
   * fires for a peer relay that dialed INTO us (see this class's own top
   * doc comment - federation links are symmetric). Verifies the signature,
   * checks the blacklist, then replies with our OWN signed
   * `relay-hello-ack` over the SAME connection the hello arrived on -
   * NEVER via `federationTransport` (we didn't dial this peer, we have no
   * outbound transport entry for it).
   * @param {{relayId: string, ts: number, sig: string}} message
   * @param {string} peerId - the INBOUND connection's own transport-assigned id.
   * @param {import('@qu/sync').Transport} replyTransport - `relay.js`'s own
   *   client-facing `WebSocketServerTransport` (`this.transport`) - passed
   *   in rather than captured at construction time, since this manager has
   *   no other reason to know about the client-facing transport at all.
   */
  async handleRelayHello(message, peerId, replyTransport) {
    if (!(await this.#verifyHelloSignature(message))) {
      log.warn(`rejected relay-hello from connection ${peerId}: signature does not verify`);
      return;
    }
    if (await this.#isBlacklisted(message.relayId)) {
      log.warn(`rejected relay-hello from ~${message.relayId.slice(0, 10)}…: blacklisted`);
      return;
    }
    this.#handshaked.set(peerId, message.relayId);
    const ack = await this.#buildOwnHello();
    replyTransport.sendTo(peerId, { type: 'relay-hello-ack', ...ack });
    log.info(`relay-hello accepted from ~${message.relayId.slice(0, 10)}… (connection ${peerId})`);
  }

  /**
   * Handles an incoming `relay-hello-ack` - the DIALING side's confirmation
   * of whichever peer it just sent a `relay-hello` to (see `#sendHello()`).
   * Trust-on-first-use: a peer configured with no `relayId` pinned yet
   * accepts and PERSISTS whatever verified identity answers (see
   * `#persistPinnedRelayId()`); a peer with an ALREADY pinned `relayId`
   * that doesn't match is refused outright (protects against a URL being
   * quietly repointed at a different relay after the fact). Once trusted,
   * subscribes to this peer's configured prefixes + fetchPrefix backfill -
   * eager replication only ever starts once a peer's identity is confirmed.
   * @param {{relayId: string, ts: number, sig: string}} message
   * @param {string} peerId - always a url here, see `#connectPeer()`.
   */
  async handleRelayHelloAck(message, peerId) {
    if (!(await this.#verifyHelloSignature(message))) {
      log.warn(`rejected relay-hello-ack from ${peerId}: signature does not verify`);
      return;
    }
    const config = this.#peerConfigs.get(peerId);
    if (!config) return; // reconcile() already removed this peer - ignore a late-arriving ack
    if (config.relayId && config.relayId !== message.relayId) {
      log.warn(`relay-hello-ack from ${config.url} claims ~${message.relayId.slice(0, 10)}…, pinned identity is ~${config.relayId.slice(0, 10)}… - refusing to trust this connection`);
      this.#status.set(peerId, { state: 'untrusted', attempts: 0, lastError: 'relayId mismatch' });
      return;
    }
    if (!config.relayId) {
      config.relayId = message.relayId;
      await this.#persistPinnedRelayId(config.url, message.relayId).catch((err) => log.error('failed to persist pinned relayId:', err));
    }
    this.#handshaked.set(peerId, message.relayId);
    this.#status.set(peerId, { state: 'connected', attempts: 0, lastError: null });
    log.info(`federation link to ${config.url} authenticated as ~${message.relayId.slice(0, 10)}…`);
    this.#subscribeConfiguredPrefixes(peerId);
  }

  /** @param {string} peerId */
  #subscribeConfiguredPrefixes(peerId) {
    const config = this.#peerConfigs.get(peerId);
    if (!config || !this.#federationSync) return;
    for (const prefix of config.prefixes) {
      this.#federationSync.subscribe(prefix, peerId);
      // Reciprocal catch-up - same "subscribe only ever delivers FUTURE
      // writes" gap `SyncEngine.fetchPrefix()`'s own doc comment describes,
      // closed here per-peer exactly like `refreshSubscriptions()` already
      // closes it for a single-peer client engine.
      this.#federationSync.fetchPrefix(prefix, peerId).catch((err) => {
        log.warn(`fetchPrefix("${prefix}") from ${config.url} failed:`, err.message);
      });
    }
  }

  /** @param {string} url @param {string} relayId */
  async #persistPinnedRelayId(url, relayId) {
    const settings = await getSettings(this.#qu);
    const peers = (settings.federation.peers ?? []).map((p) => (p.url === url ? { ...p, relayId } : p));
    await saveSettings(this.#qu, { federation: { ...settings.federation, peers } });
  }

  /**
   * @param {string} value - either a `relayId` (pubkey) or a url - the
   * blacklist is a flat list that may contain either form (a URL isn't
   * known yet for an inbound `relay-hello`, only its `relayId` is - see
   * `handleRelayHello()`'s own call site; `suggestPeer()` checks both forms
   * for the same URL/relayId pair for defense in depth).
   * @returns {Promise<boolean>}
   */
  async #isBlacklisted(value) {
    const settings = await getSettings(this.#qu);
    return (settings.federation.blacklist ?? []).includes(value);
  }

  /**
   * @param {string} peerId
   * @returns {boolean} Whether `peerId` (either direction - a url we dialed,
   *   or an inbound connection id) has completed a verified `relay-hello`
   *   handshake. Consulted only for logging/status today - `forward()`
   *   deliberately does NOT gate on this (see its own doc comment for why):
   *   this exists for the admin UI's own peer status display.
   */
  isKnownPeer(peerId) {
    return this.#handshaked.has(peerId);
  }

  /**
   * `SyncEngine`'s `onLocalMiss` hook (see its constructor's own doc
   * comment) - RELAY FEDERATION ON-DEMAND QUERY ROUTING. Wired into BOTH
   * this relay's client-facing engine and `federationSync` (see `relay.js`),
   * so this fires for an ordinary browser client's cache miss just as much
   * as for a miss forwarded here BY another federated relay.
   *
   * DELIBERATELY NOT GATED on `isKnownPeer(excludePeerId)` - this codebase
   * has no read/subscribe authorization layer at all today (any connected
   * peer may already `subscribe()` to anything not under
   * `LOCAL_ONLY_PREFIX`), so extending that same openness to "may also
   * trigger a hop-limited forwarded fetch" is not a new privilege, just
   * more of the same one this relay already grants every connection. The
   * hop-limit itself (see below) is the actual resource bound, not peer
   * identity.
   *
   * @param {{kind: 'request'|'prefix-request', path?: string, prefix?: string, hops: number|null, excludePeerId: string}} req -
   *   `hops` is exactly `SyncEngine`'s own three-valued contract (see
   *   `#handleRequest`'s doc comment): `null` means "a fresh miss, not yet
   *   part of a forwarding chain" - THIS method is the one place that turns
   *   that into a concrete starting budget (`hopLimit`), a number means
   *   "already `hopLimit - N` hops in, this many left".
   * @returns {Promise<object|Array|null>} A QuBit (for `kind: 'request'`),
   *   an entries array (for `kind: 'prefix-request'`), or `null`/nothing found.
   */
  async forward({ kind, path, prefix, hops, excludePeerId }) {
    if (!this.#federationSync) return null;
    const budget = hops == null ? this.#hopLimit : hops;
    if (budget <= 0) return null;

    const candidates = this.#federationTransport.peerIds().filter((peerId) => peerId !== excludePeerId && this.#handshaked.has(peerId));
    if (candidates.length === 0) return null;

    if (kind === 'request') {
      const results = await Promise.all(
        candidates.map((peerId) => this.#federationSync.fetch(path, peerId, this.#hopTimeoutMs, budget - 1).catch(() => null))
      );
      return results.find((quBit) => quBit != null) ?? null;
    }

    // 'prefix-request': fetchPrefix() persists matches straight into the
    // SAME QuStore this relay's own #handleRequest/#handlePrefixRequest
    // reads from (federationSync and the client-facing engine are two
    // SyncEngine instances over ONE shared `qu` - see relay.js), and
    // returns a merged COUNT, not the raw entries (see fetchPrefix()'s own
    // doc comment) - so answering is "pull into local storage, then
    // re-read locally", not relaying entries hop-by-hop. Re-applies the
    // SAME LOCAL_ONLY_PREFIX filter #handlePrefixRequest's own local read
    // already applies - required here too, since this result REPLACES that
    // filtered read rather than merging with it (see `#handlePrefixRequest`'s
    // own call site).
    await Promise.all(
      candidates.map((peerId) => this.#federationSync.fetchPrefix(prefix, peerId, this.#hopTimeoutMs, budget - 1).catch(() => 0))
    );
    const raw = await this.#qu.getAllUnderMount(prefix);
    const entries = raw.filter(({ path: p }) => !p.startsWith(LOCAL_ONLY_PREFIX));
    return entries.length > 0 ? entries : null;
  }

  /**
   * "Is this URL a genuine Qu relay?" probe - `GET <url>/relay-info` (see
   * `http-router.js`), verified against the SAME signature shape
   * `#verifyHelloSignature()` already checks for the wire handshake. Used by
   * both the admin UI's manual "add peer" flow and `suggestPeer()` below -
   * proves "something at this URL controls the private key for the
   * `relayId` it claims", nothing about whether it should be TRUSTED (that
   * decision is `autoLearn`/blacklist/admin-approval, layered on top).
   * @param {string} url
   * @returns {Promise<{relayId: string, ts: number, sig: string, quProtocolVersion?: number}>}
   * @throws {Error} If unreachable, not JSON, or the signature doesn't verify.
   */
  async probeRelayInfo(url) {
    const infoUrl = new URL('/relay-info', url).toString();
    let res;
    try {
      res = await fetch(infoUrl, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      throw new Error(`could not reach ${infoUrl}: ${err.message}`);
    }
    if (!res.ok) throw new Error(`relay-info probe failed: HTTP ${res.status}`);
    const body = await res.json();
    if (!(await this.#verifyHelloSignature(body))) {
      throw new Error('relay-info signature does not verify - not a genuine Qu relay (or a spoofed/misconfigured one)');
    }
    return body;
  }

  /**
   * CLIENT-LEARNED PEER FLOW - a client app (see `http-router.js`'s
   * `POST /federation/suggest`) reports a foreign relay URL it learned
   * about (e.g. shared by a user) to ITS OWN relay. Probes it (see
   * `probeRelayInfo()`), checks the blacklist, then either adds it straight
   * to `federation.peers[]` (if `autoLearn` is on) or queues it in
   * `federation.pending[]` for an admin to approve/reject via the admin UI -
   * see `relay-settings.js`'s own doc comment on why `autoLearn` defaults
   * to OFF.
   * @param {string} url
   * @param {string} suggestedBy - the reporting client's own actor pubkey.
   * @returns {Promise<{status: 'added'|'pending'|'already-known'}>}
   * @throws {Error} If `probeRelayInfo()` throws (not a genuine Qu relay),
   *   or the URL is blacklisted.
   */
  async suggestPeer(url, suggestedBy) {
    const settings = await getSettings(this.#qu);
    const federation = settings.federation;
    if ((federation.blacklist ?? []).includes(url)) {
      throw new Error('this relay URL is blacklisted on this relay');
    }
    if ((federation.peers ?? []).some((p) => p.url === url) || (federation.pending ?? []).some((p) => p.url === url)) {
      return { status: 'already-known' };
    }

    const info = await this.probeRelayInfo(url); // throws if unreachable/not a genuine Qu relay
    if ((federation.blacklist ?? []).includes(info.relayId)) {
      throw new Error('this relay is blacklisted on this relay (by relayId)');
    }

    if (federation.autoLearn) {
      const peers = [...(federation.peers ?? []), { url, relayId: info.relayId, label: url, prefixes: [], addedAt: Date.now(), addedBy: suggestedBy, source: 'client-learned' }];
      const merged = await saveSettings(this.#qu, { federation: { ...federation, peers } });
      await this.reconcile(merged.federation);
      return { status: 'added' };
    }

    const pending = [...(federation.pending ?? []), { url, relayId: info.relayId, suggestedBy, suggestedAt: Date.now() }];
    await saveSettings(this.#qu, { federation: { ...federation, pending } });
    return { status: 'pending' };
  }

  /** @returns {Array<{url: string, relayId: string|null, label: string, prefixes: string[], state: string, attempts: number, lastError: string|null, handshaked: boolean}>} Live status for the admin UI - see `apps/relay-admin/client.js`'s own federation section. */
  getStatus() {
    return [...this.#peerConfigs.values()].map((config) => ({
      ...config,
      ...(this.#status.get(config.url) ?? { state: 'connecting', attempts: 0, lastError: null }),
      handshaked: this.#handshaked.has(config.url),
    }));
  }

  /** Closes every federation connection - called from `relay.js`'s own `close()` during shutdown. */
  close() {
    this.#federationTransport.closeAll();
  }
}
