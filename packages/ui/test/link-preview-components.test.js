import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, waitFor } from '../src/testing.js';

installDom();
const { QuLinkPreviewElement, _resetLinkPreviewCacheForTests } = await import('../src/link-preview-components.js');

function makeContainer() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function installFetchMock(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test.beforeEach(() => {
  _resetLinkPreviewCacheForTests();
});

test('fetches /link-preview?url=... for the given url attribute and renders a card', async () => {
  const mock = installFetchMock(() => jsonResponse({ url: 'https://example.com/a', title: 'A Title', description: 'A description', image: 'https://example.com/img.png', siteName: 'example.com' }));
  const container = makeContainer();
  try {
    const el = document.createElement('qu-link-preview');
    el.setAttribute('url', 'https://example.com/a');
    container.appendChild(el);

    await waitFor(() => el.hidden === false);
    assert.equal(mock.calls[0], `/link-preview?url=${encodeURIComponent('https://example.com/a')}`);
    assert.equal(el.querySelector('.qu-link-preview-title').textContent, 'A Title');
    assert.equal(el.querySelector('.qu-link-preview-description').textContent, 'A description');
    assert.equal(el.querySelector('.qu-link-preview-site').textContent, 'example.com');
    assert.equal(el.querySelector('.qu-link-preview-image').src, 'https://example.com/img.png');
    const card = el.querySelector('.qu-link-preview');
    assert.equal(card.href, 'https://example.com/a');
    assert.equal(card.target, '_blank');
    assert.equal(card.rel, 'noopener noreferrer');
  } finally {
    mock.restore();
  }
});

test('renders nothing (stays hidden, no child nodes) when the relay has no preview-worthy metadata', async () => {
  const mock = installFetchMock(() => jsonResponse({ url: 'https://example.com/x', title: null, description: null, image: null, siteName: null }));
  const container = makeContainer();
  try {
    const el = document.createElement('qu-link-preview');
    el.setAttribute('url', 'https://example.com/x');
    container.appendChild(el);

    await new Promise((resolve) => setTimeout(resolve, 10)); // let the microtask/fetch chain settle
    assert.equal(el.hidden, true);
    assert.equal(el.childNodes.length, 0);
  } finally {
    mock.restore();
  }
});

test('renders nothing when the fetch itself fails (network error, relay down, ...) - never throws', async () => {
  const mock = installFetchMock(() => { throw new Error('network down'); });
  const container = makeContainer();
  try {
    const el = document.createElement('qu-link-preview');
    el.setAttribute('url', 'https://example.com/unreachable');
    container.appendChild(el);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(el.hidden, true);
  } finally {
    mock.restore();
  }
});

test('renders nothing when the relay responds with a non-ok status (e.g. link previews disabled, 404)', async () => {
  const mock = installFetchMock(() => jsonResponse({ error: 'disabled' }, { ok: false, status: 404 }));
  const container = makeContainer();
  try {
    const el = document.createElement('qu-link-preview');
    el.setAttribute('url', 'https://example.com/x');
    container.appendChild(el);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(el.hidden, true);
  } finally {
    mock.restore();
  }
});

test('a card with no image renders the title/description without an <img>', async () => {
  const mock = installFetchMock(() => jsonResponse({ url: 'https://example.com/no-image', title: 'No Image Here', description: null, image: null, siteName: 'example.com' }));
  const container = makeContainer();
  try {
    const el = document.createElement('qu-link-preview');
    el.setAttribute('url', 'https://example.com/no-image');
    container.appendChild(el);

    await waitFor(() => el.hidden === false);
    assert.equal(el.querySelector('.qu-link-preview-image'), null);
    assert.equal(el.querySelector('.qu-link-preview-title').textContent, 'No Image Here');
  } finally {
    mock.restore();
  }
});

test('caches by url - two elements for the SAME url only trigger one fetch', async () => {
  const mock = installFetchMock(() => jsonResponse({ url: 'https://example.com/shared', title: 'Shared', description: null, image: null, siteName: 'example.com' }));
  const container = makeContainer();
  try {
    const el1 = document.createElement('qu-link-preview');
    el1.setAttribute('url', 'https://example.com/shared');
    const el2 = document.createElement('qu-link-preview');
    el2.setAttribute('url', 'https://example.com/shared');
    container.append(el1, el2);

    await waitFor(() => el1.hidden === false && el2.hidden === false);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test('no url attribute at all renders nothing and never fetches', async () => {
  const mock = installFetchMock(() => jsonResponse({}));
  const container = makeContainer();
  try {
    const el = document.createElement('qu-link-preview');
    container.appendChild(el);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(el.hidden, true);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('changing the url attribute re-mounts with the new url\'s preview', async () => {
  const mock = installFetchMock((url) => {
    if (url.includes('first')) return jsonResponse({ url: 'https://example.com/first', title: 'First', description: null, image: null, siteName: 'example.com' });
    return jsonResponse({ url: 'https://example.com/second', title: 'Second', description: null, image: null, siteName: 'example.com' });
  });
  const container = makeContainer();
  try {
    const el = document.createElement('qu-link-preview');
    el.setAttribute('url', 'https://example.com/first');
    container.appendChild(el);
    await waitFor(() => el.querySelector('.qu-link-preview-title')?.textContent === 'First');

    el.setAttribute('url', 'https://example.com/second');
    await waitFor(() => el.querySelector('.qu-link-preview-title')?.textContent === 'Second');
  } finally {
    mock.restore();
  }
});
