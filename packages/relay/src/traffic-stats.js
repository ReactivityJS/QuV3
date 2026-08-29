/**
 * TRAFFIC STATS — relay-wide byte/rate telemetry, combining two independent
 * counters this relay already tracks separately into ONE snapshot for
 * `apps/relay-admin`'s debug-mode traffic section (see
 * `packages/relay/src/http-router.js`'s `GET /admin/traffic-stats`):
 *
 *   - `WebSocketServerTransport`'s own counters (`this.transport` in
 *     `relay.js`) - every INBOUND connection this relay serves, which is
 *     both ordinary browser clients AND any peer relay that dialed INTO
 *     this one (see that class's own doc comment - both land in the same
 *     `#peers` map, there is no separate inbound federation listener).
 *   - `FederationTransport`'s own `getAggregateStats()` (`federationManager.
 *     transport` in `relay.js`) - every OUTBOUND connection this relay
 *     itself dialed to a configured federation peer.
 *
 * Deliberately a tiny, dependency-free wrapper - each half already does its
 * own counting (see either transport's own doc comment), this class only
 * ever adds the two together and remembers when the relay itself booted
 * (`sinceMs`, so a caller can show "since relay start" rather than
 * pretending this is a lifetime total across restarts - it isn't, these
 * counters are always in-memory/session-only, same as the client-side
 * counters they mirror).
 */
export class TrafficStats {
  #clientTransport;
  #federationTransport;
  #startedAt = Date.now();

  /**
   * @param {{clientTransport: import('./transports/websocket-server-transport.js').WebSocketServerTransport, federationTransport?: import('./transports/federation-transport.js').FederationTransport|null}} options -
   *   `federationTransport` is optional (omitted/`null` before federation is
   *   wired up, or in a context with no federation at all) - contributes
   *   zero to every total when absent.
   */
  constructor({ clientTransport, federationTransport = null }) {
    this.#clientTransport = clientTransport;
    this.#federationTransport = federationTransport;
  }

  /** @returns {{bytesIn: number, bytesOut: number, rateIn: number, rateOut: number, sinceMs: number}} */
  getSnapshot() {
    const federation = this.#federationTransport?.getAggregateStats() ?? { bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0 };
    return {
      bytesIn: this.#clientTransport.getBytesIn() + federation.bytesIn,
      bytesOut: this.#clientTransport.getBytesOut() + federation.bytesOut,
      rateIn: this.#clientTransport.getCurrentRateIn() + federation.rateIn,
      rateOut: this.#clientTransport.getCurrentRateOut() + federation.rateOut,
      sinceMs: this.#startedAt,
    };
  }
}
