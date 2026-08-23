/** A minimal fake Qu instance - just enough of QuStore's surface (get/put/getChildren/onStorageChange) for @qu/reactive's watch()/watchChildren() (and therefore every Qu-Component) to work against. Mirrors packages/ui/test/support/fake-qu.js - kept as its own small copy rather than a cross-package relative import. */
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
    async getChildren(parentPath, { order = 'desc' } = {}) {
      const prefix = `${parentPath}/`;
      const entries = [...store.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, quBit]) => ({ path, quBit }));
      entries.sort((a, b) => (order === 'asc' ? a.quBit.ts - b.quBit.ts : b.quBit.ts - a.quBit.ts));
      return entries;
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
