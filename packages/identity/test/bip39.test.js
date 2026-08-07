import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMnemonicPhrase, isValidMnemonic, mnemonicToSeedBytes } from '../src/bip39.js';

test('generateMnemonicPhrase() defaults to a 24-word (256-bit) mnemonic', () => {
  const mnemonic = generateMnemonicPhrase();
  assert.equal(mnemonic.split(' ').length, 24);
  assert.equal(isValidMnemonic(mnemonic), true);
});

test('generateMnemonicPhrase() produces the correct word count for every valid strength', () => {
  const expected = { 128: 12, 160: 15, 192: 18, 224: 21, 256: 24 };
  for (const [bits, words] of Object.entries(expected)) {
    const mnemonic = generateMnemonicPhrase(Number(bits));
    assert.equal(mnemonic.split(' ').length, words, `strength ${bits}`);
    assert.equal(isValidMnemonic(mnemonic), true, `strength ${bits}`);
  }
});

test('generateMnemonicPhrase() calls are independently random', () => {
  const a = generateMnemonicPhrase();
  const b = generateMnemonicPhrase();
  assert.notEqual(a, b);
});

test('isValidMnemonic() rejects a garbage string', () => {
  assert.equal(isValidMnemonic('not a real mnemonic at all'), false);
  assert.equal(isValidMnemonic(''), false);
});

test('isValidMnemonic() rejects a bad checksum - deterministic, not derived from a random mnemonic', () => {
  // The well-known all-zero-entropy 12-word test vector is
  // "...abandon about" (the last word carries the checksum bits) - swapping
  // in a different in-wordlist word breaks the checksum deterministically,
  // unlike mutating a randomly generated mnemonic (which has a small but
  // real chance of coincidentally still checksumming valid).
  const valid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const invalid = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
  assert.equal(isValidMnemonic(valid), true);
  assert.equal(isValidMnemonic(invalid), false);
});

test('mnemonicToSeedBytes() returns a 64-byte seed, deterministic for the same mnemonic+passphrase', async () => {
  const mnemonic = generateMnemonicPhrase();
  const a = await mnemonicToSeedBytes(mnemonic, 'pass');
  const b = await mnemonicToSeedBytes(mnemonic, 'pass');
  assert.equal(a.length, 64);
  assert.deepEqual(a, b);
});

test('mnemonicToSeedBytes() produces a DIFFERENT seed for a different passphrase (same mnemonic)', async () => {
  const mnemonic = generateMnemonicPhrase();
  const noPass = await mnemonicToSeedBytes(mnemonic);
  const withPass = await mnemonicToSeedBytes(mnemonic, 'secret');
  assert.notDeepEqual(noPass, withPass);
});
