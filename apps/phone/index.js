/** PHONE — purely a client-side (WebRTC audio/video calling) app; nothing to register server-side. See client.js/src/call.js's own doc comments. */
export async function register(qu, manifest) {
  console.log(`[${manifest.name}] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
