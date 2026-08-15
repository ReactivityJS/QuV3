/**
 * PLATFORM — one small heuristic deciding whether `renderEmojiPicker()`
 * (see emoji.js's own doc comment) should defer to the host OS's own
 * emoji keyboard (Android GBoard, iOS keyboard, ...) instead of loading
 * `@qu/thread-ui`'s own desktop panel (see emoji-panel.js).
 *
 * `(pointer: coarse)` - the device's PRIMARY pointer is a finger, not a
 * mouse - rather than Android-only (or any-OS) user-agent sniffing: every
 * touch device with a software keyboard, Android AND iOS/iPadOS alike,
 * already ships a native emoji panel with its own "recently used" row
 * maintained by the OS, so there's no reason to special-case just one of
 * them, and UA strings are trivially spoofable/unreliable besides. A
 * device with BOTH a touch screen and an attached mouse/trackpad reports
 * whichever pointer type the OS considers primary - exactly the signal
 * that matters here (does the user have a software keyboard as their main
 * text input right now), not "does this hardware have a touchscreen at
 * all".
 */
export function prefersNativeEmojiKeyboard() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false; // some non-browser/older DOM shim without a working matchMedia - fall back to the desktop panel rather than throwing
  }
}
