/**
 * CHROME — the Shell-owned, session-scoped counterpart to `@qu/ui`'s
 * `mountAppTemplate()`. Where `mountAppTemplate()` is called BY an app, per
 * view, `mountChrome()` is mounted ONCE by Shell (`apps/shell/client.js`,
 * alongside `mountHeader()`), for the whole session - the "platform loads
 * the app, the app doesn't mount itself into the platform" inversion. An
 * app never calls this file directly; it receives a `ctx.chrome` handle
 * (see `begin()` below) and only ever calls `chrome.set(partial)` with
 * plain data, the exact same `AppConfig` shape `mountAppTemplate()` already
 * takes (`navigation`/`views`/`settings`/`primaryAction`/`fullHeight`) -
 * this file decides WHERE (sidebar vs. footer, by device, via
 * `@qu/ui`'s shared `buildChrome()`) and HOW (list vs. collapsed "More…"
 * menu, via the admin-configurable `menuThreshold` below) it renders.
 *
 * WHY A SEPARATE FILE, NOT JUST `mountAppTemplate()` CALLED FROM SHELL:
 * `mountAppTemplate()`'s whole contract is "called once per view, tears
 * down and rebuilds everything on the next call" - exactly backwards from
 * what a SESSION-scoped chrome needs (one persistent DOM structure,
 * `content`/`contentSlot` never recreated, only the surrounding
 * sidebar/footer rebuilt as the active app's own registered config
 * changes). `buildChrome()` (`@qu/ui`'s `app-template.js`) is the exact
 * extraction point both files share - the `hasChrome`/`fabOnly` decision
 * tree and the sidebar/footer DOM-building itself, so this file and
 * `mountAppTemplate()` can never silently drift into two different chrome
 * behaviors for the same `AppConfig` shape.
 *
 * REACTIVITY - Qu-Components, not manual re-render: a `navigation` (or
 * `views`) section MAY be registered as `{list: {path|parent, template,
 * onItemStamped?}, activeId?, heading?, filter?}` instead of a plain
 * `items[]` snapshot - this mounts a REAL `<qu-list>` (`@qu/ui`'s
 * `components.js`, already proven by `apps/app-list`/`user-list`/
 * `contact-list`) bound to that Qu path/parent, with `@qu/ui`'s own
 * `.qu`/`.syncFetch` ancestor-resolution wiring done here. The list then
 * updates itself via `<qu-list>`'s own keyed, per-item reconciliation
 * (`components.js`'s `_renderedByPath` map) - an unchanged item is never
 * touched, only genuinely added/removed/changed ones cause DOM work. A
 * caller (e.g. Forum) never has to `watch()`/recompute/re-push a snapshot
 * itself for this section's own list MEMBERSHIP; it only pushes a NEW
 * `chrome.set({navigation: {...}})` when something ELSE about the section
 * changes (which item is active, the heading, whether the section even
 * exists this route).
 *
 * `template`/`onItemStamped` are `<qu-list>`'s OWN real contract (a literal
 * `<template>` element, stamped per item; `onItemStamped(els, itemId, item)`
 * fires once per NEWLY stamped item, before insertion - see
 * `components.js`'s own doc comment) - NOT a JS item-mapping function. This
 * file is a thin pass-through: it creates the `<qu-list>` element, sets
 * `path`/`parent` and `.qu`/`.syncFetch`, appends the caller's own
 * `template`, and forwards `onItemStamped`. Building the template markup
 * and computing a per-item `href` (something plain `<qu-view>`/`<qu-bind>`
 * genuinely can't express - see `components.js`'s own `related` doc
 * comment) is the CALLER's job, via `onItemStamped`, exactly like
 * `apps/app-list`'s existing `<qu-list>` usage already does for its own
 * per-row imperative touches.
 *
 * ACTIVE-ITEM HIGHLIGHTING is handled SEPARATELY from `<qu-list>`'s own
 * data-driven reconciliation - `activeId` is route state, not Qu-store
 * data, so it can change (navigating between channels) without the
 * underlying channel LIST changing at all, meaning `onItemStamped` (fired
 * only for NEWLY stamped items) would never re-fire for it. `syncActiveId()`
 * below walks the STABLE, already-stamped `<qu-list>` children on every
 * `chrome.set()` call and toggles the active class using each child's own
 * `.qu.ownPath` (which `<qu-list>` already sets per stamped item) - never
 * recreating the list itself for an active-id-only change.
 *
 * MOBILE FOOTER, TOO (`navigation.list`, `!desktopOnly`) - a `list:`-backed
 * section now renders in the mobile footer as well as the desktop sidebar:
 * a second, independent `<qu-list>` (cheap - its own `watch()` subscription,
 * never shared with the sidebar's instance, since the two are never visible
 * at the same time anyway) inside a `buildPopupTrigger()`-style pill+popup,
 * built by `buildReactiveFooterPill()` below. The one genuinely new problem
 * this raises - the pill's own visible label (the CURRENTLY ACTIVE item's
 * name) has no synchronous `items[]` array to read from, unlike a static
 * section - is solved with a SECOND literal `<template>`, `pillTemplate`
 * (same contract as `template` itself): stamped once per active-item CHANGE
 * (not per data change), its root elements' `.qu` set to the SAME
 * `ItemContext` the footer's own already-stamped `<qu-list>` child created
 * for that item (see `resolveActiveChild()`/`buildReactiveFooterPill()`
 * below) - a `<qu-view field="...">` inside it is then genuinely,
 * continuously live, not a one-time snapshot with an accepted staleness
 * tradeoff. No `pillTemplate` given (or no active item resolved yet) falls
 * back to showing the section's own `heading`. `views.list` is NOT
 * supported (only `navigation.list` is, matching this file's existing
 * scope) - a second axis of "is this list-backed" for `views` too isn't
 * asked for by any real use case yet.
 *
 * `prefixItems` (`navigation.list.prefixItems`, optional) - a small array of
 * STATIC `{id, label, href}` items (Forum's own "All channels" aggregate
 * entry is the motivating, and so far only, real case) rendered as plain
 * `<li><a>`s (via `@qu/ui`'s own `buildLinkList()`) immediately BEFORE the
 * live `<qu-list>`, as its own sibling inside the same `.qu-apptpl-section`
 * - not spliced into the `<qu-list>` element itself (its own reconciliation
 * in `components.js`'s `_render()` assumes it exclusively owns every
 * non-`<template>` child; a foreign leading node would corrupt its own
 * cursor-based reordering, confirmed by reading that code, not assumed).
 * Captured ONCE at first build, same as `template`/`onItemStamped` already
 * are - not refreshed by a later `chrome.set()` on an already-built section
 * (Forum's own prefix entry never changes, so a genuinely changing
 * `prefixItems` set is untested - it would need its own design, not
 * assumed free here). Active-highlighting and the footer pill's own label
 * both check `prefixItems` FIRST (a plain, synchronous `id === activeId`
 * match - no template/stamping needed, unlike a real list item) before
 * falling through to the `<qu-list>`-stamped-item / `heading`-fallback
 * paths below.
 *
 * A NOTE ON DECRYPTION - `<qu-view>`/`<qu-list>` (`components.js`) read the
 * Qu store DIRECTLY, with no decryption: a curated item whose own document
 * was written via `AccessService.writeOptionsFor()` with restricted
 * `readers` (e.g. Forum's own restricted channels) is genuine ciphertext at
 * that raw path (confirmed empirically, not assumed - `{iv, ct, to}`, no
 * `title` field at all) - a `<qu-view field="...">` bound to it resolves to
 * `undefined`, not a useful fallback. Neither `template` nor `pillTemplate`
 * are safe defaults for content that MIGHT be encrypted; a caller in that
 * position resolves each item's real value through its own decrypt-aware
 * Service inside `onItemStamped` instead (an app-level, imperative
 * callback, never `<qu-view>`) - Forum's own `ChannelService.getChannel()`
 * is the first real example (see its own `client.js` usage) - the same
 * "imperative escape hatch, not a second templating mechanism"
 * `onItemStamped` was already built for (`components.js`'s own doc
 * comment). A caller whose list items are never encrypted stays free to use
 * `<qu-view>`/`pillTemplate` directly, same as `apps/app-list`'s own
 * existing usage already does.
 *
 * `menuThreshold` overflow truncation (below) still applies ONLY to
 * `buildChrome()`'s plain `items[]` sections (primaryAction/views/settings),
 * in BOTH sidebar and footer - a `list:`-backed section is exempt in both
 * places: the sidebar was already exempt (truncating a live, keyed-
 * reconciled list needs its own design, not assumed for free), and the
 * footer popup needs no truncation at all - it's already a real scroll
 * region (`.qu-apptpl-popup`'s own `max-height`/`overflow-y`), unlike the
 * sidebar's own unbounded column.
 */
