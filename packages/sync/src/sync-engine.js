import { QuCrypto } from '@qu/core';
import { assertWriteAuthorized } from '@qu/engines';

/**
 * Any path under this prefix never leaves the local device via SyncEngine,
 * regardless of what any peer subscribed to (checked at broadcast AND at
 * incoming-write time - see the two checks below, not just one). This is
 * the one hard-coded safety rail in an otherwise fully generic replication
 * layer: `@qu/identity`'s master seed lives at `/store/secure/identity/seed`
 * written with NO signWith/encryptWith - by design, since encrypting it
 * with a Qu key derived FROM itself would be circular. That makes it the
 * one piece of data in this whole system that must never be replicated
 * anywhere, under any subscription - a client broadly subscribing (or
 * being subscribed to) for "everything under /store" must not be able to
 * accidentally leak or receive it. Any future local-only secret should live
 * under this same prefix to get this guarantee for free.
 */
export const LOCAL_ONLY_PREFIX = '/store/secure/';

/**
 * @param {object} quBit
 * @returns {Promise<boolean>} Whether an author claim on this QuBit
 *   actually checks out. A QuBit with no `sig` makes no authorship claim at
 *   all (plenty of legitimate app data is written unsigned) and is
 *   accepted as-is: sync doesn't retroactively demand authenticity nothing
 *   ever promised. A QuBit WITH a `sig` (and/or `pub`) IS making a claim -
 *   "actor X wrote this exact value" - and that claim must cryptographically
 *   check out or the write is rejected outright, since accepting an
 *   unverified `pub`+`sig` pair from the wire would let any connected peer
 *   forge writes under someone else's identity (e.g. a fabricated Thread
 *   message attributed to a real, unrelated actor).
 */
async function isAuthentic(quBit) {
  if (!quBit.sig) return true;
  if (!quBit.pub) return false; // a signature with no claimed signer can never verify
  try {
    const payload = JSON.stringify({ path: quBit.path, val: quBit.val, ts: quBit.ts, pub: quBit.pub });
    return await QuCrypto.verify(
      new TextEncoder().encode(payload),
      QuCrypto.fromBase64(quBit.sig),
      QuCrypto.fromBase64(quBit.pub)
    );
  } catch {
    return false; // malformed base64, wrong-length key, etc. - treat exactly like "did not verify"
  }
}

/**
 * SYNC ENGINE — path-based pub/sub replication between Qu peers.
 *
 * Three things happen here:
 *   1. Local writes are broadcast to subscribers. SyncEngine listens on
 *      QuStore's notify bus (`qu.onStorageChange`, see `@qu/core`'s
 *      `store.js`) - it is NOT part of the value-transform pipeline, so a
 *      network hiccup here can never affect what gets written locally.
 *   2. Incoming QuBits from peers - whether pushed via sync, returned as a
 *      `fetch()`/`fetchPrefix()` response, or otherwise handed to us by a
 *      peer we do not control - are written straight to the mounted
 *      adapter, bypassing QuStore's seal step: a QuBit arriving this way
 *      already carries its own original signature/timestamp; re-signing it
 *      locally would forge a new signature from data we didn't actually
 *      write. EVERY one of these paths runs through the SAME gate,
 *      `#validateIncomingWrite()` (see its own doc comment below), before
 *      anything is persisted. A synced write is additionally re-broadcast
 *      to this peer's OWN subscribers (excluding whoever just sent it)
 *      once accepted, so a relay acts as a genuine hub - not just a
 *      dead-end recipient - for however many clients are subscribed to it.
 *   3. `fetch(path)`/`fetchPrefix(prefix)` let a peer explicitly request
 *      value(s) it doesn't have yet (e.g. after subscribing, to backfill
 *      history) - answered by whatever the OTHER side's adapter happens to
 *      hold, which this side must never blindly trust just because it
 *      asked for it (see `#validateIncomingWrite()`).
 *
 * INCOMING-WRITE VALIDATION (docs/v3-technical-concept.md §3.3, V3
 * milestone #1, since broadened beyond just sync) — every path that can
 * cause a network-originated QuBit to be persisted (`#handleSync`,
 * `#handleResponse`/`fetch()`, `fetchPrefix()`) runs `#validateIncomingWrite()`,
 * which throws unless the QuBit is well-formed, its OWN `path` field
 * matches the path it's being persisted under, its signature verifies, AND
 * `@qu/engines`' `assertWriteAuthorized()` - the exact same decision
 * `AccessEngine` makes for a LOCALLY-originated `put()` - accepts the
 * writer for this path (see that method's own doc comment for why each
 * check exists). This closes a real, confirmed gap in the prototype this
 * is rebuilt from: `AccessEngine` only ever ran as part of `QuStore.put()`'s
 * TRANSFORM step, which `#persistDirectly()`'s `putSealed()` call
 * deliberately bypasses (see point 2 above) - so a network-originated write
 * used to be able to reach the adapter with no write-ACL check at all
 * (`#handleSync`'s old behavior), or with no authenticity check at all
 * (`fetch()`/`fetchPrefix()`'s old behavior), meaning a peer this side
 * merely talks to - not necessarily trusts - could write to, or splice
 * validly-signed-but-misplaced content onto, any resource it could reach.
 * A write that fails validation is rejected silently for sync (not
 * persisted, not acked, not re-broadcast - exactly as if it had never
 * arrived, no different information leaked to the sender than any other
 * dropped message), rejects the caller's own pending promise for `fetch()`,
 * and is skipped (uncounted) for `fetchPrefix()`.
 *
 * What this does NOT (and structurally cannot) cover: a peer's own
 * genuinely-authorized write, once accepted, is exactly as re-broadcastable
 * as before - this is authorization for WRITES, not a content firewall. And
 * a synced write reaching an ENCRYPTED (non-`'*'`-readers) Thread that a
 * bypassing writer was never authorized for still isn't READABLE by real
 * readers even if it somehow got persisted (it wouldn't be a valid
 * ciphertext for any of them) - defense in depth, not a reason this check
 * would have been optional.
 *
 * Compared to the original prototype, this version drops the defensive
 * "maybe pub/sig arrived as a Buffer, maybe as a plain object, let's guess"
 * conversion layer: `@qu/core`'s `QuStore` always produces `pub`/`sig` as
 * base64 strings (see `store.js`'s `#seal`), so a QuBit is always trivially
 * JSON-safe. The only remaining validation is a cheap shape check on
 * incoming network data.
 */
