import { QuCrypto } from '@qu/core';
import { createLogger } from '@qu/log';

import { getSettings } from './relay-settings.js';
import { buildAppsCatalog } from './apps-catalog.js';
import { serveApps } from './static-apps.js';
import { serveShell } from './static-shell.js';
import { getLinkPreview } from './link-preview.js';

const log = createLogger('HttpRouter');

/**
 * HTTP ROUTER — the relay's PUBLIC HTTP surface (liveness, public config,
 * VAPID public key, the apps catalog + static app/shell serving) plus
 * dispatch into `AdminHttp`'s privileged routes. Split out of the relay's
 * own composition root for the same one-cross-cutting-concern-per-file
 * reason `admin-http.js`'s own doc comment states
 * (docs/v3-technical-concept.md §2.1).
 */
export class HttpRouter {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('./admin-http.js').AdminHttp} adminHttp
   * @param {import('@qu/loader').QuLoader} loader - Source of truth for
   *   `/apps.json` (see `apps-catalog.js`'s `buildAppsCatalog()`) - read
   *   fresh on every request via `loader.listManifests()`, so apps loaded
   *   partway through `boot()` (see `relay.js`) show up the moment they're
   *   actually loaded, not just after `boot()` fully completes.
   * @param {{adminPubs: string[], appsDir: string, serveShell: boolean, shellDir: string, state: {transport: object|null, vapidKeys: {publicKey: string}|null, federationManager?: import('./federation-manager.js').FederationManager|null}, iceServers?: Array<object>, getLinkPreviewImpl?: typeof getLinkPreview}} options -
   *   `state` is a mutable, shared reference the caller keeps populating as
   *   the relay boots (`transport`/`vapidKeys` aren't known until partway
   *   through `boot()` - see `relay.js`) - read fresh on every request
   *   rather than captured once at construction time, so a request that
   *   happens to land before boot fully completes sees `null`
   *   (`/healthz`'s own `peerId` field, `/push/vapid-public-key`'s
   *   `publicKey` field) instead of a stale/undefined value.
   */
  constructor(qu, adminHttp, loader, { adminPubs, appsDir, serveShell: serveShellOption, shellDir, state, iceServers = [], getLinkPreviewImpl = getLinkPreview }) {
    this.qu = qu;
    this.adminHttp = adminHttp;
    this.loader = loader;
    this.adminPubs = adminPubs;
    this.appsDir = appsDir;
    this.serveShellOption = serveShellOption;
    this.shellDir = shellDir;
    this.state = state;
    this.iceServers = iceServers;
    // Injectable (see link-preview.test.js style DI) so this route's own
    // tests don't have to make REAL outbound network requests - defaults to
    // the real, caching, SSRF-guarded implementation in link-preview.js.
    this.getLinkPreview = getLinkPreviewImpl;
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async handle(req, res) {
    try {
      // Cheap, dependency-free liveness probe - checked before anything
      // else touches disk. Meant for container orchestrators/reverse
      // proxies (Docker HEALTHCHECK, Traefik, k8s probes, ...) to tell
      // "container up, relay answering" apart from "upstream unreachable",
      // which is what those layers usually report to clients as a
      // 502/503 - if this route itself times out or refuses to connect,
      // the problem is in front of the relay, not in it.
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', peerId: this.state.transport?.getPeerId() ?? null }));
        return;
      }

      // The self-generating menu's data source, once a shell exists to read
      // it (see apps-catalog.js's own doc comment) - every loaded app with a
      // `clientMain`, filtered/annotated by this relay's current
      // `disabledApps` setting.
      if (req.url === '/apps.json') {
        const settings = await getSettings(this.qu);
        const body = JSON.stringify(buildAppsCatalog(this.loader, settings.disabledApps, settings.hiddenFromAppList));
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(body);
        return;
      }

      // Public, non-secret config a client needs before it knows anything
      // else: which actor pubkeys are relay admins, so a UI can show (or
      // hide) an admin nav entry for the connected identity, this relay's
      // current admin-configurable settings, `relayPub` - this relay's
      // own signing identity, what `apps/app-list` checks each
      // `/store/apps/catalog/<name>` entry's signer against before trusting
      // it (see `apps-catalog-store.js`'s own doc comment: no AccessEngine
      // ACL guards that path, the reader verifies the signer instead, same
      // as every other derived list in this codebase), and `iceServers` -
      // this operator's own `RTCIceServer[]` list (see this class's own
      // constructor doc comment), which `apps/shell` threads into every
      // mounted app's `ctx` for `@qu/webrtc`'s `WebRTCTransport` to use.
      // This is a UX convenience ONLY, never an authorization boundary -
      // all of this is public information anyone could read here
      // regardless; the actual privileged admin ACTION (`POST
      // /admin/settings`) independently verifies a signed request against
      // `adminPubs` server-side, exactly like every other writer/reader ACL
      // in this codebase, never trusting that only an admin's client would
      // ever render the button.
      if (req.url === '/config.json') {
        const settings = await getSettings(this.qu);
        // `federationStatus` is LIVE connection state (connecting/connected/
        // backoff/dead, handshake result) - unlike everything else here,
        // this is never persisted in `settings` itself (see
        // FederationManager.getStatus()'s own doc comment), so it has to be
        // read fresh from the manager on every request, same "state isn't
        // known until partway through boot()" reasoning `relayPub`/
        // `vapidKeys` already have elsewhere in this class.
        const federationStatus = this.state.federationManager?.getStatus() ?? [];
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ adminPubs: this.adminPubs, relayPub: this.state.relayPub, settings, iceServers: this.iceServers, federationStatus }));
        return;
      }

      // RELAY FEDERATION - "is this URL a genuine Qu relay?" probe (see
      // `FederationManager.getRelayInfo()`/`probeRelayInfo()`). Deliberately
      // unauthenticated, same reasoning as `/config.json` just above -
      // `relayId` is already public, the signature only ever proves key
      // possession, never trustworthiness (that decision happens entirely
      // on the CALLING relay's side - blacklist/autoLearn/admin approval).
      // 404s (not empty-200) when federation isn't wired up at all, so a
      // prober can tell "no federation support" apart from "federation
      // support but nothing to report" - there is no such empty state here,
      // this route always has an answer once federation exists at all.
      if (req.url === '/relay-info') {
        if (!this.state.federationManager) {
          res.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ error: 'federation not enabled on this relay' }));
          return;
        }
        const info = await this.state.federationManager.getRelayInfo();
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(info));
        return;
      }

      // RELAY FEDERATION - the client-learned-peer flow (see
      // `FederationManager.suggestPeer()`'s own doc comment). Signed by the
      // reporting client's own identity (any logged-in actor, NOT gated by
      // `adminPubs` like the `/admin/*` routes below - suggesting a peer is
      // a much smaller privilege than administering this relay, and
      // `autoLearn`/blacklist/admin-approval are the actual gates on what
      // happens next).
      if (req.url === '/federation/suggest' && req.method === 'POST') {
        await this.#handleFederationSuggest(req, res);
        return;
      }

      if (req.url === '/admin/settings' && req.method === 'POST') {
        await this.adminHttp.handleSettings(req, res);
        return;
      }
      if (req.url === '/admin/data/list' && req.method === 'POST') {
        await this.adminHttp.handleDataList(req, res);
        return;
      }
      if (req.url === '/admin/data/import' && req.method === 'POST') {
        await this.adminHttp.handleDataImport(req, res);
        return;
      }
      if (req.url === '/admin/federation/retry' && req.method === 'POST') {
        await this.adminHttp.handleFederationRetry(req, res);
        return;
      }

      // The public half of this relay's VAPID keypair - what a browser's
      // `PushManager.subscribe({applicationServerKey: ...})` needs. Public
      // by definition (VAPID's whole point is identifying the sender, same
      // as a TLS cert - never a secret).
      if (req.url === '/push/vapid-public-key') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ publicKey: this.state.vapidKeys?.publicKey ?? null }));
        return;
      }

      // Server-side Open Graph unfurling (title/description/image) for a
      // URL a chat/forum message links to - see `link-preview.js`'s own top
      // doc comment for why this is a relay route rather than a direct
      // client-side fetch of the target site (IP-leak to arbitrary third
      // parties + CORS), and for the SSRF guard every fetch this route
      // triggers goes through. `enabled: false` (an admin's own kill
      // switch, see `relay-settings.js`) answers 404 rather than a "success
      // with everything null" 200, so a client can tell "this relay has the
      // feature off" apart from "fetched fine, page just had no OG tags".
      if (req.url?.startsWith('/link-preview')) {
        const settings = await getSettings(this.qu);
        if (!settings.linkPreviews.enabled) {
          res.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ error: 'link previews are disabled on this relay' }));
          return;
        }
        const target = new URL(req.url, 'http://internal').searchParams.get('url');
        if (!target) {
          res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ error: 'missing url query parameter' }));
          return;
        }
        // getLinkPreview() never throws (see its own doc comment) - a dead/
        // blocked/non-HTML target just resolves to `null` here, same as any
        // other "nothing to preview" outcome, cached at its own (shorter)
        // negative TTL so this relay doesn't hammer it on every render.
        const preview = await this.getLinkPreview(target);
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300', // a client-side re-fetch (e.g. a fresh page load) can reuse a recent response too - this relay's own cache already governs true freshness
        }).end(JSON.stringify(preview ?? { url: target, title: null, description: null, image: null, siteName: null }));
        return;
      }

      // So OTHER relays can load the apps THIS one hosts (see
      // static-apps.js's own doc comment).
      if (await serveApps(req, res, this.appsDir)) return;

      // `apps/shell` - checked last, right before the final 404 fallback,
      // same position this had in the prototype this is rebuilt from.
      if (this.serveShellOption && (await serveShell(req, res, this.shellDir))) return;

      res.writeHead(404).end('Not Found');
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404).end('Not Found');
      } else {
        log.error('handler error:', err);
        res.writeHead(500).end('Internal Server Error');
      }
    }
  }

  /**
   * `POST /federation/suggest` - see this method's own call site for why
   * this is signed-but-not-admin-gated. `{actorPub, url, signature}`,
   * `signature` over `JSON.stringify({url})` - deliberately the SMALLEST
   * possible signed payload (just the url, not a nested object shape that
   * could accidentally admit ambiguity about what was actually signed),
   * unlike `admin-http.js`'s own settings/query payloads which sign a
   * larger object because there's more than one field to protect.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   */
  async #handleFederationSuggest(req, res) {
    if (!this.state.federationManager) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'federation not enabled on this relay' }));
      return;
    }
    // Gated by EITHER client-suggest flag (see relay-settings.js's own doc
    // comment on both) - the server can't tell which UI (if any) actually
    // triggered this POST, so it enforces "at least one client-facing path
    // is enabled at all", never a per-path distinction. Checked before
    // touching the request body at all - the cheapest possible rejection
    // when an admin hasn't opted into either.
    const settings = await getSettings(this.qu);
    if (!settings.federation.allowClientSuggestViaSettings && !settings.federation.allowClientSuggestViaShare) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'client relay suggestions are disabled on this relay' }));
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      return;
    }
    const { actorPub, url, signature } = body ?? {};
    if (typeof actorPub !== 'string' || typeof signature !== 'string' || typeof url !== 'string' || !url) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'expected { actorPub, url, signature }' }));
      return;
    }
    let verified = false;
    try {
      verified = await QuCrypto.verify(
        new TextEncoder().encode(JSON.stringify({ url })),
        QuCrypto.fromBase64Url(signature),
        QuCrypto.fromBase64Url(actorPub)
      );
    } catch {
      verified = false; // malformed base64/signature - same "treat exactly like did not verify" convention as admin-http.js's own #verifyAdmin()
    }
    if (!verified) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'signature does not verify' }));
      return;
    }
    try {
      const result = await this.state.federationManager.suggestPeer(url, actorPub);
      log.info(`federation peer suggestion from ~${actorPub.slice(0, 10)}…: ${url} -> ${result.status}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes=8KiB] - A `{actorPub, url, signature}` payload is tiny.
 * @returns {Promise<object>} Parsed JSON body.
 * @throws {Error} On a body over `maxBytes` or malformed JSON.
 */
async function readJsonBody(req, maxBytes = 8 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