import { buildChrome, normalizeAppConfig, ensureStyle, buildFilterInput, buildPopupTrigger, buildPillShell, buildLinkList } from '@qu/ui';

const BREAKPOINT = '720px';

function sameListRegistration(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.path === b.path && a.parent === b.parent && a.template === b.template;
}

/**
 * The `<qu-list>`-wiring shared by BOTH the sidebar's reactive section
 * (`buildReactiveNavSection()`) and the footer's reactive pill+popup
 * (`buildReactiveFooterPill()`) - creating the element, setting
 * `path`/`parent`/`.qu`/`.syncFetch`, appending the caller's own `template`
 * clone, and wiring `onItemStamped`. The two callers differ in what they DO
 * around this (active-class toggling on every stamped child vs. a single
 * live pill label) enough that they stay separate functions - this is only
 * the ~identical setup boilerplate between them.
 * @returns {HTMLElement} an unconnected `<qu-list>`, not yet appended anywhere
 */
function createBoundList(listSpec, { qu, syncFetch, onStamped }) {
  const listEl = document.createElement('qu-list');
  listEl.className = 'qu-apptpl-list';
  if (listSpec.path) listEl.setAttribute('path', listSpec.path);
  else listEl.setAttribute('parent', listSpec.parent);
  listEl.qu = qu;
  if (syncFetch) listEl.syncFetch = syncFetch;
  listEl.onItemStamped = onStamped;
  listEl.appendChild(listSpec.template.cloneNode(true));
  return listEl;
}

