const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  RexClient,
  REX_SNAPSHOT_INTERVAL_MS,
  REX_SNAPSHOT_AFTER_OUTPUT_MS,
  REX_DATA_RETRY_MIN_MS,
  REX_DATA_RETRY_MAX_MS,
  REX_DATA_STABLE_MS,
  REX_SEED_RETRY_MS,
} = require('../.test-build/app/apps/terminal/rex-client.js');
const { REX_RECONNECT_MIN_DELAY_MS } = require('../.test-build/app/apps/terminal/rex/control.js');
const { REX_DATA_SUBPROTOCOL } = require('../.test-build/app/apps/terminal/rex/protocol.js');
const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');

// Recorded from a live Rex server by scripts/rex-stream-fixtures.mjs, at 80x24.
const recorded = require(path.join(__dirname, 'fixtures', 'rex', 'stream-output.json'));
const COLS = recorded.grid.columns;
const ROWS = recorded.grid.rows;
const MAC_GRID = { cols: 120, rows: 40 };
const SELF = 'client:glasses';
const SESSION = 'session:work';
const BLOCK = 'block:0000000a-0000-0000-0000-00000000000a';
const NONCE = 7n;
const TOKEN = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);
const TICKET = 'AAECAwQFBgcICQoLDA0ODw';
const FORMAT = 'com.superlogical.terminal.format';
const HELLO = 0x01;
const RESUME = 0x02;
const RESUME_BYTES = 25;
const RESUME_COUNT_OFFSET = 17;
const REJECT_INVALID_TICKET = [0x82, 0x01];
const CLOSE_RECONNECT_REQUIRED = 1013;
const CLOSE_BLOCK_CLOSED = 4000;
const CLOSE_ABNORMAL = 1006;
const SNAPSHOT_STAND_IN = 'GHOSTSNP binary snapshot stand-in';

