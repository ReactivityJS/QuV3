import { promises as fs } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sortAndPaginateChildren } from '@qu/core/adapters/cursor';

/**
 * Recursively lists every `.json` file under `dir` (one file per stored
 * QuBit - see the class doc comment). `FsAdapter`'s atomic write leaves a
 * `<path>.<uuid>.tmp` file briefly mid-rename - never a finished, readable
 * QuBit, and its name never ends in `.json` (it ends in `.tmp`), so the
 * `.json`-suffix filter below already excludes it without special-casing.
 */
async function walkJsonFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // directory doesn't exist (e.g. nothing stored under this prefix yet)
  }
  const out = [];
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkJsonFiles(full)));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * FS ADAPTER — Node.js filesystem persistence. Stores each QuBit as one
 * JSON file, mirroring the path structure on disk (`/a/b/c` -> `<base>/a/b/c.json`).
 * Simple, human-inspectable, good enough for a single relay's local data;
 * swap for a real database adapter if you outgrow it - QuStore never knows
 * the difference.
 *
 * Only exported from `@qu/runtime/fs`, never from a package-root `.`
 * import - this file is Node-only (`node:fs`), and a browser bundle must
 * never end up with it in its dependency graph just because it imported
 * something else from this package. `@qu/runtime/indexeddb` is the browser
 * counterpart, exported the same deliberately-isolated way.
 *
 * Two correctness properties `put()` guarantees that a naive
 * `fs.writeFile()` does not - both matter under concurrent synced writes to
 * the SAME path (e.g. a collection's `create()` immediately followed by its
 * own `addItem()`):
 *
 *   1. ATOMIC writes - `fs.writeFile()` alone is open+write+close; two
 *      overlapping calls to the same path can interleave at the OS level,
 *      producing a file that's neither the old nor the new value (often
 *      not even valid JSON). Writing to a uniquely-named temp file first,
 *      then `rename()`-ing it into place, is safe because POSIX rename is
 *      atomic - a concurrent reader always sees either the complete old
 *      file or the complete new one, never a mix.
 *   2. ORDERING - fixing #1 alone would still let two concurrent writers
 *      finish in EITHER order, so the "later" logical write (by content)
 *      could still lose to the "earlier" one if that one simply finishes
 *      its I/O second. Every QuBit carries a monotonic `ts` - `put()` reads
 *      the CURRENT on-disk value first and skips writing if it's already at
 *      least as new, so final state always reflects the logically-latest
 *      write regardless of I/O completion order.
 *   3. SERIALIZATION - point 2's own read-then-write is ITSELF a
 *      check-then-act race if two `put()` calls for the SAME path overlap:
 *      both can read the same "current" value before either has written,
 *      both pass the ts-guard, and whichever finishes its write second
 *      physically wins regardless of which call's `ts` was actually
 *      newer. `#putLocked()` below is the actual read+write body; `put()`
 *      chains calls for the SAME path through `#writeLocks` so only one is
 *      ever in flight per path - calls for DIFFERENT paths still run fully
 *      in parallel.
 */
export class FsAdapter {
  #writeLocks = new Map(); // filePath -> tail of the promise chain serializing put() calls to that path

  /** @param {string} [basePath='./qu-store'] */
  constructor(basePath = './qu-store') {
    this.basePath = basePath;
  }

  #filePath(rel) {
    return join(this.basePath, rel.replace(/^\//, '')) + '.json';
  }

  async #ensureDir(filePath) {
    await fs.mkdir(dirname(filePath), { recursive: true });
  }

