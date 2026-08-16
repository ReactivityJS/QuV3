import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ICE_SERVERS, resolveIceServers } from '../src/ice-config.js';

test('resolveIceServers() falls back to DEFAULT_ICE_SERVERS with no options', () => {
  assert.deepEqual(resolveIceServers(), DEFAULT_ICE_SERVERS);
  assert.deepEqual(resolveIceServers({}), DEFAULT_ICE_SERVERS);
});

test('resolveIceServers() prefers an operator list over the default', () => {
  const operatorServers = [{ urls: 'stun:operator.example:3478' }];
  assert.deepEqual(resolveIceServers({ operatorServers }), operatorServers);
});

test('resolveIceServers() prefers an explicit override over both the operator list and the default', () => {
  const operatorServers = [{ urls: 'stun:operator.example:3478' }];
  const override = [{ urls: 'stun:override.example:3478' }];
  assert.deepEqual(resolveIceServers({ operatorServers, override }), override);
});

test('resolveIceServers() ignores an empty operator/override list rather than resolving to []', () => {
  assert.deepEqual(resolveIceServers({ operatorServers: [], override: [] }), DEFAULT_ICE_SERVERS);
});
