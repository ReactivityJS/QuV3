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
 * SCOPED FOR THIS ROUND (Forum-only proof-of-concept, not a silent gap):
 *   - A `list:`-based section renders in the DESKTOP SIDEBAR ONLY. Forum's
 *     mobile channel-switcher pill (today's `desktopOnly: false` behavior)
 *     is real, deliberate follow-up work, not built here - extending the
 *     reactive section to the mobile popup trigger is a second, separable
 *     unit of work once a second real app needs the same shape.
 *   - `menuThreshold` overflow truncation (below) applies ONLY to
 *     `buildChrome()`'s plain `items[]` sections (primaryAction/views/
 *     settings) - deliberately NOT combined with a `list:`-based section in
 *     this round (truncating a live, keyed-reconciled list needs its own
 *     design, not assumed to fall out for free from combining two
 *     mechanisms that individually work).
 */
import { buildChrome, normalizeAppConfig, ensureStyle, buildFilterInput } from '@qu/ui';

const BREAKPOINT = '720px';

function sameListRegistration(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.path === b.path && a.parent === b.parent && a.template === b.template;
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

  const listEl = document.createElement('qu-list');
  listEl.className = 'qu-apptpl-list';
  if (listSpec.path) listEl.setAttribute('path', listSpec.path);
  else listEl.setAttribute('parent', listSpec.parent);
  listEl.qu = qu;
  if (syncFetch) listEl.syncFetch = syncFetch;
  listEl.onItemStamped = (els, itemId, item) => {
    listSpec.onItemStamped?.(els, itemId, item);
    applyActiveClass(els[0], itemId);
  };

  if (filter) {
    wrap.appendChild(buildFilterInput(
      () => [...listEl.children].filter((c) => c.tagName !== 'TEMPLATE').map((el) => ({ el, search: el.dataset.search ?? '' })),
      { placeholder: filterPlaceholder },
    ));
  }
  listEl.appendChild(listSpec.template.cloneNode(true));
  wrap.appendChild(listEl);

  // Handles the OTHER direction: activeId changes on an ALREADY-stamped,
  // otherwise-unchanged list (navigating between channels, no new item
  // added/removed) - `onItemStamped` only fires for NEWLY stamped items,
  // so already-stamped ones need this explicit walk instead.
  function syncActive(activeId) {
    currentActiveId = activeId;
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

  // The sidebar is a PERSISTENT element, created once, NEVER `.remove()`d as
  // a whole and recreated - only its own children get swapped per rebuild.
  // This matters specifically because a `list:`-registered section's
  // `reactiveNav.el` (containing a live `<qu-list>`) must never be
  // disconnected from the document even momentarily: an explicit
  // `.remove()` on an ANCESTOR followed by a later re-append fires
  // `<qu-list>`'s `disconnectedCallback()` (tears down its `watch()`
  // subscription AND wipes every stamped item) and then
  // `connectedCallback()` again on re-insertion (a fresh, ASYNC re-fetch) -
  // exactly the "full rebuild" this whole mechanism exists to avoid.
  // Confirmed empirically (not just a theoretical concern, and not saved by
  // `insertBefore()` alone either - see `rebuild()`'s own `sidebarEl.
  // firstChild !== reactiveNav.el` guard below): even calling
  // `insertBefore(node, ref)` to "move" a node that's already exactly at
  // the target position still fires disconnect+reconnect, so the code
  // below skips that call entirely, not just relies on insertBefore being
  // a no-op for an unchanged position.
  const sidebarEl = document.createElement('aside');
  sidebarEl.className = 'qu-apptpl-sidebar';
  let footerEl = null;
  let cleanupChrome = () => {};
  let reactiveNav = null; // {el, syncActive, cleanup, registration} | null

  let epoch = 0;
  let currentConfig = {};

  function teardownReactiveNav() {
    reactiveNav?.el?.remove();
    reactiveNav?.cleanup?.();
    reactiveNav = null;
  }

  function rebuild() {
    const navList = currentConfig.navigation?.list ?? null;
    const passthrough = { ...currentConfig };
    if (navList) passthrough.navigation = null; // reactive section spliced in separately below

    const cfg = normalizeAppConfig({ ...passthrough, render: () => {} });

    cleanupChrome();
    footerEl?.remove();
    if (!navList) teardownReactiveNav();

    const built = buildChrome(cfg);
    cleanupChrome = built.cleanup;
    footerEl = built.footerEl;

    // Move buildChrome()'s own freshly-built sections into the PERSISTENT
    // sidebarEl, preserving `reactiveNav.el` (if kept) rather than wiping
    // and rebuilding it - everything from `built.sidebarEl` is disposable,
    // brand new DOM every call (mountAppTemplate()'s own per-call
    // semantics), so only ITS children are worth keeping; the temporary
    // wrapper itself is discarded.
    for (const child of [...sidebarEl.children]) {
      if (reactiveNav && child === reactiveNav.el) continue;
      child.remove();
    }
    if (built.sidebarEl) {
      for (const child of [...built.sidebarEl.children]) sidebarEl.appendChild(child);
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
    }

    applyMenuThreshold(sidebarEl, menuThreshold);

    root.className = currentConfig.fullHeight ? 'qu-apptpl-root qu-apptpl-root--full-height' : 'qu-apptpl-root';
    if (currentConfig.fullHeight && built.hasMobileFooterContent && !built.fabOnly) root.classList.add('qu-apptpl-root--has-footer-bar');
    contentSlot.classList.toggle('qu-apptpl-content--with-bar', built.hasMobileFooterContent && !built.fabOnly && !currentConfig.fullHeight);

    // Same "skip insertBefore() entirely when already correctly
    // positioned" guard as `reactiveNav.el` above, one level up: without
    // it, EVERY rebuild() call re-disconnects/reconnects the whole
    // persistent sidebarEl subtree (including any live <qu-list> inside
    // it) via `layout`, even when sidebarEl was already exactly here.
    if (sidebarEl.children.length > 0) {
      if (layout.firstChild !== sidebarEl) layout.insertBefore(sidebarEl, contentSlot);
    } else {
      sidebarEl.remove(); // nothing to show - safe to fully detach, reactiveNav (if any) was already torn down above when navList became absent
    }
    if (footerEl) root.appendChild(footerEl);
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
  }

  return { contentSlot, begin, stop };
}
