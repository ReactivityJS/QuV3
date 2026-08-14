import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { createLogger } from '@qu/log';

const log = createLogger('LinkPreview');

/**
 * LINK PREVIEWS — server-side Open Graph unfurling for URLs typed into chat/
 * forum messages (title/description/image, ported UX request: a real
 * preview card, not just an auto-linked `<a>`). Deliberately RELAY-side, not
 * a direct client-side `fetch()` of the target site: a client fetching
 * arbitrary third-party URLs on every render of every message containing a
 * link would leak that viewer's IP address to every site anyone ever pasted
 * a link to, and would hit CORS on the majority of sites that don't send
 * permissive headers. Routing through this relay (see `http-router.js`'s
 * `/link-preview` route) fixes both at once - and the "cache result" step
 * below means the SAME url only gets fetched from the target site once per
 * TTL window, not once per viewer per render.
 *
 * SSRF is the whole ballgame here: `url` is caller-supplied (a viewer typed
 * it into their own chat message), so fetching it server-side without
 * validation would let anyone probe this relay's own internal network
 * (`http://169.254.169.254/...` cloud metadata endpoints, `http://localhost:
 * <internal-port>/...`, a private subnet's admin panels, ...) through the
 * relay as an open proxy. `#assertSafeUrl()` below is the actual guard:
 * scheme must be http(s), no embedded credentials, only the default ports,
 * and - the part a naive hostname-string check would miss entirely - the
 * hostname's OWN RESOLVED IP (not just its literal spelling) must not fall
 * in any private/loopback/link-local/reserved range. Re-validated on every
 * redirect hop too (a public hostname could still redirect somewhere
 * private), with `redirect: 'manual'` so nothing follows a redirect without
 * this module seeing and re-checking it first.
 */

const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 512 * 1024; // plenty for a page's <head> - this never needs the full document
const POSITIVE_TTL_MS = 60 * 60 * 1000; // 1 hour - a page's OG tags essentially never change minute to minute
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // a failure (dead link, blocked, timeout, ...) is retried much sooner
const CACHE_MAX_ENTRIES = 1000;

/** @type {Map<string, {data: object|null, expiresAt: number}>} Insertion-ordered - the oldest entry is always `cache.keys().next().value`, used for the simple size-cap eviction below. */
const cache = new Map();

/** Test-only: clears the module-level cache so tests don't leak state into each other. */
export function _resetLinkPreviewCache() {
  cache.clear();
}

/** @param {string} ip @returns {boolean} True for any IPv4 address that isn't globally-routable public unicast. */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // malformed - refuse rather than guess
  const [a, b, c] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224-239), reserved (240-255), broadcast (255.255.255.255)
  return false;
}

/** @param {string} ip @returns {boolean} True for any IPv6 address that isn't globally-routable public unicast. */
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped - check the EMBEDDED v4 address, not the v6 wrapper
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** @param {string} ip @returns {boolean} */
function isPrivateIP(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not a syntactically valid IP at all - refuse rather than guess
}

/**
 * Throws unless `urlStr` is safe to fetch server-side - see this file's own
 * top doc comment for what "safe" means here.
 * @param {string} urlStr
 * @param {(hostname: string) => Promise<Array<{address: string}>>} lookupImpl
 * @returns {Promise<URL>} The parsed, validated URL - callers should fetch
 *   THIS object (not re-parse `urlStr`), for the same reason a SQL query
 *   binds the already-checked value rather than re-deriving it.
 */
async function assertSafeUrl(urlStr, lookupImpl) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
  if (parsed.username || parsed.password) throw new Error('credentials in URL are not allowed');
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new Error('unsupported port');

  let addresses;
  try {
    addresses = await lookupImpl(parsed.hostname, { all: true });
  } catch {
    throw new Error('DNS resolution failed');
  }
  if (!addresses || addresses.length === 0) throw new Error('DNS resolution failed');
  // ALL resolved addresses are checked, not just the first - a hostname
  // resolving to both a public and a private address (deliberately, to
  // rebind past a check that only looked at one) must still be refused.
  for (const { address } of addresses) {
    if (isPrivateIP(address)) throw new Error(`refusing to fetch a private/internal address (${address})`);
  }
  return parsed;
}

