/**
 * QU-COMPONENTS — declarative, reactive Custom Elements over
 * @qu/reactive's `watch()`. The DOM-mount-lifecycle counterpart to that
 * plain function: `<qu-view>` subscribes in `connectedCallback()` and
 * unsubscribes in `disconnectedCallback()`, so a page full of these never
 * needs manually written subscribe/unsubscribe wiring.
 *
 * Deliberately BROWSER-ONLY (extends HTMLElement at module-evaluation time
 * - importing this in Node throws immediately unless a DOM shim like
 * `jsdom` is installed first - see this package's own tests). Import it
 * directly wherever it's used; it registers the tags as a side effect.
 *
 * This is the concrete "Templates" primitive for Quniverse apps: a
 * `<qu-list>`'s `<template>` child gets stamped once per item, live-rebound
 * on every change, with zero build step. It is deliberately OPTIONAL, not
 * the mandated way to build every app UI - but as of the `apps/app-list`/
 * `user-list`/`contact-list` rebuild it IS what all three of those apps use
 * (see docs/v3-technical-concept.md §5's now-fully-resolved verdict): the
 * earlier "these three apps' data isn't list-shaped" finding turned out to
 * be a gap in `<qu-list>` ITSELF, not in the apps - `<qu-list>` only
 * understood CURATED lists (one document = one array). `parent` (below)
 * adds DERIVED-list support (many sibling documents under a shared prefix -
 * `directory/entries`, private flags, ...), which is what those three apps'
 * data actually is.
 *
 * Elements:
 *   <qu-view>  read-only, live-updating.
 *   <qu-bind>  IS a <qu-view> plus write-back, implemented as a one-method
 *              subclass, not a second mechanism.
 *   <qu-list>  the declarative form of "one <template> stamped per item in
 *              a list", keyed by each item's own path (see its own doc
 *              comment below). Supports BOTH curated (`path`) and derived
 *              (`parent`) lists.
 *   <qu-key>   shows the CURRENT list item's own id (its path's last
 *              segment) - the one thing a <qu-list> <template> has no other
 *              declarative way to show.
 *   <qu-if>    shows/hides its children based on a watched value's
 *              truthiness (or equality to a fixed attribute) - see its own
 *              doc comment below.
 *
 * ---------------------------------------------------------------------
 * Attributes (<qu-view>/<qu-bind>/<qu-if>):
 *   path    Absolute Qu path (e.g. "/store/wiki/docs/intro"). Required,
 *           UNLESS the current `.qu` context is itself a <qu-list> item (see
 *           below), in which case an omitted `path` defaults to that item's
 *           own path - or `related` (below) is given instead.
 *   related Alternative to `path`, only meaningful inside a <qu-list> item
 *           whose `.relatedPaths` resolver named this key (see <qu-list>'s
 *           own doc comment) - e.g. `related="profile"` resolves through
 *           `context.relatedPaths.profile`, a path computed from the
 *           item's OWN id at stamp time (a directory entry's id -> that
 *           actor's separate profile document, say). This is the "late-
 *           bound" reference case: unlike a plain `path`, which any caller
 *           holding a concrete id already knows how to build (see
 *           `@qu/services`' `paths.js` - those typed functions ARE the
 *           templating, no string-placeholder DSL needed), an item's own id
 *           genuinely isn't known until <qu-list> stamps it.
 *   field   Optional. A Qu document is typically ONE JSON object at ONE
 *           path rather than one QuBit per field - so unlike leaf-per-field
 *           designs, `field` reads/writes a PROPERTY of the object at
 *           `path`, not a separate QuBit. <qu-bind>'s write-back is
 *           therefore a read-modify-write on that whole document, not an
 *           independent, collision-free write to its own leaf - fine for
 *           the common "one person edits this document" case, worth
 *           knowing if you're binding something with genuinely concurrent
 *           multi-writer edits in mind.
 *   attr    Which DOM attribute/property carries the value:
 *            "value"        form controls (input/textarea/select)
 *            "textContent"  plain text (works with contenteditable)
 *            "innerHTML"    rich content
 *            "checked"      checkboxes/radios (write-back event: "change")
 *            anything else  a generic HTML attribute (href, src, class,
 *                            data-*, ...), read/written via get/setAttribute
 *          Default ("auto", or omitted): form controls use `.value`,
 *          everything else uses `.textContent`.
 *
 * Target element: a plain `<qu-view>`/`<qu-bind>` acts on ITSELF. Wrap a
 * single real form control (or any element) as its one child, and that
 * child becomes the target instead:
 *
 *   <qu-bind path="/store/wiki/docs/intro" field="title" attr="value"><input></qu-bind>
 *   <qu-view path="/store/gallery/assets/logo/meta" field="mime"></qu-view>
 *
 * Which Qu instance: never a global. Set `.qu` as a plain property on the
 * element itself, or on any ancestor (including across a shadow-root
 * boundary) - findQu() below walks up looking for it. Because appendChild()
 * runs connectedCallback() synchronously, `container.qu = qu` must happen
 * BEFORE the qu-view/qu-bind children are appended - if it's missing at
 * mount time, one microtask retry covers the common "appended, then wired
 * up next line" ordering before giving up for real.
 */
