import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketServerTransport } from '../src/transports/websocket-server-transport.js';

/** Boots a real http+ws server on an ephemeral port, wrapped in WebSocketServerTransport. Caller must call teardown() when done. */
async function freshServer(options = {}) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const transport = new WebSocketServerTransport(wss, options);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  return {
    transport,
    port,
    teardown: async () => {
      transport.closeAllPeers();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

/** Connects a plain `ws` client, resolving once the connection is open. */
function connectClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolves with the next parsed JSON message a client receives. */
function nextMessage(ws) {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  });
}

test('getPeerId() returns a stable "relay-..." identifier', async () => {
  const { transport, teardown } = await freshServer();
  try {
    const id = transport.getPeerId();
    assert.ok(id.startsWith('relay-'));
    assert.equal(transport.getPeerId(), id);
  } finally {
    await teardown();
  }
});

test('a connecting client\'s message arrives via onMessage() tagged with a "peer-..." id', async () => {
  const { transport, port, teardown } = await freshServer();
  try {
    const received = new Promise((resolve) => transport.onMessage(resolve));
    const client = await connectClient(port);
    client.send(JSON.stringify({ type: 'hello' }));

    const { data, peerId } = await received;
    assert.deepEqual(data, { type: 'hello' });
    assert.ok(peerId.startsWith('peer-'));
  } finally {
    await teardown();
  }
});

test('two different clients get two different peerIds', async () => {
  const { transport, port, teardown } = await freshServer();
  try {
    const peerIds = [];
    transport.onMessage(({ peerId }) => peerIds.push(peerId));

    const a = await connectClient(port);
    const b = await connectClient(port);
    a.send(JSON.stringify({ from: 'a' }));
    b.send(JSON.stringify({ from: 'b' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(peerIds.length, 2);
    assert.notEqual(peerIds[0], peerIds[1]);
  } finally {
    await teardown();
  }
});

test('sendTo(peerId, data) reaches exactly that peer, not another', async () => {
  const { transport, port, teardown } = await freshServer();
  try {
    const peerIds = [];
    transport.onMessage(({ peerId }) => peerIds.push(peerId));

    const a = await connectClient(port);
    const b = await connectClient(port);
    a.send(JSON.stringify({ hello: 'a' })); // registers a's peerId
    await new Promise((resolve) => setTimeout(resolve, 20));

    const bMessages = [];
    b.on('message', (raw) => bMessages.push(JSON.parse(raw.toString())));
    const aReceived = nextMessage(a);

    transport.sendTo(peerIds[0], { only: 'for-a' });
    assert.deepEqual(await aReceived, { only: 'for-a' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(bMessages, []); // b never got it
  } finally {
    await teardown();
  }
});

test('send(data) broadcasts to every currently connected peer', async () => {
  const { transport, port, teardown } = await freshServer();
  try {
    const a = await connectClient(port);
    const b = await connectClient(port);
    const aReceived = nextMessage(a);
    const bReceived = nextMessage(b);

    transport.send({ broadcast: true });

    assert.deepEqual(await aReceived, { broadcast: true });
    assert.deepEqual(await bReceived, { broadcast: true });
  } finally {
    await teardown();
  }
});

test('a malformed (non-JSON) message from a client is dropped, not crashing the server', async () => {
  const { transport, port, teardown } = await freshServer();
  try {
    let calls = 0;
    transport.onMessage(() => calls++);
    const client = await connectClient(port);
    client.send('not valid json {{{');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 0);

    // The server is still alive - a well-formed message right after still works.
    const received = new Promise((resolve) => transport.onMessage(resolve));
    client.send(JSON.stringify({ ok: true }));
    assert.deepEqual((await received).data, { ok: true });
  } finally {
    await teardown();
  }
});

test('REGRESSION: setRateLimit() drops messages beyond N per rolling minute window', async () => {
  const { transport, port, teardown } = await freshServer({ maxMessagesPerMinute: 2 });
  try {
    let received = 0;
    transport.onMessage(() => received++);
    const client = await connectClient(port);

    client.send(JSON.stringify({ n: 1 }));
    client.send(JSON.stringify({ n: 2 }));
    client.send(JSON.stringify({ n: 3 })); // over the limit - dropped
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(received, 2);
  } finally {
    await teardown();
  }
});

test('setRateLimit() applied live raises/lowers the limit for a peer\'s NEXT message', async () => {
  const { transport, port, teardown } = await freshServer({ maxMessagesPerMinute: 1 });
  try {
    let received = 0;
    transport.onMessage(() => received++);
    const client = await connectClient(port);

    client.send(JSON.stringify({ n: 1 }));
    client.send(JSON.stringify({ n: 2 })); // dropped, over the initial limit of 1
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 1);

    transport.setRateLimit(0); // unlimited from here on
    client.send(JSON.stringify({ n: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 2);
  } finally {
    await teardown();
  }
});

test('rate limit of 0 (default) never drops anything', async () => {
  const { transport, port, teardown } = await freshServer(); // maxMessagesPerMinute defaults to 0
  try {
    let received = 0;
    transport.onMessage(() => received++);
    const client = await connectClient(port);
    for (let i = 0; i < 20; i++) client.send(JSON.stringify({ n: i }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(received, 20);
  } finally {
    await teardown();
  }
});

test('closeAllPeers() forcibly disconnects every connected client', async () => {
  const { transport, port, teardown } = await freshServer();
  try {
    const client = await connectClient(port);
    const closed = new Promise((resolve) => client.once('close', resolve));
    transport.closeAllPeers();
    await closed; // resolves - proves the connection was actually torn down
  } finally {
    await teardown();
  }
});
