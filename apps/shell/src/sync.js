import { SyncEngine, WebSocketClientTransport } from '@qu/sync';
import { IndexedDBOutboxStore } from '@qu/runtime/indexeddb-outbox';
import { createLogger } from '@qu/log';

const log = createLogger('shell:sync');

/**
 * Connects to THIS relay (the one that served this page - same origin,
 * `ws:`/`wss:` swapped in for `http:`/`https:`, since `@qu/relay`'s
 * WebSocket server listens on the exact same HTTP server/port - see
 * `relay.js`'s `boot()`) as a star-topology client: every local write gets
 * forwarded unconditionally (`publishAllTo`), exactly the shape
 * `SyncEngine`'s own constructor doc comment describes for "a browser shell
 * talking to its one relay".
 *
 * `IndexedDBOutboxStore` (`@qu/runtime`, already independently tested) is
 * what makes a write survive a reload while offline - without it, a write
 * made just before closing the tab with no connection yet established
 * would only live in the transport's in-memory send queue, gone on reload.
 *
 * @param {import('@qu/core').QuStore} qu
 * @returns {{sync: SyncEngine, transport: WebSocketClientTransport}}
 */
export function connectToRelay(qu) {
  const wsUrl = `${window.location.origin.replace(/^http/, 'ws')}/`;
  const transport = new WebSocketClientTransport(wsUrl);
  const outbox = new IndexedDBOutboxStore();
  const sync = new SyncEngine(qu, transport, { publishAllTo: transport.getPeerId(), outbox });

  transport.connect().then(
    () => log.info(`connected to ${wsUrl}`),
    (err) => log.warn(`initial connection to ${wsUrl} failed - will keep retrying in the background:`, err.message)
  );

  return { sync, transport };
}