/**
 * Finds the already-stamped `<qu-list>` child whose own id (the last
 * segment of its `.qu.ownPath`, the same convention `<qu-list>`'s own
 * `_render()` uses to derive `itemId`) matches `activeId` - `null` if
 * `activeId` is unset or nothing matching has stamped in yet (stamping is
 * async, this can legitimately be true for a whole microtask after
 * `syncActive()` first runs).
 */
function resolveActiveChild(listEl, activeId) {
  if (activeId == null) return null;
  for (const child of listEl.children) {
    if (child.tagName === 'TEMPLATE') continue;
    const ownPath = child.qu?.ownPath;
    const itemId = ownPath ? ownPath.slice(ownPath.lastIndexOf('/') + 1) : null;
    if (itemId === activeId) return child;
  }
  return null;
}

/**
 * Mounts a `<qu-list>`-backed reactive section - the `list:`-registered
 * counterpart to `@qu/ui`'s own `buildLinkList()`/`buildDesktopSidebar()`
 * per-section rendering (see this file's own top doc comment for why the
 * two stay separate rather than one shared function).
 * @returns {{el: HTMLElement, syncActive: (activeId: string|null) => void, cleanup: () => void}}
 */
function buildReactiveNavSection(listSpec, { qu, syncFetch, heading, filter, filterPlaceholder }) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-apptpl-section';
  if (heading) {
    const h = document.createElement('h2');
    h.className = 'qu-apptpl-section-heading';
    h.textContent = heading;
    wrap.appendChild(h);
  }

  // Tracked in a closure, not just applied once per `syncActive()` call:
  // `<qu-list>`'s own stamping is ASYNC (its `watch()` subscription's first
  // delivery happens on a later microtask, never synchronously within THIS
  // function), so a section created with an `activeId` already set would
  // otherwise never get its active class applied at all - `syncActive()`
  // runs synchronously, before anything is stamped yet, and nothing calls
  // it again once stamping actually completes. Reading `currentActiveId`
  // fresh inside `onItemStamped` (below) closes that gap: whichever item
  // stamps in, at whatever time, checks against the LATEST known activeId,
  // not a snapshot from before it existed.
  let currentActiveId = null;

  function applyActiveClass(itemEl, itemId) {
    const link = itemEl.matches?.('a') ? itemEl : itemEl.querySelector?.('a');
    link?.classList.toggle('qu-apptpl-item-active', itemId != null && itemId === currentActiveId);
  }

  // See this file's own top doc comment's "prefixItems" paragraph - a
  // separate, plain `<ul class="qu-apptpl-list">` sibling of the `<qu-list>`
  // below, NOT spliced into it (that would corrupt `<qu-list>`'s own
  // cursor-based child reconciliation).
  const prefixItems = listSpec.prefixItems ?? [];
  const prefixEl = prefixItems.length ? buildLinkList(prefixItems) : null;
  if (prefixEl) wrap.appendChild(prefixEl);

  const listEl = createBoundList(listSpec, {
    qu, syncFetch,
    onStamped: (els, itemId, item) => {
      listSpec.onItemStamped?.(els, itemId, item);
      applyActiveClass(els[0], itemId);
    },
  });

  if (filter) {
    wrap.appendChild(buildFilterInput(
      () => [...listEl.children].filter((c) => c.tagName !== 'TEMPLATE').map((el) => ({ el, search: el.dataset.search ?? '' })),
      { placeholder: filterPlaceholder },
    ));
  }
  wrap.appendChild(listEl);

  function syncPrefixActive(activeId) {
    if (!prefixEl) return;
    [...prefixEl.children].forEach((li, i) => {
      li.querySelector('a')?.classList.toggle('qu-apptpl-item-active', prefixItems[i]?.id === activeId);
    });
  }

  // Handles the OTHER direction: activeId changes on an ALREADY-stamped,
  // otherwise-unchanged list (navigating between channels, no new item
  // added/removed) - `onItemStamped` only fires for NEWLY stamped items,
  // so already-stamped ones need this explicit walk instead.
  function syncActive(activeId) {
    currentActiveId = activeId;
    syncPrefixActive(activeId);
    for (const child of listEl.children) {
      if (child.tagName === 'TEMPLATE') continue;
      const ownPath = child.qu?.ownPath;
      const itemId = ownPath ? ownPath.slice(ownPath.lastIndexOf('/') + 1) : null;
      applyActiveClass(child, itemId);
    }
  }

  return { el: wrap, syncActive, cleanup: () => {} };
}

