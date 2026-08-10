import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankFor } from '../src/extension-order.js';

test('rankFor(): an id listed in the configured order sorts by its index there', () => {
  const order = { 'content.messageFooter': ['reactions', 'core.timestamp', 'core.menu'] };
  assert.equal(rankFor(order, 'content.messageFooter', 'reactions'), 0);
  assert.equal(rankFor(order, 'content.messageFooter', 'core.timestamp'), 1);
  assert.equal(rankFor(order, 'content.messageFooter', 'core.menu'), 2);
});

test('rankFor(): an id NOT listed for this point falls back, offset after every explicitly configured id', () => {
  const order = { 'content.messageFooter': ['reactions'] };
  assert.equal(rankFor(order, 'content.messageFooter', 'newPlugin', 0), 10_000);
  assert.equal(rankFor(order, 'content.messageFooter', 'newPlugin', 5), 10_005);
});

test('rankFor(): no config at all for this point falls back to the plain fallback offset', () => {
  assert.equal(rankFor({}, 'content.messageFooter', 'reactions', 3), 10_003);
  assert.equal(rankFor(null, 'content.messageFooter', 'reactions', 3), 10_003);
  assert.equal(rankFor(undefined, 'content.messageFooter', 'reactions', 3), 10_003);
});

test('rankFor(): a different point\'s config never leaks into this point\'s ranking', () => {
  const order = { 'other.point': ['reactions'] };
  assert.equal(rankFor(order, 'content.messageFooter', 'reactions', 2), 10_002);
});
