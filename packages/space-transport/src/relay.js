/**
 * RELAY FORWARDER — a blind store-and-forward relay: verifies an incoming
 * envelope's write signature against the Kind-Schema's write-ACL, then
 * forwards it to every other connected peer and (optionally) persists it.
 * It is given ONLY public keys, never an X25519 private key anywhere in its
 * construction - so unlike a peer, it cannot call `openUpdate()` even if
 * its code tried to. That is what "the relay never sees plaintext" means
 * here: not a policy this class promises to follow, but a capability it
 * was never handed in the first place (see envelope.js's `verifyEnvelope()`
 * vs `openUpdate()` split).
 *
 * `resolveKindSchema(nodeId)` lets the relay look up which Kind-Schema (and
 * therefore which write-ACL) a given Node id belongs to, without the relay
 * needing to understand what a Node's CONTENT means - same "blind to
 * content, aware only of routing/ACL metadata" posture QuStore's own relay
 * has today.
 */
import { verifyEnvelope } from '@qu/space-core';
import { QuCrypto } from '@qu/core';

/**
 * @param {{hub: object, members: Array<{pub: Uint8Array}>, resolveKindSchema: (nodeId: string) => object, storage?: object}} params
 */
export function createRelayForwarder({ hub, members, resolveKindSchema, storage = null }) {
  const writerPubs = new Set(members.map((m) => QuCrypto.toBase64(m.pub)));
  const isAuthorizedWriter = (pubB64) => writerPubs.has(pubB64);

  /** @type {Array<{nodeId: string, envelope: object}>} Every envelope this relay ever handled, ciphertext/signature only - for tests to assert "no plaintext ever passed through here." */
  const seen = [];

  hub.registerRelay(async (fromPeerId, { nodeId, envelope }) => {
    const kindSchema = resolveKindSchema(nodeId);
    if (!kindSchema) return; // unknown Node - nothing to route to.
    if (!(await verifyEnvelope(envelope, isAuthorizedWriter))) return; // bad/foreign signature - drop, never forwarded or stored.

    seen.push({ nodeId, envelope });
    await storage?.append(nodeId, envelope);

    for (const peerId of hub.peerIds()) {
      if (peerId === fromPeerId) continue; // never echo a write back to its own author.
      hub.deliverTo(peerId, fromPeerId, { nodeId, envelope });
    }
  });

  return { seen };
}
