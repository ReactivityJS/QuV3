/**
 * UNWRAP — strips the QuBit envelope ({path, val, ts, pub, sig}) down to the
 * plain value apps actually want. This is the concrete mechanism behind
 * "Services hide storage details": QuStore always deals in QuBits (see
 * @qu/core), but nothing above the Service layer should ever need to know
 * that a value arrived wrapped in one.
 *
 * Used specifically by `ListService`'s CURATED lists (`listCurated()`),
 * where `@qu/engines`' `CollectionEngine` resolves a `{$list: [...]}`
 * index to an array of full referenced QuBits - callers of `listCurated()`
 * want plain values back, not envelopes. DERIVED lists
 * (`ListService.listDerived()`) deliberately do NOT unwrap - see that
 * method's own doc comment for why (pagination needs the envelope's `ts`/
 * cursor, and the caller owns its own unwrap/decrypt shape).
 */

/**
 * @param {*} quBitOrValue
 * @returns {*} `.val` if this looks like a QuBit, otherwise the input unchanged.
 */
export function unwrap(quBitOrValue) {
  if (quBitOrValue && typeof quBitOrValue === 'object' && 'val' in quBitOrValue && 'ts' in quBitOrValue) {
    return quBitOrValue.val;
  }
  return quBitOrValue;
}

/** @param {Array<*>} list @returns {Array<*>} Each element run through unwrap(). */
export function unwrapAll(list) {
  return list.map(unwrap);
}
