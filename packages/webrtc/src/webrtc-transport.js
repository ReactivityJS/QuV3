import { Transport } from '@qu/sync/transport';
import { createLogger } from '@qu/log';
import { PeerConnection } from './peer-connection.js';
import { resolveIceServers } from './ice-config.js';

const log = createLogger('webrtc:transport');

/**
 * WEBRTC TRANSPORT — a general implementation of `@qu/sync`'s `Transport`
 * interface, not a mechanism specific to any one mount or app. That
 * interface's own doc comment already names "a WebRTC data channel" as a
 * hypothetical implementation; this is it. Any `SyncEngine` - one replicating
 * a volatile app-feature mount, or (see the plan's "Generalität" section)
 * one replicating the durable `store`/`blob` mount directly between two
 * browsers - can be backed by this class exactly as it would by
 * `WebSocketClientTransport`.
 *
 * Unlike `WebSocketClientTransport` (which only ever talks to the one relay
 * it connected to), this class manages a `Map<peerId, PeerConnection>` -
 * architecturally the SAME "multiple simultaneous peers" category
 * `SyncEngine`'s own `targetPeerId` parameters already anticipate for a
 * relay's SERVER-side transport (see `sync-engine.js`'s own doc comments on
 * `subscribe()`/`fetch()`/`fetchPrefix()`), even though this runs in a
 * browser.
 *
 * `peerId` here is always a stable actor pubkey (base64url), never an
 * ephemeral relay-assigned connection id - that's what makes the
 * DETERMINISTIC INITIATOR tie-break below possible: both sides compute
 * `selfPeerId < remotePeerId` independently and always agree, so exactly one
 * side creates the data channel and sends the first offer, with no extra
 * negotiation message and no "glare" (both sides offering at once).
 *
 * This class never sends or receives a signal (SDP offer/answer, ICE
 * candidate) over any network channel itself - see `onOutgoingSignal()`/
 * `handleIncomingSignal()`. Delivering those is the caller's job (see
 * `@qu/services`' `WebRtcSignalService`, which carries them over the
 * existing relay-backed sync stack).
 */
export class WebRTCTransport extends Transport {
  #selfPeerId;
  #iceServers;
  #peers = new Map();
  #messageCallbacks = [];
  #outgoingSignalCallbacks = [];
  #peerConnectedCallbacks = [];

  /**
   * @param {{selfPeerId: string, iceServers?: Array<object>}} options -
   *   `selfPeerId`: this identity's own stable actor pubkey (base64url).
   *   `iceServers`: optional override/operator list - see `ice-config.js`'s
   *   own doc comment for the three-layer resolution this runs through.
   */
  constructor({ selfPeerId, iceServers } = {}) {
    super();
    if (!selfPeerId) throw new Error('WebRTCTransport: selfPeerId is required');
    this.#selfPeerId = selfPeerId;
    this.#iceServers = resolveIceServers({ operatorServers: iceServers });
  }

  /** No single "the connection" to establish here - each peer connects independently via `addPeer()`. Resolves immediately. */
  async connect() {}

  getPeerId() {
    return this.#selfPeerId;
  }

