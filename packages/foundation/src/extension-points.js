import { QuEvents } from '@qu/core';
import { createLogger } from '@qu/log';
import { rankFor } from './extension-order.js';

const log = createLogger('extension-points');

/**
 * EXTENSION POINTS — the Drupal-hooks-inspired mechanism behind manifest.js's
 * `contributes` field (see that field's own doc comment for the full
 * rationale/vocabulary). One `ExtensionPointHost` is built from the SAME
 * apps catalog every mounted app already receives as `ctx.apps` (see
 * `apps/shell/client.js`'s `renderRoute()`, which constructs one per route
 * and hands it to the mounted app as `ctx.extensionPoints`).
 *
 * SCOPE, NARROWED ON PURPOSE: an earlier version of this class also had
 * `run()`/`notify()` "callback hook" methods wrapping a private `HookBus`,
 * covering e.g. "before/after a message is saved". That was REMOVED - Qu
 * Core already has exactly that mechanism, `QuStore.onStorageChange()` (see
 * `@qu/core/store.js`), which `@qu/reactive`'s `watch()`/`watchChildren()`,
 * `@qu/sync`, and `@qu/relay` all already build on. A save/storage-triggered
 * reaction needs NO indirection through a named "point" string at all - a
 * contributor just calls `qu.onStorageChange(({path, quBit}) => {...})`
 * directly, filtering by path, exactly like every other place in this
 * codebase already does. Duplicating that as a second, parallel hook bus
 * here would be new functionality Qu doesn't need - this class stays scoped
 * to the ONE problem Core genuinely can't solve on its own: Core has no
 * concept of "apps", "manifests", or "only one app's UI is mounted at a
 * time", so it can't know how to go find and load another app's contributed
 * UI. That crossing is what's actually built here. A point that's really
 * just "notify me when X is written" belongs in `definesExtensionPoints`
 * with `kind: 'hook'` for DISCOVERABILITY only (documenting that the point
 * exists and how to actually subscribe to it) - it has no `ExtensionPointHost`
 * method backing it, on purpose.
 *
 * THE CORE TRICK (what's actually left, and why it's still needed): only ONE
 * app's `clientMain` is ever mounted in-place at a time (see `actions.js`'s
 * own doc comment on that constraint) - but nothing stops a DIFFERENT app's
 * already-catalog-known, already-integrity/signature-pinned `clientMainUrl`
 * from being dynamically `import()`-ed just to grab one of its OTHER named
 * exports, without ever calling `mount()` on it or putting it in charge of
 * the screen. That's exactly what a shell already does for the ACTIVE app
 * (`await import(app.clientMainUrl)`); this class does the same thing for
 * any number of BACKGROUND contributor apps, caching each module after its
 * first import (a contributor invoked from many rows of a `<qu-list>`, e.g.
 * a Like button per message, must not re-fetch/re-eval its module once per
 * row).
 *
 * "The realization should be modeled like Core's own listeners" - so once a
 * manifest-declared contributor is actually loaded, REGISTERING and FIRING
 * it reuses `@qu/core`'s own `QuEvents` (the exact class `QuStore` itself
 * uses internally for its `storage:put` notify bus) instead of a bespoke
 * re-implementation - same `on(topic, handler, {order})` shape, same
 * ordering/fault-isolation guarantees, imported directly from `@qu/core`,
 * not reinvented here:
 *
 *   - `renderSlot(point, container, payload)` - UI slot / content plugin,
 *     e.g. Share/Bookmark buttons on a forum message. Every contributor's
 *     `export`ed function is registered onto an internal `QuEvents` instance
 *     as `(itemContainer, payload) -> void|Promise<void>`, called via
 *     `QuEvents.emit()` and expected to mount its own DOM into `itemContainer`
 *     (a fresh child element created per contributor, so contributors can't
 *     stomp each other's DOM). `QuEvents` itself provides the ordering
 *     (`contributes[].order`) and per-listener fault isolation.
 *   - `collect(point, payload)` - context menu / data-returning extension:
 *     `export`'s function is `(payload) -> Array<{id, label, icon?, onClick}>
 *     | Promise<...>`, results from every contributor concatenated and
 *     returned. Deliberately NOT built on `QuEvents.emit()` - `QuEvents`
 *     is fire-and-forget fan-out by design (return values are documented as
 *     "simply ignored, not chained"), and gathering answers back is a
 *     genuinely different primitive, so this one case keeps its own small
 *     loop rather than forcing a shape that doesn't fit.
 *
 * NOT this class's job: WHICH apps get dynamically imported here is entirely
 * a function of the trusted apps catalog (`ctx.apps`, already vetted the
 * same way the shell vets the one app it mounts) - this class adds no new
 * trust decision, it only adds new call sites for a trust decision that
 * already exists.
 */
export class ExtensionPointHost {
  /** @type {Array<object>} */
  #apps;
  /** @type {QuEvents} */
  #events;
  /** @type {Record<string, string[]>|null} */
  #extensionOrder;
  /** @type {Map<string, Promise<object>>} */
  #moduleCache = new Map();
  /** @type {Set<string>} */
  #registeredPoints = new Set();

