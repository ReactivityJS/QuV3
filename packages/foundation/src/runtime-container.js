/**
 * RUNTIME CONTAINER — the fix for docs/v3-technical-concept.md §2.1's "god
 * object" finding: `relay.js`/`apps/shell/src/main.js` in the prototype this
 * is rebuilt from grew into 600-900 line composition roots that accumulated
 * unrelated responsibilities (HTTP+WS+push+admin+static serving; routing+
 * menu+auth+badge+mount-context) as methods on one class, despite a clean
 * Services/Engines layer already existing underneath both. Layering the
 * *domain* code well didn't prevent a monolith at the *composition* root.
 *
 * `RuntimeContainer` is the same shape as `Registry`/`HookBus` (see
 * registry.js/hooks.js) - a small, generic piece of infrastructure, not
 * domain logic - generalized to be the ONE place a relay or a shell wires
 * cross-cutting concerns together:
 *
 *   runtime.register('pushDelivery', () => new PushDeliveryService(registry, catalog));
 *   runtime.register('adminApi', (rt) => new AdminApiRouter(rt.resolve('registry'), identity));
 *   const pushDelivery = runtime.resolve('pushDelivery'); // constructed here, on first use
 *   runtime.resolve('pushDelivery'); // same instance - already constructed
 *
 * This is a discipline, not just a container class - the concrete V3 rule
 * this enables: **no file wires more than one cross-cutting concern's worth
 * of behavior directly**; if it needs a second one, it becomes a registered
 * module instead of a method on a growing class. `relay.js`/`shell/main.js`
 * (not yet built in V3 - this package has no real caller for this yet, same
 * "comes back paired with its first real consumer" reasoning `registry.js`
 * already applies to `registerCapability`) are expected to shrink to:
 * construct the container, register each module, resolve what's needed,
 * start it.
 *
 * DELIBERATELY NOT INCLUDED HERE: `bootClientRuntime(config)` -
 * docs/v3-technical-concept.md §7 Finding 5's proposed shared helper for the
 * ~15-import client boot sequence (`QuStore`, every Engine, `QuIdentityEngine`,
 * `SyncEngine` + transport, Services, `HookBus`, ...) that both a shell and a
 * demo app would otherwise hand-assemble independently and let drift (the
 * concrete drift QuV2 had: `demo`'s Engine list was missing `ThreadEngine`).
 * That helper only pays for itself once there are at least two real callers
 * to de-duplicate - V3 has zero `apps/` yet. It is exactly the kind of
 * "build the general helper before its second caller exists" this
 * repository's own principles (see docs/v3-technical-concept.md §0) warn
 * against, so it is deferred to whichever of `@qu/relay`/`apps/shell` is
 * built first, not spec'd speculatively here.
 */
export class RuntimeContainer {
  /** @type {Map<string, (container: RuntimeContainer) => object>} */
  #factories = new Map();
  /** @type {Map<string, object>} */
  #instances = new Map();
  /** @type {Set<string>} Names currently being resolved - cycle detection. */
  #resolving = new Set();

  /**
   * @param {string} name - Unique module name, e.g. "pushDelivery".
   * @param {(container: RuntimeContainer) => object} factory - Called AT
   *   MOST ONCE, the first time `resolve(name)` is called (or never, if it
   *   never is) - registering something nobody ends up needing costs
   *   nothing. Receives this container, so a factory can depend on another
   *   registered module via `container.resolve('otherName')` without
   *   needing to close over a `runtime` variable from its own registration
   *   site. Must be SYNCHRONOUS - a module whose own setup is genuinely
   *   async (e.g. an identity engine needing `await importMnemonic()`
   *   first) does that itself, after resolving it, not as part of
   *   construction; this container only ever hands back an already-built
   *   object, never a Promise of one.
   * @throws {Error} If `name` is already registered - the same "no silent
   *   name collisions" invariant `Registry` enforces (registry.js), for the
   *   same reason: two unrelated modules quietly overwriting each other
   *   under one name is exactly the kind of bug that should fail loudly at
   *   registration time, not manifest as "the wrong thing got resolved"
   *   somewhere else entirely.
   */
  register(name, factory) {
    if (this.#factories.has(name)) {
      throw new Error(`RuntimeContainer: "${name}" is already registered`);
    }
    this.#factories.set(name, factory);
  }

  /**
   * Instantiates `name` on first call (running its factory), and returns
   * the SAME instance on every call after - a lazy singleton, not a
   * per-call factory invocation.
   *
   * @param {string} name
   * @returns {object}
   * @throws {Error} If `name` was never registered (message lists what was,
   *   same diagnostic shape as `Registry.getEngine()`'s own error), or if
   *   resolving it re-enters itself transitively (A's factory resolves B,
   *   whose factory resolves A) - reported as the exact cycle instead of a
   *   stack overflow, the same failure-mode choice
   *   `DependencyResolver.resolve()` already makes for a circular
   *   `requires` chain.
   */
  resolve(name) {
    if (this.#instances.has(name)) return this.#instances.get(name);

    const factory = this.#factories.get(name);
    if (!factory) {
      const known = Array.from(this.#factories.keys()).join(', ') || '(none)';
      throw new Error(`RuntimeContainer: no module named "${name}" (known: ${known})`);
    }

    if (this.#resolving.has(name)) {
      throw new Error(`RuntimeContainer: circular dependency resolving "${name}"`);
    }
    this.#resolving.add(name);
    try {
      const instance = factory(this);
      this.#instances.set(name, instance);
      return instance;
    } finally {
      this.#resolving.delete(name);
    }
  }

  /**
   * @param {string} name
   * @returns {boolean} Whether `name` is registered - does NOT instantiate
   *   it, unlike `resolve()`.
   */
  has(name) {
    return this.#factories.has(name);
  }

  /** @returns {string[]} Every registered module name (instantiated or not). */
  list() {
    return Array.from(this.#factories.keys());
  }
}
