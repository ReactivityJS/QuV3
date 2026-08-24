/**
 * CONTACTS (app id stays `user-list` - merged with the former
 * `apps/contact-list`, see client.js's own top doc comment) — server-side
 * half. UI-only (see client.js) - see apps/app-list/index.js for why this
 * stays a documented no-op.
 */
export async function register(qu, manifest) {
  console.log(`[user-list] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