import { watch, watchChildren } from '@qu/reactive';
import { createLogger } from '@qu/log';

const log = createLogger('qu-ui');

/** Exported so other browser-only Qu-Components can reuse the same "walk up for `.qu`" resolution. */
export function findQu(el) {
  let node = el;
  while (node) {
    if (node.qu) return node.qu;
    node = node.parentNode || node.host || null;
  }
  return null;
}

/**
 * Same walk as `findQu()`, for `.syncFetch` - kept as a SEPARATE property
 * (not bundled onto the `qu` object itself) so a container can be given a
 * real `qu` plus a real backfill function independently, and so `<qu-list>`
 * can resolve it BEFORE it mounts by reading it off an ancestor set ahead
 * of time (`container.qu = qu; container.syncFetch = (p) => sync.fetchPrefix(p);`
 * - same "set both before inserting/connecting" discipline as `.qu` alone
 * already requires), rather than needing it set as a property on the
 * `<qu-list>` element itself AFTER insertion, which would already be too
 * late (`watch()`/`watchChildren()`'s own `syncFetch` fires synchronously,
 * the moment `_mount()` calls them - see `<qu-list>`'s own doc comment).
 */
export function findSyncFetch(el) {
  let node = el;
  while (node) {
    if (node.syncFetch) return node.syncFetch;
    node = node.parentNode || node.host || null;
  }
  return null;
}

function resolveTarget(el) {
  return el.children.length === 1 ? el.children[0] : el;
}

function resolveIO(attrName, target) {
  if (attrName === 'checked') {
    return { get: (el) => el.checked, set: (el, v) => { el.checked = !!v; }, event: 'change' };
  }
  if (attrName === 'value' || attrName === 'textContent' || attrName === 'innerHTML') {
    return { get: (el) => el[attrName], set: (el, v) => { el[attrName] = v ?? ''; }, event: 'input' };
  }
  if (attrName && attrName !== 'auto') {
    return {
      get: (el) => el.getAttribute(attrName),
      set: (el, v) => { if (v == null) el.removeAttribute(attrName); else el.setAttribute(attrName, String(v)); },
      event: 'input',
    };
  }
  const isFormControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  return isFormControl
    ? { get: (el) => el.value, set: (el, v) => { el.value = v ?? ''; }, event: 'input' }
    : { get: (el) => el.textContent, set: (el, v) => { el.textContent = v ?? ''; }, event: 'input' };
}

/**
 * Shared by <qu-view>/<qu-bind>/<qu-if>: resolves the effective path from
 * `path`/`related`/the implicit `context.ownPath` fallback, in that
 * priority order. Returns `null` (after logging) if none apply.
 */
function resolvePath(el, context) {
  const relatedAttr = el.getAttribute('related');
  if (relatedAttr !== null) {
    const related = context.relatedPaths?.[relatedAttr];
    if (!related) {
      log.error(`${el.tagName.toLowerCase()}: related="${relatedAttr}" not found on the current .qu context's relatedPaths`, el);
      return null;
    }
    return related;
  }
  const pathAttr = el.getAttribute('path');
  const path = pathAttr !== null ? pathAttr : context.ownPath;
  if (!path) {
    log.error(`${el.tagName.toLowerCase()}: missing "path"/"related" attribute (and the current .qu context has no implicit path to fall back to)`, el);
    return null;
  }
  return path;
}

