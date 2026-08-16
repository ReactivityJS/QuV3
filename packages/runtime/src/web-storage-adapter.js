import { sortAndPaginateChildren } from '@qu/core/adapters/cursor';

/**
 * WEB STORAGE ADAPTER — shared `QuAdapter` implementation over the
 * synchronous Web Storage API (`sessionStorage`/`localStorage`). Not
 * exported itself - `SessionStorageAdapter`/`LocalStorageAdapter` (this
 * package's own `session-storage-adapter.js`/`local-storage-adapter.js`)
 * are thin, one-line subclasses naming which global storage object backs
 * them, so the ts-guard/`getChildren()`/serialization logic lives here once
 * instead of twice.
 *
 * Storage: one Web Storage key per QuBit, `<namespace>:<rel>`,
 * JSON-serialized - `namespace` is what lets more than one adapter share the
 * SAME origin's storage without colliding (Web Storage has no separate
 * "database" concept the way IndexedDB does) - the same role
 * `IndexedDBAdapter`'s `dbName` plays.
 */
export class WebStorageAdapter {
  #storage;
  #keyPrefix;

  /**
   * @param {Storage} storage - `sessionStorage` or `localStorage`.
   * @param {string} [namespace='qu-store']
   */
  constructor(storage, namespace = 'qu-store') {
    this.#storage = storage;
    this.#keyPrefix = `${namespace}:`;
  }

  #key(rel) {
    return this.#keyPrefix + rel;
  }

  #relFromKey(key) {
    return key.slice(this.#keyPrefix.length);
  }

  /**
   * @param {string} rel @param {object} quBit
   * @returns {Promise<object>} `quBit`, even if a logically newer value
   *   already stored won the ts-guard below - same convention every other
   *   adapter in this codebase uses.
   */
  async put(rel, quBit) {
    const key = this.#key(rel);
    const currentRaw = this.#storage.getItem(key);
    if (currentRaw) {
      const current = JSON.parse(currentRaw);
      if (typeof current.ts === 'number' && typeof quBit.ts === 'number' && current.ts > quBit.ts) {
        return quBit; // a logically newer value is already stored - never overwrite it with an older one
      }
    }
    this.#storage.setItem(key, JSON.stringify(quBit));
    return quBit;
  }

  /** @param {string} rel @returns {Promise<object|null>} */
  async get(rel) {
    const raw = this.#storage.getItem(this.#key(rel));
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Arbitrary-depth, UNSORTED prefix scan - same contract as every other
   * adapter's `getAll()`. A full scan of this storage object's own keys:
   * Web Storage has no range-query primitive to do better with (unlike
   * IndexedDB's `IDBKeyRange`), and the realistic key counts here (a single
   * origin's `sessionStorage`/`localStorage`) never justify one.
   * @param {string} relPrefix
   * @returns {Promise<Array<{rel: string, quBit: object}>>}
   */
  async getAll(relPrefix) {
    const prefix = relPrefix.endsWith('/') ? relPrefix : relPrefix + '/';
    const out = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (!key || !key.startsWith(this.#keyPrefix)) continue;
      const rel = this.#relFromKey(key);
      if (rel === relPrefix || rel.startsWith(prefix)) {
        out.push({ rel, quBit: JSON.parse(this.#storage.getItem(key)) });
      }
    }
    return out;
  }

  /**
   * ONE level of children under `parentRel` only, `(ts, rel)`-ordered,
   * cursor-paginated via the shared `sortAndPaginateChildren()` helper - see
   * docs/v3-technical-concept.md §1.2 for the full contract.
   * @param {string} parentRel
   * @param {{sort?: 'ts', order?: 'asc'|'desc', limit?: number, cursor?: string}} [options]
   * @returns {Promise<Array<{rel: string, quBit: object, cursor: string}>>}
   */
  async getChildren(parentRel, options = {}) {
    const prefix = parentRel.endsWith('/') ? parentRel : parentRel + '/';
    const candidates = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (!key || !key.startsWith(this.#keyPrefix)) continue;
      const rel = this.#relFromKey(key);
      if (!rel.startsWith(prefix)) continue;
      const remainder = rel.slice(prefix.length);
      if (remainder === '' || remainder.includes('/')) continue; // not a direct child
      candidates.push({ rel, quBit: JSON.parse(this.#storage.getItem(key)) });
    }
    return sortAndPaginateChildren(candidates, options);
  }
}