/**
 * The mobile-footer counterpart to `buildReactiveNavSection()` - a SECOND,
 * independent `<qu-list>` (same `path`/`parent`, a fresh `template` clone -
 * the same `<template>` element can't be a child of two `<qu-list>`s) inside
 * a pill+popup (`buildPillShell()`/`buildPopupTrigger()`, `@qu/ui`). Cheap:
 * its own `watch()` subscription, never shared with the sidebar's instance -
 * the two are never visible at the same time anyway (same reasoning
 * `buildFilterInput()`'s own doc comment already gives for building
 * independent filter inputs per breakpoint).
 *
 * The pill's own visible label tracks the CURRENTLY ACTIVE item, genuinely
 * live, via `listSpec.pillTemplate` (this file's own top doc comment has the
 * full "why a template, not a JS callback" reasoning) - `applyPill()` below
 * re-stamps it ONLY when the resolved active item's own `ownPath` actually
 * changes (never on every call - re-stamping unchanged would tear down and
 * recreate whatever reactive elements `pillTemplate` contains, the same
 * churn class `mountChrome()`'s own `insertBefore` guards exist to prevent
 * elsewhere in this file).
 * @returns {{el: HTMLElement, syncActive: (activeId: string|null) => void, cleanup: () => void}}
 */
function buildReactiveFooterPill(listSpec, { qu, syncFetch, heading, filter, filterPlaceholder }) {
  let currentActiveId = null;
  let appliedKey = null; // a stamped item's own `ownPath`, or `prefix:<id>` for a prefixItems match - see applyPillForPrefix() below

  const { btn, labelEl } = buildPillShell(heading ?? 'Menu');
  labelEl.textContent = heading ?? '';

  const prefixItems = listSpec.prefixItems ?? [];

  /**
   * `targetEl` is either a STABLE, already-inserted `<qu-list>` child
   * (`resolveActiveChild()`'s own return, for the `syncActive()` path - an
   * activeId change on an already-stamped list) or the JUST-stamped
   * element itself, passed directly by `onStamped` below - NOT re-derived
   * via `resolveActiveChild()` there, because `<qu-list>`'s own
   * `onItemStamped` fires BEFORE the stamped element is actually inserted
   * as a child of `listEl` (see `components.js`'s own doc comment: "before
   * insertion") - `resolveActiveChild()`'s `listEl.children` walk would
   * find nothing yet for that case.
   */
  function applyPillFor(targetEl) {
    const ownPath = targetEl?.qu?.ownPath ?? null;
    if (ownPath === appliedKey) return; // unchanged - do not re-stamp
    appliedKey = ownPath;
    labelEl.textContent = '';
    if (targetEl && listSpec.pillTemplate) {
      const clone = listSpec.pillTemplate.content.cloneNode(true);
      // Reuses the SAME ItemContext the footer's own already-stamped
      // <qu-list> child was given (see components.js's own ItemContext) -
      // not a new one - so a <qu-view field="..."> inside pillTemplate
      // resolves against the exact same live data the popup's own row does.
      for (const el of clone.children) el.qu = targetEl.qu;
      labelEl.appendChild(clone);
    } else {
      labelEl.textContent = heading ?? '';
    }
  }

  // A `prefixItems` match (see this file's own top doc comment) is static,
  // already-known data - no template/stamping/decryption needed, unlike a
  // real `<qu-list>` item, so this is a plain, synchronous text swap. Kept
  // as its own sentinel key (`prefix:<id>`, distinct from any real
  // `ownPath` string) so a transition to/from a real stamped item is never
  // mistaken for "unchanged".
  function applyPillForPrefix(item) {
    const key = `prefix:${item.id}`;
    if (key === appliedKey) return;
    appliedKey = key;
    labelEl.textContent = item.label;
  }

  function applyPill() {
    const prefixMatch = prefixItems.find((it) => it.id === currentActiveId);
    if (prefixMatch) { applyPillForPrefix(prefixMatch); return; }
    applyPillFor(resolveActiveChild(listEl, currentActiveId));
  }

  const listEl = createBoundList(listSpec, {
    qu, syncFetch,
    onStamped: (els, itemId, item) => {
      listSpec.onItemStamped?.(els, itemId, item);
      if (itemId === currentActiveId) applyPillFor(els[0]);
    },
  });

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'qu-apptpl-section';
  if (prefixItems.length) bodyWrap.appendChild(buildLinkList(prefixItems));
  if (filter) {
    bodyWrap.appendChild(buildFilterInput(
      () => [...listEl.children].filter((c) => c.tagName !== 'TEMPLATE').map((el) => ({ el, search: el.dataset.search ?? '' })),
      { placeholder: filterPlaceholder },
    ));
  }
  bodyWrap.appendChild(listEl);

  const { el, cleanup } = buildPopupTrigger({ triggerEl: btn, bodyEl: bodyWrap, popupPosition: 'left' });

  // Handles the OTHER direction, same as buildReactiveNavSection()'s own
  // syncActive(): activeId changes (a route change) on an ALREADY-stamped,
  // otherwise-unchanged list - onStamped only fires for NEWLY stamped items.
  function syncActive(activeId) {
    currentActiveId = activeId;
    applyPill();
  }

  return { el, syncActive, cleanup };
}

