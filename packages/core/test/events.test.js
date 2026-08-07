import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuEvents } from '../src/events.js';

test('on()/emit() delivers the same payload to every listener (fan-out, not a chain)', async () => {
  const bus = new QuEvents();
  const seen = [];
  bus.on('topic', (payload) => seen.push(['a', payload]));
  bus.on('topic', () => undefined); // returns nothing - must not blank out payload for the next listener
  bus.on('topic', (payload) => seen.push(['c', payload]));

  await bus.emit('topic', { value: 42 });

  assert.deepEqual(seen, [
    ['a', { value: 42 }],
    ['c', { value: 42 }],
  ]);
});

test('listeners run in `order` (lower first), registration order breaking ties', async () => {
  const bus = new QuEvents();
  const calls = [];
  bus.on('topic', () => calls.push('default-1')); // order 50
  bus.on('topic', () => calls.push('early'), { order: 0 });
  bus.on('topic', () => calls.push('default-2')); // order 50, registered after default-1
  bus.on('topic', () => calls.push('late'), { order: 100 });

  await bus.emit('topic', {});

  assert.deepEqual(calls, ['early', 'default-1', 'default-2', 'late']);
});

test('a throwing listener is isolated - later listeners still run, emit() still resolves', async () => {
  const bus = new QuEvents();
  const calls = [];
  bus.on('topic', () => {
    throw new Error('boom');
  });
  bus.on('topic', () => calls.push('after'));

  const ctx = await bus.emit('topic', { ok: true });

  assert.deepEqual(calls, ['after']);
  assert.equal(ctx.errors.length, 1);
  assert.equal(ctx.errors[0].error.message, 'boom');
  assert.deepEqual(ctx.result, { ok: true });
});

test('the unsubscribe function removes exactly the handler it was returned for', async () => {
  // QuEvents has no separate off(topic, handler) method - the returned
  // closure from on() is the only way to unsubscribe (see class doc comment).
  const bus = new QuEvents();
  const calls = [];
  const offA = bus.on('topic', () => { calls.push('a'); });
  bus.on('topic', () => { calls.push('b'); });
  offA();

  await bus.emit('topic', {});

  assert.deepEqual(calls, ['b']);
  assert.equal(bus.listenerCount('topic'), 1);
});

test('the unsubscribe function returned by on() also removes the listener', async () => {
  const bus = new QuEvents();
  const calls = [];
  const off = bus.on('topic', () => calls.push('x'));
  off();

  await bus.emit('topic', {});

  assert.deepEqual(calls, []);
  assert.equal(bus.listenerCount('topic'), 0);
});

test('once() fires exactly one time then unsubscribes itself', async () => {
  const bus = new QuEvents();
  const calls = [];
  bus.once('topic', (payload) => calls.push(payload));

  await bus.emit('topic', 1);
  await bus.emit('topic', 2);

  assert.deepEqual(calls, [1]);
  assert.equal(bus.listenerCount('topic'), 0);
});

test('listenerCount() reflects registrations for a topic, 0 for an unknown topic', () => {
  const bus = new QuEvents();
  assert.equal(bus.listenerCount('nothing'), 0);
  bus.on('topic', () => {});
  bus.on('topic', () => {});
  assert.equal(bus.listenerCount('topic'), 2);
});
