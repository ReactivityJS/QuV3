/** GEO CHASE — purely a client-side (WebRTC mesh + geolocation) app; nothing to register server-side. See client.js/src/mesh.js's own doc comments. */
export async function register(qu, manifest) {
  console.log(`[${manifest.name}] registered (${manifest.name}@${manifest.version}) - UI-only, see client.js`);
}