function fakeTimers() {
  let nextId = 1;
  let clock = 0;
  const timeouts = new Map();
  return {
    now: () => clock,
    setTimeout(callback, ms) {
      const id = nextId++;
      timeouts.set(id, { callback, at: clock + ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        let pick = null;
        for (const [id, entry] of timeouts) if (entry.at <= target && (!pick || entry.at < pick.at)) pick = { id, ...entry };
        if (!pick) break;
        timeouts.delete(pick.id);
        clock = pick.at;
        pick.callback();
      }
      clock = target;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const bytes = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
const rexMessage = (message, nonce = NONCE) => `\x1b_rex1;${nonce};${JSON.stringify(message)}\x1b\\`;
const resize = ({ cols, rows }, nonce) => rexMessage({ type: 'resize', cols, rows, cell_width_px: 0, cell_height_px: 0, owner: null }, nonce);

function welcomeFrame(nonce = NONCE, token = TOKEN) {
  const frame = Buffer.alloc(32);
  frame[0] = 0x81;
  Buffer.from(token).copy(frame, 1);
  frame.writeUInt32LE(60000, 20);
  frame.writeBigUInt64LE(BigInt(nonce), 24);
  return new Uint8Array(frame);
}

const WORK = {
  revision: 1,
  session_id: SESSION,
  label: 'work',
  windows: [
    {
      window_id: 'window:w0',
      label: 'Window window:w0'.slice(-8),
      layers: [{ layer_id: 'layer:0', kind: 'tiled', bounds: [0, 0, 1, 1], layout: null, blocks: [{ block_id: BLOCK, label: 'shell', creator_name: 'com.superlogical.terminal', flavor: 'com.superlogical.terminal.shell' }] }],
    },
  ],
};

function harness({ dataSockets = true } = {}) {
  const timers = fakeTimers();
  const sockets = [];
  const dataConnections = [];
  const logs = [];
  const client = new RexClient({
    endpoint: parseRexConnectionString('rex://127.0.0.1:8792'),
    createSocket: (url, subprotocol, handlers) => {
      const socket = {
        handlers,
        sent: [],
        answered: new Set(),
        closed: null,
        send(text) {
          if (socket.closed) return false;
          socket.sent.push(JSON.parse(text));
          return true;
        },
        close(code, reason) {
          socket.closed = { code, reason };
        },
      };
      sockets.push(socket);
      return socket;
    },
    openDataSocket: dataSockets
      ? (url, listener) => {
          const socket = {
            url,
            listener,
            sent: [],
            closed: null,
            sendBinary(frame) {
              if (socket.closed) return false;
              socket.sent.push(Buffer.from(frame));
              return true;
            },
            close(code, reason) {
              socket.closed = { code, reason };
            },
          };
          dataConnections.push(socket);
          return socket;
        }
      : undefined,
    timers,
    now: timers.now,
    cols: COLS,
    rows: ROWS,
    log: (line) => logs.push(line),
  });
  const delivered = [];
  const detached = [];
  const activity = [];
  client.onTerminalData((data, kind) => delivered.push({ kind, text: Buffer.from(data).toString('latin1') }));
  client.onSessionDetached((reason) => detached.push(reason));
  client.onActivity((socket) => activity.push(socket));
  const socket = () => sockets.at(-1);
  const data = () => dataConnections.at(-1);
  const receive = (message) => socket().handlers.onMessage(JSON.stringify(message));
  const open = (method) => socket().sent.filter((m) => m.type === 'request' && !socket().answered.has(m.id) && (!method || m.method === method));
  const sentCount = (method) => socket().sent.filter((m) => m.method === method).length;
  const answer = (method, payload) => {
    const [request] = open(method);
    assert.ok(request, `a ${method} request is waiting`);
    socket().answered.add(request.id);
    receive({ type: 'response', id: request.id, seq: 0, payload });
    return request;
  };
  const event = (inner) => receive({ type: 'event', seq: 0, payload: { type: 'session_event', payload: { session_id: SESSION, event: inner } } });

  async function handshake() {
    socket().handlers.onOpen();
    receive({ type: 'welcome', protocol: 'rex.control.v1', api_revision: 18, limits: { max_message_bytes: 1048576 }, client: { id: SELF, reconnect_token: 't' } });
    answer('session.bootstrap', { client_id: SELF, attach_all: { sessions: [{ session_id: SESSION, label: 'work' }] } });
    answer('session.view', WORK);
    await flush();
  }
  async function viewAsOwner() {
    client.start();
    await handshake();
    client.onSessionAttached(() => client.view());
    client.connectSession(BLOCK);
    answer('session.attach', { client_id: SELF, view: WORK });
    await flush();
    answer('session.own_block', { blocks: [{ block_id: BLOCK, owner: SELF }] });
    await flush();
    answer('com.superlogical.terminal.resize', {});
    await flush();
  }
  /** Answers data.connect and opens the data socket it leads to. */
  async function hello() {
    answer('data.connect', { ticket: TICKET, expires_in_ms: 60000 });
    await flush();
    data().listener.onOpen();
  }
  /** View BLOCK, stream it, and answer the seed with `seed`. Returns the stream bytes served so far. */
  async function live(seed = 'SEED', grid = { cols: COLS, rows: ROWS }) {
    await viewAsOwner();
    await hello();
    data().listener.onBinaryMessage(welcomeFrame());
    const first = bytes(SNAPSHOT_STAND_IN + resize(grid));
    data().listener.onBinaryMessage(first);
    answer(FORMAT, { content: seed });
    await flush();
    return first.length;
  }
  /** Advances the clock until a new `method` request goes out, and returns how long that took. */
  const waitForRequest = (method) => {
    const asked = sentCount(method);
    let waited = 0;
    while (sentCount(method) === asked) {
      assert.ok(waited <= REX_DATA_RETRY_MAX_MS, `no ${method} within the longest backoff`);
      timers.advance(1);
      waited++;
    }
    return waited;
  };
  const serve = (text) => {
    const chunk = bytes(text);
    data().listener.onBinaryMessage(chunk);
    return chunk.length;
  };
  return { client, timers, logs, delivered, detached, activity, socket, data, dataConnections, open, sentCount, answer, event, handshake, viewAsOwner, hello, live, serve, waitForRequest };
}

test('viewing streams the block: a seed arrives as a snapshot, then the recorded bytes as output, in order', async () => {
  const h = harness();
  await h.viewAsOwner();
  const connect = h.answer('data.connect', { ticket: TICKET, expires_in_ms: 60000 });
  assert.deepEqual(connect.payload, { session_id: SESSION, block_id: BLOCK, data_ref_id: 'terminal', subprotocol: REX_DATA_SUBPROTOCOL });
  await flush();
  assert.equal(h.data().url, 'ws://127.0.0.1:8792/api/data');
  h.data().listener.onOpen();
  assert.deepEqual([...h.data().sent[0]], [HELLO, ...Buffer.from(TICKET, 'base64url')]);

  h.data().listener.onBinaryMessage(welcomeFrame(recorded.nonce));
  const [first, ...rest] = recorded.connections[0].frames.map((frame) => new Uint8Array(Buffer.from(frame.base64, 'base64')));
  h.data().listener.onBinaryMessage(first);
  assert.equal(h.delivered.length, 0, 'nothing is shown before the seed');
  assert.equal(h.answer(FORMAT, { content: 'SEED' }).payload.args.format, 'vt');
  await flush();
  for (const frame of rest) h.data().listener.onBinaryMessage(frame);

  assert.deepEqual(h.delivered[0], { kind: 'snapshot', text: 'SEED' });
  assert.ok(h.delivered.slice(1).every((piece) => piece.kind === 'output'));
  const output = h.delivered.slice(1).map((piece) => piece.text).join('');
  assert.match(output, /progress 99%/);
  assert.ok(output.indexOf('red') < output.indexOf('progress 99%'));
  assert.ok(!output.includes('rex1;'), 'Rex messages never reach the emulator');
  assert.ok(h.activity.length > 0 && h.activity.every((socket) => socket === BLOCK), 'stream output is activity for the viewed block');
});

test('an idle live stream sends no format request, whatever time, input or block events pass', async () => {
  const h = harness();
  await h.live();
  const formats = h.sentCount(FORMAT);
  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS * 120);
  h.event({ type: 'block_event', payload: { block_id: BLOCK, name: 'bell', payload: {} } });
  h.client.sendInput('x');
  h.answer('com.superlogical.terminal.write', { bytes_written: 1 });
  await flush();
  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS * 120);
  assert.equal(h.sentCount(FORMAT), formats);
  h.serve('x');
  assert.deepEqual(h.delivered.at(-1), { kind: 'output', text: 'x' }, 'the echo arrives as output');
});

test('a dropped data connection resumes with the exact byte count and carries on without a new seed', async () => {
  const h = harness();
  let count = await h.live();
  count += h.serve('one\r\n');
  h.timers.advance(REX_DATA_STABLE_MS);
  const dropped = h.data();
  dropped.listener.onFailure('connection reset');
  h.timers.advance(REX_DATA_RETRY_MIN_MS - 1);
  assert.equal(h.dataConnections.length, 1, 'no retry before the backoff');
  h.timers.advance(1);
  assert.notEqual(h.data(), dropped);
  h.data().listener.onOpen();
  const resume = h.data().sent[0];
  assert.equal(resume.length, RESUME_BYTES);
  assert.equal(resume[0], RESUME);
  assert.deepEqual([...resume.subarray(1, RESUME_COUNT_OFFSET)], [...TOKEN]);
  assert.equal(resume.readBigUInt64LE(RESUME_COUNT_OFFSET), BigInt(count));
  assert.equal(h.sentCount('data.connect'), 1, 'a resume needs no ticket');

  dropped.listener.onBinaryMessage(bytes('late'));
  h.data().listener.onBinaryMessage(welcomeFrame());
  h.serve('two\r\n');
  const formats = h.sentCount(FORMAT);
  assert.deepEqual(h.delivered.slice(-2), [{ kind: 'output', text: 'one\r\n' }, { kind: 'output', text: 'two\r\n' }]);
  assert.equal(h.sentCount(FORMAT), formats);
  assert.ok(h.logs.some((line) => line.startsWith(`rex data: RESUME accepted at ${count} bytes`)));
});

test('a REJECT or close 1013 starts over with a new ticket', async () => {
  const h = harness();
  await h.live();
  h.data().listener.onClosed(CLOSE_RECONNECT_REQUIRED, 'data reconnect required');
  h.waitForRequest('data.connect');
  await h.hello();
  assert.equal(h.data().sent[0][0], HELLO);

  const rejected = h.data();
  rejected.listener.onBinaryMessage(Uint8Array.from(REJECT_INVALID_TICKET));
  assert.equal(rejected.closed.code, 1000);
  rejected.listener.onClosed(1008, 'data handshake rejected');
  h.waitForRequest('data.connect');
  assert.equal(h.dataConnections.length, 2, 'the REJECT decides, not the close after it');

  await h.hello();
  h.data().listener.onBinaryMessage(welcomeFrame());
  h.data().listener.onBinaryMessage(bytes(SNAPSHOT_STAND_IN + resize({ cols: COLS, rows: ROWS })));
  while (h.open(FORMAT).length) h.answer(FORMAT, { content: 'SEED AGAIN' });
  await flush();
  assert.deepEqual(h.delivered.at(-1), { kind: 'snapshot', text: 'SEED AGAIN' });
});

test('snapshots poll while the stream waits to start over, and stop once it does', async () => {
  const h = harness();
  await h.live();
  h.data().listener.onClosed(CLOSE_RECONNECT_REQUIRED, 'data reconnect required');
  h.timers.advance(0);
  h.answer(FORMAT, { content: 'POLLED' });
  await flush();
  assert.deepEqual(h.delivered.at(-1), { kind: 'snapshot', text: 'POLLED' });
  h.waitForRequest('data.connect');
  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS * 4);
  assert.equal(h.open(FORMAT).length, 0, 'no poll once a new stream is on its way');
});

test('a refused RESUME starts over with a new ticket', async () => {
  const h = harness();
  await h.live();
  h.timers.advance(REX_DATA_STABLE_MS);
  h.data().listener.onClosed(CLOSE_ABNORMAL, '');
  h.timers.advance(REX_DATA_RETRY_MIN_MS);
  h.data().listener.onOpen();
  assert.equal(h.data().sent[0][0], RESUME);
  h.data().listener.onBinaryMessage(Uint8Array.from([0x82, 0x03]));
  h.waitForRequest('data.connect');
  assert.equal(h.dataConnections.length, 2);
});

test('close 4000 shows the pane as closed and does not reconnect', async () => {
  const h = harness();
  await h.live();
  h.data().listener.onClosed(CLOSE_BLOCK_CLOSED, 'block closed');
  assert.equal(h.client.state().status, 'Pane closed.');
  assert.deepEqual(h.detached, ['session closed']);
  h.timers.advance(REX_DATA_RETRY_MAX_MS * 4);
  assert.equal(h.dataConnections.length, 1);
  assert.equal(h.sentCount('data.connect'), 1);
});

test('a block that keeps failing backs off, and a connection that stayed up resumes after the minimum delay', async () => {
  const h = harness();
  await h.viewAsOwner();
  const delays = [];
  for (let failures = 0; failures < 9; failures++) {
    await h.hello();
    h.data().listener.onClosed(1011, 'data provider failed');
    delays.push(h.waitForRequest('data.connect'));
  }
  const expected = delays.map((_, index) => Math.min(REX_DATA_RETRY_MAX_MS, REX_DATA_RETRY_MIN_MS * 2 ** (index + 1)));
  assert.deepEqual(delays, expected);

  await h.hello();
  h.data().listener.onBinaryMessage(welcomeFrame());
  h.timers.advance(REX_DATA_STABLE_MS);
  const before = h.dataConnections.length;
  h.data().listener.onClosed(CLOSE_ABNORMAL, '');
  h.timers.advance(REX_DATA_RETRY_MIN_MS);
  assert.equal(h.dataConnections.length, before + 1);
});

test('leaving the pane closes the data socket, and nothing from it is delivered afterwards', async () => {
  const h = harness();
  await h.live();
  const left = h.data();
  h.serve('busy\r\n');
  h.client.unview();
  assert.deepEqual(left.closed, { code: 1000, reason: 'faceclaw leaving the pane' });
  const shown = h.delivered.length;
  left.listener.onBinaryMessage(bytes('after\r\n'));
  left.listener.onClosed(CLOSE_ABNORMAL, '');
  h.timers.advance(REX_DATA_RETRY_MAX_MS * 4);
  assert.equal(h.delivered.length, shown);
  assert.equal(h.dataConnections.length, 1);
  assert.equal(h.sentCount(FORMAT), 1);
});

test('a seed read that lands after leaving the pane is dropped', async () => {
  const h = harness();
  await h.viewAsOwner();
  await h.hello();
  h.data().listener.onBinaryMessage(welcomeFrame());
  h.data().listener.onBinaryMessage(bytes(SNAPSHOT_STAND_IN + resize({ cols: COLS, rows: ROWS })));
  h.client.disconnectSession();
  h.answer(FORMAT, { content: 'SEED' });
  await flush();
  assert.equal(h.delivered.length, 0);
});

test('a failed seed read is asked for again', async () => {
  const h = harness();
  await h.viewAsOwner();
  await h.hello();
  h.data().listener.onBinaryMessage(welcomeFrame());
  h.data().listener.onBinaryMessage(bytes(SNAPSHOT_STAND_IN + resize({ cols: COLS, rows: ROWS })));
  const [request] = h.open(FORMAT);
  h.socket().answered.add(request.id);
  h.socket().handlers.onMessage(JSON.stringify({ type: 'response', id: request.id, seq: 0, error: { code: 'internal', message: 'busy', status: 500 } }));
  await flush();
  h.timers.advance(REX_SEED_RETRY_MS);
  h.answer(FORMAT, { content: 'SEED' });
  await flush();
  assert.deepEqual(h.delivered, [{ kind: 'snapshot', text: 'SEED' }]);
});

test('a seed that lands while the data connection is down is read again after the RESUME', async () => {
  const h = harness();
  await h.viewAsOwner();
  await h.hello();
  h.data().listener.onBinaryMessage(welcomeFrame());
  h.data().listener.onBinaryMessage(bytes(SNAPSHOT_STAND_IN + resize({ cols: COLS, rows: ROWS })));
  h.data().listener.onClosed(CLOSE_ABNORMAL, '');
  h.answer(FORMAT, { content: 'TAKEN WHILE DOWN' });
  await flush();
  assert.equal(h.delivered.length, 0);
  h.timers.advance(REX_SEED_RETRY_MS);
  h.data().listener.onOpen();
  assert.equal(h.data().sent[0][0], RESUME);
  h.data().listener.onBinaryMessage(welcomeFrame());
  h.timers.advance(REX_SEED_RETRY_MS);
  h.answer(FORMAT, { content: 'SEED' });
  await flush();
  assert.deepEqual(h.delivered, [{ kind: 'snapshot', text: 'SEED' }]);
});

test('at another client size, output turns into snapshots; back at the glasses grid, the stream starts over', async () => {
  const h = harness();
  await h.live();
  const first = h.data();
  h.serve(resize(MAC_GRID) + 'mac sized\r\n');
  h.timers.advance(0);
  h.answer(FORMAT, { content: 'MAC SCREEN' });
  await flush();
  assert.deepEqual(h.delivered.at(-1), { kind: 'snapshot', text: 'MAC SCREEN' });
  assert.ok(!h.delivered.some((piece) => piece.text.includes('mac sized')), 'output laid out for another grid is never written');

  h.serve('more\r\n');
  h.timers.advance(REX_SNAPSHOT_AFTER_OUTPUT_MS);
  h.answer(FORMAT, { content: 'MAC SCREEN 2' });
  await flush();
  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS * 10);
  assert.equal(h.open(FORMAT).length, 0, 'no timer while following the stream');

  h.serve(resize({ cols: COLS, rows: ROWS }));
  assert.equal(first.closed.code, 1000);
  await h.hello();
  assert.equal(h.data().sent[0][0], HELLO);
});

