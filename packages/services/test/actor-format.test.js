import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatActorLabel, matchesActorQuery } from '../src/actor-format.js';

const PUB = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';

test('formatActorLabel uses the alias when present', () => {
  assert.equal(formatActorLabel(PUB, { alias: 'Ada' }), 'Ada');
});

test('formatActorLabel falls back to a truncated pubkey when alias is unset', () => {
  assert.equal(formatActorLabel(PUB, null), `~${PUB.slice(0, 16)}…`);
});

test('formatActorLabel falls back for an empty-string alias too', () => {
  assert.equal(formatActorLabel(PUB, { alias: '' }), `~${PUB.slice(0, 16)}…`);
});

test('matchesActorQuery: an empty query matches everything', () => {
  assert.equal(matchesActorQuery(PUB, { alias: 'Ada' }, ''), true);
  assert.equal(matchesActorQuery(PUB, { alias: 'Ada' }, '   '), true);
});

test('matchesActorQuery matches on alias, case-insensitively', () => {
  assert.equal(matchesActorQuery(PUB, { alias: 'Ada Lovelace' }, 'lovelace'), true);
  assert.equal(matchesActorQuery(PUB, { alias: 'Ada Lovelace' }, 'BOB'), false);
});

test('matchesActorQuery matches on a pubkey substring, case-insensitively', () => {
  assert.equal(matchesActorQuery(PUB, null, 'ABCDEF'), true);
  assert.equal(matchesActorQuery(PUB, null, 'zzz'), false);
});

test('matchesActorQuery works with no profile at all', () => {
  assert.equal(matchesActorQuery(PUB, undefined, PUB.slice(0, 5)), true);
});
