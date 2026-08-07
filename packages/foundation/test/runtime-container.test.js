import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeContainer } from '../src/runtime-container.js';

test('register()/resolve() round-trip', () => {
  const runtime = new RuntimeContainer();
  runtime.register('thing', () => ({ value: 42 }));
  assert.deepEqual(runtime.resolve('thing'), { value: 42 });
});

test('resolve() returns the SAME instance on every call - a lazy singleton, not a per-call factory', () => {
  const runtime = new RuntimeContainer();
  runtime.register('thing', () => ({}));
  assert.equal(runtime.resolve('thing'), runtime.resolve('thing'));
});

test('the factory is called AT MOST ONCE, only when first resolved', () => {
  const runtime = new RuntimeContainer();
  let calls = 0;
  runtime.register('thing', () => {
    calls++;
    return {};
  });
  assert.equal(calls, 0); // registering alone never invokes it
  runtime.resolve('thing');
  runtime.resolve('thing');
  runtime.resolve('thing');
  assert.equal(calls, 1);
});

test('a registered-but-never-resolved module\'s factory never runs', () => {
  const runtime = new RuntimeContainer();
  let called = false;
  runtime.register('unused', () => {
    called = true;
    return {};
  });
  assert.equal(called, false);
});

test('resolve() of an unregistered name throws, listing what IS registered', () => {
  const runtime = new RuntimeContainer();
  runtime.register('a', () => ({}));
  runtime.register('b', () => ({}));
  assert.throws(() => runtime.resolve('nope'), /no module named "nope"/);
  assert.throws(() => runtime.resolve('nope'), /a, b/);
});

test('resolve() of an unregistered name in an empty container reports "(none)"', () => {
  const runtime = new RuntimeContainer();
  assert.throws(() => runtime.resolve('nope'), /\(none\)/);
});

test('register() of an already-registered name throws - no silent overwrite', () => {
  const runtime = new RuntimeContainer();
  runtime.register('thing', () => ({}));
  assert.throws(() => runtime.register('thing', () => ({})), /"thing" is already registered/);
});

test('has() reports registration WITHOUT instantiating', () => {
  const runtime = new RuntimeContainer();
  let called = false;
  runtime.register('thing', () => {
    called = true;
    return {};
  });
  assert.equal(runtime.has('thing'), true);
  assert.equal(called, false);
  assert.equal(runtime.has('nope'), false);
});

test('list() returns every registered name, instantiated or not', () => {
  const runtime = new RuntimeContainer();
  runtime.register('a', () => ({}));
  runtime.register('b', () => ({}));
  runtime.resolve('a');
  assert.deepEqual(runtime.list().sort(), ['a', 'b']);
});

test('a factory can depend on another registered module via the container argument', () => {
  const runtime = new RuntimeContainer();
  runtime.register('config', () => ({ prefix: 'qu' }));
  runtime.register('greeting', (rt) => `${rt.resolve('config').prefix}-hello`);
  assert.equal(runtime.resolve('greeting'), 'qu-hello');
});

test('a shared dependency resolved by two different modules\' factories is the SAME instance', () => {
  const runtime = new RuntimeContainer();
  runtime.register('shared', () => ({ id: Math.random() }));
  runtime.register('a', (rt) => ({ shared: rt.resolve('shared') }));
  runtime.register('b', (rt) => ({ shared: rt.resolve('shared') }));
  assert.equal(runtime.resolve('a').shared, runtime.resolve('b').shared);
});

test('REGRESSION: a direct circular dependency (A resolves B, B resolves A) throws instead of stack-overflowing', () => {
  const runtime = new RuntimeContainer();
  runtime.register('a', (rt) => rt.resolve('b'));
  runtime.register('b', (rt) => rt.resolve('a'));
  assert.throws(() => runtime.resolve('a'), /circular dependency resolving "a"/);
});

test('REGRESSION: an indirect circular dependency (A -> B -> C -> A) is also caught', () => {
  const runtime = new RuntimeContainer();
  runtime.register('a', (rt) => rt.resolve('b'));
  runtime.register('b', (rt) => rt.resolve('c'));
  runtime.register('c', (rt) => rt.resolve('a'));
  assert.throws(() => runtime.resolve('a'), /circular dependency resolving "a"/);
});

test('after a cycle throws, the involved names are NOT poisoned - resolving them again re-attempts (and still fails the same way)', () => {
  const runtime = new RuntimeContainer();
  runtime.register('a', (rt) => rt.resolve('b'));
  runtime.register('b', (rt) => rt.resolve('a'));
  assert.throws(() => runtime.resolve('a'));
  assert.throws(() => runtime.resolve('a')); // not stuck thinking "a" is still mid-resolution from the first attempt
});

test('a factory that throws is NOT cached as a "successful" resolution - a later resolve() retries it', () => {
  const runtime = new RuntimeContainer();
  let attempt = 0;
  runtime.register('flaky', () => {
    attempt++;
    if (attempt === 1) throw new Error('first attempt fails');
    return { ok: true, attempt };
  });

  assert.throws(() => runtime.resolve('flaky'), /first attempt fails/);
  assert.deepEqual(runtime.resolve('flaky'), { ok: true, attempt: 2 });
  assert.equal(runtime.resolve('flaky'), runtime.resolve('flaky')); // now genuinely cached
});

test('two independent RuntimeContainer instances never share registrations or instances', () => {
  const a = new RuntimeContainer();
  const b = new RuntimeContainer();
  a.register('thing', () => ({ from: 'a' }));
  assert.equal(b.has('thing'), false);
  b.register('thing', () => ({ from: 'b' }));
  assert.equal(a.resolve('thing').from, 'a');
  assert.equal(b.resolve('thing').from, 'b');
});
