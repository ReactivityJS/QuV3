import { randomUUID } from 'node:crypto';
import { Transport } from '@qu/sync';
import { createLogger } from '@qu/log';

const log = createLogger('WebSocketServerTransport');
const textEncoder = new TextEncoder();
// See getCurrentRateIn()/getCurrentRateOut() - same trailing-window design
// as @qu/sync's WebSocketClientTransport (client-side counterpart).
const RATE_WINDOW_MS = 5000;

/**
 * WEBSOCKET SERVER TRANSPORT — the server side of `@qu/sync`'s `Transport`
 * interface, built on the `ws` package. Assigns each connecting socket a
 * stable peerId (so `SyncEngine`'s `sendTo(peerId, ...)`/subscriber
 * bookkeeping has something meaningful to key on - a transport that just
 * passed the raw `ws` connection object around instead would work for
 * "reply to whoever just asked" but couldn't address a specific peer chosen
 * earlier, e.g. for `fetch(path, targetPeerId)`).
 */
export class WebSocketServerTransport extends Transport {
  #peerId;
  #peers;
  #callbacks;
  #maxMessagesPerMinute;
  #messageCounts;
  #bytesIn = 0;
  #bytesOut = 0;
  #inSamples = []; // {t, bytes}, chronological - see #currentRate()
  #outSamples = [];

  /**
   * @param {import('ws').WebSocketServer} wss - Already listening.
   * @param {{maxMessagesPerMinute?: number}} [options] - `maxMessagesPerMinute`:
   *   0 (default) means unlimited. A fixed-window-per-peer counter, not a
   *   sliding one - simple and cheap, and "roughly N/minute" is all a
   *   casual-abuse guard needs to be; see `setRateLimit()` for changing this
   *   live (e.g. from an admin settings change) without dropping connections.
   */
  constructor(wss, { maxMessagesPerMinute = 0 } = {}) {
    super();
    this.wss = wss;
    this.#peerId = `relay-${randomUUID()}`;
    /** @type {Map<string, import('ws').WebSocket>} */
    this.#peers = new Map();
    this.#callbacks = [];
    this.#maxMessagesPerMinute = maxMessagesPerMinute;
    /** @type {Map<string, {count: number, windowStart: number}>} */
    this.#messageCounts = new Map();

    this.wss.on('connection', (ws) => {
      const peerId = `peer-${randomUUID()}`;
      this.#peers.set(peerId, ws);
      log.debug(`${peerId} connected (${this.#peers.size} total)`);

      ws.on('message', (raw) => {
        // Counted BEFORE the rate-limit check below - bytes genuinely
        // arrived over the wire regardless of whether this peer is over its
        // limit (see getBytesIn()'s own doc comment). `raw` is already a
        // Buffer here, so `.length` is an exact byte count - no encoding
        // step needed, unlike the outbound side below.
        this.#recordIn(raw.length);
        if (this.#isRateLimited(peerId)) return; // silently dropped - a misbehaving/abusive peer gets no signal to adapt to, an honest one self-throttles from normal usage patterns anyway
        let data;
        try {
          data = JSON.parse(raw.toString());
        } catch {
          log.warn(`dropping malformed message from ${peerId}`);
          return;
        }
        for (const cb of this.#callbacks) cb({ data, peerId });
      });

      ws.on('close', () => {
        this.#peers.delete(peerId);
        this.#messageCounts.delete(peerId);
        log.debug(`${peerId} disconnected (${this.#peers.size} remaining)`);
      });
    });
  }

  /** @param {number} maxMessagesPerMinute - 0 disables the limit. Takes effect for every peer's NEXT message, no reconnect needed. */
  setRateLimit(maxMessagesPerMinute) {
    this.#maxMessagesPerMinute = maxMessagesPerMinute;
  }

  /** @param {string} peerId @returns {boolean} */
  #isRateLimited(peerId) {
    if (!this.#maxMessagesPerMinute) return false;
    const now = Date.now();
    const entry = this.#messageCounts.get(peerId);
    if (!entry || now - entry.windowStart >= 60_000) {
      this.#messageCounts.set(peerId, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;
    return entry.count > this.#maxMessagesPerMinute;
  }

  getPeerId() {
    return this.#peerId;
  }

  async connect() {
    // The WebSocketServer is already listening by the time this transport
    // is constructed - nothing to do here.
  }

  /** Broadcasts to every currently connected peer. */
  send(data) {
    const message = JSON.stringify(data);
    const bytes = textEncoder.encode(message).length;
    for (const ws of this.#peers.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
        this.#recordOut(bytes); // once per ACTUAL send - N peers means N real writes to N sockets, not one shared count
      }
    }
  }

  /** @param {string} peerId @param {object} data */
  sendTo(peerId, data) {
    const ws = this.#peers.get(peerId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    const message = JSON.stringify(data);
    this.#recordOut(textEncoder.encode(message).length);
    ws.send(message);
  }

  onMessage(callback) {
    this.#callbacks.push(callback);
  }

  /**
   * Forcibly closes every currently connected peer socket. Node's
   * `http.Server.close()` only stops accepting NEW connections - it waits
   * indefinitely for existing ones (including open WebSocket upgrades) to
   * close on their own before its callback fires. Call this before closing
   * the HTTP server during shutdown, or `close()` will hang forever with a
   * single connected client still attached.
   */
  closeAllPeers() {
    for (const ws of this.#peers.values()) ws.terminate();
    this.#peers.clear();
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

  /** @param {{t: number, bytes: number}[]} samples */
  #pruneSamples(samples) {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (samples.length && samples[0].t < cutoff) samples.shift();
  }

  /** @param {{t: number, bytes: number}[]} samples @returns {number} Average bytes/sec over the trailing `RATE_WINDOW_MS`, summed across ALL currently/recently connected peers - see `getCurrentRateIn()`'s own doc comment. */
  #currentRate(samples) {
    this.#pruneSamples(samples);
    let sum = 0;
    for (const s of samples) sum += s.bytes;
    return sum / (RATE_WINDOW_MS / 1000);
  }

  /**
   * TELEMETRY - aggregate byte counters across EVERY client (and, when this
   * transport backs the relay's client-facing `SyncEngine`, every inbound
   * federation-peer dial too - both land in the same `#peers` map, see this
   * class's own top doc comment) this transport has ever served, not
   * per-peer. See `@qu/relay`'s `traffic-stats.js` for where this is
   * combined with `FederationTransport`'s own OUTBOUND-side counters into
   * one relay-wide snapshot exposed to `apps/relay-admin`. Session-only (see
   * `@qu/sync`'s `WebSocketClientTransport.getBytesIn()`'s identical doc
   * comment on why this is never persisted).
   * @returns {number}
   */
  getBytesIn() {
    return this.#bytesIn;
  }

  /** @returns {number} See `getBytesIn()`'s own doc comment. */
  getBytesOut() {
    return this.#bytesOut;
  }

  /** @returns {number} Average inbound bytes/sec over the trailing `RATE_WINDOW_MS` (5s), summed across every peer. */
  getCurrentRateIn() {
    return this.#currentRate(this.#inSamples);
  }

  /** @returns {number} Average outbound bytes/sec over the trailing `RATE_WINDOW_MS` (5s), summed across every peer. */
  getCurrentRateOut() {
    return this.#currentRate(this.#outSamples);
  }
}
