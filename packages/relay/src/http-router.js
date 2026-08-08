import { getSettings } from './relay-settings.js';

/**
 * HTTP ROUTER — the relay's PUBLIC HTTP surface (liveness, public config,
 * VAPID public key) plus dispatch into `AdminHttp`'s privileged routes.
 * Split out of the relay's own composition root for the same
 * one-cross-cutting-concern-per-file reason `admin-http.js`'s own doc
 * comment states (docs/v3-technical-concept.md §2.1).
 *
 * DELIBERATELY NOT WIRED HERE: `/apps.json`, static app serving
 * (`/apps/<name>/...`), and shell serving (`/`, `/shell-bundle.js`, PWA
 * files). Those all need `@qu/loader` (manifest discovery/integrity
 * checking) and a real `apps/shell` to serve - neither exists in V3 yet.
 * `handle()` falls through to a plain 404 for any of those paths today;
 * wiring them in is the Apps milestone's job, not a gap in this one.
 */
export class HttpRouter {
  /**
   * @param {import('@qu/core').QuStore} qu
   * @param {import('./admin-http.js').AdminHttp} adminHttp
   * @param {{adminPubs: string[], state: {transport: object|null, vapidKeys: {publicKey: string}|null}}} options -
   *   `state` is a mutable, shared reference the caller keeps populating as
   *   the relay boots (`transport`/`vapidKeys` aren't known until partway
   *   through `boot()` - see `relay.js`) - read fresh on every request
   *   rather than captured once at construction time, so a request that
   *   happens to land before boot fully completes sees `null`
   *   (`/healthz`'s own `peerId` field, `/push/vapid-public-key`'s
   *   `publicKey` field) instead of a stale/undefined value.
   */
  constructor(qu, adminHttp, { adminPubs, state }) {
    this.qu = qu;
    this.adminHttp = adminHttp;
    this.adminPubs = adminPubs;
    this.state = state;
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

      // Public, non-secret config a client needs before it knows anything
      // else: which actor pubkeys are relay admins, so a UI can show (or
      // hide) an admin nav entry for the connected identity, plus this
      // relay's current admin-configurable settings. This is a UX
      // convenience ONLY, never an authorization boundary - all of this is
      // public information anyone could read here regardless; the actual
      // privileged admin ACTION (`POST /admin/settings`) independently
      // verifies a signed request against `adminPubs` server-side, exactly
      // like every other writer/reader ACL in this codebase, never trusting
      // that only an admin's client would ever render the button.
      if (req.url === '/config.json') {
        const settings = await getSettings(this.qu);
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ adminPubs: this.adminPubs, settings }));
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

      // The public half of this relay's VAPID keypair - what a browser's
      // `PushManager.subscribe({applicationServerKey: ...})` needs. Public
      // by definition (VAPID's whole point is identifying the sender, same
      // as a TLS cert - never a secret).
      if (req.url === '/push/vapid-public-key') {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ publicKey: this.state.vapidKeys?.publicKey ?? null }));
        return;
      }

      res.writeHead(404).end('Not Found');
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404).end('Not Found');
      } else {
        console.error('[HttpRouter] handler error:', err);
        res.writeHead(500).end('Internal Server Error');
      }
    }
  }
}