/**
 * Truncates a `.qu-apptpl-section > .qu-apptpl-list`'s `<li>` items beyond
 * `menuThreshold`, replacing the overflow with one `buildPopupTrigger()`-
 * style "More…" trigger - a DOM post-processing pass over what
 * `buildChrome()`'s own `buildDesktopSidebar()` already built, kept here
 * rather than folded into `@qu/ui` since only this session-scoped chrome
 * uses it so far (see this file's own top doc comment's "SCOPED FOR THIS
 * ROUND"). Desktop sidebar only - the mobile footer's popup-trigger
 * mechanism already collapses N items into one trigger regardless of count,
 * so there is nothing to additionally truncate there.
 */
function applyMenuThreshold(sidebarEl, menuThreshold) {
  if (!sidebarEl || !Number.isFinite(menuThreshold) || menuThreshold <= 0) return;
  // `<qu-list class="qu-apptpl-list">` (a `list:`-registered reactive
  // section, see `buildReactiveNavSection()` above) shares this selector's
  // class name with `buildLinkList()`'s plain `<ul class="qu-apptpl-list">`
  // - excluded by tag name, not just by convention, since truncating a
  // live, keyed-reconciled list is explicitly out of scope for this round
  // (see this file's own top doc comment's "SCOPED FOR THIS ROUND").
  for (const list of sidebarEl.querySelectorAll(':scope > .qu-apptpl-section > .qu-apptpl-list:not(qu-list)')) {
    const items = [...list.children];
    if (items.length <= menuThreshold) continue;
    const overflow = items.slice(menuThreshold);
    const moreLi = document.createElement('li');
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'qu-apptpl-pill';
    moreBtn.textContent = `⋯ ${overflow.length} more`;
    moreBtn.setAttribute('aria-haspopup', 'true');
    moreBtn.setAttribute('aria-expanded', 'false');
    const popup = document.createElement('div');
    popup.className = 'qu-apptpl-popup';
    popup.hidden = true;
    popup.style.position = 'static';
    for (const li of overflow) {
      li.remove();
      popup.appendChild(li.firstElementChild ?? li);
    }
    moreBtn.addEventListener('click', () => {
      const opening = popup.hidden;
      popup.hidden = !opening;
      moreBtn.setAttribute('aria-expanded', String(opening));
    });
    moreLi.append(moreBtn, popup);
    list.appendChild(moreLi);
  }
}

