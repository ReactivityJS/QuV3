// Minimal Web Storage polyfill for Node - just enough of the
// getItem/setItem/removeItem/key/length surface that
// SessionStorageAdapter/LocalStorageAdapter (and their shared
// WebStorageAdapter) actually use. Node has no built-in
// sessionStorage/localStorage global, unlike IndexedDB's own
// `fake-indexeddb/auto` polyfill this same test suite already relies on for
// IndexedDBAdapter.
class MemoryStorage {
  #map = new Map();
  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(key, value) {
    this.#map.set(key, String(value));
  }
  removeItem(key) {
    this.#map.delete(key);
  }
  key(index) {
    return [...this.#map.keys()][index] ?? null;
  }
  get length() {
    return this.#map.size;
  }
}

export function installWebStoragePolyfill() {
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
}
