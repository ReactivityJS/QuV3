import { sortAndPaginateChildren } from '@qu/core/adapters/cursor';

/**
 * INDEXEDDB ADAPTER — persistent storage for browser environments. Stores
 * each QuBit as a value in a single object store, keyed by its relative
 * path. Lazily opens the database on first use.
 *
 * Only exported from `@qu/runtime/indexeddb`, never from a package-root `.`
 * import - see `fs-adapter.js`'s doc comment for why this package has no
 * shared entry point. This file assumes a global `indexedDB`/`IDBKeyRange`
 * (a real browser, or a test polyfill such as `fake-indexeddb` - see
 * `test/indexeddb-adapter.test.js`) and must never be imported anywhere
 * that isn't one of those.
 */
export class IndexedDBAdapter {
  #dbPromise = null;

  /** @param {string} [dbName='qu-store'] */
  constructor(dbName = 'qu-store') {
    this.dbName = dbName;
  }

  #open() {
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('qubits')) {
          db.createObjectStore('qubits');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.#dbPromise;
  }

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>}
   */
  async put(rel, quBit) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('qubits', 'readwrite');
      tx.objectStore('qubits').put(quBit, rel);
      tx.oncomplete = () => resolve(quBit);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * @param {string} rel
   * @returns {Promise<object|null>}
   */
  async get(rel) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('qubits', 'readonly');
      const request = tx.objectStore('qubits').get(rel);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Lists every stored QuBit whose key starts with `relPrefix`, ARBITRARY
   * DEPTH, via an `IDBKeyRange` bound rather than a full-store scan+filter -
   * see `FsAdapter.getAll()`'s doc comment for what this enables (reciprocal
   * sync catch-up, outbox replay). `'￿'` is a standard idiom for a
   * string-prefix upper bound: it sorts after any realistic single-codepoint
   * suffix a real path segment would have.
   * @param {string} relPrefix
   * @returns {Promise<Array<{rel: string, quBit: object}>>}
   */
  async getAll(relPrefix) {
    const db = await this.#open();
    const range = IDBKeyRange.bound(relPrefix, relPrefix + '￿', false, false);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('qubits', 'readonly');
      const store = tx.objectStore('qubits');
      const out = [];
      const request = store.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        out.push({ rel: cursor.key, quBit: cursor.value });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * ONE level of children under `parentRel` only, `(ts, rel)`-ordered,
   * cursor-paginated - see docs/v3-technical-concept.md §1.2 for the full
   * `ChildQueryOptions`/`ChildEntry` contract, and its "mandatory
   * correctness, optional efficiency" rule.
   *
   * V1, shipped here: reuse the SAME `IDBKeyRange` prefix-bound cursor scan
   * `getAll()` already has (native, uses the primary key index - real
   * efficiency over a full-store scan), then filter to direct children and
   * sort/paginate in memory via the shared `sortAndPaginateChildren()`
   * helper - correct, and cheaper than `getAll()` already was, but not yet
   * `O(limit)`.
   *
   * A genuine `O(limit)` version is a valid, natural upgrade for a specific
   * collection that proves hot enough to justify it: add a second object
   * store indexed by `[parentPath, ts]`, maintained transactionally
   * alongside `put()`, and query that directly instead of filtering here.
   * Deliberately NOT built in V1 - no adapter should carry an index nothing
   * has needed yet (see docs/v3-technical-concept.md §1.2 and principle 4).
   * @param {string} parentRel
   * @param {{sort?: 'ts', order?: 'asc'|'desc', limit?: number, cursor?: string}} [options]
   * @returns {Promise<Array<{rel: string, quBit: object, cursor: string}>>}
   */
  async getChildren(parentRel, options = {}) {
    const prefix = parentRel.endsWith('/') ? parentRel : parentRel + '/';
    const underPrefix = await this.getAll(prefix);
    const candidates = underPrefix.filter((entry) => !entry.rel.slice(prefix.length).includes('/'));
    return sortAndPaginateChildren(candidates, options);
  }

  /*
   * Permanently deletes this adapter's ENTIRE underlying IndexedDB database -
   * every QuBit ever stored under it, gone, unrecoverable. There is no
   * finer-grained delete anywhere in this stack (QuStore itself has no
   * delete() at all - every other method here is put/get only), so this is
   * a deliberate all-or-nothing operation, e.g. for "forget this identity."
   * @returns {Promise<void>}
   */
  async destroy() {
    // Close our own open connection first - deleteDatabase() blocks (fires
    // onblocked, never onsuccess) while ANY connection to it is still open,
    // including this adapter's own.
    if (this.#dbPromise) {
      const db = await this.#dbPromise;
      db.close();
      this.#dbPromise = null;
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      // Some OTHER tab/connection still has it open - the browser completes
      // the delete once that closes on its own; not worth blocking the
      // caller (typically about to reload the page) on that.
      request.onblocked = () => resolve();
    });
  }
}
