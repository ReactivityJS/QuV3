import { HookBus } from './hooks.js';
import { createLogger } from '@qu/log';

const log = createLogger('extension-points');

/**
 * EXTENSION POINTS — the Drupal-hooks-inspired, universal mechanism behind
 * manifest.js's `contributes` field (see that field's own doc comment for
 * the full rationale/vocabulary). One `ExtensionPointHost` is built from the
 * SAME apps catalog every mounted app already receives as `ctx.apps` (see
 * `apps/shell/client.js`'s `renderRoute()`, which now also constructs one
 * per route and hands it to the mounted app as `ctx.extensionPoints`).
 *
 * THE CORE TRICK: only ONE app's `clientMain` is ever mounted in-place at a
 * time (see `actions.js`'s own doc comment on that constraint) - but nothing
 * stops a DIFFERENT app's already-catalog-known, already-integrity/signature
 * -pinned `clientMainUrl` from being dynamically `import()`-ed just to grab
 * one of its OTHER named exports, without ever calling `mount()` on it or
 * putting it in charge of the screen. That's exactly what a shell already
 * does for the ACTIVE app (`await import(app.clientMainUrl)`); this class
 * does the same thing for any number of BACKGROUND contributor apps, caches
 * each module after its first import (a contributor invoked from many rows
 * of a `<qu-list>`, e.g. a Like button per message, must not re-fetch/re-eval
 * its module once per row), and exposes three thin, purpose-shaped callers
 * over that one mechanism - matching `contributes[].kind`'s three cases:
 *
 *   - `renderSlot(point, container, payload)` - UI slot / content plugin.
 *     Every contributor's `export`ed function is called as
 *     `(itemContainer, payload) -> void|Promise<void>` and expected to mount
 *     its own DOM into `itemContainer` (a fresh child element this method
 *     creates and appends per contributor, so contributors can't stomp each
 *     other's DOM). Contributors run in `order` (lower first).
 *   - `run(point, payload)` / `notify(point, payload)` - callback hooks.
 *     Delegates to an internal `HookBus` with EXACTLY that class's own
 *     `run`/`notify` semantics (sequential+payload-patching vs.
 *     parallel+side-effect-only, see hooks.js) - manifest-declared
 *     contributors for `point` are lazily registered onto the bus the FIRST
 *     time this point is asked for (nothing loads until actually needed),
 *     then every later call for the same `point` just reuses the bus.
 *   - `collect(point, payload)` - context menu / data-returning extension.
 *     Every contributor's function is called as `(payload) ->
 *     Array<object>|object|Promise<...>`; results are flattened into one
 *     array (each item tagged with `appId` so a caller can attribute/dedupe),
 *     sorted by `order`.
 *
 * ERROR ISOLATION: one contributor throwing (a bad module, a bug in someone
 * else's app) never breaks another contributor or the host app itself -
 * `renderSlot`/`collect` skip the failing contributor (removing its
 * already-appended container for `renderSlot`); `run`/`notify` inherit
 * `HookBus`'s own isolation (`notify` swallows per-handler, `run` still lets
 * a throw propagate - transformations legitimately need to be able to abort
 * the chain, exactly as documented on `HookBus.run` itself).
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
  /** @type {HookBus} */
  #hooks;
  /** @type {Map<string, Promise<object>>} */
  #moduleCache = new Map();
  /** @type {Set<string>} */
  #registeredHookPoints = new Set();

  /**
   * @param {Array<object>} apps - The manifest catalog (e.g. `ctx.apps`) -
   *   each entry as `buildAppsCatalog()` shapes it (`name`, `clientMainUrl`,
   *   `contributes`, ...).
   * @param {{hooks?: HookBus}} [options] - `hooks` lets a caller share one
   *   `HookBus` across several `ExtensionPointHost`s (e.g. so a LOCAL,
   *   in-memory `.on()` registration from the currently mounted app's own
   *   code and manifest-declared cross-app contributors both fire together
   *   for the same `point`) - defaults to a fresh, private bus.
   */
  constructor(apps, { hooks } = {}) {
    this.#apps = apps ?? [];
    this.#hooks = hooks ?? new HookBus();
  }

  /** The underlying `HookBus` - exposed so a mounted app can `.on()` its own local, in-memory handlers alongside manifest-declared contributors. */
  get hooks() {
    return this.#hooks;
  }

  /**
   * @param {string} point
   * @param {HTMLElement} container
   * @param {*} payload
   */
  async renderSlot(point, container, payload) {
    for (const contributor of this.#contributorsFor(point)) {
      const fn = await this.#load(contributor);
      if (!fn) continue;
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
    }
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

  /** @param {string} point @param {object} payload @returns {Promise<object>} */
  async run(point, payload) {
    await this.#ensureRegistered(point);
    return this.#hooks.run(point, payload);
  }

  /** @param {string} point @param {object} payload */
  async notify(point, payload) {
    await this.#ensureRegistered(point);
    return this.#hooks.notify(point, payload);
  }

  #contributorsFor(point) {
    const found = [];
    for (const app of this.#apps) {
      for (const c of app.contributes ?? []) {
        if (c.point !== point) continue;
        found.push({ appId: app.name, clientMainUrl: app.clientMainUrl, export: c.export, order: c.order ?? 0 });
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

  async #ensureRegistered(point) {
    if (this.#registeredHookPoints.has(point)) return;
    this.#registeredHookPoints.add(point);
    for (const contributor of this.#contributorsFor(point)) {
      this.#hooks.on(point, async (payload) => {
        const fn = await this.#load(contributor);
        return fn ? fn(payload) : undefined;
      }, { order: contributor.order });
    }
  }
}

/**
 * Pure query over the catalog's `definesExtensionPoints` declarations (see
 * manifest.js's own doc comment) - the CODE-level counterpart to reading
 * that field as static JSON: lets a caller discover every extension point
 * the currently loaded system defines, and what defined it, without
 * grepping source. Deliberately a standalone function, not a method (same
 * reasoning as `actionsForSlot()` - it's a pure read over data a caller
 * already has, no instance state needed) - a future "what extension points
 * exist" admin/dev view can call this directly, and `ExtensionPointHost`
 * doesn't need it for its own operation (a `point` id needs no prior
 * definition to be usable, exactly like a `HookBus` name - `contributes`
 * targeting an undeclared `point` still works, `definesExtensionPoints` is
 * discovery, never a gate).
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