  /**
   * @param {Array<object>} apps - The manifest catalog (e.g. `ctx.apps`) -
   *   each entry as `buildAppsCatalog()` shapes it (`name`, `clientMainUrl`,
   *   `contributes`, ...).
   * @param {{events?: QuEvents, extensionOrder?: Record<string, string[]>}} [options]
   *   `events` lets a caller share one `QuEvents` instance across several
   *   `ExtensionPointHost`s, or register its own LOCAL, in-memory `.on()`
   *   handlers (e.g. from the currently mounted app's own code) alongside
   *   manifest-declared contributors for the same `point` - defaults to a
   *   fresh, private instance. `extensionOrder` is relay-settings' own
   *   admin-edited `{[point]: [id, ...]}` map (see `extension-order.js`'s
   *   own doc comment) - when a point's id is listed there, it overrides
   *   that contributor's manifest `contributes[].order` for sorting
   *   purposes; exposed back via the `.order` getter below so a host app
   *   can rank its OWN native items (via `rankFor()`) consistently with
   *   whatever a plugin contributor gets sorted by.
   */
  constructor(apps, { events, extensionOrder } = {}) {
    this.#apps = apps ?? [];
    this.#events = events ?? new QuEvents();
    this.#extensionOrder = extensionOrder ?? null;
  }

  /** The underlying `QuEvents` bus - exposed so a mounted app can `.on()` its own local handlers alongside manifest-declared contributors. */
  get events() {
    return this.#events;
  }

  /** The admin-edited `{[point]: [id, ...]}` order map this host was built with (possibly `null`) - see `extension-order.js`'s `rankFor()`, the intended way to consult it. */
  get order() {
    return this.#extensionOrder;
  }

  /**
   * @param {string} point
   * @param {HTMLElement} container
   * @param {*} payload
   */
  async renderSlot(point, container, payload) {
    await this.#ensureRegistered(point);
    await this.#events.emit(point, { container, payload });
  }

  /**
   * @param {string} point
   * @param {*} payload
   * @returns {Promise<Array<object>>}
   */
  async collect(point, payload) {
    const out = [];
    for (const contributor of this.#contributorsFor(point)) {
      const fn = await this.#load(contributor);
      if (!fn) continue;
      try {
        const items = await fn(payload);
        if (items) for (const item of [].concat(items)) out.push({ ...item, appId: contributor.appId });
      } catch (err) {
        log.error(`contributor "${contributor.appId}" failed collecting for "${point}":`, err);
      }
    }
    return out;
  }

  #contributorsFor(point) {
    const found = [];
    for (const app of this.#apps) {
      if (app.enabled === false) continue; // an admin-disabled app (relay-settings' disabledApps) contributes nothing, same as not being in the catalog at all
      for (const c of app.contributes ?? []) {
        if (c.point !== point) continue;
        // rankFor() lets an admin's extensionOrder override this manifest
        // order for sorting purposes - see this class's own constructor
        // doc comment and extension-order.js's own doc comment.
        found.push({ appId: app.name, clientMainUrl: app.clientMainUrl, export: c.export, order: rankFor(this.#extensionOrder, point, app.name, c.order ?? 0) });
      }
    }
    return found.sort((a, b) => a.order - b.order);
  }

  async #load(contributor) {
    if (!contributor.clientMainUrl) return null;
    let modPromise = this.#moduleCache.get(contributor.clientMainUrl);
    if (!modPromise) {
      modPromise = import(/* @vite-ignore */ contributor.clientMainUrl);
      this.#moduleCache.set(contributor.clientMainUrl, modPromise);
    }
    try {
      const mod = await modPromise;
      return mod[contributor.export] ?? null;
    } catch (err) {
      log.error(`failed loading contributor module "${contributor.clientMainUrl}":`, err);
      return null;
    }
  }

  /** Lazily registers every manifest-declared contributor for `point` onto `#events`, once - repeat calls (many rows of a list, several renderSlot()s for the same point) reuse the same registration. */
  async #ensureRegistered(point) {
    if (this.#registeredPoints.has(point)) return;
    this.#registeredPoints.add(point);
    for (const contributor of this.#contributorsFor(point)) {
      this.#events.on(point, async ({ container, payload }) => {
        const fn = await this.#load(contributor);
        if (!fn) return;
        const itemEl = document.createElement('div');
        itemEl.className = 'qu-ext-slot-item';
        itemEl.dataset.contributorApp = contributor.appId;
        container.appendChild(itemEl);
        try {
          await fn(itemEl, payload);
        } catch (err) {
          itemEl.remove();
          log.error(`contributor "${contributor.appId}" failed rendering slot "${point}":`, err);
        }
      }, { order: contributor.order });
    }
  }
}

/**
 * Pure query over the catalog's `definesExtensionPoints` declarations (see
 * manifest.js's own doc comment) - the CODE-level counterpart to reading
 * that field as static JSON: lets a caller discover every extension point
 * the currently loaded system defines (including plain `kind: 'hook'`
 * points that are really just a `qu.onStorageChange()`/`watch()` path, not
 * something this class renders), and what defined it, without grepping
 * source. Deliberately a standalone function, not a method (same reasoning
 * as `actionsForSlot()` - it's a pure read over data a caller already has,
 * no instance state needed).
 * @param {Array<object>} apps - The manifest catalog (e.g. `ctx.apps`).
 * @returns {Array<{point: string, kind: string|null, description: string|null, definedBy: string}>}
 */
export function listDefinedPoints(apps) {
  const out = [];
  for (const app of apps ?? []) {
    for (const d of app.definesExtensionPoints ?? []) {
      out.push({ point: d.point, kind: d.kind ?? null, description: d.description ?? null, definedBy: app.name });
    }
  }
  return out;
}
