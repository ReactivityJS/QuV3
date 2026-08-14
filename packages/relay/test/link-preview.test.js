import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLinkPreview, getLinkPreview, _resetLinkPreviewCache } from '../src/link-preview.js';

const PUBLIC_IP = '93.184.216.34'; // a real, public, unrouted-to-by-this-test IP (example.com's, historically) - only ever used as a fake DNS answer below, never actually contacted
function publicLookup() {
  return async () => [{ address: PUBLIC_IP, family: 4 }];
}
function fakeHtmlResponse(html, { status = 200, contentType = 'text/html', headers = {} } = {}) {
  return async () => new Response(html, { status, headers: { 'content-type': contentType, ...headers } });
}

test('extracts og:title/og:description/og:image, resolving a relative og:image against the page URL', async () => {
  const html = `<html><head>
    <meta property="og:title" content="A Great Article">
    <meta property="og:description" content="It is about things.">
    <meta property="og:image" content="/images/hero.png">
  </head></html>`;
  const result = await fetchLinkPreview('https://example.com/article', {
    lookupImpl: publicLookup(),
    fetchImpl: fakeHtmlResponse(html),
  });
  assert.deepEqual(result, {
    url: 'https://example.com/article',
    title: 'A Great Article',
    description: 'It is about things.',
    image: 'https://example.com/images/hero.png',
    siteName: 'example.com',
  });
});

test('falls back to <title> and og:site_name when og:title/og:description are absent', async () => {
  const html = '<html><head><title>Plain Old Title</title><meta property="og:site_name" content="Example Site"></head></html>';
  const result = await fetchLinkPreview('https://example.com/plain', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse(html) });
  assert.equal(result.title, 'Plain Old Title');
  assert.equal(result.description, null);
  assert.equal(result.siteName, 'Example Site');
});

test('falls back to the plain <meta name="description"> when og:description is absent', async () => {
  const html = '<html><head><title>T</title><meta name="description" content="the plain kind"></head></html>';
  const result = await fetchLinkPreview('https://example.com/x', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse(html) });
  assert.equal(result.description, 'the plain kind');
});

test('tolerates content= appearing BEFORE property= in the tag (real-world pages are inconsistent about attribute order)', async () => {
  const html = '<html><head><meta content="Content-First Title" property="og:title"></head></html>';
  const result = await fetchLinkPreview('https://example.com/x', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse(html) });
  assert.equal(result.title, 'Content-First Title');
});

test('decodes HTML entities in extracted text', async () => {
  const html = '<html><head><meta property="og:title" content="Fish &amp; Chips &mdash; &#39;Tasty&#39;"></head></html>';
  const result = await fetchLinkPreview('https://example.com/x', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse(html) });
  assert.equal(result.title, 'Fish & Chips &mdash; \'Tasty\'');
});

test('a page with no title, description, or image resolves to null - never an empty card', async () => {
  const html = '<html><head></head><body>nothing here</body></html>';
  const result = await fetchLinkPreview('https://example.com/empty', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse(html) });
  assert.equal(result, null);
});

test('rejects a non-http(s) scheme before ever attempting to fetch', async () => {
  let fetchCalled = false;
  await assert.rejects(
    fetchLinkPreview('file:///etc/passwd', { lookupImpl: publicLookup(), fetchImpl: async () => { fetchCalled = true; return new Response(''); } }),
    /unsupported protocol/
  );
  assert.equal(fetchCalled, false);
});

test('rejects a URL with embedded credentials', async () => {
  await assert.rejects(fetchLinkPreview('https://user:pass@example.com/', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse('<html></html>') }), /credentials/);
});

test('rejects a non-default port', async () => {
  await assert.rejects(fetchLinkPreview('https://example.com:8443/', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse('<html></html>') }), /unsupported port/);
});

for (const [label, ip] of [
  ['loopback', '127.0.0.1'],
  ['a cloud metadata endpoint address', '169.254.169.254'],
  ['RFC1918 10.x', '10.0.0.5'],
  ['RFC1918 172.16.x', '172.16.5.5'],
  ['RFC1918 192.168.x', '192.168.1.1'],
  ['CGNAT', '100.64.0.1'],
  ['multicast', '224.0.0.1'],
]) {
  test(`SSRF guard: refuses to fetch a hostname that resolves to ${label} (${ip})`, async () => {
    let fetchCalled = false;
    await assert.rejects(
      fetchLinkPreview('https://internal.example/', {
        lookupImpl: async () => [{ address: ip, family: 4 }],
        fetchImpl: async () => { fetchCalled = true; return new Response(''); },
      }),
      /private\/internal address/
    );
    assert.equal(fetchCalled, false);
  });
}

