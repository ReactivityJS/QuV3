import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore } from '../src/store.js';
import { QuCrypto } from '../src/crypto.js';
import { MemoryStoreAdapter } from '../src/adapters/memory.js';

function storeWithMemoryAdapter() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  return qu;
}

test('put()/get() round-trip a plain value', async () => {
  const qu = storeWithMemoryAdapter();
  await qu.put('/store/hello', { greeting: 'world' });
  const quBit = await qu.get('/store/hello');
  assert.deepEqual(quBit.val, { greeting: 'world' });
  assert.equal(quBit.path, '/store/hello');
  assert.equal(quBit.pub, null);
  assert.equal(quBit.sig, null);
});

test('get() of a never-written path returns null', async () => {
  const qu = storeWithMemoryAdapter();
  assert.equal(await qu.get('/store/nothing-here'), null);
});

test('put() signs and verifiably attributes a QuBit when signWith/writerPub are given', async () => {
  const qu = storeWithMemoryAdapter();
  const kp = await QuCrypto.generateKeypair();

  const quBit = await qu.put('/store/signed', { x: 1 }, { signWith: kp.privateKey, writerPub: kp.publicKey });

  assert.equal(quBit.pub, QuCrypto.toBase64(kp.publicKey));
  assert.ok(quBit.sig);
  const payload = new TextEncoder().encode(JSON.stringify({ path: quBit.path, val: quBit.val, ts: quBit.ts, pub: quBit.pub }));
  const verified = await QuCrypto.verify(payload, QuCrypto.fromBase64(quBit.sig), kp.publicKey);
  assert.equal(verified, true);
});

test('put() throws if signWith is given without writerPub', async () => {
  const qu = storeWithMemoryAdapter();
  const kp = await QuCrypto.generateKeypair();
  await assert.rejects(() => qu.put('/store/x', 1, { signWith: kp.privateKey }), /writerPub is required/);
});

test('put() encrypts val for the given recipient(s) when encryptWith is set', async () => {
  const qu = storeWithMemoryAdapter();
  const sender = await QuCrypto.generateKeypair();
  const recipient = await QuCrypto.generateKeypair();

  const quBit = await qu.put(
    '/store/secret',
    { message: 'hi' },
    { encryptWith: recipient.xPublicKey, senderXPrivateKey: sender.xPrivateKey }
  );

  // val must no longer be the plaintext - it's now an envelope.
  assert.ok(quBit.val.iv && quBit.val.ct && Array.isArray(quBit.val.to));
  const decrypted = await QuCrypto.decrypt(
    QuCrypto.fromBase64(quBit.val.iv),
    QuCrypto.fromBase64(quBit.val.ct),
    QuCrypto.fromBase64(quBit.val.to[0].key),
    sender.xPublicKey,
    recipient.xPrivateKey
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(decrypted)), { message: 'hi' });
});

test('registerEngine() TRANSFORM runs only for matching segments, and can rewrite the value', async () => {
  const qu = storeWithMemoryAdapter();
  const calls = [];
  qu.registerEngine({
    segment: 'docs',
    put: (ctx) => {
      calls.push(ctx.path);
      return { value: { ...ctx.val, touchedByEngine: true } };
    },
  });

  await qu.put('/store/docs/1', { title: 'a' });
  await qu.put('/store/other/1', { title: 'b' }); // does not contain "docs" segment - engine must not run

  assert.deepEqual(calls, ['/store/docs/1']);
  const docQuBit = await qu.get('/store/docs/1');
  const otherQuBit = await qu.get('/store/other/1');
  assert.equal(docQuBit.val.touchedByEngine, true);
  assert.equal(otherQuBit.val.touchedByEngine, undefined);
});

