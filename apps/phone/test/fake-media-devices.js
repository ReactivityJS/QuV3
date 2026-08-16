// Minimal `navigator.mediaDevices.getUserMedia()` fake - Node has no
// `navigator` global at all (confirmed: @qu/ui/testing's installDom() only
// ever sets window/document/HTMLElement/customElements/CustomEvent/Node,
// never navigator), so this is a from-scratch stub, not an extension of
// something jsdom already provides.

function fakeTrack(kind) {
  return { kind, id: `${kind}-track`, enabled: true, stopped: false, stop() { this.stopped = true; } };
}

function fakeMediaStream() {
  const tracks = [fakeTrack('audio'), fakeTrack('video')];
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
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        async getUserMedia() {
          if (deny) throw new Error('Permission denied');
          return fakeMediaStream();
        },
      },
    },
    configurable: true,
    writable: true,
  });
}