test('SSRF guard: refuses an IPv6 loopback/link-local/unique-local resolution', async () => {
  for (const ip of ['::1', 'fe80::1', 'fd00::1']) {
    await assert.rejects(
      fetchLinkPreview('https://internal.example/', { lookupImpl: async () => [{ address: ip, family: 6 }], fetchImpl: async () => new Response('') }),
      /private\/internal address/,
      `expected ${ip} to be refused`
    );
  }
});

test('SSRF guard: refuses when EVEN ONE of several resolved addresses is private (DNS-rebinding-style multi-answer)', async () => {
  await assert.rejects(
    fetchLinkPreview('https://internal.example/', {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
      fetchImpl: async () => new Response(''),
    }),
    /private\/internal address/
  );
});

test('SSRF guard: a redirect target is re-validated - a public hostname redirecting to a private address is refused', async () => {
  let calls = 0;
  const lookupImpl = async (hostname) => {
    if (hostname === 'public.example') return [{ address: PUBLIC_IP, family: 4 }];
    return [{ address: '127.0.0.1', family: 4 }]; // the redirect's own hostname resolves privately
  };
  const fetchImpl = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://internal.example/secret' } });
  };
  await assert.rejects(fetchLinkPreview('https://public.example/', { lookupImpl, fetchImpl }), /private\/internal address/);
  assert.equal(calls, 1); // never actually fetched the redirect target
});

test('follows a same-safety redirect chain up to the cap and returns the final page\'s metadata', async () => {
  let hop = 0;
  const fetchImpl = async () => {
    hop++;
    if (hop <= 2) return new Response(null, { status: 302, headers: { location: `https://example.com/hop${hop}` } });
    return new Response('<html><head><title>Final</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const result = await fetchLinkPreview('https://example.com/start', { lookupImpl: publicLookup(), fetchImpl });
  assert.equal(result.title, 'Final');
});

test('gives up after too many redirects', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } });
  await assert.rejects(fetchLinkPreview('https://example.com/start', { lookupImpl: publicLookup(), fetchImpl }), /too many redirects/);
});

test('rejects a non-HTML content-type', async () => {
  await assert.rejects(
    fetchLinkPreview('https://example.com/file.pdf', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse('%PDF-1.4', { contentType: 'application/pdf' }) }),
    /unsupported content-type/
  );
});

test('rejects a non-2xx upstream response', async () => {
  await assert.rejects(
    fetchLinkPreview('https://example.com/missing', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse('not found', { status: 404 }) }),
    /upstream responded 404/
  );
});

test('caps how much of the body is read - a huge page does not hang or exhaust memory', async () => {
  // A title placed well past a small cap to prove it's genuinely truncated, not just slow.
  const huge = `<html><head>${'x'.repeat(2_000_000)}<title>Should Never Be Seen</title></head></html>`;
  const result = await fetchLinkPreview('https://example.com/huge', { lookupImpl: publicLookup(), fetchImpl: fakeHtmlResponse(huge) });
  assert.equal(result, null); // truncated before ever reaching the real <title>, and nothing else in the (truncated) head is preview-worthy
});

test('getLinkPreview() caches a successful result - a second call for the same URL does not re-fetch', async (t) => {
  t.after(() => _resetLinkPreviewCache());
  _resetLinkPreviewCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('<html><head><title>Cached</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }); };
  const first = await getLinkPreview('https://example.com/cache-me', { lookupImpl: publicLookup(), fetchImpl });
  const second = await getLinkPreview('https://example.com/cache-me', { lookupImpl: publicLookup(), fetchImpl });
  assert.equal(first.title, 'Cached');
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test('getLinkPreview() also caches a FAILURE (never throws) - a second call for a dead link does not re-fetch either', async (t) => {
  t.after(() => _resetLinkPreviewCache());
  _resetLinkPreviewCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('nope', { status: 500 }); };
  const first = await getLinkPreview('https://example.com/dead', { lookupImpl: publicLookup(), fetchImpl });
  const second = await getLinkPreview('https://example.com/dead', { lookupImpl: publicLookup(), fetchImpl });
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls, 1);
});

test('getLinkPreview() never throws even for a URL fetchLinkPreview() itself would reject on', async (t) => {
  t.after(() => _resetLinkPreviewCache());
  _resetLinkPreviewCache();
  const result = await getLinkPreview('not-a-url-at-all', { lookupImpl: publicLookup(), fetchImpl: async () => new Response('') });
  assert.equal(result, null);
});
