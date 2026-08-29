import { Transport } from '../transport.js';
import { createLogger } from '@qu/log';

const log = createLogger('WebSocketClientTransport');
const textEncoder = new TextEncoder();

// See getCurrentRateIn()/getCurrentRateOut() - a trailing window average,
// same fixed-window simplicity as WebSocketServerTransport's own per-peer
// message-count rate limiter (packages/relay/src/transports/websocket-server-transport.js).
const RATE_WINDOW_MS = 5000;

/**
 * WEBSOCKET CLIENT TRANSPORT — connects to a single remote peer (typically a
 * relay) over WebSocket. Works in browsers (native `WebSocket`) and in
 * Node.js 22+ (which ships a global `WebSocket` too); for older Node
 * versions, pass a `WebSocketImpl` (e.g. the `ws` package's export).
 *
 * `send()`/`sendTo()` QUEUE outgoing messages if the socket isn't OPEN yet
 * (not connected, or still mid-handshake) instead of throwing - a raw
 * `WebSocket.send()` throws `InvalidStateError` when called before the
 * 'open' event, and a caller very often has a real reason to start sending
 * before `connect()`'s Promise has resolved: a SyncEngine constructed with
 * this transport (see `sync-engine.js`'s `publishAllTo` option) starts
 * observing local writes immediately, and the FIRST write of a session can
 * legitimately happen before the handshake finishes (e.g. a brand-new
 * identity publishing its own public profile the moment it's created).
 * Queueing means a caller never has to choose between "block everything on
 * the network round-trip" and "risk a crash/dropped write" - connect() can
 * run fully in the background.
 *
 * AUTO-RECONNECT: an unexpected disconnect (network blip, the relay
 * restarting, ...) triggers automatic reconnection with exponential
 * backoff (1s, 2s, 4s, ... capped at `maxReconnectDelayMs`, each with up to
 * 50% jitter so many clients reconnecting to the same relay at once don't
 * all retry in lockstep). `close()` (a DELIBERATE disconnect) disables this -
 * it would be actively wrong for a caller that explicitly asked to
 * disconnect to find itself reconnected a moment later.
 *
 * A fresh reconnection is a BRAND NEW WebSocket connection, which a relay's
 * server-side transport assigns a brand new peerId to - from the relay's
 * SyncEngine's point of view, this is a peer it has never seen
 * subscriptions from before, even though it's "the same" client as far as
 * the app is concerned. `onReconnect()` is the hook that lets SyncEngine
 * (see its constructor) notice this and RE-SEND its active subscriptions
 * over the new connection - without it, a reconnected client would sit
 * there with a healthy-looking socket that silently never receives another
 * live update for anything it had subscribed to before the drop.
 */
export class WebSocketClientTransport extends Transport {
  #ws = null;
  #callbacks = [];
  #reconnectCallbacks = [];
  #reconnectAttemptCallbacks = []; // see onReconnectAttempt()
  #peerId = `peer-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  /** @type {object[]} Messages sent before the socket reached OPEN, flushed once it does. */
  #sendQueue = [];
  #manuallyClosed = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #bytesIn = 0;
  #bytesOut = 0;
  #inSamples = []; // {t, bytes}, chronological - see #currentRate()
  #outSamples = [];