  /**
   * @param {string} rel
   * @param {object} quBit
   * @returns {Promise<object>} `quBit` (even if a newer value already on
   *   disk won the race and this write was skipped - see class doc
   *   comment point 2 - the CALLER wrote this value, so it's what they get
   *   back; `get()` immediately after may show something else).
   */
  put(rel, quBit) {
    const filePath = this.#filePath(rel);
    const previousTail = this.#writeLocks.get(filePath) ?? Promise.resolve();
    // Chained via `.then(fn, fn)` (not `.finally()`) so a REJECTED previous
    // write never poisons this one - each put() must still get its own
    // fair attempt regardless of whether an earlier one for this path failed.
    const thisWrite = previousTail.then(
      () => this.#putLocked(rel, filePath, quBit),
      () => this.#putLocked(rel, filePath, quBit)
    );
    this.#writeLocks.set(filePath, thisWrite);
    // Once this write settles, only remove the map entry if nothing newer
    // has replaced it in the meantime (a later put() for the same path may
    // already be the current tail) - otherwise we'd drop a still-pending
    // chain and let a future call start unserialized. `.finally()`'s own
    // returned promise adopts `thisWrite`'s rejection if it rejects - and
    // since nothing else observes THAT derived promise, a real write
    // failure would otherwise surface as a SECOND, unhandled rejection here
    // even though `thisWrite` itself (returned below) is already correctly
    // handled by the caller. The trailing `.catch(() => {})` exists solely
    // to keep that already-observed rejection from also being reported as
    // unhandled a second time.
    thisWrite
      .finally(() => {
        if (this.#writeLocks.get(filePath) === thisWrite) this.#writeLocks.delete(filePath);
      })
      .catch(() => {});
    return thisWrite;
  }

  async #putLocked(rel, filePath, quBit) {
    await this.#ensureDir(filePath);

    const current = await this.get(rel);
    if (current && typeof current.ts === 'number' && typeof quBit.ts === 'number' && current.ts > quBit.ts) {
      return quBit; // a logically newer value is already stored - don't overwrite it with an older one
    }

    // Temp-file-then-rename: the ONLY safe way to make a multi-writer-syscall
    // operation (write bytes, THEN make them visible at the real path) atomic.
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(quBit), 'utf8');
    await fs.rename(tempPath, filePath);
    return quBit;
  }

  /**
   * @param {string} rel
   * @returns {Promise<object|null>}
   */
  async get(rel) {
    try {
      return JSON.parse(await fs.readFile(this.#filePath(rel), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      // A reader can legitimately observe a mid-rename moment (file briefly
      // absent) or a torn write on a filesystem without atomic rename
      // guarantees - treat either as "nothing usable here yet" rather than
      // crashing the caller. Still log it: a genuinely corrupted file on
      // disk looks identical to "never written" to every caller otherwise,
      // and that's worth knowing about.
      if (err instanceof SyntaxError) {
        console.error(`[FsAdapter] corrupt JSON at ${this.#filePath(rel)}: ${err.message}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Lists every QuBit stored under `relPrefix`, ARBITRARY DEPTH, UNSORTED -
   * used by sync's reciprocal catch-up (a reconnecting peer asking "what's
   * under this prefix that I might have missed") and the client-side sync
   * outbox's replay-on-reconnect walk. Deliberately separate from
   * `getChildren()` below - see that method's own doc comment for why they
   * are two different operations, not one overloaded with options.
   *
   * ASSUMES `relPrefix` aligns with a real directory boundary - true for
   * every prefix actually used by sync's `subscribe()` (always a whole path
   * segment, e.g. a space id). A prefix that lands mid-segment simply finds
   * no directory and returns nothing, rather than matching by string
   * prefix - a deliberate simplicity trade-off.
   * @param {string} relPrefix
   * @returns {Promise<Array<{rel: string, quBit: object}>>}
   */
  async getAll(relPrefix) {
    const dir = join(this.basePath, relPrefix.replace(/^\//, ''));
    const files = await walkJsonFiles(dir);
    const entries = await Promise.all(files.map(async (filePath) => {
      const rel = '/' + relative(this.basePath, filePath).split(sep).join('/').replace(/\.json$/, '');
      try {
        return { rel, quBit: JSON.parse(await fs.readFile(filePath, 'utf8')) };
      } catch {
        return null; // corrupt/mid-rename - skip, consistent with get()'s own handling
      }
    }));
    return entries.filter((e) => e !== null);
  }

  /**
   * ONE level of children under `parentRel` only, `(ts, rel)`-ordered,
   * cursor-paginated - see docs/v3-technical-concept.md §1.2 for the full
   * `ChildQueryOptions`/`ChildEntry` contract. A non-recursive `readdir()`
   * of exactly `basePath/parentRel` IS the "direct children" operation on a
   * filesystem: a deeper descendant (e.g. a message's own reactions) lives
   * inside a SUBDIRECTORY of this one, which `withFileTypes`'s
   * `entry.isFile()` check excludes without walking into it - cheaper than
   * `getAll()`'s recursive walk, not just narrower.
   * @param {string} parentRel
   * @param {{sort?: 'ts', order?: 'asc'|'desc', limit?: number, cursor?: string}} [options]
   * @returns {Promise<Array<{rel: string, quBit: object, cursor: string}>>}
   */
  async getChildren(parentRel, options = {}) {
    const dir = join(this.basePath, parentRel.replace(/^\//, ''));
    let dirEntries;
    try {
      dirEntries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return []; // nothing stored under this parent yet
    }

    const parentPrefix = parentRel.endsWith('/') ? parentRel : parentRel + '/';
    const candidates = [];
    for (const entry of dirEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue; // subdirectories are deeper descendants, not direct children
      const filePath = `${dir}/${entry.name}`;
      let quBit;
      try {
        quBit = JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch {
        continue; // corrupt/mid-rename - skip, consistent with get()'s own handling
      }
      candidates.push({ rel: parentPrefix + entry.name.replace(/\.json$/, ''), quBit });
    }
    return sortAndPaginateChildren(candidates, options);
  }
}
