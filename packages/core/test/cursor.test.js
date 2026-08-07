import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeChildCursor, sortAndPaginateChildren } from '../src/adapters/cursor.js';

function candidate(rel, ts) {
  return { rel, quBit: { path: 'irrelevant', val: null, ts, pub: null, sig: null } };
}

test('encodeChildCursor() is deterministic for the same (ts, rel), and distinct for different ones', () => {
  const a1 = encodeChildCursor(candidate('/x/a', 1));
  const a2 = encodeChildCursor(candidate('/x/a', 1));
  const b = encodeChildCursor(candidate('/x/b', 1));
  const aLaterTs = encodeChildCursor(candidate('/x/a', 2));

  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.notEqual(a1, aLaterTs);
});

test('sortAndPaginateChildren() orders by ts, tie-broken by rel, honoring `order`', () => {
  const candidates = [candidate('/x/b', 100), candidate('/x/a', 100), candidate('/x/c', 200)];

  const desc = sortAndPaginateChildren(candidates, { order: 'desc' });
  assert.deepEqual(desc.map((e) => e.rel), ['/x/c', '/x/b', '/x/a']);

  const asc = sortAndPaginateChildren(candidates, { order: 'asc' });
  assert.deepEqual(asc.map((e) => e.rel), ['/x/a', '/x/b', '/x/c']);
});

test('sortAndPaginateChildren() does not mutate the input array', () => {
  const candidates = [candidate('/x/b', 2), candidate('/x/a', 1)];
  const original = [...candidates];
  sortAndPaginateChildren(candidates, { order: 'asc' });
  assert.deepEqual(candidates, original);
});

test('sortAndPaginateChildren() every returned entry carries a `cursor`', () => {
  const result = sortAndPaginateChildren([candidate('/x/a', 1), candidate('/x/b', 2)]);
  assert.ok(result.every((e) => typeof e.cursor === 'string' && e.cursor.length > 0));
});

test('sortAndPaginateChildren() limit+cursor pagination covers every candidate exactly once', () => {
  const candidates = Array.from({ length: 5 }, (_, i) => candidate(`/x/m${i}`, i));

  let cursor;
  const seen = [];
  for (let i = 0; i < 10; i++) { // generous upper bound, loop breaks itself
    const page = sortAndPaginateChildren(candidates, { order: 'asc', limit: 2, cursor });
    if (page.length === 0) break;
    seen.push(...page.map((e) => e.rel));
    cursor = page[page.length - 1].cursor;
  }

  assert.deepEqual(seen, ['/x/m0', '/x/m1', '/x/m2', '/x/m3', '/x/m4']);
});

test('sortAndPaginateChildren() with no options returns everything, unpaginated', () => {
  const candidates = [candidate('/x/a', 1), candidate('/x/b', 2)];
  const result = sortAndPaginateChildren(candidates);
  assert.equal(result.length, 2);
});

test('sortAndPaginateChildren() on an empty candidate list returns an empty array', () => {
  assert.deepEqual(sortAndPaginateChildren([]), []);
});
