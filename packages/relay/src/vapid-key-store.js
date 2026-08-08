import { generateVapidKeys } from '@qu/push';

const VAPID_PATH = '/store/secure/push/vapid';

/**
 * Resolves this relay's VAPID (RFC 8292) keypair: explicit `publicKey` +
 * `privateKey` options win if both are given; otherwise a keypair persisted
 * under LOCAL_ONLY_PREFIX (see `@qu/sync`'s `sync-engine.js` - same prefix
 * `relay-settings.js` uses, for the identical "never syncs to a peer"
 * reason) is reused across restarts, or generated once on first boot - the
 * same "pin explicitly, or auto-generate-and-persist" pattern this relay
 * already uses for its own operational identity.
 *
 * @param {import('@qu/core').QuStore} qu
 * @param {{publicKey?: string, privateKey?: string, subject?: string}} [options]
 *   `subject` (default 'mailto:admin@example.com') is required by every
 *   push service (RFC 8292) so they have someone to contact about abuse -
 *   override this for a real deployment.
 * @returns {Promise<{publicKey: string, privateKey: string, subject: string}>}
 */
export async function setupVapidKeys(qu, { publicKey, privateKey, subject = 'mailto:admin@example.com' } = {}) {
  if (publicKey && privateKey) {
    return { publicKey, privateKey, subject };
  }
  const stored = await qu.get(VAPID_PATH);
  if (stored?.val) {
    return { ...stored.val, subject };
  }
  const generated = generateVapidKeys();
  await qu.put(VAPID_PATH, generated);
  return { ...generated, subject };
}

export { VAPID_PATH };
