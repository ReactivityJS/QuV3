// Minimal `navigator.mediaDevices.getUserMedia()` fake - Node has no
// `navigator` global at all (confirmed: @qu/ui/testing's installDom() only
// ever sets window/document/HTMLElement/customElements/CustomEvent/Node,
// never navigator), so this is a from-scratch stub, not an extension of
// something jsdom already provides.

function fakeTrack(kind) {
  return { kind, id: `${kind}-track`, enabled: true, stopped: false, stop() { this.stopped = true; } };
}

/** Honors `constraints.video` (unlike a real device stub that always granted both) - lets tests confirm an audio-only request never even gets a video track, not just a video track that's later disabled. */
function fakeMediaStream(constraints) {
  const tracks = [fakeTrack('audio')];
  if (constraints?.video !== false) tracks.push(fakeTrack('video'));
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
}

/**
 * @param {{deny?: boolean}} [options] - `deny: true` makes getUserMedia() reject, simulating a denied/unavailable device.
 *
 * Node 22+ has its OWN built-in `globalThis.navigator` (a getter-only own
 * property backing its experimental Navigator API, e.g. `navigator.userAgent`)
 * - a plain `globalThis.navigator = ...` throws (`Cannot set property
 * navigator ... which has only a getter`), so this replaces it via
 * `Object.defineProperty()` instead, same as any other read-only global a
 * test needs to stub.
 */
export function installFakeMediaDevices({ deny = false } = {}) {
  const calls = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        async getUserMedia(constraints) {
          calls.push(constraints);
          if (deny) throw new Error('Permission denied');
          return fakeMediaStream(constraints);
        },
      },
    },
    configurable: true,
    writable: true,
  });
  return calls; // test-only: every constraints object getUserMedia() was called with, in order
}