  /**
   * @param {string} url - e.g. "ws://localhost:8080".
   * @param {{WebSocketImpl?: typeof WebSocket, maxReconnectDelayMs?: number}} [options]
   *   `maxReconnectDelayMs` (default 30s) caps the exponential backoff -
   *   without a ceiling, a long outage would leave the delay between
   *   attempts growing forever, well past the point of being useful.
   */
  constructor(url, { WebSocketImpl, maxReconnectDelayMs = 30_000 } = {}) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    this.maxReconnectDelayMs = maxReconnectDelayMs;
    if (!this.WebSocketImpl) {
      throw new Error('WebSocketClientTransport: no WebSocket implementation available - pass { WebSocketImpl }');
    }
  }

  getPeerId() {
    return this.#peerId;
  }

  async connect() {
    this.#manuallyClosed = false;
    return this.#connectOnce();
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      this.#ws = ws;
      let settled = false;

      ws.addEventListener('open', () => {
        settled = true;
        log.debug(`connected to ${this.url}`);
        this.#reconnectAttempt = 0;
        this.#flushQueue();
        for (const cb of this.#reconnectCallbacks) cb();
        resolve();
      });
      ws.addEventListener('error', (err) => {
        // Only the very first connection attempt's promise needs a
        // rejection - a failed RECONNECT attempt (settled=false here too,
        // since it never opened) is handled entirely by the 'close'
        // listener below scheduling the next retry, not by rejecting
        // anything (nothing is awaiting a reconnect attempt specifically).
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      ws.addEventListener('message', (event) => {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        // Counted BEFORE the parse attempt below - bytes genuinely arrived
        // over the wire regardless of whether they turn out to be valid
        // JSON (see getBytesIn()'s own doc comment).
        this.#recordIn(textEncoder.encode(raw).length);
        try {
          const data = JSON.parse(raw);
          for (const cb of this.#callbacks) cb({ data, peerId: 'relay' });
        } catch (err) {
          log.error('invalid message:', err);
        }
      });
      ws.addEventListener('close', () => {
        if (this.#manuallyClosed) return;
        this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect() {
    const base = Math.min(1000 * 2 ** this.#reconnectAttempt, this.maxReconnectDelayMs);
    const delay = base * (0.5 + Math.random() * 0.5); // 50-100% of base, so many clients don't retry in lockstep
    this.#reconnectAttempt++;
    log.debug(`connection to ${this.url} dropped - reconnecting in ${Math.round(delay)}ms (attempt ${this.#reconnectAttempt})`);
    for (const cb of this.#reconnectAttemptCallbacks) cb(this.#reconnectAttempt);
    // A try-limit caller (see onReconnectAttempt()'s own doc comment) may
    // have called close() synchronously from within the callback loop just
    // above - re-check here rather than unconditionally scheduling the next
    // attempt regardless of that call, same guard the 'close' event listener
    // above already applies for the exact same reason.
    if (this.#manuallyClosed) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#connectOnce().catch((err) => {
        // #connectOnce()'s promise only rejects via the 'error' listener
        // above, which itself only fires before any successful open - a
        // reconnect attempt that fails outright (not just drops later)
        // still triggers its OWN 'close' event and schedules the next
        // retry from there, so nothing is lost by not chaining further here.
        log.error('reconnect attempt failed:', err);
      });
    }, delay);
  }

  #flushQueue() {
    for (const data of this.#sendQueue) this.#sendNow(data);
    this.#sendQueue = [];
  }

  /** Serializes, counts, and actually sends over an OPEN socket - the one choke point both `send()` and `#flushQueue()` funnel through, so outbound byte counting (see `getBytesOut()`) never needs its own call site per caller. */
  #sendNow(data) {
    const json = JSON.stringify(data);
    this.#recordOut(textEncoder.encode(json).length);
    this.#ws.send(json);
  }

  send(data) {
    if (this.#ws && this.#ws.readyState === this.#ws.OPEN) {
      this.#sendNow(data);
    } else {
      this.#sendQueue.push(data); // counted later, in #flushQueue(), once actually transmitted - never here, or a queued-then-flushed message would be counted twice
    }
  }

  sendTo(_peerId, data) {
    // A single-connection client transport only ever has one peer (the relay
    // it connected to) - sendTo and send are equivalent here.
    this.send(data);
  }

  onMessage(callback) {
    this.#callbacks.push(callback);
  }

  /**
   * Registers a callback fired every time a connection is ESTABLISHED,
   * including the very first `connect()` - not just reconnects. A caller
   * that wants to replay per-connection state (SyncEngine's active
   * subscriptions) can do so unconditionally on every call without
   * special-casing "is this the first time", since there's nothing to
   * replay yet on the very first call anyway.
   * @param {() => void} callback
   */
  onReconnect(callback) {
    this.#reconnectCallbacks.push(callback);
  }

  /**
   * Registers a callback fired every time a connection attempt FAILS and a
   * retry gets scheduled (i.e. every `#scheduleReconnect()` call) - the
   * counterpart to `onReconnect()` above, which only ever fires on SUCCESS.
   * Never fires for a deliberate `close()` (which disables retrying
   * entirely, same as `#scheduleReconnect()`'s own guard). Exists for a
   * caller that needs to detect a peer that's been unreachable for many
   * consecutive attempts (e.g. relay federation's dead-peer detection, see
   * `@qu/relay`'s `FederationManager`) - this transport itself retries
   * forever with no such concept, by design (see this class's own top doc
   * comment on AUTO-RECONNECT); a caller wanting a try-limit has to count
   * these itself and call `close()` once it decides to give up.
   * @param {(attempt: number) => void} callback - `attempt` is the same
   *   1-based counter logged above (1 on the very first failed retry).
   */
  onReconnectAttempt(callback) {
    this.#reconnectAttemptCallbacks.push(callback);
  }

  /** Closes the underlying connection. Also drops anything still queued - a closed transport has nowhere left to flush to. Disables auto-reconnect - this is a DELIBERATE disconnect. */
  close() {
    this.#manuallyClosed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#sendQueue = [];
    this.#ws?.close();
  }

  /** @param {number} byteLength */
  #recordIn(byteLength) {
    this.#bytesIn += byteLength;
    this.#pushSample(this.#inSamples, byteLength);
  }

  /** @param {number} byteLength */
  #recordOut(byteLength) {
    this.#bytesOut += byteLength;
    this.#pushSample(this.#outSamples, byteLength);
  }

  /** @param {{t: number, bytes: number}[]} samples @param {number} byteLength */
  #pushSample(samples, byteLength) {
    samples.push({ t: Date.now(), bytes: byteLength });
    this.#pruneSamples(samples);
  }

  /** Drops every sample older than `RATE_WINDOW_MS` - `samples` is always chronological (pushed in time order), so this only ever needs to trim from the front. @param {{t: number, bytes: number}[]} samples */
  #pruneSamples(samples) {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (samples.length && samples[0].t < cutoff) samples.shift();
  }

  /** @param {{t: number, bytes: number}[]} samples @returns {number} Average bytes/sec over the trailing `RATE_WINDOW_MS` - re-prunes at READ time too (not just on write), so an idle connection's rate correctly decays toward 0 rather than showing a stale burst forever. */
  #currentRate(samples) {
    this.#pruneSamples(samples);
    let sum = 0;
    for (const s of samples) sum += s.bytes;
    return sum / (RATE_WINDOW_MS / 1000);
  }

  /**
   * TELEMETRY - see `apps/relay-federation`'s sibling `apps/debug` UI (or
   * any debug-mode-gated display) for what consumes these. Byte counts are
   * UTF-8 byte length of the JSON wire payload (`TextEncoder`-measured, not
   * `.length`, which is UTF-16 code units and would undercount for
   * non-ASCII content like emoji in chat messages) - the same unit both
   * `send()`'s outbound path and the inbound `message` listener measure in,
   * so `getBytesIn()`/`getBytesOut()` are directly comparable. Session-only
   * (in-memory, never persisted) - resets to 0 on every fresh page load /
   * new transport instance, by design (see `packages/ui`'s debug-mode doc
   * comment on why this is treated as transient diagnostic state, not
   * history).
   * @returns {number} Total bytes received since this transport was constructed.
   */
  getBytesIn() {
    return this.#bytesIn;
  }

  /** @returns {number} Total bytes sent since this transport was constructed. See `getBytesIn()`'s own doc comment. */
  getBytesOut() {
    return this.#bytesOut;
  }

  /** @returns {number} Average inbound bytes/sec over the trailing `RATE_WINDOW_MS` (5s) - 0 if nothing arrived that recently. */
  getCurrentRateIn() {
    return this.#currentRate(this.#inSamples);
  }

  /** @returns {number} Average outbound bytes/sec over the trailing `RATE_WINDOW_MS` (5s) - 0 if nothing was sent that recently. */
  getCurrentRateOut() {
    return this.#currentRate(this.#outSamples);
  }
}