/**
 * Reads at most `maxBytes` of `response.body`, then cancels the stream -
 * never buffers a whole (potentially huge, or intentionally slow-trickling)
 * response just to read its `<head>`.
 * @param {Response} response @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readLimitedBody(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8', 0, maxBytes);
}

/** @param {string} str @returns {string} */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&apos;/g, '\'')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * A hand-rolled `<meta>`/`<title>` tag reader, not a real HTML parser - this
 * repo has no HTML-parsing dependency anywhere (see `@qu/push`'s own "no
 * dependencies beyond node:crypto and fetch" precedent) and Open Graph tags
 * only ever need a handful of well-known `<meta>` attributes out of a page's
 * `<head>`, never a full DOM. Deliberately tolerant of attribute order
 * (`property`/`content` can appear in either order - real-world pages are
 * inconsistent about this) but NOT of malformed/adversarial HTML beyond
 * that - this only ever reads out of a bounded `MAX_BODY_BYTES` prefix
 * fetched from a URL the caller already ran through `assertSafeUrl()`.
 * @param {string} property e.g. 'og:title'
 * @param {string} html
 * @returns {string|null}
 */
function extractMetaContent(property, html) {
  const propFirst = new RegExp(`<meta[^>]*?(?:property|name)=["']${property}["'][^>]*?content=["']([^"']*)["'][^>]*?>`, 'i');
  const contentFirst = new RegExp(`<meta[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']${property}["'][^>]*?>`, 'i');
  const match = html.match(propFirst) ?? html.match(contentFirst);
  return match ? decodeHtmlEntities(match[1]).trim() || null : null;
}

/** @param {string} html @returns {string|null} */
function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? decodeHtmlEntities(match[1]).trim() || null : null;
}

/**
 * @param {string} html @param {URL} pageUrl - The fetched (post-redirect) URL, used as the base for a relative `og:image`.
 * @returns {{url: string, title: string|null, description: string|null, image: string|null, siteName: string}|null}
 *   `null` when the page has NOTHING preview-worthy (no title, no
 *   description, no image) - rendering an empty card would be worse than no
 *   card at all.
 */
function parsePreviewMetadata(html, pageUrl) {
  const title = extractMetaContent('og:title', html) ?? extractTitleTag(html);
  const description = extractMetaContent('og:description', html) ?? extractMetaContent('description', html);
  let image = extractMetaContent('og:image', html);
  if (image) {
    try {
      image = new URL(image, pageUrl).toString();
    } catch {
      image = null; // a malformed og:image value - drop it, don't fail the whole preview over it
    }
  }
  const siteName = extractMetaContent('og:site_name', html) ?? pageUrl.hostname;
  if (!title && !description && !image) return null;
  return { url: pageUrl.toString(), title, description, image, siteName };
}

/**
 * Fetches and parses Open Graph-style preview metadata for `urlStr`. Throws
 * on any safety/network/parse failure - callers that want a "just tell me
 * null on failure" shape should use `getLinkPreview()` below instead, which
 * wraps this with exactly that plus caching.
 * @param {string} urlStr
 * @param {{fetchImpl?: typeof fetch, lookupImpl?: typeof lookup}} [options] - Injectable for tests; both default to the real global/node:dns implementations.
 * @returns {Promise<{url: string, title: string|null, description: string|null, image: string|null, siteName: string}|null>}
 */
export async function fetchLinkPreview(urlStr, { fetchImpl = fetch, lookupImpl = lookup } = {}) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safeUrl = await assertSafeUrl(current, lookupImpl);
    const res = await fetchImpl(safeUrl, {
      redirect: 'manual', // see this file's own top doc comment - a redirect target gets the SAME safety check, never followed blindly
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'QuLinkPreviewBot/1.0 (+https://github.com/ReactivityJS/QuV3)' },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('redirect response with no Location header');
      current = new URL(location, safeUrl).toString();
      continue;
    }
    if (!res.ok) throw new Error(`upstream responded ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) throw new Error(`unsupported content-type: ${contentType || '(none)'}`);
    const html = await readLimitedBody(res, MAX_BODY_BYTES);
    return parsePreviewMetadata(html, safeUrl);
  }
  throw new Error('too many redirects');
}

/**
 * `fetchLinkPreview()` plus an in-memory, TTL'd cache keyed by the exact
 * input `urlStr` - the thing `/link-preview` (see `http-router.js`) actually
 * calls. Caches FAILURES too (at a shorter TTL) - without that, a single
 * dead/slow/blocked link posted into a busy room would otherwise be
 * re-fetched by this relay on every single render of that message by every
 * viewer, for as long as the message exists.
 * @param {string} urlStr
 * @param {{fetchImpl?: typeof fetch, lookupImpl?: typeof lookup}} [options]
 * @returns {Promise<object|null>} `null` on any failure or "nothing preview-worthy" result - never throws.
 */
export async function getLinkPreview(urlStr, options) {
  const now = Date.now();
  const cached = cache.get(urlStr);
  if (cached && cached.expiresAt > now) return cached.data;

  let data;
  try {
    data = await fetchLinkPreview(urlStr, options);
  } catch (err) {
    log.info(`preview fetch failed for ${urlStr}: ${err.message}`);
    data = null;
  }

  if (!cache.has(urlStr) && cache.size >= CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value); // evict the oldest entry - Map preserves insertion order
  }
  cache.set(urlStr, { data, expiresAt: now + (data ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return data;
}