test('a control reconnect keeps the data connection', async () => {
  const h = harness();
  await h.live();
  const stream = h.data();
  h.socket().handlers.onClose(CLOSE_ABNORMAL, '');
  h.serve('during\r\n');
  h.timers.advance(REX_RECONNECT_MIN_DELAY_MS);
  await h.handshake();
  h.answer('session.attach', { client_id: SELF, view: WORK });
  await flush();
  h.answer('session.own_block', { blocks: [{ block_id: BLOCK, owner: SELF }] });
  await flush();
  h.answer('com.superlogical.terminal.resize', {});
  await flush();
  h.serve('after\r\n');
  assert.equal(stream.closed, null);
  assert.equal(h.data(), stream);
  assert.deepEqual(h.delivered.slice(-2).map((piece) => piece.text), ['during\r\n', 'after\r\n']);
  assert.equal(h.sentCount(FORMAT), 0, 'the new control connection reads no snapshot');
});

test('without a data socket the client stays in snapshot mode', async () => {
  const h = harness({ dataSockets: false });
  await h.viewAsOwner();
  h.timers.advance(0);
  h.answer(FORMAT, { content: 'first' });
  await flush();
  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS);
  h.answer(FORMAT, { content: 'second' });
  await flush();
  assert.deepEqual(h.delivered, [{ kind: 'snapshot', text: 'first' }, { kind: 'snapshot', text: 'second' }]);
  assert.equal(h.sentCount('data.connect'), 0);
});
