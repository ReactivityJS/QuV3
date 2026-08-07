import { HookBus } from './hooks.js';

/**
 * REGISTRY — the single place Engines and Services announce themselves.
 * This is what turns "a pile of loaded modules" into something the
 * DependencyResolver and other packages can look things up in by name,
 * instead of importing each other directly.
 *
 * Two kinds of registration:
 *   - Engine  - implements behaviour on top of Qu Core (e.g. "document-engine").
 *   - Service - a Data/Entity-API facade apps actually call (e.g. "document-service").
 *
 * The Registry does not instantiate anything itself - packages construct
 * their own Engine/Service instances (typically inside their manifest's
 * `register(qu, ctx)` export) and hand the finished object to
 * `registerEngine`/`registerService`. The Registry is purely a lookup table
 * plus a few invariants (no silent name collisions, clear errors on missing
 * lookups).
 *
 * Also carries one `hooks` field (see hooks.js's `HookBus`) - for
 * server-side `register(qu, manifest, registry)` calls that want to
 * run/transform at a specific moment (e.g.
 * `registry.hooks.on('cms.beforeSavePage', ...)`).
 *
 * DEFERRED, on purpose: a declarative "Capability" registration
 * (`registerCapability(entityKind, action, handler)` / `capabilitiesFor
 * (entityKind)`) existed in the QuV2 prototype this is built from, framed as
 * "what actions exist for this entity kind" for building context menus
 * without hardcoding them. It was never actually wired to a caller there -
 * dead API surface. It is deliberately NOT ported here yet; it comes back
 * paired with its first real consumer (a context-menu builder in the
 * Quniverse/app layer), not before. See docs/v3-technical-concept.md §2.2/§7.
 */
export class Registry {
  /** @type {Map<string, {instance: object, manifest: object|null}>} */
  #engines = new Map();
  /** @type {Map<string, {instance: object, manifest: object|null}>} */
  #services = new Map();
  /** @type {HookBus} */
  hooks = new HookBus();

  /**
   * @param {string} name - Unique engine name, e.g. "document-engine".
   * @param {object} instance
   * @param {object} [manifest] - The manifest that registered it, for diagnostics.
   */
  registerEngine(name, instance, manifest = null) {
    this.#assertFree(this.#engines, name, 'engine');
    this.#engines.set(name, { instance, manifest });
  }

  /**
   * @param {string} name - Unique service name, e.g. "document-service".
   * @param {object} instance
   * @param {object} [manifest]
   */
  registerService(name, instance, manifest = null) {
    this.#assertFree(this.#services, name, 'service');
    this.#services.set(name, { instance, manifest });
  }

  /**
   * @param {string} name
   * @returns {object} The registered engine instance.
   * @throws {Error} If not found - includes the list of known engines to help debugging.
   */
  getEngine(name) {
    return this.#get(this.#engines, name, 'engine');
  }

  /** @param {string} name @returns {object} */
  getService(name) {
    return this.#get(this.#services, name, 'service');
  }

  /** @param {string} name @returns {boolean} */
  hasEngine(name) {
    return this.#engines.has(name);
  }

  /** @param {string} name @returns {boolean} */
  hasService(name) {
    return this.#services.has(name);
  }

  /**
   * @param {string} name - Either an engine or a service name.
   * @returns {boolean} True if registered as either.
   */
  has(name) {
    return this.#engines.has(name) || this.#services.has(name);
  }

  /** @returns {string[]} All registered engine names. */
  listEngines() {
    return Array.from(this.#engines.keys());
  }

  /** @returns {string[]} All registered service names. */
  listServices() {
    return Array.from(this.#services.keys());
  }

  #assertFree(map, name, kind) {
    if (map.has(name)) {
      throw new Error(`Registry: ${kind} "${name}" is already registered`);
    }
  }

  #get(map, name, kind) {
    const entry = map.get(name);
    if (!entry) {
      const known = Array.from(map.keys()).join(', ') || '(none)';
      throw new Error(`Registry: no ${kind} named "${name}" (known: ${known})`);
    }
    return entry.instance;
  }
}