/**
 * @param {HTMLElement} container - appended into; owns everything inside
 *   except `contentSlot`'s own children (whatever the currently-mounted app
 *   renders there).
 * @param {{qu: object, services: object, subscribe?: Function, syncFetch?: Function, menuThreshold?: number}} deps
 * @returns {{
 *   contentSlot: HTMLElement,
 *   begin: () => {set: (partial: object) => void},
 *   stop: () => void,
 * }}
 */
export function mountChrome(container, { qu, syncFetch, menuThreshold = 8 } = {}) {
  ensureStyle(BREAKPOINT);

  const root = document.createElement('div');
  const layout = document.createElement('div');
  layout.className = 'qu-apptpl-layout';
  const contentSlot = document.createElement('div');
  contentSlot.className = 'qu-apptpl-content';
  layout.appendChild(contentSlot);
  root.appendChild(layout);
  container.appendChild(root);

  // BOTH the sidebar AND the footer are PERSISTENT elements, created once,
  // NEVER `.remove()`d as a whole and recreated - only their own children
  // get swapped per rebuild. The footer became persistent for the exact
  // same reason the sidebar already was: a `list:`-registered section's own
  // reactive element (`reactiveNav.el` in the sidebar, `reactiveFooter.el`
  // in the footer) must never be disconnected from the document even
  // momentarily - an explicit `.remove()` on an ANCESTOR followed by a
  // later re-append fires `<qu-list>`'s `disconnectedCallback()` (tears
  // down its `watch()` subscription AND wipes every stamped item) and then
  // `connectedCallback()` again on re-insertion (a fresh, ASYNC re-fetch) -
  // exactly the "full rebuild" this whole mechanism exists to avoid.
  // Confirmed empirically (not just a theoretical concern, and not saved by
  // `insertBefore()`/`appendChild()` alone either - see `rebuild()`'s own
  // three guards below): even calling `insertBefore(node, ref)` (or
  // `appendChild(node)`, the footer's own equivalent) to "move" a node
  // that's already exactly at the target position still fires
  // disconnect+reconnect, so the code below skips those calls entirely, not
  // just relies on either being a no-op for an unchanged position.
  //
  // The footer is made UNCONDITIONALLY persistent (not only when a `list:`
  // section is actually present) deliberately - a route where `navigation`
  // flips between the `list:`/`items[]` forms (a real sequence, not
  // hypothetical: Forum's own board→channel→topic navigation does exactly
  // this) would otherwise hit an untested structural-switch path at the
  // exact moment a live `<qu-list>` is most exposed. Unconditional costs a
  // few extra lines and keeps both containers reasoning identically.
  const sidebarEl = document.createElement('aside');
  sidebarEl.className = 'qu-apptpl-sidebar';
  const footerEl = document.createElement('div');
  footerEl.className = 'qu-apptpl-footer';
  let cleanupChrome = () => {};
  let reactiveNav = null; // {el, syncActive, cleanup, registration} | null - sidebar
  let reactiveFooter = null; // same shape - footer pill+popup

  let epoch = 0;
  let currentConfig = {};

  function teardownReactiveNav() {
    reactiveNav?.el?.remove();
    reactiveNav?.cleanup?.();
    reactiveNav = null;
  }

  function teardownReactiveFooter() {
    reactiveFooter?.el?.remove();
    reactiveFooter?.cleanup?.();
    reactiveFooter = null;
  }

  function rebuild() {
    const navList = currentConfig.navigation?.list ?? null;
    const passthrough = { ...currentConfig };
    if (navList) passthrough.navigation = null; // reactive section(s) spliced in separately below

    const cfg = normalizeAppConfig({ ...passthrough, render: () => {} });

    // `navigation.list`'s own `desktopOnly` is honored exactly like the
    // `items[]` form already does (`buildChrome()`'s own `mobileNav`
    // computation) - `buildChrome()` never sees `cfg.navigation` for a
    // `list:` registration at all (nulled out above), so it has no way to
    // know a mobile footer pill is coming unless told explicitly.
    const hasExternalMobileNav = !!(navList && !currentConfig.navigation.desktopOnly);

    cleanupChrome();
    if (!navList) teardownReactiveNav();
    if (!hasExternalMobileNav) teardownReactiveFooter();

    const built = buildChrome(cfg, { hasExternalMobileNav });
    cleanupChrome = built.cleanup;
    // The footer's own class (e.g. the `fabOnly` variant) still comes fresh
    // from `buildChrome()` every rebuild - only the ELEMENT itself is
    // persistent, not its class name.
    footerEl.className = built.footerEl?.className ?? 'qu-apptpl-footer';

    // Move buildChrome()'s own freshly-built sections into the PERSISTENT
    // sidebarEl/footerEl, preserving `reactiveNav.el`/`reactiveFooter.el`
    // (if kept) rather than wiping and rebuilding them - everything from
    // `built.sidebarEl`/`built.footerEl` is disposable, brand new DOM every
    // call (mountAppTemplate()'s own per-call semantics), so only ITS
    // children are worth keeping; the temporary wrapper itself is discarded.
    for (const child of [...sidebarEl.children]) {
      if (reactiveNav && child === reactiveNav.el) continue;
      child.remove();
    }
    if (built.sidebarEl) {
      for (const child of [...built.sidebarEl.children]) sidebarEl.appendChild(child);
    }
    for (const child of [...footerEl.children]) {
      if (reactiveFooter && child === reactiveFooter.el) continue;
      child.remove();
    }
    if (built.footerEl) {
      for (const child of [...built.footerEl.children]) footerEl.appendChild(child);
    }

    if (navList) {
      const registration = { path: navList.path, parent: navList.parent, template: navList.template };
      if (!reactiveNav || !sameListRegistration(reactiveNav.registration, registration)) {
        teardownReactiveNav();
        reactiveNav = buildReactiveNavSection(navList, {
          qu, syncFetch,
          heading: currentConfig.navigation.heading,
          filter: !!currentConfig.navigation.filter,
          filterPlaceholder: currentConfig.navigation.heading ? `Filter ${currentConfig.navigation.heading}…` : 'Filter…',
        });
        reactiveNav.registration = registration;
      }
      reactiveNav.syncActive(currentConfig.navigation.activeId ?? null);
      // Guarded, unlike the doc comment above might suggest: insertBefore()
      // fires disconnectedCallback/connectedCallback even when "moving" a
      // node back to the position it's already at (confirmed empirically,
      // not just per a stricter reading of the DOM spec than assumed
      // above) - skipping the call entirely when already correctly
      // positioned is what actually keeps `<qu-list>` connected without
      // interruption, not `insertBefore()`'s own semantics alone.
      if (sidebarEl.firstChild !== reactiveNav.el) sidebarEl.insertBefore(reactiveNav.el, sidebarEl.firstChild);

      if (hasExternalMobileNav) {
        if (!reactiveFooter || !sameListRegistration(reactiveFooter.registration, registration)) {
          teardownReactiveFooter();
          reactiveFooter = buildReactiveFooterPill(navList, {
            qu, syncFetch,
            heading: currentConfig.navigation.heading,
            filter: !!currentConfig.navigation.filter,
            filterPlaceholder: currentConfig.navigation.heading ? `Filter ${currentConfig.navigation.heading}…` : 'Filter…',
          });
          reactiveFooter.registration = registration;
        }
        reactiveFooter.syncActive(currentConfig.navigation.activeId ?? null);
        if (footerEl.firstChild !== reactiveFooter.el) footerEl.insertBefore(reactiveFooter.el, footerEl.firstChild);
      }
    }

    applyMenuThreshold(sidebarEl, menuThreshold);

    root.className = currentConfig.fullHeight ? 'qu-apptpl-root qu-apptpl-root--full-height' : 'qu-apptpl-root';
    if (currentConfig.fullHeight && built.hasMobileFooterContent && !built.fabOnly) root.classList.add('qu-apptpl-root--has-footer-bar');
    contentSlot.classList.toggle('qu-apptpl-content--with-bar', built.hasMobileFooterContent && !built.fabOnly && !currentConfig.fullHeight);

    // Same "skip insertBefore()/appendChild() entirely when already
    // correctly positioned" guard as `reactiveNav.el`/`reactiveFooter.el`
    // above, one level up: without it, EVERY rebuild() call
    // re-disconnects/reconnects the whole persistent sidebarEl/footerEl
    // subtree (including any live <qu-list> inside either) via
    // `layout`/`root`, even when they were already exactly here.
    if (sidebarEl.children.length > 0) {
      if (layout.firstChild !== sidebarEl) layout.insertBefore(sidebarEl, contentSlot);
    } else {
      sidebarEl.remove(); // nothing to show - safe to fully detach, reactiveNav (if any) was already torn down above when navList became absent
    }
    if (footerEl.children.length > 0) {
      if (root.lastChild !== footerEl) root.appendChild(footerEl);
    } else {
      footerEl.remove(); // nothing to show - reactiveFooter (if any) was already torn down above when hasExternalMobileNav became false
    }
  }

  /**
   * Called by `apps/shell/client.js`'s `renderRoute()` at the START of every
   * navigation (same place `stopMountedApp`/`screen.textContent` are already
   * reset) - resets the displayed chrome to empty immediately, advances the
   * internal epoch, and returns a FRESH `{set(partial)}` handle bound to
   * that epoch. A `set()` call from a PREVIOUS handle (a stale `watch()`
   * callback or async IIFE from an already-torn-down view) is a silent
   * no-op instead of corrupting the now-current app's own chrome - the same
   * `token`/`stopped` epoch discipline `apps/shell/client.js`'s own
   * `navToken` already uses elsewhere in this file, applied one layer down.
   */
  function begin() {
    epoch += 1;
    const myEpoch = epoch;
    currentConfig = {};
    rebuild();
    return {
      set(partial) {
        if (myEpoch !== epoch) return;
        currentConfig = { ...currentConfig, ...partial };
        rebuild();
      },
    };
  }

  function stop() {
    cleanupChrome();
    teardownReactiveNav();
    teardownReactiveFooter();
  }

  return { contentSlot, begin, stop };
}