export class QuViewElement extends HTMLElement {
  static get observedAttributes() { return ['path', 'related', 'field', 'attr']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  /**
   * Always tears down any previous mount before building a fresh one - NOT
   * just when the caller already knows one exists. Parsing an element
   * straight from HTML markup with its attributes already present can fire
   * attributeChangedCallback() for those initial attributes while
   * isConnected is ALREADY true, i.e. BEFORE connectedCallback() itself
   * runs - both then call _mount(), and without this, that would mean two
   * independent subscriptions. Self-cleaning here means the order/count of
   * calls no longer matters.
   */
  _mount(isRetry = false) {
    this._unmount();
    const context = findQu(this);
    if (!context) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else log.error(`${this.tagName.toLowerCase()}: no Qu instance found - set .qu on this element or an ancestor`, this);
      return;
    }
    const path = resolvePath(this, context);
    if (!path) return;
    const field = this.getAttribute('field');
    const target = resolveTarget(this);
    const io = resolveIO(this.getAttribute('attr'), target);
    this._off = this._start(context, path, field, target, io);
  }

  _unmount() {
    this._off?.();
    this._off = null;
  }

  _start(context, path, field, target, { set }) {
    return watch(context, path, (value) => set(target, field ? value?.[field] : value));
  }
}

export class QuBindElement extends QuViewElement {
  _start(context, path, field, target, io) {
    const off = super._start(context, path, field, target, io);
    const handler = async () => {
      const newValue = io.get(target);
      if (field) {
        const current = (await context.get(path))?.val ?? {};
        await context.put(path, { ...current, [field]: newValue });
      } else {
        await context.put(path, newValue);
      }
    };
    target.addEventListener(io.event, handler);
    return () => {
      off();
      target.removeEventListener(io.event, handler);
    };
  }
}

/**
 * A `.qu`-duck-typed context for one <qu-list> item: forwards get()/
 * onStorageChange() to the real Qu instance (so watch() works unmodified),
 * and adds `ownPath` - the fallback a descendant <qu-view field="..."> with
 * no `path` attribute of its own resolves to, so a <template> never has to
 * repeat the item's id - plus `relatedPaths`, resolved ONCE at stamp time
 * from <qu-list>'s own `.relatedPaths` function (see that element's doc
 * comment), for descendants using `related="name"` instead of `path`.
 */
class ItemContext {
  constructor(qu, ownPath, relatedPaths = null) {
    this.qu = qu;
    this.ownPath = ownPath;
    this.relatedPaths = relatedPaths;
  }
  get(path) {
    return this.qu.get(path);
  }
  put(path, value) {
    return this.qu.put(path, value);
  }
  getChildren(parentPath, options) {
    return this.qu.getChildren(parentPath, options);
  }
  onStorageChange(handler) {
    return this.qu.onStorageChange(handler);
  }
}

/**
 * `<qu-list path="...">` (CURATED) or `<qu-list parent="...">` (DERIVED,
 * mutually exclusive with `path` - give exactly one) - one `<template>`
 * child, cloned once per item in the list, each clone's `.qu` set to an
 * ItemContext so `<qu-view>`/`<qu-bind>` elements inside the template can
 * address that item's fields with a plain `field`, no path math:
 *
 *   <qu-list path="/store/wiki/lists/all-pages">           <!-- one document IS the array -->
 *   <qu-list parent="/store/directory/entries">             <!-- many sibling documents -->
 *     <template>
 *       <li>
 *         <qu-view field="title"></qu-view>
 *         <qu-bind field="body" attr="innerHTML" contenteditable="true"></qu-bind>
 *       </li>
 *     </template>
 *   </qu-list>
 *
 * `path` uses `watch()` (the whole array lives at one path); `parent` uses
 * `watchChildren()` (@qu/reactive) - each item is its own sibling QuBit,
 * re-fetched on any DIRECT child write. Both feed the exact same `_render()`
 * below, which only ever needs `.path` per entry - the two list SHAPES
 * differ, the rendering doesn't.
 *
 * `.relatedPaths` - an optional property (a plain JS function, NOT a
 * string-template attribute - Custom Element attributes are always
 * strings, and a per-item id genuinely isn't known until stamp time, so
 * this has to be a callback, set on the element like `.qu` already is):
 *
 *   listEl.relatedPaths = (itemId, item) => ({ profile: actorPath(itemId, 'profile') });
 *
 * Called once per NEWLY stamped item (not on every re-render - see
 * `_render()`), `itemId` being the item's own path's last segment. The
 * result is exposed to that item's descendants as `context.relatedPaths`,
 * readable via `<qu-view related="profile">` etc. Set this BEFORE the list
 * mounts (same discipline `.qu` already requires) - items stamped before
 * it's set won't retroactively pick it up.
 *
 * `.onItemStamped(els, itemId, item)` - another optional settable
 * function, called once per NEWLY stamped item (same timing as
 * `relatedPaths`, right after `.qu`/`relatedPaths` are assigned, before the
 * clone is inserted into the DOM) - see its own inline doc comment in
 * `_render()` below for what it's for and why it exists alongside
 * `relatedPaths` instead of trying to express everything as paths.
 *
 * `.syncFetch` - an optional function, resolved via the SAME ancestor-walk
 * as `.qu` (`findSyncFetch()`, mirroring `findQu()`) rather than a property
 * on the `<qu-list>` element itself, and passed straight through as
 * `watch()`/`watchChildren()`'s own `syncFetch` option (see either's doc
 * comment in `@qu/reactive`): `container.qu = qu; container.syncFetch =
 * (prefix) => sync.fetchPrefix(prefix);` on the SAME container a `<qu-list
 * parent="...">` is about to be inserted into. Without this, a fresh client
 * only ever sees whatever's already LOCAL (disk/IndexedDB) plus whatever a
 * broad `subscribe()` happens to push AFTER this list mounted - data a peer
 * wrote before this session ever connected sits invisible until something
 * unrelated triggers a re-read. Must be set BEFORE the list connects (same
 * as `.qu`) - `watch()`/`watchChildren()` invoke `syncFetch` synchronously,
 * the moment `_mount()` calls them, too early for a property set on the
 * `<qu-list>` element itself AFTER an `innerHTML` assignment already
 * connected it to pick up (unlike `.relatedPaths`/`.onItemStamped`, which
 * are read later, at per-item stamp time).
 *
 * Keyed by each item's own `path`: re-renders reuse the SAME cloned
 * elements across changes (tracked in `this._renderedByPath`), only
 * removing entries that dropped out and only reordering when position
 * actually changed - unlike a full teardown/rebuild, this preserves focus,
 * scroll position and any per-item local DOM state (e.g. an open
 * <details>) on items that didn't change, at the cost of "an item that
 * keeps the same path but everything else changes" doing an in-place
 * child update rather than a fresh clone (already the case - the clone's
 * descendants are plain <qu-view>/<qu-bind>, which update themselves).
 */
