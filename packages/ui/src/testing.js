/**
 * TESTING — a tiny jsdom bootstrap, shared by this package's own Custom
 * Element tests and every app under `apps/*` that renders DOM in a test
 * (`apps/app-list`, `apps/user-list`, `apps/contact-list`). Node has no
 * DOM; `@qu/ui`'s Custom Elements need `HTMLElement`/`customElements`/
 * `document` to even be IMPORTABLE at all (they extend `HTMLElement` at
 * module-evaluation time - see `components.js`'s own doc comment).
 *
 * Deliberately NOT part of the default `.` export: this pulls in `jsdom`
 * (a devDependency here, not a runtime one - see this package's
 * `package.json`), so importing it from anything other than a test file
 * would be a mistake a separate `./testing` subpath makes easy to avoid -
 * a production bundle that never imports this subpath never sees `jsdom`
 * at all.
 */
import { JSDOM } from 'jsdom';

const GLOBAL_KEYS = ['window', 'document', 'HTMLElement', 'customElements', 'CustomEvent', 'Node'];

/**
 * Installs a fresh jsdom window's globals onto `globalThis`. Call this
 * BEFORE dynamically `import()`-ing anything that (transitively) imports
 * `@qu/ui`'s `components.js` - a plain top-level `import` is hoisted ahead
 * of any other code in the same module, so `installDom()` would run too
 * late to matter if the Custom Element module were imported statically in
 * the same file (see this package's own test files for the pattern).
 *
 * Call once per test FILE, not per test: `customElements.define()` throws
 * on a second registration for the same tag name, so re-installing a fresh
 * jsdom window (and therefore a fresh, empty custom-element registry) more
 * than once per file would make re-importing `components.js` fail the
 * second time.
 * @returns {() => void} Restores whatever was on `globalThis` before.
 */
export function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const previous = {};
  for (const key of GLOBAL_KEYS) previous[key] = globalThis[key];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.customElements = dom.window.customElements;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.Node = dom.window.Node;
  return () => {
    for (const key of GLOBAL_KEYS) globalThis[key] = previous[key];
  };
}

/**
 * Polls `check()` until it returns truthy, instead of guessing how many
 * microtask ticks a render needs. A fixed count of `setImmediate`/
 * `Promise.resolve()` flushes is fragile the moment more than one real
 * async layer is involved (a mocked `fetch()` plus a real Service's own
 * `await` chain, e.g. `apps/user-list/client.js`'s combined
 * `directory.listVisible()` + `contacts.listContacts()` + per-entry
 * `profiles.getPublicProfile()` calls) - each extra `await` inside the
 * code under test can need one more tick than the test happened to flush,
 * making the test's PASS/FAIL depend on implementation detail unrelated to
 * what it's actually asserting. Polling waits exactly as long as needed,
 * no more, no less, regardless of how many real async layers are involved.
 *
 * `check` may itself be `async` (e.g. `() => services.foo.isBar()`) - the
 * `await` below is load-bearing, not defensive style: `!check()` on an
 * async `check` tests the (always-truthy) `Promise` object itself, never
 * its resolved value, so a naive `while (!check())` returns immediately
 * having polled nothing at all. FIXED (was a real, silent bug here for a
 * long time - every caller passing an async `check` was, in effect, not
 * actually waiting for anything; it only ever looked like it worked
 * because by the time a test's next line ran, the real condition had
 * usually already become true anyway - a coincidence, not a guarantee,
 * and the actual source of several "occasionally flaky" tests across this
 * codebase's app suites).
 * @param {() => boolean|Promise<boolean>} check
 * @param {{timeout?: number, interval?: number}} [options]
 * @returns {Promise<void>}
 */
export async function waitFor(check, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`waitFor: condition never became true within ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