test('a `handled: true` engine outcome skips SEAL/PERSIST and returns its own result', async () => {
  const qu = storeWithMemoryAdapter();
  const customResult = { path: '/store/asset/1', val: 'engine-persisted-this-itself', ts: 123, pub: null, sig: null };
  qu.registerEngine({
    segment: 'asset',
    put: () => ({ handled: true, result: customResult }),
  });

  const result = await qu.put('/store/asset/1', 'ignored-by-engine');
  assert.equal(result, customResult);
  // The default adapter path was never used - nothing was actually stored under that path via the normal pipeline.
  assert.equal(await qu.get('/store/asset/1'), null);
});

test('a `handled: true` engine outcome notifies with the RESULT\'s own path, not the outer put() path', async () => {
  const qu = storeWithMemoryAdapter();
  const customResult = { path: '/store/asset/1/meta', val: 'engine-persisted-this-itself', ts: 123, pub: null, sig: null };
  qu.registerEngine({
    segment: 'asset',
    put: () => ({ handled: true, result: customResult }),
  });
  const notifications = [];
  qu.onStorageChange((payload) => notifications.push(payload));

  await qu.put('/store/asset/1', 'ignored-by-engine');

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].path, customResult.path);
  assert.equal(notifications[0].quBit, customResult);
});

test('engines run in `order` (lower first) among matches for the same path', async () => {
  const qu = storeWithMemoryAdapter();
  const calls = [];
  // Engine put() handlers must return undefined/a PutOutcome, never a bare
  // truthy primitive - `calls.push(...)` returns the new array length, which
  // would otherwise be misread as a (malformed) outcome. Block bodies here
  // keep these as plain `undefined`-returning side effects.
  qu.registerEngine({ segment: 'x', order: 10, put: () => { calls.push('second'); } });
  qu.registerEngine({ segment: 'x', order: 0, put: () => { calls.push('first'); } });
  qu.registerEngine({ segment: null, order: -5, put: () => { calls.push('global-runs-too'); } });

  await qu.put('/store/x/1', {});
  assert.deepEqual(calls, ['global-runs-too', 'first', 'second']);
});

test('registerEngine() returns an unregister function that stops future invocations', async () => {
  const qu = storeWithMemoryAdapter();
  let count = 0;
  const unregister = qu.registerEngine({ segment: 'x', put: () => { count++; } });

  await qu.put('/store/x/1', {});
  unregister();
  await qu.put('/store/x/2', {});

  assert.equal(count, 1);
});

test('putSealed() bypasses TRANSFORM/SEAL and stores the QuBit exactly as given', async () => {
  const qu = storeWithMemoryAdapter();
  let transformRan = false;
  qu.registerEngine({ segment: 'x', put: () => { transformRan = true; } });

  const alreadySealed = { path: '/store/x/1', val: 'from-a-peer', ts: 999, pub: 'somePub', sig: 'someSig' };
  await qu.putSealed('/store/x/1', alreadySealed);

  assert.equal(transformRan, false);
  const stored = await qu.get('/store/x/1');
  assert.deepEqual(stored, alreadySealed);
});

test('putSealed() fires storage:put with origin:"sync", a normal put() does not set origin', async () => {
  const qu = storeWithMemoryAdapter();
  const notifications = [];
  qu.onStorageChange((payload) => notifications.push(payload));

  await qu.put('/store/local', 1);
  await qu.putSealed('/store/remote', { path: '/store/remote', val: 2, ts: 1, pub: null, sig: null });

  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].origin, undefined);
  assert.equal(notifications[1].origin, 'sync');
});

test('a throwing storage:put listener never breaks the write that triggered it', async () => {
  const qu = storeWithMemoryAdapter();
  qu.onStorageChange(() => {
    throw new Error('listener exploded');
  });
  // Must not reject - QuEvents.emit() isolates listener errors.
  await qu.put('/store/still-works', 1);
  assert.deepEqual((await qu.get('/store/still-works')).val, 1);
});

test('getAllUnderMount() returns every QuBit under a prefix, unsorted, arbitrary depth', async () => {
  const qu = storeWithMemoryAdapter();
  await qu.put('/store/space/a', 1);
  await qu.put('/store/space/nested/b', 2);
  await qu.put('/store/other/c', 3);

  const entries = await qu.getAllUnderMount('/store/space');
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ['/store/space/a', '/store/space/nested/b']);
});