export class QuListElement extends HTMLElement {
  static get observedAttributes() { return ['path', 'parent']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  _mount(isRetry = false) {
    this._unmount();
    const context = findQu(this);
    if (!context) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else log.error('qu-list: no Qu instance found - set .qu on this element or an ancestor', this);
      return;
    }
    const path = this.getAttribute('path');
    const parent = this.getAttribute('parent');
    if (!path && !parent) { log.error('qu-list: missing required "path" or "parent" attribute', this); return; }
    const template = this.querySelector('template');
    if (!template) { log.error('qu-list: missing a <template> child to stamp per item', this); return; }

    const syncFetch = findSyncFetch(this);
    this._renderedByPath = new Map();
    this._off = path
      ? watch(context, path, (items) => this._render(items ?? [], context, template), { syncFetch })
      : watchChildren(context, parent, (entries) => this._render(entries, context, template), { syncFetch });
  }

  _render(items, qu, template) {
    // Two independent reasons an entry gets skipped:
    //  - CURATED (`path`): a referenced item that no longer resolves (e.g.
    //    deleted) delivers `null` for that slot.
    //  - DERIVED (`parent`): raw `{path, quBit}` entries include TOMBSTONES
    //    (`quBit.val === null`, `QuStore` has no `delete()`) - every
    //    derived-list Service in this codebase (`DirectoryService`,
    //    `FlagService`, `PinService`, ...) already filters these out before
    //    a caller ever sees them; a `<qu-list parent="...">` bound directly
    //    to a raw path has to do the same filtering itself. Only items that
    //    actually carry a `.quBit` (derived shape) are checked this way -
    //    curated items have no such field, so this never affects them.
    const validItems = items.filter((item) => item?.path && (!('quBit' in item) || item.quBit?.val));

    const nextByPath = new Map();
    for (const item of validItems) {
      let els = this._renderedByPath.get(item.path);
      if (!els) {
        const clone = template.content.cloneNode(true);
        els = [...clone.children];
        const itemId = item.path.slice(item.path.lastIndexOf('/') + 1);
        const related = this.relatedPaths ? this.relatedPaths(itemId, item) : null;
        for (const el of els) el.qu = new ItemContext(qu, item.path, related);
        // Optional escape hatch for the one thing pure HTML/`related` can't
        // express: mounting an EXISTING imperative helper (e.g.
        // `renderFlagToggle()` from `@qu/ui`, already the correct, tested
        // way to toggle a self-encrypted private flag - see
        // `apps/app-list`'s client.js) into a slot inside the freshly
        // stamped clone, or giving one specific descendant its OWN `.qu`
        // (e.g. a private-storage facade) distinct from the rest of the
        // row. Called ONCE per newly stamped item, before insertion - not a
        // second templating mechanism, just "here are the real DOM nodes
        // your <template> produced, do what plain HTML genuinely can't."
        this.onItemStamped?.(els, itemId, item);
      }
      nextByPath.set(item.path, els);
    }

    // Anything that dropped out of the new item list gets removed - not
    // reused even if the same path reappears later, since a removed
    // <qu-view>'s subscription is gone with it.
    for (const [path, els] of this._renderedByPath) {
      if (!nextByPath.has(path)) for (const el of els) el.remove();
    }

    // Walk the target order, moving/inserting only what isn't already in
    // place - insertBefore() on a node that's already exactly there is a
    // no-op in the DOM, so unchanged items never move.
    let cursor = [...this.children].find((child) => child.tagName !== 'TEMPLATE') ?? null;
    for (const item of validItems) {
      for (const el of nextByPath.get(item.path)) {
        if (el !== cursor) this.insertBefore(el, cursor);
        else cursor = el.nextSibling;
      }
    }

    this._renderedByPath = nextByPath;
  }

