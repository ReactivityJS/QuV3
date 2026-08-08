import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, setLogLevel, getLogLevel } from '../src/index.js';

const MODULE_URL = new URL('../src/logger.js', import.meta.url).href;

/** Forces a fresh module evaluation (fresh `currentLevel` closure) - the only way to re-exercise resolveLevel()'s one-time-at-import-time logic. */
async function freshModule() {
  return import(`${MODULE_URL}?t=${Math.random()}`);
}

function captureConsole() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const originals = { debug: console.debug, log: console.log, warn: console.warn, error: console.error };
  console.debug = (...args) => calls.debug.push(args);
  console.log = (...args) => calls.info.push(args);
  console.warn = (...args) => calls.warn.push(args);
  console.error = (...args) => calls.error.push(args);
  return {
    calls,
    restore: () => Object.assign(console, originals),
  };
}

test('default level is info - debug is filtered, info/warn/error pass', () => {
  setLogLevel('info');
  const { calls, restore } = captureConsole();
  const log = createLogger('Test');
  try {
    log.debug('hidden');
    log.info('shown');
    log.warn('shown');
    log.error('shown');
  } finally {
    restore();
  }
  assert.equal(calls.debug.length, 0);
  assert.equal(calls.info.length, 1);
  assert.equal(calls.warn.length, 1);
  assert.equal(calls.error.length, 1);
});

test('every emitted line is prefixed with [scope]', () => {
  setLogLevel('info');
  const { calls, restore } = captureConsole();
  const log = createLogger('MyScope');
  try {
    log.info('hello', { extra: 1 });
  } finally {
    restore();
  }
  const [prefix, message, extra] = calls.info[0];
  assert.match(prefix, /\[MyScope\]$/);
  assert.equal(message, 'hello');
  assert.deepEqual(extra, { extra: 1 });
});

test('setLogLevel raises/lowers the threshold live for loggers created before AND after the call', () => {
  setLogLevel('error');
  const { calls, restore } = captureConsole();
  const log = createLogger('Test');
  try {
    log.warn('hidden at error level');
    setLogLevel('debug');
    log.debug('now visible');
    createLogger('Another').debug('also visible - a NEW logger sees the same live threshold');
  } finally {
    restore();
    setLogLevel('info');
  }
  assert.equal(calls.warn.length, 0);
  assert.equal(calls.debug.length, 2);
});

test('getLogLevel reflects the current threshold', () => {
  setLogLevel('warn');
  assert.equal(getLogLevel(), 'warn');
  setLogLevel('info');
  assert.equal(getLogLevel(), 'info');
});

test('setLogLevel throws on an unrecognized level, current level unchanged', () => {
  setLogLevel('info');
  assert.throws(() => setLogLevel('verbose'), /unknown level "verbose"/);
  assert.equal(getLogLevel(), 'info');
});

test('Node: QU_LOG_LEVEL env var sets the initial level at module load time', async () => {
  const previous = process.env.QU_LOG_LEVEL;
  process.env.QU_LOG_LEVEL = 'debug';
  try {
    const fresh = await freshModule();
    assert.equal(fresh.getLogLevel(), 'debug');
  } finally {
    if (previous === undefined) delete process.env.QU_LOG_LEVEL;
    else process.env.QU_LOG_LEVEL = previous;
  }
});

test('browser fallback: localStorage qu:logLevel sets the initial level when QU_LOG_LEVEL is unset', async () => {
  const previous = process.env.QU_LOG_LEVEL;
  delete process.env.QU_LOG_LEVEL;
  globalThis.localStorage = { getItem: (key) => (key === 'qu:logLevel' ? 'warn' : null) };
  try {
    const fresh = await freshModule();
    assert.equal(fresh.getLogLevel(), 'warn');
  } finally {
    delete globalThis.localStorage;
    if (previous !== undefined) process.env.QU_LOG_LEVEL = previous;
  }
});

test('a localStorage that throws on access (private mode) is tolerated - falls back to the default', async () => {
  const previous = process.env.QU_LOG_LEVEL;
  delete process.env.QU_LOG_LEVEL;
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); } };
  try {
    const fresh = await freshModule();
    assert.equal(fresh.getLogLevel(), 'info');
  } finally {
    delete globalThis.localStorage;
    if (previous !== undefined) process.env.QU_LOG_LEVEL = previous;
  }
});

test('Node output is timestamp-prefixed (ISO 8601)', () => {
  setLogLevel('info');
  const { calls, restore } = captureConsole();
  const log = createLogger('Test');
  try {
    log.info('x');
  } finally {
    restore();
    setLogLevel('info');
  }
  assert.match(calls.info[0][0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[Test\]$/);
});
