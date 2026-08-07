import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryStoreAdapter, QuCrypto } from '@qu/core';
import { AccessEngine } from '@qu/engines';
import { QuIdentityEngine } from '@qu/identity';
import { AccessService } from '../src/access-service.js';

async function freshSetup() {
  const qu = new QuStore();
  qu.mount('store', new MemoryStoreAdapter());
  new AccessEngine(qu);
  const identity = new QuIdentityEngine(qu);
  await identity.importMnemonic(identity.generateMnemonic());
  return { qu, identity, access: new AccessService(qu, identity) };
}

test('getAcl() of an unprotected resource returns null', async () => {
  const { access } = await freshSetup();
  assert.equal(await access.getAcl('space', 'docs', 'never-protected'), null);
});

test('protect() with an explicit writers array auto-adds the caller (includeSelfAsWriter defaults true)', async () => {
  const { access, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  const acl = await access.protect('space', 'docs', 'd1', { writers: ['someone-else'] });
  assert.deepEqual([...acl.writers].sort(), [myPub, 'someone-else'].sort());
});

test('protect(..., { includeSelfAsWriter: false }) does NOT auto-add the caller', async () => {
  const { access } = await freshSetup();
  const acl = await access.protect('space', 'docs', 'd1', { writers: ['someone-else'] }, { includeSelfAsWriter: false });
  assert.deepEqual(acl.writers, ['someone-else']);
});

test('unprotect() reopens a resource back to fully public', async () => {
  const { access } = await freshSetup();
  // includeSelfAsWriter defaults true here - AccessEngine only allows an
  // ALREADY-listed writer to change a resource's ACL again (see
  // access-engine.js), so the caller must be a writer of its own creation
  // to be able to unprotect() it later, same as any real caller would need.
  await access.protect('space', 'docs', 'd1', { writers: ['only-me'] });
  const reopened = await access.unprotect('space', 'docs', 'd1');
  assert.deepEqual(reopened, { writers: '*', readers: '*' });
});

test('addWriter()/removeWriter() grow/shrink the writer list', async () => {
  const { access, identity } = await freshSetup();
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await access.protect('space', 'docs', 'd1', { writers: ['a'] }); // includeSelfAsWriter:true - needed to be able to call addWriter()/removeWriter() again below
  const grown = await access.addWriter('space', 'docs', 'd1', 'b');
  assert.deepEqual([...grown.writers].sort(), ['a', 'b', myPub].sort());
  const shrunk = await access.removeWriter('space', 'docs', 'd1', 'a');
  assert.deepEqual([...shrunk.writers].sort(), ['b', myPub].sort());
});

test('addWriter() on an unprotected resource throws - call protect() first', async () => {
  const { access } = await freshSetup();
  await assert.rejects(() => access.addWriter('space', 'docs', 'never-protected', 'a'));
});

test('addReader()/removeReader() grow/shrink the reader list', async () => {
  const { access } = await freshSetup();
  await access.protect('space', 'docs', 'd1', { readers: ['a'] }, { includeSelfAsWriter: false });
  const grown = await access.addReader('space', 'docs', 'd1', 'b');
  assert.deepEqual([...grown.readers].sort(), ['a', 'b']);
  const shrunk = await access.removeReader('space', 'docs', 'd1', 'a');
  assert.deepEqual(shrunk.readers, ['b']);
});

test('AccessEngine actually enforces what protect() writes - a non-writer\'s put() is rejected', async () => {
  const { qu, access } = await freshSetup();
  await access.protect('space', 'docs', 'd1', { writers: ['only-this-one'] }, { includeSelfAsWriter: false });

  const outsiderKp = await QuCrypto.generateKeypair();
  await assert.rejects(() => qu.put('/store/space/docs/d1', { title: 'hacked' }, {
    signWith: outsiderKp.privateKeyPkcs8,
    writerPub: outsiderKp.publicKey,
  }));
});

test('writeOptionsFor() returns plain signing options for an open ("*") resource - no encryption', async () => {
  const { access } = await freshSetup();
  const options = await access.writeOptionsFor('space', 'docs', 'never-protected');
  assert.ok(options.signWith);
  assert.equal(options.encryptWith, undefined);
});

test('writeOptionsFor() returns encryptWith for a resource with restricted readers', async () => {
  const { access, identity } = await freshSetup();
  await identity.publishMainProfile({ name: 'me' }); // own X key must be resolvable as a reader of our own resource
  const myPub = QuCrypto.toBase64Url((await identity.getMainKey()).publicKey);
  await access.protect('space', 'docs', 'd1', { readers: [myPub] });

  const options = await access.writeOptionsFor('space', 'docs', 'd1');
  assert.ok(Array.isArray(options.encryptWith) && options.encryptWith.length === 1);
  assert.ok(options.senderXPrivateKey);
});

test('writeOptionsFor() fails closed if a restricted reader has no resolvable profile', async () => {
  const { access } = await freshSetup();
  await access.protect('space', 'docs', 'd1', { readers: ['nobody-ever-published'] });
  await assert.rejects(() => access.writeOptionsFor('space', 'docs', 'd1'), /resolveReaderXKeys/);
});