  _clearItems() {
    for (const child of [...this.children]) {
      if (child.tagName !== 'TEMPLATE') child.remove();
    }
  }

  _unmount() {
    this._off?.();
    this._off = null;
    this._clearItems();
    this._renderedByPath = null;
  }
}

/**
 * `<qu-key>` - displays the current `.qu` context's `ownPath` last segment
 * as plain text (e.g. a <qu-list> item at `/store/wiki/docs/intro` ->
 * `intro`). Never subscribes to anything: an item's own id is exactly what
 * <qu-list> used to decide it's a distinct item in the first place, so it
 * cannot change without becoming a different item (a new stamped clone),
 * unlike its VALUE, which is why <qu-view> still needs a live subscription
 * and this doesn't.
 */
export class QuKeyElement extends HTMLElement {
  connectedCallback() {
    const context = findQu(this);
    const path = context?.ownPath;
    this.textContent = path ? path.slice(path.lastIndexOf('/') + 1) : '';
  }
}

/**
 * `<qu-if path="..." field="..." [equals="..."] [negate]>` - toggles
 * `this.hidden` on a watched value, live:
 *   - no `equals`: hidden when the (optional `field` of the) value is
 *     falsy, shown when truthy.
 *   - `equals="x"`: shown only when `String(value) === "x"` (e.g. an enum
 *     status field), hidden otherwise.
 *   - `negate`: inverts either of the above (a plain "shown unless" form,
 *     rather than requiring a second watch/attribute just to flip it).
 * Same `path`/`field`/implicit-`ownPath` resolution as <qu-view> - inside
 * a <qu-list> <template>, an omitted `path` defaults to that item's own
 * path, same as everywhere else in this file.
 *
 *   <qu-if field="archived" negate><qu-view field="title"></qu-view></qu-if>
 *   <qu-if field="status" equals="published">...</qu-if>
 */
export class QuIfElement extends HTMLElement {
  static get observedAttributes() { return ['path', 'related', 'field', 'equals']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  _mount(isRetry = false) {
    this._unmount();
    const context = findQu(this);
    if (!context) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else log.error('qu-if: no Qu instance found - set .qu on this element or an ancestor', this);
      return;
    }
    const path = resolvePath(this, context);
    if (!path) return;
    const field = this.getAttribute('field');
    const hasEquals = this.hasAttribute('equals');
    const equals = this.getAttribute('equals');
    const negate = this.hasAttribute('negate');
    this._off = watch(context, path, (value) => {
      const actual = field ? value?.[field] : value;
      const truthy = hasEquals ? String(actual) === equals : !!actual;
      this.hidden = negate ? truthy : !truthy;
    });
  }

  _unmount() {
    this._off?.();
    this._off = null;
  }
}

if (!customElements.get('qu-view')) customElements.define('qu-view', QuViewElement);
if (!customElements.get('qu-bind')) customElements.define('qu-bind', QuBindElement);
if (!customElements.get('qu-list')) customElements.define('qu-list', QuListElement);
if (!customElements.get('qu-key')) customElements.define('qu-key', QuKeyElement);
if (!customElements.get('qu-if')) customElements.define('qu-if', QuIfElement);