export class SyncEngine {
  #qu;
  #transport;
  #publishAllTo;
  #subscriptions = new Map(); // path/prefix -> Set<peerId> (subscribers TO us)
  #mySubscriptions = new Map(); // path/prefix -> targetPeerId (subscriptions WE made, see subscribe() below)
  #pendingRequests = new Map(); // requestId -> {resolve, reject, timeout}
  #pendingPrefixRequests = new Map(); // requestId -> {resolve, reject, timeout} - see fetchPrefix()
  #lastAckedTs = new Map(); // path -> highest sync-ack ts seen - see waitForAck()
  #ackWaiters = new Map(); // path -> Array<{ts, resolve, timeout}> - see waitForAck()
  #requestCounter = 0;
  #unsubscribeLocalWrites;
  #generation = 0;
  #reconnectCallbacks = []; // app-level onReconnect() listeners (see below) - separate from the transport's OWN reconnect hook, which this class already consumes internally to replay subscriptions
  #outbox; // see outbox.js - only ever set for a publishAllTo (client) SyncEngine
  #onPeerIdentified; // see constructor's own doc comment
  #onLocalMiss; // see constructor's own doc comment - relay federation on-demand forwarding
  #onRelayHello; // see constructor's own doc comment - relay federation handshake
  #onRelayHelloAck; // see constructor's own doc comment - relay federation handshake
  #onExternalPersist; // see constructor's own doc comment - relay federation cross-engine live bridge
  #recentBroadcasts = new Map(); // "path:ts" -> expiry ms - see #shouldSkipRebroadcast()
  #prefixWatermarks = new Map(); // prefix -> highest ts confirmed by a whole completed fetchPrefix() response batch for that prefix - see #bumpWatermark()/fetchPrefix()'s own `sinceTs` doc comment. NOT "highest ts ever persisted" - deliberately narrower, see #bumpWatermark()'s own doc comment for why.
  #fullSyncDone = new Set(); // "targetPeerId:prefix" keys (same shape as #mySubscriptions) for which a sinceTs:null full catch-up has completed at least once - see refreshSubscriptions()

  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('./transport.js').Transport} transport
   * @param {{publishAllTo?: string, outbox?: import('./outbox.js').OutboxStore, onPeerIdentified?: (peerId: string, actorPub: string) => void}} [options] -
   *   `publishAllTo`: ALWAYS forward every local write (except
   *   `LOCAL_ONLY_PREFIX`) to this one peerId, unconditionally - no
   *   subscription round-trip required. This is what a star-topology
   *   CLIENT (a browser shell talking to its one relay) should set:
   *   `subscribe()` only ever covers what the REMOTE side later decides to
   *   tell you about (and requires that round-trip to complete first),
   *   which creates an unavoidable race for anything the CLIENT itself
   *   writes very early (e.g. a brand-new identity's own public profile,
   *   published the moment it's created) - if that write happens before
   *   the relay's own subscribe-back message has arrived,
   *   subscription-based broadcasting would silently drop it. Unconditional
   *   publish to a known, single upstream peer has no such race: it works
   *   the instant the transport is connected. Left unset (the default) for
   *   relay-to-relay peering, where publishing EVERYTHING unconditionally
   *   to whoever merely connected would be too permissive - that direction
   *   stays exactly as explicit/subscription-based as before.
   *   `outbox`: an `OutboxStore` (see outbox.js) that persistently records
   *   every `publishAllTo` write until it's acknowledged, and gets replayed
   *   on every (re)connect - closes the one gap the transport's own
   *   in-memory send queue can't (a reload while offline). Only meaningful
   *   together with `publishAllTo`; ignored otherwise.
   *   `onPeerIdentified(peerId, actorPub)`: called whenever an incoming
   *   synced write's signature verifies (see `#handleSync`'s `isAuthentic()`
   *   check) - `actorPub` is therefore never spoofable, it's exactly as
   *   trustworthy as any other signed QuBit in this codebase. This is a
   *   PASSIVE, free side effect of traffic that's already happening (no new
   *   wire message, no handshake) - a relay can use it to learn "which
   *   peerId belongs to which actor" from the writes it already receives
   *   (e.g. a thread-presence heartbeat, same as any other signed write),
   *   for things like deciding whether a push notification is redundant
   *   because the recipient is visibly still connected. Left unset (the
   *   default) for a peer with no reason to care who's connected, e.g. a
   *   plain client SyncEngine.
   *   `onLocalMiss({kind, path, prefix, hops, excludePeerId})`: consulted by
   *   `#handleRequest`/`#handlePrefixRequest` when a `request`/
   *   `prefix-request` arrives for something this peer doesn't have locally
   *   AND `hops !== 0` (see `#handleRequest`'s own doc comment for the full
   *   `null`-vs-`0`-vs-number contract) - relay federation's on-demand query
   *   routing. Left unset (the default) for any SyncEngine with nothing else
   *   to forward to (a plain client, or a relay's own client-facing engine
   *   before federation is wired in) - a miss is then simply answered
   *   `null`/empty, identical to today's behavior. Returns the QuBit (for
   *   `kind: 'request'`) or an entries array (for `kind: 'prefix-request'`),
   *   or `null`/nothing found - this class has no opinion on HOW the hook
   *   fills the miss (which peers it asks, whether it decides to ask
   *   anyone at all), it only ever offers the hook a miss to fill.
   *   `onRelayHello(message, peerId)` / `onRelayHelloAck(message, peerId)`:
   *   dispatched verbatim for the two wire messages relay federation adds
   *   (see `#handleIncoming`) - this class does not verify, sign, or reply
   *   to either one itself; it has no relay identity/signing key of its own
   *   to do so with. Left unset (the default) means these message types are
   *   simply ignored, same as any other unknown `type` used to be.
   *   `onExternalPersist(path, quBit)`: called every time `#persistDirectly()`
   *   actually writes a NEW value (from `#handleSync`, `#handleResponse`/
   *   `fetch()`, or `fetchPrefix()`'s merge loop - all three funnel through
   *   that one method), regardless of which of the three triggered it. A
   *   relay running TWO independent `SyncEngine` instances over the SAME
   *   `QuStore` (`this.sync` for local browser clients, `federationSync`
   *   for outbound federation peer links - see `@qu/relay`'s `relay.js`)
   *   needs this to bridge the two: each engine's own `#subscriptions` map
   *   only ever holds ITS OWN peers, so a write persisted by ONE engine is
   *   otherwise invisible to the OTHER engine's subscribers - the
   *   `origin==='sync'` check on this class's own `onStorageChange`
   *   listener (below) exists specifically to stop an engine re-broadcasting
   *   a write IT ITSELF already handled via `#handleSync`'s own explicit
   *   broadcast, which means it also (as an unavoidable side effect of using
   *   the same flag) hides a write handled by a DIFFERENT engine sharing
   *   this `qu`. `relay.js` wires each engine's `onExternalPersist` to call
   *   the OTHER engine's `rebroadcastLocally()` (see that method's own doc
   *   comment for why this is cycle-safe). Left unset (the default) for any
   *   SyncEngine with no sibling engine to bridge to (a plain client, or a
   *   relay before federation is wired in) - a no-op.
   */
  constructor(qu, transport, { publishAllTo = null, outbox = null, onPeerIdentified = null, onLocalMiss = null, onRelayHello = null, onRelayHelloAck = null, onExternalPersist = null } = {}) {
    this.#qu = qu;
    this.#transport = transport;
    this.#publishAllTo = publishAllTo;
    this.#outbox = outbox;
    this.#onPeerIdentified = onPeerIdentified;
    this.#onLocalMiss = onLocalMiss;
    this.#onRelayHello = onRelayHello;
    this.#onRelayHelloAck = onRelayHelloAck;
    this.#onExternalPersist = onExternalPersist;

    this.#unsubscribeLocalWrites = this.#qu.onStorageChange(async ({ path, quBit, origin }) => {
      // `origin === 'sync'` means this notify came from QuStore.putSealed()
      // (see its own doc comment) - i.e. THIS SyncEngine (or another one
      // sharing this qu instance) just persisted a write that arrived FROM
      // a peer, not a genuinely new local write. #handleSync already does
      // its own, correctly origin-EXCLUDED re-broadcast for that case right
      // after persisting - broadcasting it AGAIN here, with no origin to
      // exclude, would bounce the write straight back to whoever sent it,
      // which bounces it back again, forever.
      if (origin === 'sync') return;
      if (path.startsWith(LOCAL_ONLY_PREFIX)) return; // see LOCAL_ONLY_PREFIX doc comment above
      const message = { type: 'sync', path, quBit };
      if (this.#publishAllTo) {
        if (this.#outbox) {
          // Recorded BEFORE sending, and awaited here (QuEvents.emit awaits
          // every storage:put listener - see events.js - so this genuinely
          // delays QuStore.put()'s own resolution until the entry is
          // durable): a crash/reload between "sent" and "acknowledged" must
          // never lose the entry, only a crash/reload between "wrote
          // locally" and "recorded in the outbox" can (a strictly smaller
          // window than an in-memory-only queue, which loses anything not
          // yet flushed to an OPEN socket). A failed outbox write is
          // logged, not thrown - matching every other notify listener here,
          // a persistence hiccup in this side channel must never fail the
          // write itself.
          try {
            await this.#outbox.set(path, quBit);
          } catch (err) {
            console.error(`[SyncEngine] failed to record outbox entry for "${path}":`, err);
          }
        }
        this.#transport.sendTo(this.#publishAllTo, message);
      }
      this.#broadcastToSubscribers(path, message, this.#publishAllTo); // publishAllTo already got it above - never send it twice
    });

    this.#transport.onMessage(({ data, peerId }) => {
      if (!isPlainObject(data) || typeof data.type !== 'string') {
        console.warn('[SyncEngine] ignoring malformed message');
        return;
      }
      this.#handleIncoming(data, peerId);
    });

    // A reconnected transport is a BRAND NEW connection as far as the
    // remote side is concerned (see WebSocketClientTransport's own doc
    // comment on `onReconnect()` for why) - it has no memory of what we'd
    // previously asked it to subscribe us to. Only client-style transports
    // that can actually drop and reconnect implement this hook (duck-typed
    // check - a relay's server-side transport, which only ever accepts
    // connections rather than initiating/losing one of its own, doesn't).
    if (typeof this.#transport.onReconnect === 'function') {
      this.#transport.onReconnect(() => {
        // Fires on the very FIRST connect too (not just actual reconnects -
        // see WebSocketClientTransport's own `onReconnect()` doc comment),
        // which is exactly right: a fresh page load has the exact same
        // "local storage could be stale, this session has no idea what it
        // missed" problem a mid-session reconnect does. See
        // refreshSubscriptions()'s own doc comment for what this actually does.
        this.refreshSubscriptions();
        // OUTBOX REPLAY - the other half of the offline-robustness story
        // (see outbox.js): resend whatever is still unacknowledged from a
        // PREVIOUS connection, including one that ended in a reload (the
        // transport's own in-memory send queue can't do this - it's gone
        // the moment the page was). Also fires on the very first connect,
        // same reasoning as the generation bump above. Harmless if the
        // transport's own send queue already covers the same entry (a
        // mid-session drop-and-reconnect with no reload in between) -
        // `#persistDirectly`'s ts-guard on the receiving end makes a
        // duplicate resend a no-op, not a correctness issue, just a
        // redundant message in that common case.
        this.#replayOutbox();
        this.#replayPendingRequests();
        for (const cb of this.#reconnectCallbacks) cb();
      });
    }
  }

  /**
   * Re-sends every still-outstanding `fetch()`/`fetchPrefix()` request after
   * a reconnect - a REAL, previously-silent gap: a fresh reconnection is a
   * brand new connection as far as the remote side is concerned (same
   * reasoning `refreshSubscriptions()`/`#replayOutbox()` above already act
   * on), so a request sent moments before a drop is answered by nobody -
   * the relay that received it is gone, and the NEW connection has no idea
   * a request was ever made. Previously this just sat in
   * `#pendingRequests`/`#pendingPrefixRequests` until its own timeout fired
   * (10s/15s), degrading silently (every caller's own `.catch(() => {})`
   * swallows it - see e.g. `@qu/reactive`'s `watch()`/`watchChildren()`) to
   * whatever was already locally cached, resolved only by a full page
   * reload (a fresh connection, made before anything tries to fetch).
   * `#handleResponse()`/`#handlePrefixResponse()` already ignore a late or
   * duplicate response for a requestId no longer pending, so replaying a
   * request that's ALSO about to be answered by the original send (a
   * narrow race, not the common case) is harmless - never a double-resolve.
   */
  #replayPendingRequests() {
    for (const { message, targetPeerId } of this.#pendingRequests.values()) {
      if (targetPeerId) this.#transport.sendTo(targetPeerId, message);
      else this.#transport.send(message);
    }
    for (const { message, targetPeerId } of this.#pendingPrefixRequests.values()) {
      if (targetPeerId) this.#transport.sendTo(targetPeerId, message);
      else this.#transport.send(message);
    }
  }

  /** Resends every still-unacknowledged outbox entry to `publishAllTo`. See outbox.js. */
  async #replayOutbox() {
    if (!this.#outbox || !this.#publishAllTo) return;
    try {
      const entries = await this.#outbox.getAll();
      for (const { path, quBit } of entries) {
        this.#transport.sendTo(this.#publishAllTo, { type: 'sync', path, quBit });
      }
    } catch (err) {
      console.error('[SyncEngine] outbox replay failed:', err);
    }
  }

  /** Stops listening to local writes. Call when tearing down this SyncEngine. */
  close() {
    this.#unsubscribeLocalWrites();
  }

  /**
   * Manually triggers the SAME "bump the generation, resubscribe, reciprocal
   * catch-up" cycle a genuine transport reconnect already runs internally
   * (see the constructor's own `onReconnect` wiring, which now just calls
   * this) - WITHOUT touching the transport connection itself.
   *
   * Exists for one case a transport-level reconnect can't reliably detect on
   * its own: a mobile browser/app backgrounded and later foregrounded again
   * does NOT necessarily close the underlying socket - the OS may keep it
   * alive, or a flaky mobile network may let it go silently stale without
   * either side's TCP stack noticing right away. Either way, the JS event
   * loop itself was merely suspended while backgrounded, so no transport
   * 'close'/reconnect event ever fires - yet real time passed, and this
   * session has no idea what it missed. Confirmed live: a chat room left
   * mounted through a phone screen lock never picked up messages sent while
   * it was locked, even after unlocking - only leaving and re-entering the
   * room (a fresh mount, with its own one-time subscribe+catch-up) did.
   *
   * A caller (see `apps/shell/client.js`'s own `document.visibilitychange`
   * listener) should call this directly whenever the page becomes visible
   * again, treating that moment exactly like a real reconnect: bumping the
   * generation gives every Service's own per-generation background refresh
   * (`@qu/services`' `sync-freshness.js`) a fresh chance to re-verify
   * whatever it already has cached, and the reciprocal `fetchPrefix()` per
   * active subscription re-delivers anything a currently-mounted view's
   * `watchChildren()` missed (its own one-time `syncFetch` already fired
   * back at mount, long before this moment).
   *
   * Deliberately NOT bundled with outbox replay or `onReconnect()`
   * callbacks (see the constructor) - those are genuinely about a NEW
   * connection (there is nothing freshly "unacknowledged" to resend, and no
   * app-level "we just reconnected" signal to fire, just because the tab
   * became visible again on a connection that, as far as this class can
   * tell, never actually dropped).
   */
  refreshSubscriptions() {
    this.#generation++;
    for (const { prefix, targetPeerId } of this.#mySubscriptions.values()) {
      this.#transport.sendTo(targetPeerId, { type: 'subscribe', path: prefix });
      // RECIPROCAL CATCH-UP - see fetchPrefix()'s own doc comment for why
      // this closes the "subscribe only delivers FUTURE writes" gap for
      // whatever this side missed. Fire-and-forget (never awaited by a
      // caller): a slow or failing catch-up must never block anything else.
      //
      // INCREMENTAL CATCH-UP (see fetchPrefix()'s own `sinceTs` doc comment):
      // once a FULL catch-up for this exact (prefix, targetPeerId) pair has
      // completed at least once (`#fullSyncDone`), every SUBSEQUENT
      // reconnect/foreground-triggered catch-up only asks for what's newer
      // than this engine's own watermark for `prefix` - the dominant real
      // case (a short-lived drop, almost everything already present) no
      // longer re-downloads the whole prefix on every reconnect. A caller
      // with no prior full sync (fresh subscription, or a previous attempt
      // that never completed - see below) still gets `sinceTs: null`, i.e.
      // today's full-dump behavior, unchanged.
      //
      // CLOCK-SKEW MARGIN: `ts` is always a WRITER's own local clock (see
      // `packages/core/src/qubit.js`'s `createQuBit()`) - there is no
      // relay-authoritative timestamp anywhere in this codebase, so the
      // stored watermark can only ever be as trustworthy as the clock of
      // whichever peer happened to contribute the newest entry to the batch
      // that set it (see `#bumpWatermark()`'s own doc comment for why it's
      // now scoped to a whole confirmed batch, not a single write - that
      // alone narrows but does not eliminate this). Subtracting
      // `CLOCK_SKEW_MARGIN_MS` here, at the one place a stored watermark
      // becomes a `sinceTs` REQUEST, re-asks for a small trailing window on
      // every incremental catch-up rather than trusting the watermark's
      // exact boundary - cheap (a handful of harmless re-merges, safely
      // absorbed by `#persistDirectly()`'s own anti-regression ts-guard) and
      // bounds the worst case to "some peer's clock is off by more than
      // this margin" instead of "permanently missing" the way an unmargined
      // boundary did. Applied HERE specifically, not inside `fetchPrefix()`
      // itself (whose own doc comment already frames `sinceTs` as an exact,
      // honest boundary other callers may rely on) and not server-side in
      // `#handlePrefixRequest` (would double-apply for a client already
      // margining its own request).
      const key = `${targetPeerId ?? ''}:${prefix}`;
      let sinceTs = null;
      if (this.#fullSyncDone.has(key)) {
        const watermark = this.#prefixWatermarks.get(prefix);
        if (watermark !== undefined) sinceTs = Math.max(0, watermark - CLOCK_SKEW_MARGIN_MS);
      }
      this.fetchPrefix(prefix, targetPeerId, undefined, null, sinceTs)
        .then(() => this.#fullSyncDone.add(key)) // safe unconditionally: a no-op if `key` was already marked done, and correctly marks a first-ever full sync done once it actually completes - see this method's own call site reasoning above
        .catch((err) => {
          console.warn(`[SyncEngine] refreshSubscriptions(): catch-up for "${prefix}" failed:`, err);
        });
    }
  }

  /**
   * SUBSCRIBE-BASED SYNC ONLY EVER DELIVERS FUTURE WRITES (see this class's
   * own doc comment, and subscribe()'s) - a session that was offline, or
   * simply wasn't running yet, has no way to learn what it missed just by
   * staying connected from now on. This is the "generation" a caller (see
   * `@qu/services`' `createFreshnessTracker()`) can use to know THAT it
   * might have missed something and refresh accordingly - bumped once per
   * connection established (including the very first one, not just actual
   * reconnects). A caller that read+cached a path under an OLDER generation
   * than this one should treat that cached value as merely a fast first
   * answer, worth a background re-check - see `@qu/services`'
   * `sync-freshness.js` for the concrete pattern this enables.
   * @returns {number}
   */
  getGeneration() {
    return this.#generation;
  }

  /**
   * Registers a callback fired every time this SyncEngine's connection to
   * its remote peer is (re-)established, including the very first one -
   * see getGeneration()'s own doc comment for why the first connection
   * counts too. A thin passthrough over the transport's own onReconnect()
   * (already used internally, above, to replay subscriptions) - exposed
   * here so application code holding a SyncEngine (not the raw transport)
   * can react too, e.g. to force-refresh whatever it currently has open.
   * A no-op registration (never fires) on a transport that doesn't support
   * reconnecting at all (see the constructor's own duck-typed check).
   * @param {() => void} callback
   * @returns {() => void} Unsubscribe function - important for a caller
   *   that registers one of these per short-lived operation rather than
   *   once for the app's whole lifetime; without a way to remove it, every
   *   such registration would leak for as long as this SyncEngine exists,
   *   even after its own job is done.
   */
  onReconnect(callback) {
    this.#reconnectCallbacks.push(callback);
    return () => {
      const idx = this.#reconnectCallbacks.indexOf(callback);
      if (idx !== -1) this.#reconnectCallbacks.splice(idx, 1);
    };
  }

  /**
   * TELEMETRY - a thin passthrough to the underlying transport's own byte/
   * rate counters (see `WebSocketClientTransport`'s own `getBytesIn()` doc
   * comment), so app code holding a `SyncEngine` - never the raw transport,
   * which isn't threaded into a mounted app's `ctx`, see
   * `apps/shell/client.js` - can read them without reaching past this class.
   * Duck-typed, same pattern as the constructor's own `onReconnect` check:
   * a transport that doesn't implement these (e.g. a relay's
   * `WebSocketServerTransport`, which aggregates across MANY peer
   * connections differently - see `@qu/relay`'s own traffic-stats module,
   * not a single connection's own count) yields all-zero stats rather than
   * throwing.
   * @returns {{bytesIn: number, bytesOut: number, rateIn: number, rateOut: number}}
   */
  getTransportStats() {
    const t = this.#transport;
    if (typeof t.getBytesIn !== 'function') return { bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0 };
    return { bytesIn: t.getBytesIn(), bytesOut: t.getBytesOut(), rateIn: t.getCurrentRateIn(), rateOut: t.getCurrentRateOut() };
  }

  /**
   * Asks `targetPeerId` to start pushing future writes under `pathPrefix` to
   * us (matched by string prefix; a trailing '*' is accepted for
   * readability but not required). This sends a 'subscribe' message over
   * the transport - the actual bookkeeping happens on the REMOTE peer's
   * SyncEngine, in its own `#subscriptions` map, since it's the one
   * deciding who to notify when it writes locally. Subscribing only
   * affects FUTURE writes; use `fetch()` for data that already exists.
   *
   * The remote side registers the subscriber under the peerId ITS OWN
   * transport assigned to the connection the message arrived on - never a
   * self-reported ID inside the message. If it did trust a client-supplied
   * ID, any peer could claim to "be" a different peerId and hijack their
   * subscription (or receive pushes meant for someone else); a server-side
   * transport is the only thing that can truthfully say which live
   * connection a message came from.
   *
   * @param {string} pathPrefix
   * @param {string} [targetPeerId] - Required for transports with multiple
   *   simultaneous peers (e.g. a relay's server transport). Single-peer
   *   client transports (e.g. WebSocketClientTransport, which only ever
   *   talks to the one relay it connected to) ignore this and it may be omitted.
   */
  subscribe(pathPrefix, targetPeerId = null) {
    const prefix = pathPrefix.replace(/\*$/, '');
    // Remembered so a reconnected transport (see the constructor's
    // onReconnect() hook above) can replay it - the remote side's own
    // bookkeeping for this subscription lives entirely on a connection
    // that no longer exists once a reconnect happens.
    this.#mySubscriptions.set(`${targetPeerId ?? ''}:${prefix}`, { prefix, targetPeerId });
    this.#transport.sendTo(targetPeerId, { type: 'subscribe', path: prefix });
  }

  /** @param {string} pathPrefix @param {string} [targetPeerId] */
  unsubscribe(pathPrefix, targetPeerId = null) {
    const prefix = pathPrefix.replace(/\*$/, '');
    this.#mySubscriptions.delete(`${targetPeerId ?? ''}:${prefix}`);
    this.#transport.sendTo(targetPeerId, { type: 'unsubscribe', path: prefix });
  }

  /** @param {string} prefix @param {string} peerId */
  #addSubscriber(prefix, peerId) {
    const set = this.#subscriptions.get(prefix) ?? new Set();
    set.add(peerId);
    this.#subscriptions.set(prefix, set);
  }

  /** @param {string} prefix @param {string} peerId */
  #removeSubscriber(prefix, peerId) {
    const set = this.#subscriptions.get(prefix);
    if (!set) return;
    set.delete(peerId);
    if (set.size === 0) this.#subscriptions.delete(prefix);
  }

  /**
   * Requests a value from a specific peer (or broadcasts the request if
   * `targetPeerId` is omitted) and waits for a response.
   * @param {string} path
   * @param {string|null} [targetPeerId]
   * @param {number} [timeoutMs=10000]
   * @param {number|null} [hops=null] - RELAY FEDERATION ON-DEMAND ROUTING: if
   *   the peer answering this request doesn't have `path` locally either, it
   *   may forward the miss on to ITS OWN federation peers (see
   *   `onLocalMiss` in the constructor's own doc comment) - see
   *   `#handleRequest`'s own doc comment for the full `null` vs `0` vs a
   *   positive number contract this deliberately three-valued parameter
   *   uses to tell "a fresh, not-yet-forwarded request" apart from "already
   *   N hops into a forwarding chain, N of them left". `null` (the default)
   *   means "not part of any forwarding chain" - every existing caller of
   *   `fetch()` is therefore completely unaffected by this parameter's
   *   addition; passing `0` explicitly means "forward nothing further",
   *   distinct from `null` even though both look like "don't forward" at a
   *   glance - see `#handleRequest`'s own doc comment for why that
   *   distinction has to exist at all.
   * @returns {Promise<object|null>} The QuBit, or null if the peer doesn't have it.
   */
  async fetch(path, targetPeerId = null, timeoutMs = 10000, hops = null) {
    const requestId = `${Date.now()}-${this.#requestCounter++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        reject(new Error(`SyncEngine.fetch: timed out waiting for "${path}"`));
      }, timeoutMs);
      const message = { type: 'request', requestId, path, requester: this.#transport.getPeerId(), hops };
      // `message`/`targetPeerId` kept alongside the resolver so a reconnect
      // mid-flight (see the constructor's own onReconnect wiring and
      // #replayPendingRequests()) can re-send this EXACT request instead of
      // silently losing it to its own timeout - see that method's own doc
      // comment for why a request sent right before a drop has no other way
      // to ever get answered.
      this.#pendingRequests.set(requestId, { resolve, reject, timeout, message, targetPeerId });
      if (targetPeerId) this.#transport.sendTo(targetPeerId, message);
      else this.#transport.send(message);
    });
  }

  /**
   * Resolves once a peer's `sync-ack` for `path` covers AT LEAST `ts` -
   * i.e. the peer this write was sent to (see `publishAllTo`) has durably
   * PERSISTED it, not merely received bytes over the wire. Every write
   * `#handleSync` accepts triggers an ack automatically (see that method) -
   * this is simply a way for application code to listen for one on a
   * specific path, instead of `fetch()`-polling the same path back and
   * hoping the round-trip proves the same thing.
   *
   * If an ack covering `ts` already arrived BEFORE this call (a real race:
   * a fast relay can ack before the caller gets around to awaiting this),
   * resolves immediately from `#lastAckedTs` rather than registering a
   * waiter that would never see a message that already came and went.
   *
   * @param {string} path
   * @param {number} ts - The QuBit's own `ts` (as returned by the write
   *   that produced it) - resolves on an ack for this exact write OR a
   *   newer one at the same path (matches `#handleSyncAck`'s own
   *   never-regress comparison).
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<void>} Rejects on timeout - callers should treat that
   *   as "still unknown, not necessarily failed" (the write itself is safe
   *   in the outbox, if configured - see outbox.js - and will re-ack on
   *   the next reconnect regardless of whether anything is still waiting).
   */
  async waitForAck(path, ts, timeoutMs = 10000) {
    const already = this.#lastAckedTs.get(path);
    if (already !== undefined && already >= ts) return;
    return new Promise((resolve, reject) => {
      const entry = { ts, resolve, timeout: null };
      entry.timeout = setTimeout(() => {
        const waiters = this.#ackWaiters.get(path);
        if (waiters) {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) this.#ackWaiters.delete(path);
        }
        reject(new Error(`SyncEngine.waitForAck: timed out waiting for ack of "${path}" (ts=${ts})`));
      }, timeoutMs);
      const list = this.#ackWaiters.get(path) ?? [];
      list.push(entry);
      this.#ackWaiters.set(path, list);
    });
  }

  /**
   * RECIPROCAL CATCH-UP - asks `targetPeerId` for every QuBit it has under
   * `prefix`, merges each one locally (via the same ts-guarded
   * `#persistDirectly` a normal synced write or `fetch()` response uses -
   * never regresses newer local data), and returns however many arrived.
   *
   * This is what closes the gap `subscribe()`'s own doc comment names
   * plainly: subscribing only ever delivers writes made AFTER the
   * subscription exists, so a peer reconnecting after time offline (or
   * connecting for the very first time) has no way to learn what it
   * missed just by staying connected from now on. Called automatically for
   * every active subscription on every (re)connect (see the constructor) -
   * a caller only needs this directly for an ad hoc, not-yet-subscribed
   * prefix.
   *
   * Deliberately ONE-DIRECTIONAL (the requester pulls from the target, not
   * a two-way exchange) - unlike a peer-symmetric mesh, this system's only
   * real topology is a star (browser clients each hold one relay
   * connection, see `publishAllTo`), so the other direction - a relay
   * learning about writes a client made while genuinely disconnected (not
   * just this same request pending) - is handled by the client's own
   * persistent sync outbox replaying on reconnect (see outbox.js), not by
   * the relay asking back here. Two simpler, direction-specific mechanisms
   * instead of one generic bidirectional protocol neither side's topology
   * actually needs.
   *
   * Entries are validated+persisted with bounded concurrency (see
   * `FETCH_PREFIX_CONCURRENCY` below), not strictly one-at-a-time: a large
   * catch-up batch would otherwise pay a full validate+read+write round
   * trip serially per entry even though different paths never contend with
   * each other (`FsAdapter.put()`'s own lock is keyed per path). This does
   * NOT introduce a new ordering hazard - `entries` itself already arrives
   * in filesystem iteration order, not causal order (see `getAll()`'s own
   * "UNSORTED" doc comment, which is what serves this response on the
   * peer's side), so same-batch ordering was never a guarantee this method
   * could rely on in the first place.
   *
   * @param {string} prefix
   * @param {string|null} [targetPeerId]
   * @param {number} [timeoutMs=15000]
   * @param {number|null} [hops=null] - See `fetch()`'s own identical
   *   parameter and `#handleRequest`'s doc comment for the full `null` vs
   *   `0` vs positive-number contract.
   * @param {number|null} [sinceTs=null] - INCREMENTAL SYNC: when given, the
   *   peer answers with only the entries under `prefix` whose OWN `ts` is
   *   STRICTLY GREATER than `sinceTs` (see `#handlePrefixRequest`'s server
   *   side) - `null` (the default) means "send everything", today's
   *   unchanged full-dump behavior, so every existing caller of
   *   `fetchPrefix()` is unaffected by this parameter's addition.
   *   Deliberately a simple "anything newer than X" filter, not a precise
   *   diff: an entry this side never actually received in the past, but
   *   whose `ts` happens to be OLDER than `sinceTs`, is NOT re-sent by this
   *   mechanism - a conscious trade-off (see `refreshSubscriptions()`'s own
   *   call site) that trades perfect completeness-after-a-gap for cutting
   *   the dominant "short reconnect, almost everything already present"
   *   case down to just what's new, with no per-entry watermark bookkeeping
   *   on either side.
   * @returns {Promise<number>} How many QuBits actually passed validation
   *   (see `#validateIncomingWrite()`) AND were persisted - not merely how
   *   many entries the peer sent back. An entry that fails validation is
   *   skipped and not counted; one skipped by `#persistDirectly()`'s own
   *   anti-regression ts-guard, or one whose persistence itself failed, is
   *   not counted either.
   */
  async fetchPrefix(prefix, targetPeerId = null, timeoutMs = 15000, hops = null, sinceTs = null) {
    const requestId = `${Date.now()}-${this.#requestCounter++}`;
    const entries = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingPrefixRequests.delete(requestId);
        reject(new Error(`SyncEngine.fetchPrefix: timed out waiting for "${prefix}"`));
      }, timeoutMs);
      const message = { type: 'prefix-request', requestId, prefix, requester: this.#transport.getPeerId(), hops, sinceTs };
      // See fetch()'s own identical comment - #replayPendingRequests() needs
      // `message`/`targetPeerId` to re-send this exact request after a
      // mid-flight reconnect instead of losing it to its own timeout. This
      // is the SAME method every app's own `ctx.syncFetch` calls through
      // (`apps/shell/client.js`'s own `syncFetch = (prefix) =>
      // sync.fetchPrefix(prefix)`) - without this, a request that happened
      // to be in flight at the exact moment a relay restarted (or any
      // transient drop) would silently degrade to whatever was already
      // locally cached until the next full page load, not just re-connect.
      this.#pendingPrefixRequests.set(requestId, { resolve, reject, timeout, message, targetPeerId });
      if (targetPeerId) this.#transport.sendTo(targetPeerId, message);
      else this.#transport.send(message);
    });

    // `batchMaxTs` feeds `#bumpWatermark()` below - the MAX ts across every
    // entry in THIS response that actually validated (an entry that fails
    // `#validateIncomingWrite()` - unsigned, forged, whatever - must never
    // move the watermark forward: a single bad entry could otherwise let a
    // misbehaving peer poison it arbitrarily far ahead and permanently
    // starve every future incremental catch-up for this prefix, the exact
    // failure mode `#persistDirectly()`'s own doc comment describes for an
    // untrusted single write, just reachable a different way). Whether the
    // entry actually turned out to be NEW information (`#persistDirectly()`
    // returning `true` vs `false`) does not matter for this - the server's
    // own guarantee ("this batch is everything currently newer than
    // sinceTs") is about the returned SET, not about whether any one entry
    // happened to be new to us.
    let batchMaxTs;
    const persistedCount = await mapWithConcurrency(entries, FETCH_PREFIX_CONCURRENCY, async ({ path, quBit }) => {
      try {
        await this.#validateIncomingWrite(path, quBit);
      } catch (err) {
        console.warn(`[SyncEngine] fetchPrefix(): skipping invalid entry for "${path}": ${err.message}`);
        return false;
      }
      if (batchMaxTs === undefined || quBit.ts > batchMaxTs) batchMaxTs = quBit.ts;
      return this.#persistDirectly(path, quBit);
    });
    if (batchMaxTs !== undefined) this.#bumpWatermark(prefix, batchMaxTs);
    return persistedCount;
  }

  /**
   * @param {string} path
   * @param {object} message
   * @param {string|null} [excludePeerId] - Never re-send to whoever this
   *   message originated from (relevant only for hub re-broadcast, see
   *   #handleSync - a peer already has the write it just sent us).
   */
  #broadcastToSubscribers(path, message, excludePeerId = null) {
    for (const [prefix, peers] of this.#subscriptions) {
      if (!path.startsWith(prefix)) continue;
      for (const peerId of peers) {
        if (peerId === excludePeerId) continue;
        if (peerId !== this.#transport.getPeerId()) this.#transport.sendTo(peerId, message);
      }
    }
  }

  /**
   * @param {string} path @param {number} ts
   * @returns {boolean} Whether a rebroadcast of this exact path+ts combo was
   *   already sent within the last `REBROADCAST_DEDUP_TTL_MS` - see
   *   `#handleSync`'s own call site for why this exists (mesh bandwidth,
   *   never correctness). Cheap by design: `ts` is already the LWW
   *   discriminant `#persistDirectly` uses and unique per genuine write, so
   *   it doubles as a free content-identity proxy - no separate hashing.
   */
  #shouldSkipRebroadcast(path, ts) {
    const key = `${path}:${ts}`;
    const now = Date.now();
    const expiry = this.#recentBroadcasts.get(key);
    if (expiry && expiry > now) return true;
    this.#recentBroadcasts.set(key, now + REBROADCAST_DEDUP_TTL_MS);
    capCache(this.#recentBroadcasts, MAX_DEDUP_CACHE_ENTRIES);
    return false;
  }

  /**
   * Re-broadcasts an ALREADY-persisted, already-validated QuBit to THIS
   * engine's own subscribers - never persists, never re-validates (the
   * caller's own `#persistDirectly()` call already did that). See the
   * constructor's own `onExternalPersist` doc comment for why this exists:
   * a relay running two independent `SyncEngine` instances over one shared
   * `QuStore` needs a way for a write persisted by ONE engine to reach the
   * OTHER engine's own, otherwise-disjoint `#subscriptions` map.
   *
   * Gated by the SAME `#shouldSkipRebroadcast()` TTL dedup `#handleSync`
   * itself already uses - checked here on THIS (the receiving) engine's own
   * cache, not the calling engine's. This is what actually makes
   * cross-engine bridging safe in an N-relay mesh, not `excludePeerId`:
   * `excludePeerId` only ever excludes ONE immediate sender on ONE engine's
   * own broadcast, which was sufficient for a single engine's hub
   * re-broadcast but not once two independent engines (each with their own
   * federation links) are bridged together - a redundant resend of the same
   * `path:ts` arriving via a peer several hops away, invisible to any
   * `excludePeerId`, would otherwise re-trigger the bridge on every
   * duplicate delivery. Reusing the existing per-engine dedup cache closes
   * that with no new mechanism.
   *
   * @param {string} path
   * @param {object} quBit
   * @param {{excludePeerId?: string|null}} [options]
   */
  rebroadcastLocally(path, quBit, { excludePeerId = null } = {}) {
    if (this.#shouldSkipRebroadcast(path, quBit.ts)) return;
    this.#broadcastToSubscribers(path, { type: 'sync', path, quBit }, excludePeerId);
  }

  /**
   * Advances `#prefixWatermarks[prefix]` to `ts` if `ts` is newer than
   * whatever's already stored - called ONLY from `fetchPrefix()`'s own
   * merge loop, with the MAX `ts` across one whole confirmed-valid response
   * batch for that exact `prefix`, never from an individual write (see
   * `#persistDirectly()`'s own doc comment for why: a single write's `ts`
   * is only the sender's own unsynchronized local clock, not a "everything
   * up to here is confirmed complete" checkpoint - only a batch the relay
   * itself just confirmed is "everything currently newer than sinceTs" can
   * honestly mean that). A write bridged in via `rebroadcastLocally()` (see
   * that method's own doc comment) never reaches this at all - only
   * `fetchPrefix()` calls it, and a bridge never calls `fetchPrefix()`
   * either - so it can never advance a watermark for a `(prefix,
   * targetPeerId)` pair this engine never actually fetched from.
   * @param {string} prefix @param {number} ts
   */
  #bumpWatermark(prefix, ts) {
    const current = this.#prefixWatermarks.get(prefix);
    if (current === undefined || ts > current) this.#prefixWatermarks.set(prefix, ts);
  }

  #handleIncoming(message, peerId) {
    switch (message.type) {
      case 'sync':
        return this.#handleSync(message, peerId);
      case 'request':
        return this.#handleRequest(message, peerId);
      case 'response':
        return this.#handleResponse(message);
      case 'prefix-request':
        return this.#handlePrefixRequest(message, peerId);
      case 'prefix-response':
        return this.#handlePrefixResponse(message);
      case 'sync-ack':
        return this.#handleSyncAck(message);
      case 'subscribe':
        return this.#addSubscriber(message.path, peerId);
      case 'unsubscribe':
        return this.#removeSubscriber(message.path, peerId);
      // RELAY FEDERATION HANDSHAKE - see the constructor's own doc comment
      // on `onRelayHello`/`onRelayHelloAck`. This class only ever dispatches
      // these verbatim to an optional hook; it has no relay identity of its
      // own to verify or sign anything with.
      case 'relay-hello':
        return this.#onRelayHello?.(message, peerId);
      case 'relay-hello-ack':
        return this.#onRelayHelloAck?.(message, peerId);
      default:
        console.warn(`[SyncEngine] unknown message type "${message.type}"`);
    }
  }

  /**
   * ONE shared gate every path that can cause a network-originated QuBit to
   * be persisted - `#handleSync`, `#handleResponse` (`fetch()`), and
   * `fetchPrefix()`'s own loop - runs identically, in this exact order:
   *   1. shape (`isValidQuBit`)
   *   2. `quBit.path === path` - the QuBit's OWN `path` field must match
   *      the path it is being persisted under. This is the one check
   *      `isAuthentic()` structurally CANNOT make: it verifies a signature
   *      over `{path: quBit.path, val, ts, pub}` - i.e. over `quBit.path`,
   *      never over whatever transport-level `path` this call happens to be
   *      persisting it at. Without this check, a validly-signed QuBit for
   *      resource A could be relayed (or served back via fetch) under an
   *      unrelated resource B: the signature would still verify (it only
   *      ever attested to A), the ACL check below would be asked about B,
   *      and `#persistDirectly()` would store it AT B - three different
   *      resources, one accepted write. Requiring equality here means the
   *      resource a write is authenticated for and the resource it ends up
   *      stored at are always, structurally, the same one.
   *   3. signature (`isAuthentic`)
   *   4. write ACL (`assertWriteAuthorized`) - the SAME decision
   *      `AccessEngine` makes for a locally-originated `put()`.
   * Throws a descriptive Error on the first failing check. Deliberately
   * silent about HOW a rejection should surface - each call site decides
   * that for itself (silently drop-and-log for `#handleSync`, reject the
   * pending promise for `fetch()`, skip-and-continue for `fetchPrefix()`) -
   * this method only ever decides whether the write is valid.
   * @param {string} path
   * @param {object} quBit
   * @returns {Promise<void>}
   */
  async #validateIncomingWrite(path, quBit) {
    if (!isValidQuBit(quBit)) {
      throw new Error('malformed QuBit');
    }
    if (quBit.path !== path) {
      throw new Error(`QuBit's own path "${quBit.path}" does not match the path it arrived under ("${path}")`);
    }
    if (!(await isAuthentic(quBit))) {
      throw new Error('signature does not verify');
    }
    const writerPub = quBit.pub ? QuCrypto.fromBase64(quBit.pub) : null;
    await assertWriteAuthorized(this.#qu, path, writerPub);
  }

  /**
   * @param {{path: string, quBit: object}} message
   * @param {string} originPeerId - Whoever sent this over the transport - a
   *   relay re-broadcasting this to ITS OWN subscribers must never echo it
   *   straight back to them.
   */
  async #handleSync({ path, quBit }, originPeerId) {
    if (path.startsWith(LOCAL_ONLY_PREFIX)) {
      console.warn(`[SyncEngine] refusing synced write for local-only path "${path}"`);
      return;
    }
    try {
      await this.#validateIncomingWrite(path, quBit);
    } catch (err) {
      console.warn(`[SyncEngine] rejecting synced QuBit for "${path}": ${err.message}`);
      return;
    }

    // See the constructor's own doc comment - only reached for a write
    // whose signature just verified above, so this pub is trustworthy here
    // even though it's never re-checked against any Engine-level ACL.
    // Converted to base64url to match the canonical `actorPub` string
    // shape every other Service in this codebase already uses (QuBit.pub
    // itself is plain base64 - see isAuthentic() above).
    if (this.#onPeerIdentified && quBit.pub) {
      this.#onPeerIdentified(originPeerId, QuCrypto.toBase64Url(QuCrypto.fromBase64(quBit.pub)));
    }
    await this.#persistDirectly(path, quBit);
    // Hub re-broadcast: a relay with N subscribed clients must forward what
    // ONE of them just sent to the OTHER N-1, not just persist it locally -
    // otherwise only writes the relay itself originates would ever reach a
    // second client, which defeats the entire point of a shared relay (see
    // the class doc comment's validation note for what this re-broadcast
    // does and does not additionally guarantee).
    //
    // REBROADCAST DEDUP (relay federation): `#broadcastToSubscribers` only
    // ever excludes the IMMEDIATE sender, not the whole path a write already
    // took - fine for a star (one relay, many clients, no cycles possible),
    // but a small MESH of federated relays (A subscribed to B subscribed to
    // C subscribed to A) can otherwise cycle the same write indefinitely.
    // Correctness never depends on this (`#persistDirectly`'s ts-guard makes
    // any redundant re-delivery a no-op), so this is purely a bandwidth
    // mitigation: skip re-broadcasting the SAME path+ts combo more than once
    // within a short window - see `#shouldSkipRebroadcast()`.
    if (!this.#shouldSkipRebroadcast(path, quBit.ts)) {
      this.#broadcastToSubscribers(path, { type: 'sync', path, quBit }, originPeerId);
    }
    // Unconditional ack back to whoever sent this - see outbox.js. A peer
    // with no outbox configured (a relay's own SyncEngine, a plain Node
    // test peer, ...) just never registers a 'sync-ack' handler's worth of
    // caring; this message costs it one ignored switch-case, nothing more.
    this.#transport.sendTo(originPeerId, { type: 'sync-ack', path, ts: quBit.ts });
  }

  /**
   * @param {{requestId: string, path: string, hops?: number|null}} message -
   *   RELAY FEDERATION ON-DEMAND ROUTING. `hops` is deliberately
   *   three-valued, not a plain boolean/count: `null` (what every existing
   *   caller's request always carries, including a fresh browser client's -
   *   see `fetch()`'s own default) means "not part of any forwarding chain
   *   yet" - `onLocalMiss`'s own caller (`FederationManager`) is the one
   *   that decides what budget a FRESH miss gets (its own configured
   *   `hopLimit`), not this class. A NUMBER means "already forwarded this
   *   many times, this many hops of budget left" - `onLocalMiss` is
   *   responsible for decrementing it for the NEXT hop it forwards to (see
   *   that hook's own contract), never this method. Explicit `0` means "a
   *   forwarding chain that has now run out of budget" - forwarding is
   *   skipped for `0` specifically, but NOT for `null`, which is why this
   *   checks `hops !== 0` rather than `hops > 0`.
   * @param {string} peerId
   */
  async #handleRequest({ requestId, path, hops = null }, peerId) {
    if (path.startsWith(LOCAL_ONLY_PREFIX)) {
      console.warn(`[SyncEngine] refusing to serve fetch() request for local-only path "${path}"`);
      this.#transport.sendTo(peerId, { type: 'response', requestId, path, quBit: null });
      return;
    }
    try {
      const { adapter, rel } = this.#qu.resolveMount(path);
      let quBit = await adapter.get(rel);
      // See this method's own doc comment for the `hops` contract. Never
      // awaited past its own failure: a forwarding attempt that errors or
      // times out degrades to the same "not found" response a local-only
      // miss already returns today, not a new failure mode for the
      // original requester.
      if (!quBit && hops !== 0 && this.#onLocalMiss) {
        quBit = await this.#onLocalMiss({ kind: 'request', path, hops, excludePeerId: peerId }).catch(() => null);
      }
      this.#transport.sendTo(peerId, { type: 'response', requestId, path, quBit: quBit ?? null });
    } catch (err) {
      console.error(`[SyncEngine] error handling request for "${path}":`, err);
      this.#transport.sendTo(peerId, { type: 'response', requestId, path, quBit: null });
    }
  }

  async #handleResponse({ requestId, path, quBit }) {
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) return; // late or duplicate response - ignore
    clearTimeout(pending.timeout);
    this.#pendingRequests.delete(requestId);

    if (!quBit) {
      pending.resolve(null); // peer doesn't have it
      return;
    }
    try {
      await this.#validateIncomingWrite(path, quBit);
    } catch (err) {
      pending.reject(new Error(`SyncEngine.fetch: invalid response for "${path}": ${err.message}`));
      return;
    }
    await this.#persistDirectly(path, quBit);
    pending.resolve(quBit);
  }

  /** @param {{requestId: string, prefix: string, hops?: number|null, sinceTs?: number|null}} message - `hops` see `#handleRequest`'s own doc comment; `sinceTs` see `fetchPrefix()`'s own doc comment - both full contracts. @param {string} peerId - see fetchPrefix() */
  async #handlePrefixRequest({ requestId, prefix, hops = null, sinceTs = null }, peerId) {
    try {
      const raw = await this.#qu.getAllUnderMount(prefix);
      // Same hard rail as #handleRequest()'s single-path fetch() - a peer
      // can never learn a local-only secret via prefix catch-up either,
      // regardless of how broad a prefix it asks for (e.g. the mount root).
      let entries = raw.filter(({ path }) => !path.startsWith(LOCAL_ONLY_PREFIX));
      // RELAY FEDERATION ON-DEMAND ROUTING - see #handleRequest()'s
      // identical `hops` contract. Only attempted on a genuine LOCAL miss
      // (nothing under this prefix at ALL, checked BEFORE the `sinceTs`
      // filter below) - a prefix this peer partially has, even if every
      // entry happens to be older than `sinceTs` (a fully-up-to-date
      // incremental answer, not a miss), is answered from what it has,
      // never merged with a forwarded result.
      if (entries.length === 0 && hops !== 0 && this.#onLocalMiss) {
        const forwarded = await this.#onLocalMiss({ kind: 'prefix-request', prefix, hops, excludePeerId: peerId }).catch(() => null);
        if (Array.isArray(forwarded)) entries = forwarded;
      }
      // INCREMENTAL SYNC (see fetchPrefix()'s own `sinceTs` doc comment) -
      // applied AFTER the miss/forwarding decision above, so a forwarded
      // result is filtered exactly like a local one.
      if (sinceTs != null) {
        entries = entries.filter(({ quBit }) => typeof quBit?.ts === 'number' && quBit.ts > sinceTs);
      }
      this.#transport.sendTo(peerId, { type: 'prefix-response', requestId, entries });
    } catch (err) {
      console.error(`[SyncEngine] error handling prefix-request for "${prefix}":`, err);
      this.#transport.sendTo(peerId, { type: 'prefix-response', requestId, entries: [] });
    }
  }

  /** @param {{requestId: string, entries: Array<{path: string, quBit: object}>}} message - see fetchPrefix() */
  #handlePrefixResponse({ requestId, entries }) {
    const pending = this.#pendingPrefixRequests.get(requestId);
    if (!pending) return; // late or duplicate response - ignore
    clearTimeout(pending.timeout);
    this.#pendingPrefixRequests.delete(requestId);
    pending.resolve(Array.isArray(entries) ? entries : []);
  }

  /**
   * @param {{path: string, ts: number}} message - see outbox.js and
   *   `#handleSync`'s unconditional ack send.
   */
  async #handleSyncAck({ path, ts }) {
    // Record it regardless of outbox/waitForAck usage - see waitForAck()'s
    // own doc comment for why a caller registering AFTER the ack already
    // arrived must still see it as covered, not time out waiting for a
    // message that already came and went.
    const currentBest = this.#lastAckedTs.get(path);
    if (currentBest === undefined || ts > currentBest) {
      this.#lastAckedTs.set(path, ts);
      capCache(this.#lastAckedTs);
    }
    const waiters = this.#ackWaiters.get(path);
    if (waiters) {
      const stillWaiting = [];
      for (const waiter of waiters) {
        if (waiter.ts <= ts) {
          clearTimeout(waiter.timeout);
          waiter.resolve();
        } else {
          stillWaiting.push(waiter);
        }
      }
      if (stillWaiting.length) this.#ackWaiters.set(path, stillWaiting);
      else this.#ackWaiters.delete(path);
    }

    if (!this.#outbox) return; // this SyncEngine doesn't track an outbox - nothing to clear
    try {
      const pending = await this.#outbox.get(path);
      // Only clear if the ack covers what we actually have queued (or
      // something newer) - a late ack for an OLDER version must never wipe
      // out a NEWER local write to the same path made in the meantime and
      // already re-queued under the same key.
      if (pending && typeof pending.ts === 'number' && pending.ts <= ts) {
        await this.#outbox.delete(path);
      }
    } catch (err) {
      console.error(`[SyncEngine] failed to process sync-ack for "${path}":`, err);
    }
  }

  /**
   * Writes an already-sealed QuBit straight to its mount and notifies
   * local storage-change listeners (see QuStore.putSealed() for why this
   * must notify, not just persist - a reactive layer built on
   * `qu.onStorageChange()`/`watch()` would otherwise never react to
   * anything arriving from another peer).
   *
   * NEVER REGRESSES a path to an OLDER value (compares `ts`, always present
   * on a QuBit - see `@qu/core`'s `qubit.js`) - both callers above
   * (`#handleSync` and `#handleResponse`) can legitimately race a write
   * this same peer makes to the SAME path a moment later: `fetch()` in
   * particular is what `@qu/services`' background-refresh mechanism (see
   * `sync-freshness.js`) uses to check an ALREADY-locally-cached path for
   * staleness, which can be in flight AT THE SAME TIME this identity's own
   * more recent write to that exact path is happening (e.g.
   * `ListService.addCurated()` reading "is this stale?" right before
   * writing) - a slow response arriving AFTER that newer local write would
   * otherwise silently overwrite it with the older data it fetched, making
   * a just-sent change vanish again.
   *
   * @param {string} path
   * @param {object} quBit
   * @returns {Promise<boolean>} Whether this call actually wrote a NEW
   *   value - `false` if skipped by the anti-regression ts-guard below, or
   *   if persistence itself threw (caught and logged here, never thrown to
   *   the caller). `fetchPrefix()`'s own merged-count return value counts
   *   only calls that return `true` here. On a genuine new write, this is
   *   also the ONE choke point that fires `onExternalPersist` (see the
   *   constructor's own doc comment - relay federation's cross-engine live
   *   bridge). Deliberately does NOT touch `#prefixWatermarks` (unlike an
   *   earlier version of this method) - see `#bumpWatermark()`'s and
   *   `refreshSubscriptions()`'s own doc comments (the latter for
   *   `CLOCK_SKEW_MARGIN_MS`) for why the watermark used for incremental
   *   resync is advanced ONLY from `fetchPrefix()`'s own merge loop, from
   *   a whole confirmed batch, never from one individual write (a live push
   *   or a single `fetch()`) - a single write's own `ts` is just the
   *   sender's own, unsynchronized local clock, and treating it as a
   *   "confirmed complete up to here" checkpoint let one fast clock silently
   *   and PERMANENTLY starve a different, slower-clocked peer's later,
   *   genuinely-not-yet-seen write from ever being incrementally re-fetched
   *   again (confirmed as a real bug, not a hypothetical - fixed by this
   *   change; see the regression tests in sync-engine.test.js's own
   *   "incremental resync watermark correctness" section).
   */
  async #persistDirectly(path, quBit) {
    try {
      const existing = await this.#qu.get(path);
      if (existing && typeof existing.ts === 'number' && typeof quBit.ts === 'number' && existing.ts > quBit.ts) {
        return false; // local data is already newer than this incoming write - never regress
      }
      await this.#qu.putSealed(path, quBit);
      this.#onExternalPersist?.(path, quBit);
      return true;
    } catch (err) {
      console.error(`[SyncEngine] failed to persist synced QuBit for "${path}":`, err);
      return false;
    }
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidQuBit(quBit) {
  return isPlainObject(quBit) && typeof quBit.path === 'string' && typeof quBit.ts === 'number';
}

const MAX_ACK_CACHE_ENTRIES = 2000; // see #lastAckedTs - session-scoped, but cheap to cap defensively (same approach as @qu/identity's key/attestation caches)
function capCache(map, maxEntries = MAX_ACK_CACHE_ENTRIES) {
  while (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}

const REBROADCAST_DEDUP_TTL_MS = 60_000; // see #shouldSkipRebroadcast() - long enough to absorb a mesh's own immediate re-delivery storm, short enough that a genuinely repeated write (same path, coincidentally same ts) is never suppressed for long
const MAX_DEDUP_CACHE_ENTRIES = 4000; // see #shouldSkipRebroadcast() - same defensive capping approach as MAX_ACK_CACHE_ENTRIES above

// see refreshSubscriptions()'s own "CLOCK-SKEW MARGIN" doc comment - 5
// minutes is generous relative to realistic peer clock drift (a device
// with any OS-level time sync is normally off by well under a second; this
// covers a genuinely misconfigured/stalled-NTP device too) while keeping
// the resulting "redundant re-fetch window" on every incremental catch-up
// small and constant, not proportional to how long a subscription has
// existed - the dominant real case (a short reconnect, almost everything
// already present) still gets a small fetch, not a full re-download.
const CLOCK_SKEW_MARGIN_MS = 5 * 60_000;

const FETCH_PREFIX_CONCURRENCY = 8; // see fetchPrefix()'s own doc comment for why bounding (not unbounding) this is the right call

/**
 * Runs `worker` over every item in `items` with at most `limit` calls
 * in flight at once (a small worker-pool, not a naive `chunk-then-
 * Promise.all` - the next item starts the instant a slot frees up, rather
 * than waiting for a whole batch of `limit` to finish together).
 * @param {Array<T>} items
 * @param {number} limit
 * @param {(item: T) => Promise<boolean>} worker
 * @returns {Promise<number>} How many calls to `worker` resolved truthy.
 * @template T
 */
async function mapWithConcurrency(items, limit, worker) {
  let cursor = 0;
  let truthyCount = 0;
  async function runOne() {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (await worker(item)) truthyCount++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return truthyCount;
}
