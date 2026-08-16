/**
 * ICE CONFIG — resolves the `RTCIceServer[]` list a `WebRTCTransport` hands
 * to every `new RTCPeerConnection({iceServers})` it creates. Three layers,
 * each overriding the previous (see the plan's "ICE-Server-Konfiguration"
 * section):
 *   1. `DEFAULT_ICE_SERVERS` below - free/public STUN, works out of the box.
 *   2. A relay operator's configured list (fetched from `/config.json`,
 *      threaded in by the caller as `operatorServers`).
 *   3. An explicit `override` passed straight into a `WebRTCTransport`
 *      constructor by an app that wants to hardcode its own list.
 *
 * TURN is deliberately out of scope here (see docs/... the plan's "Offene
 * Risiken" section) - but the `RTCIceServer` shape (`{urls, username?,
 * credential?}`) already natively supports an operator adding TURN entries
 * to either layer above with zero code changes here.
 */

/** Free, public STUN servers - enough for most home/office NATs, no account needed. */
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * @param {{operatorServers?: Array<object>, override?: Array<object>}} [options]
 * @returns {Array<object>} The `RTCIceServer[]` to use.
 */
export function resolveIceServers({ operatorServers, override } = {}) {
  if (override && override.length > 0) return override;
  if (operatorServers && operatorServers.length > 0) return operatorServers;
  return DEFAULT_ICE_SERVERS;
}