test('getChildren() returns ONLY direct children, never deeper descendants', async () => {
  const qu = storeWithMemoryAdapter();
  await qu.put('/store/thread/msgs/m1', { body: 'one' });
  await qu.put('/store/thread/msgs/m2', { body: 'two' });
  await qu.put('/store/thread/msgs/m2/reactions/like', { body: 'deep' }); // one level deeper - must be excluded

  const children = await qu.getChildren('/store/thread/msgs');
  const paths = children.map((c) => c.path).sort();
  assert.deepEqual(paths, ['/store/thread/msgs/m1', '/store/thread/msgs/m2']);
});

test('getChildren() orders by ts (desc by default), tie-broken deterministically by path', async () => {
  const qu = storeWithMemoryAdapter();
  // Same adapter instance, so we can hand-craft ts to force a real tie.
  const adapter = qu.resolveMount('/store/x').adapter;
  await adapter.put('/x/b', { path: '/store/x/b', val: 1, ts: 100, pub: null, sig: null });
  await adapter.put('/x/a', { path: '/store/x/a', val: 2, ts: 100, pub: null, sig: null }); // same ts as /x/b
  await adapter.put('/x/c', { path: '/store/x/c', val: 3, ts: 200, pub: null, sig: null });

  const desc = await qu.getChildren('/store/x', { order: 'desc' });
  // ts 200 first; then the ts=100 tie broken by rel descending ('/x/b' > '/x/a').
  assert.deepEqual(desc.map((e) => e.path), ['/store/x/c', '/store/x/b', '/store/x/a']);

  const asc = await qu.getChildren('/store/x', { order: 'asc' });
  assert.deepEqual(asc.map((e) => e.path), ['/store/x/a', '/store/x/b', '/store/x/c']);
});

test('getChildren() limit+cursor pagination yields exact, non-overlapping, gap-free pages', async () => {
  const qu = storeWithMemoryAdapter();
  const adapter = qu.resolveMount('/store/x').adapter;
  for (let i = 0; i < 5; i++) {
    await adapter.put(`/x/m${i}`, { path: `/store/x/m${i}`, val: i, ts: i, pub: null, sig: null });
  }

  const page1 = await qu.getChildren('/store/x', { order: 'asc', limit: 2 });
  assert.equal(page1.length, 2);
  assert.deepEqual(page1.map((e) => e.quBit.val), [0, 1]);

  const page2 = await qu.getChildren('/store/x', { order: 'asc', limit: 2, cursor: page1[1].cursor });
  assert.deepEqual(page2.map((e) => e.quBit.val), [2, 3]);

  const page3 = await qu.getChildren('/store/x', { order: 'asc', limit: 2, cursor: page2[1].cursor });
  assert.deepEqual(page3.map((e) => e.quBit.val), [4]);

  const all = [...page1, ...page2, ...page3];
  assert.equal(new Set(all.map((e) => e.path)).size, 5); // no duplicates
});

test('getChildren() throws for a mount whose adapter has no getChildren()', async () => {
  const qu = new QuStore();
  qu.mount('store', { put: async () => {}, get: async () => null }); // adapter without getChildren
  await assert.rejects(() => qu.getChildren('/store/x'), /has no getChildren/);
});

test('put()/getChildren() bypasses the Engine TRANSFORM step - raw QuBits come back', async () => {
  const qu = storeWithMemoryAdapter();
  qu.registerEngine({ segment: 'msgs', get: () => 'transformed' });
  await qu.put('/store/thread/msgs/m1', { body: 'hi' });

  // Direct get() DOES run TRANSFORM...
  assert.equal(await qu.get('/store/thread/msgs/m1'), 'transformed');
  // ...but getChildren() does not - callers get the raw QuBit back.
  const children = await qu.getChildren('/store/thread/msgs');
  assert.deepEqual(children[0].quBit.val, { body: 'hi' });
});
