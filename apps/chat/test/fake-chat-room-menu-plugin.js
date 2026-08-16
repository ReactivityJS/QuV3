/**
 * A minimal `content.chatRoomMenu` contributor, standing in for a real one
 * (e.g. apps/phone's `renderCallMenuItems()`) - see client.test.js's own
 * "content.chatRoomMenu" test section for why this needs to be a real,
 * separately `import()`-able module rather than an inline function (the
 * `ExtensionPointHost` resolves contributors by dynamically importing their
 * declared `clientMainUrl`, exactly like a real plugin app would be loaded).
 */
let seenPayloads = [];

export function renderFakeCallItem(payload) {
  seenPayloads.push(payload);
  return { id: 'fakeCall', label: 'Fake Call', icon: '📞', onClick: () => {} };
}

/** Test-only: every payload this contributor has been called with, in order. */
export function getSeenPayloads() {
  return [...seenPayloads];
}

/** Test-only: resets the recorded payloads between tests. */
export function resetSeenPayloads() {
  seenPayloads = [];
}
