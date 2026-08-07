import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookBus } from '../src/hooks.js';

test('run() executes handlers sequentially, each seeing the previous one\'s patch', async () => {
  const bus = new HookBus();
  const seenAt = [];
  bus.on('thread.beforePostMessage', (payload) => {
    seenAt.push(payload.body);
    return { body: payload.body + '[a]' };
  });
  bus.on('thread.beforePostMessage', (payload) => {
    seenAt.push(payload.body);
    return { body: payload.body + '[b]' };
  });

  const result = await bus.run('thread.beforePostMessage', { body: 'hi' });

  assert.deepEqual(seenAt, ['hi', 'hi[a]']);
  assert.equal(result.body, 'hi[a][b]');
});

test('run() shallow-merges a handler\'s returned patch, preserving untouched fields', async () => {
  const bus = new HookBus();
  bus.on('x', () => ({ b: 2 }));

  const result = await bus.run('x', { a: 1, b: 1 });
  assert.deepEqual(result, { a: 1, b: 2 });
});

test('run() leaves the payload unchanged when a handler returns undefined', async () => {
  const bus = new HookBus();
  bus.on('x', () => undefined);
  bus.on('x', () => {}); // implicit undefined

  const result = await bus.run('x', { a: 1 });
  assert.deepEqual(result, { a: 1 });
});

test('run() on a name with no registered handlers returns the payload as-is', async () => {
  const bus = new HookBus();
  const payload = { a: 1 };
  assert.equal(await bus.run('nothing-registered', payload), payload);
});

test('notify() runs handlers in parallel and ignores return values', async () => {
  const bus = new HookBus();
  const order = [];
  bus.on('x', async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('slow');
    return 'ignored-return-value';
  });
  bus.on('x', () => {
    order.push('fast');
  });

  await bus.notify('x', {});
  assert.deepEqual(order.sort(), ['fast', 'slow'].sort());
});

test('notify() swallows a handler rejecting asynchronously - other handlers still run', async () => {
  const bus = new HookBus();
  const ran = [];
  bus.on('x', async () => {
    throw new Error('async boom');
  });
  bus.on('x', () => { ran.push('survived'); });

  await assert.doesNotReject(() => bus.notify('x', {}));
  assert.deepEqual(ran, ['survived']);
});

test('notify() swallows a handler throwing SYNCHRONOUSLY too', async () => {
  const bus = new HookBus();
  const ran = [];
  bus.on('x', () => {
    throw new Error('sync boom'); // thrown before returning a promise at all
  });
  bus.on('x', () => { ran.push('survived'); });

  await assert.doesNotReject(() => bus.notify('x', {}));
  assert.deepEqual(ran, ['survived']);
});

test('handlers run in `order` (lower first), registration order breaking ties', async () => {
  const bus = new HookBus();
  const calls = [];
  bus.on('x', () => { calls.push('default-1'); });
  bus.on('x', () => { calls.push('early'); }, { order: -10 });
  bus.on('x', () => { calls.push('default-2'); });
  bus.on('x', () => { calls.push('late'); }, { order: 10 });

  await bus.run('x', {});
  assert.deepEqual(calls, ['early', 'default-1', 'default-2', 'late']);
});

test('off() removes exactly the given handler', async () => {
  const bus = new HookBus();
  const calls = [];
  const handlerA = () => { calls.push('a'); };
  const handlerB = () => { calls.push('b'); };
  bus.on('x', handlerA);
  bus.on('x', handlerB);
  bus.off('x', handlerA);

  await bus.run('x', {});
  assert.deepEqual(calls, ['b']);
});

test('off() on a handler that was never registered is a harmless no-op', () => {
  const bus = new HookBus();
  assert.doesNotThrow(() => bus.off('x', () => {}));
});

test('two independent HookBus instances never share state', async () => {
  const a = new HookBus();
  const b = new HookBus();
  let firedOnA = 0;
  a.on('x', () => { firedOnA++; });

  await b.notify('x', {});
  assert.equal(firedOnA, 0);
});
