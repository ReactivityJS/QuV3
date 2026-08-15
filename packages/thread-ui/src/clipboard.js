/**
 * CLIPBOARD — one tiny shared "best-effort copy" used by both
 * `apps/forum/client.js` and `apps/chat/client.js`'s own "Copy text"/"Copy
 * link" context-menu items, so the identical try/catch (`navigator.
 * clipboard` is unavailable over plain HTTP, in an iframe without the
 * `clipboard-write` permission, ...) doesn't need to exist twice. Same
 * "swallow, the action just silently does nothing" fallback
 * `apps/shell/src/onboarding.js`'s own recovery-phrase "Copy" button
 * already uses - there's no in-menu surface left to show an error in
 * anyway, since `renderContextMenu()` already closes the panel before
 * calling `onClick()`.
 * @param {string} text
 * @returns {Promise<boolean>} Whether the copy actually happened.
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
