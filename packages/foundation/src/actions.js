/**
 * ACTIONS — pure helpers over the manifest catalog's declarative `actions`
 * field (see manifest.js's own doc comment for the full "slots and actions"
 * rationale). No state, no registry instance: every app already has the full
 * catalog in hand (it's `/apps.json`, fetched once by the shell and handed
 * to every mounted app as `ctx.apps`), so filtering it for one slot id is
 * just a pure function over an array a caller already has.
 *
 * Named "slot" (not "mount") deliberately - "mount" already means two other
 * things in this codebase (a `QuMount`/`QuStore` storage mount, and the
 * `mod.mount(container, ctx)` DOM-mounting call a shell makes on an app). A
 * UI extension point that another app's manifest fills in with a link is
 * neither of those, and reusing the word invites exactly the confusion
 * three unrelated meanings for the same term would cause. "Slot" borrows the
 * native Web Components term for the same idea and collides with nothing
 * else here.
 *
 * This is deliberately NOT the same mechanism `extension-points.js`'s
 * `ExtensionPointHost`/manifest's `contributes` field is - that one crosses
 * the "only ONE app's `clientMain` is ever mounted at a time" boundary via
 * dynamic `import()` of a NAMED export from another app's already-pinned
 * module, so a contribution CAN be live, running code (a render function, a
 * hook handler). An `actions` entry here stays pure DATA (a label/icon/href
 * template) on purpose - most slot consumers (e.g. `contact-list`'s
 * `contact-row`) only ever need a link, and a link costs nothing to resolve
 * (no fetch, no module eval) - reach for `contributes` only once a slot
 * genuinely needs to run someone else's code, not just link to it.
 */

/**
 * @param {Array<{name: string, actions?: Array<{slot: string, id: string, label: string, icon?: string, hrefTemplate: string, order?: number}>}>} apps -
 *   The manifest catalog (e.g. `ctx.apps`).
 * @param {string} slotId - e.g. `"contact-row"`.
 * @returns {Array<{appId: string, id: string, label: string, icon: string|null, hrefTemplate: string}>}
 *   Every action any loaded app declared for this slot, sorted by its
 *   `order` (lower first, ties broken by declaration order) - empty if none.
 */
export function actionsForSlot(apps, slotId) {
  const found = [];
  for (const app of apps ?? []) {
    for (const action of app.actions ?? []) {
      if (action.slot !== slotId) continue;
      found.push({
        appId: app.name,
        id: action.id,
        label: action.label,
        icon: action.icon ?? null,
        hrefTemplate: action.hrefTemplate,
        order: action.order ?? 0,
      });
    }
  }
  return found
    .sort((a, b) => a.order - b.order)
    .map(({ appId, id, label, icon, hrefTemplate }) => ({ appId, id, label, icon, hrefTemplate }));
}

/**
 * Fills in an action's `hrefTemplate` (e.g. `"#/chat/{pub}"`) with concrete
 * values, URL-encoding each substitution.
 * @param {{id: string, hrefTemplate: string}} action - As returned by `actionsForSlot()`.
 * @param {Record<string, string>} params - e.g. `{pub: actorPub}`.
 * @returns {string} The resolved href, e.g. `"#/chat/AbC123..."`.
 * @throws {Error} If the template references a param that wasn't provided.
 */
export function resolveActionHref(action, params) {
  return action.hrefTemplate.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in params)) throw new Error(`resolveActionHref: action "${action.id}" needs param "${key}", got none`);
    return encodeURIComponent(params[key]);
  });
}
