/** A minimal fake Qu instance - just enough of QuStore's surface (get/put/onStorageChange) for @qu/reactive's watch() (and therefore every Qu-Component) to work against. */
export function fakeQu(initial = {}) {
  const store = new Map(Object.entries(initial).map(([path, val]) => [path, { val, ts: 1 }]));
  const listeners = new Set();
  let ts = 1;
  return {
    async get(path) {
      return store.has(path) ? store.get(path) : null;
    },
    async put(path, val) {
      ts += 1;
      store.set(path, { val, ts });
      for (const listener of listeners) listener({ path });
    },
    onStorageChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