  #isInitiator(remotePeerId) {
    return this.#selfPeerId < remotePeerId;
  }

  /**
   * Starts (or returns the existing) connection to `peerId`. Idempotent -
   * safe to call more than once for the same peer.
   * @param {string} peerId
   * @param {{initiator?: boolean}} [options] - Defaults to the deterministic
   *   tie-break; only overridden internally on renegotiation-after-failure
   *   (see `#handleFailed()`) and by `handleIncomingSignal()` for a peer
   *   this side never proactively called `addPeer()` for.
   * @returns {PeerConnection}
   */
  addPeer(peerId, { initiator = this.#isInitiator(peerId) } = {}) {
    const existing = this.#peers.get(peerId);
    if (existing) return existing;
    const pc = new PeerConnection(peerId, {
      initiator,
      iceServers: this.#iceServers,
      onSignal: (signal) => {
        for (const cb of this.#outgoingSignalCallbacks) cb(peerId, signal);
      },
      onMessage: (data) => {
        for (const cb of this.#messageCallbacks) cb({ data, peerId });
      },
      onOpen: () => {
        for (const cb of this.#peerConnectedCallbacks) cb(peerId);
      },
      onClose: () => {
        if (this.#peers.get(peerId) === pc) this.#peers.delete(peerId);
      },
      onFailed: () => this.#handleFailed(peerId, pc),
    });
    this.#peers.set(peerId, pc);
    return pc;
  }

  /** A full renegotiation (fresh `RTCPeerConnection`), not a socket-style reopen - see `PeerConnection`'s own doc comment on why only `'failed'` gets here. */
  #handleFailed(peerId, pc) {
    log.warn(`connection to "${peerId}" failed - renegotiating`);
    pc.close();
    if (this.#peers.get(peerId) === pc) this.#peers.delete(peerId);
    this.addPeer(peerId, { initiator: this.#isInitiator(peerId) });
  }

  /**
   * Feeds a signal that arrived FROM `peerId` via the signaling channel into
   * the matching `PeerConnection`, creating one (as the answerer, `initiator:
   * false`) if this side never called `addPeer()` for them first.
   * @param {string} peerId @param {object} signal
   */
  handleIncomingSignal(peerId, signal) {
    const pc = this.#peers.get(peerId) ?? this.addPeer(peerId, { initiator: false });
    pc.handleSignal(signal).catch((err) => log.warn(`handleSignal from "${peerId}" failed:`, err.message));
  }

  /**
   * Registers a callback fired whenever a `PeerConnection` produces a signal
   * that needs to leave via the signaling channel - this class has no idea
   * what that channel is (see this file's own top doc comment).
   * @param {(peerId: string, signal: object) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onOutgoingSignal(callback) {
    this.#outgoingSignalCallbacks.push(callback);
    return () => {
      const idx = this.#outgoingSignalCallbacks.indexOf(callback);
      if (idx !== -1) this.#outgoingSignalCallbacks.splice(idx, 1);
    };
  }

  /**
   * Registers a callback fired once a peer's `RTCPeerConnection` AND its
   * data channel are both open - what a caller (e.g. `SyncEngine.subscribe()`
   * wiring, see the plan's "Ein Mount..." section) uses to know when it's
   * safe to start replicating to/from this peer.
   * @param {(peerId: string) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onPeerConnected(callback) {
    this.#peerConnectedCallbacks.push(callback);
    return () => {
      const idx = this.#peerConnectedCallbacks.indexOf(callback);
      if (idx !== -1) this.#peerConnectedCallbacks.splice(idx, 1);
    };
  }

  /**
   * `SyncEngine`'s own duck-typed reconnect hook (see its constructor:
   * `typeof transport.onReconnect === 'function'`) - what makes a
   * `publishAllTo`+`outbox` `SyncEngine` (see the plan's "Persistenz &
   * Re-Sync für private Direktkanäle" section) actually replay its
   * outbox/subscriptions once the connection it's addressed to comes up,
   * exactly like it already does for `WebSocketClientTransport`. A plain
   * alias for `onPeerConnected()`: for the 2-peer `publishAllTo` case this
   * hook exists for, "a peer connected" and "reconnected" are the same
   * event (there is only the one peer). For a multi-peer mesh `SyncEngine`
   * (no `outbox`, uses `subscribe()` instead - see `WebRTCAdapter`), this
   * still fires once per peer, which only re-runs `refreshSubscriptions()`
   * (harmless/idempotent, same "over-eager but harmless" reasoning
   * `SyncEngine`'s own doc comment already accepts for the relay case).
   * @param {(peerId: string) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onReconnect(callback) {
    return this.onPeerConnected(callback);
  }

  /** @param {string} peerId */
  removePeer(peerId) {
    const pc = this.#peers.get(peerId);
    if (!pc) return;
    pc.close();
    this.#peers.delete(peerId);
  }

  /** @param {object} data - Broadcast: reaches every peer whose data channel is currently open (or about to be, via its own queue - see `PeerConnection.send()`). */
  send(data) {
    for (const pc of this.#peers.values()) pc.send(data);
  }

  /** @param {string} peerId @param {object} data */
  sendTo(peerId, data) {
    const pc = this.#peers.get(peerId);
    if (!pc) {
      log.warn(`sendTo("${peerId}"): no such peer - call addPeer() first`);
      return;
    }
    pc.send(data);
  }

  /** @param {(msg: {data: object, peerId: string}) => void} callback */
  onMessage(callback) {
    this.#messageCallbacks.push(callback);
  }
}
