/**
 * EXTENSION ORDER — one small, pure ranking function, shared by
 * `ExtensionPointHost` (sorting manifest-declared `contributes` entries for
 * a point) AND by a host app's own NATIVE items registered directly onto
 * `ExtensionPointHost.events` (see that class's own doc comment on why a
 * host can mix its own local `.on()` handlers into the same point a plugin
 * contributes to) - both need the EXACT same id -> position lookup, so it
 * lives here once instead of two independently-drifting sort comparators.
 *
 * WHY THIS EXISTS: an admin wants "reactions on the left, the read-tick on
 * the right" to be ONE setting that applies identically wherever the SAME
 * point renders (`content.messageFooter` in both `apps/forum` and
 * `apps/chat`, say) - not a per-app `contributes[].order` a maintainer
 * hardcodes at build time. `packages/relay/src/relay-settings.js`'
 * `extensionOrder` field (`{[point]: [id, ...]}`, admin-edited via
 * `apps/relay-admin`) is that one setting; this function is how a caller
 * turns it into a sort key for one specific id.
 *
 * ID SPACE: a real plugin's id is its manifest `name` (what
 * `ExtensionPointHost` already keys `contributes` entries by); a host app's
 * own native item (e.g. a message's Edit action, or its timestamp) uses a
 * `core.<name>` id instead - same flat namespace, no separate mechanism.
 */

/**
 * @param {Record<string, string[]>|null|undefined} extensionOrder - e.g.
 *   `ExtensionPointHost#order` (relay-settings' admin-edited config).
 * @param {string} point
 * @param {string} id - a manifest app `name`, or a `core.<name>` synthetic
 *   id for a host app's own native item.
 * @param {number} [fallback=0] - this id's un-configured position (a
 *   manifest `contributes[].order`, or a host app's own hardcoded default)
 *   - used ONLY when `id` isn't in `extensionOrder[point]` at all.
 * @returns {number} A sort key, lower first. Every EXPLICITLY configured id
 *   sorts strictly before every unconfigured one (offset by a fixed 10000 -
 *   comfortably above any realistic `fallback`/list length) - so a freshly
 *   installed plugin the admin hasn't arranged yet always appends at the
 *   end, in its own declared order, rather than unpredictably interleaving
 *   with an admin's explicit choices by raw number collision.
 */
export function rankFor(extensionOrder, point, id, fallback = 0) {
  const order = extensionOrder?.[point];
  const index = Array.isArray(order) ? order.indexOf(id) : -1;
  return index === -1 ? 10_000 + fallback : index;
}
