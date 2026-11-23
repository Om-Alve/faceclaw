const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  RexClient,
  rexSessionRows,
  REX_SNAPSHOT_AFTER_INPUT_MS,
  REX_SNAPSHOT_INTERVAL_MS,
  REX_OTHER_OWNER_NOTICE,
} = require('../.test-build/app/apps/terminal/rex-client.js');
const { REX_RECONNECT_MIN_DELAY_MS } = require('../.test-build/app/apps/terminal/rex/control.js');
const { parseSessionView } = require('../.test-build/app/apps/terminal/rex/protocol.js');
const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');
const fixtures = require(path.join(__dirname, 'fixtures', 'rex', 'control-messages.json'));

const COLS = 58;
const ROWS = 11;
const SELF = 'client:glasses';
const MAC = 'client:mac';
const SESSION = 'session:work';
const BLOCK = 'block:0000000a-0000-0000-0000-00000000000a';

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

const shellBlock = (id, label = 'shell') => ({ block_id: id, label, creator_name: 'com.superlogical.terminal', flavor: 'com.superlogical.terminal.shell' });
const viewPayload = (sessionId, label, windows) => ({
  revision: 1,
  session_id: sessionId,
  label,
  windows: windows.map((blocks, index) => ({
    window_id: `window:${sessionId}-${index}`,
    label: `Window ${`window:${sessionId}-${index}`.slice(-8)}`,
    layers: [{ layer_id: `layer:${index}`, kind: 'tiled', bounds: [0, 0, 1, 1], layout: null, blocks }],
  })),
});
const WORK = viewPayload(SESSION, 'work', [[shellBlock(BLOCK)]]);

function harness() {
  const timers = fakeTimers();
  const sockets = [];
  const logs = [];
  const client = new RexClient({
    endpoint: parseRexConnectionString('rex://127.0.0.1:8792'),
    createSocket: (url, subprotocol, handlers) => {
      const socket = {
        url,
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
    timers,
    now: timers.now,
    cols: COLS,
    rows: ROWS,
    log: (line) => logs.push(line),
  });
  const snapshots = [];
  const states = [];
  const attached = [];
  client.onTerminalData((data, kind) => snapshots.push({ kind, text: Buffer.from(data).toString('utf8') }));
  client.onStateChange((state) => states.push(state));
  client.onSessionAttached((label) => attached.push(label));
  const socket = () => sockets.at(-1);
  const receive = (message) => socket().handlers.onMessage(JSON.stringify(message));
  /** Requests not answered yet, oldest first. */
  const open = (method) => socket().sent.filter((m) => m.type === 'request' && !socket().answered.has(m.id) && (!method || m.method === method));
  const respond = (request, payload) => {
    socket().answered.add(request.id);
    receive({ type: 'response', id: request.id, seq: 0, payload });
  };
  const answer = (method, payload) => {
    const [request] = open(method);
    assert.ok(request, `a ${method} request is waiting`);
    respond(request, payload);
    return request;
  };
  const event = (sessionId, inner) => receive({ type: 'event', seq: 0, payload: { type: 'session_event', payload: { session_id: sessionId, event: inner } } });
  const blockEvent = (name, payload = {}) => event(SESSION, { type: 'block_event', payload: { block_id: BLOCK, name, payload } });
  const ownerChanged = (owner) => event(SESSION, { type: 'block_owner_changed', payload: { block_id: BLOCK, owner, reason: 'take' } });

  async function connect(views = [WORK]) {
    client.start();
    await handshake(views);
  }
  /** Answer the current socket's hello, bootstrap and views. */
  async function handshake(views = [WORK]) {
    socket().handlers.onOpen();
    receive({ type: 'welcome', protocol: 'rex.control.v1', api_revision: 18, limits: { max_message_bytes: 1048576 }, client: { id: SELF, reconnect_token: 't' } });
    answer('session.bootstrap', { client_id: SELF, attach_all: { sessions: views.map((v) => ({ session_id: v.session_id, label: v.label })) } });
    for (const view of views) answer('session.view', view);
    await flush();
  }
  /** Attach to BLOCK and view it as its owner, answering every request on the way. */
  async function viewAsOwner() {
    client.onSessionAttached(() => client.view());
    client.connectSession(BLOCK);
    answer('session.attach', { client_id: SELF, view: WORK });
    await flush();
    answer('session.own_block', { blocks: [{ block_id: BLOCK, owner: SELF }] });
    await flush();
    answer('com.superlogical.terminal.resize', {});
    await flush();
  }
  return { client, timers, logs, snapshots, states, attached, socket, open, respond, answer, blockEvent, ownerChanged, connect, handshake, viewAsOwner };
}

test('rows: one row per terminal block, labelled session:window.block without the labels Rex made up', () => {
  const single = parseSessionView(fixtures.response_view.payload);
  const nested = parseSessionView(fixtures.response_view_nested.payload);
  const blocks = (view) => view.windows.flatMap((window) => window.blocks.map((block) => block.blockId));

  const rows = rexSessionRows([single, nested]);
  assert.deepEqual(rows.map((row) => row.socket), [...blocks(single), ...blocks(nested)]);
  assert.deepEqual(rows.map((row) => row.title), [
    'lane-r1-fixtures',
    'lane-r2-fixtures-nested:1',
    'lane-r2-fixtures-nested:editor.logs',
    'lane-r2-fixtures-nested:editor.2',
  ]);
  assert.deepEqual(rows[0], { socket: blocks(single)[0], pid: 0, cwdHint: '', lastBellAt: null, lastOutputAt: null, title: 'lane-r1-fixtures' });

  const onboarding = { ...nested, windows: [{ ...nested.windows[0], blocks: [{ ...nested.windows[0].blocks[0], creatorName: 'com.superlogical.onboarding' }] }] };
  assert.deepEqual(rexSessionRows([onboarding]), []);
});

test('rows: a block label cleared back to its ID default is dropped too', () => {
  const view = parseSessionView(fixtures.response_view.payload);
  const block = view.windows[0].blocks[0];
  const relabel = (label) => rexSessionRows([{ ...view, windows: [{ ...view.windows[0], blocks: [{ ...block, label }] }] }])[0].title;
  assert.equal(relabel(`Block ${block.blockId.slice(-8)}`), 'lane-r1-fixtures');
  assert.equal(relabel('server'), 'lane-r1-fixtures.server');
});

test('viewing takes the block and sizes it to the glasses; unviewing disowns it', async () => {
  const h = harness();
  await h.connect();
  assert.equal(h.client.state().phase, 'connected');
  assert.deepEqual(h.client.state().sessions.map((row) => [row.socket, row.title]), [[BLOCK, 'work']]);

  h.client.connectSession(BLOCK);
  assert.deepEqual(h.open('session.attach')[0].payload, { session_id: SESSION });
  h.answer('session.attach', { client_id: SELF, view: WORK });
  await flush();
  assert.deepEqual(h.attached, ['work']);
  assert.equal(h.open('session.own_block').length, 0, 'attaching alone claims nothing');

  h.client.view();
  assert.deepEqual(h.answer('session.own_block', { blocks: [{ block_id: BLOCK, owner: SELF }] }).payload, { session_id: SESSION, block_ids: [BLOCK], mode: 'take' });
  await flush();
  assert.deepEqual(h.answer('com.superlogical.terminal.resize', {}).payload, { session_id: SESSION, block_id: BLOCK, args: { columns: COLS, rows: ROWS } });
  await flush();
  assert.equal(h.client.state().phase, 'attached');

  h.client.unview();
  assert.deepEqual(h.open('session.disown_block')[0].payload, { session_id: SESSION, block_ids: [BLOCK] });

  h.client.view();
  h.answer('session.disown_block', { blocks: [{ block_id: BLOCK }] });
  assert.equal(h.open('session.own_block').length, 1, 'viewing again takes it again');
});

test('stop closes the connection with a close frame, which hands an owned block back', async () => {
  const h = harness();
  await h.connect();
  await h.viewAsOwner();
  h.client.stop();
  assert.equal(h.socket().closed.code, 1000);
  assert.equal(h.client.state().phase, 'idle');
});

test('input goes through the queue in order, one request at a time', async () => {
  const h = harness();
  await h.connect();
  await h.viewAsOwner();
  const inputs = () => h.socket().sent.filter((m) => m.method === 'block.event' || m.method === 'com.superlogical.terminal.write');

  h.client.submitInput('ls');
  h.client.sendInput('\x1b[A');
  assert.equal(h.logs.filter((line) => line.startsWith('rex input sent')).length, 3);
  assert.equal(inputs().length, 1);
  assert.deepEqual(inputs()[0].payload, { session_id: SESSION, block_id: BLOCK, event: { type: 'paste', payload: { text: 'ls' } } });

  h.answer('block.event', {});
  assert.equal(inputs().length, 2);
  assert.equal(inputs()[1].payload.event.type, 'key');
  assert.equal(inputs()[1].payload.event.payload.key, 'enter');

  h.answer('block.event', {});
  assert.equal(inputs().length, 3);
  assert.deepEqual(inputs()[2].payload, { session_id: SESSION, block_id: BLOCK, args: { data: '\x1b[A' } });
});

test('a snapshot is read 50 ms after input, on block events, and every 500 ms while viewing', async () => {
  const h = harness();
  await h.connect();
  await h.viewAsOwner();
  h.timers.advance(0);
  h.answer('com.superlogical.terminal.format', { content: 'first' });
  await flush();
  assert.deepEqual(h.snapshots, [{ kind: 'snapshot', text: 'first' }]);

  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS - 1);
  assert.equal(h.open('com.superlogical.terminal.format').length, 0);
  h.timers.advance(1);
  assert.equal(h.open('com.superlogical.terminal.format').length, 1);
  h.answer('com.superlogical.terminal.format', { content: 'first' });
  await flush();
  assert.equal(h.snapshots.length, 1, 'an unchanged screen is not delivered again');

  h.client.sendInput('x');
  h.answer('com.superlogical.terminal.write', { bytes_written: 1 });
  await flush();
  h.timers.advance(REX_SNAPSHOT_AFTER_INPUT_MS - 1);
  assert.equal(h.open('com.superlogical.terminal.format').length, 0);
  h.timers.advance(1);
  h.answer('com.superlogical.terminal.format', { content: 'firstx' });
  await flush();

  h.blockEvent('bell');
  h.timers.advance(0);
  assert.equal(h.open('com.superlogical.terminal.format').length, 1);
  h.answer('com.superlogical.terminal.format', { content: 'firstx\x07' });
  await flush();
  assert.deepEqual(h.snapshots.map((s) => s.text), ['first', 'firstx', 'firstx\x07']);

  h.client.unview();
  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS * 4);
  assert.equal(h.open('com.superlogical.terminal.format').length, 0, 'no reads while not viewing');
});

test('one format read in flight at a time, and a read from before a re-claim is dropped', async () => {
  const h = harness();
  await h.connect();
  await h.viewAsOwner();
  h.timers.advance(0);
  assert.equal(h.open('com.superlogical.terminal.format').length, 1);
  h.blockEvent('title_changed', { title: 'vim' });
  h.blockEvent('process_changed', { generation: 2 });
  h.timers.advance(REX_SNAPSHOT_INTERVAL_MS);
  assert.equal(h.open('com.superlogical.terminal.format').length, 1, 'triggers while reading wait for the read');

  h.client.setViewport(COLS + 2, ROWS);
  h.answer('com.superlogical.terminal.format', { content: 'before the resize' });
  await flush();
  assert.equal(h.snapshots.length, 0, 'a read started before the re-claim is never delivered');
  h.answer('session.own_block', { blocks: [{ block_id: BLOCK, owner: SELF }] });
  await flush();
  assert.deepEqual(h.answer('com.superlogical.terminal.resize', {}).payload.args, { columns: COLS + 2, rows: ROWS });
  await flush();
  h.timers.advance(0);
  assert.equal(h.open('com.superlogical.terminal.format').length, 1);
  h.answer('com.superlogical.terminal.format', { content: 'after the resize' });
  await flush();
  assert.deepEqual(h.snapshots.map((s) => s.text), ['after the resize']);
});

test('a screen too large for one reply is read on with blob_read from the byte offset', async () => {
  const h = harness();
  const snapshots = [];
  h.client.onSnapshot((next, oldest) => snapshots.push([next, oldest]));
  await h.connect();
  await h.viewAsOwner();
  h.timers.advance(0);
  const format = h.answer('com.superlogical.terminal.format', { content: 'héllo ', id: 7, total: 13 });
  assert.equal(format.payload.args.format, 'vt');
  assert.ok(Object.keys(format.payload.args).filter((key) => key.startsWith('extra_')).every((key) => format.payload.args[key] === true));
  await flush();
  assert.deepEqual(h.answer('com.superlogical.terminal.blob_read', { id: 7, data: 'world', total: 13, eof: false }).payload.args, { id: 7, offset: 7, max_bytes: format.payload.args.max_bytes });
  await flush();
  assert.equal(h.open('com.superlogical.terminal.blob_read')[0].payload.args.offset, 12);
  h.answer('com.superlogical.terminal.blob_read', { id: 7, data: '!', total: 13, eof: true });
  await flush();
  assert.deepEqual(h.snapshots, [{ kind: 'snapshot', text: 'héllo world!' }]);
  assert.deepEqual(snapshots, [[0, 0]]);
});

test('another client taking the viewed block shows its screen with a notice; viewing again takes it back', async () => {
  const h = harness();
  await h.connect();
  await h.viewAsOwner();
  h.timers.advance(0);
  h.answer('com.superlogical.terminal.format', { content: 'glasses size' });
  await flush();

  h.ownerChanged(MAC);
  assert.equal(h.client.state().phase, 'connected');
  assert.equal(h.client.state().status, REX_OTHER_OWNER_NOTICE);
  h.timers.advance(0);
  h.answer('com.superlogical.terminal.format', { content: 'mac size' });
  await flush();
  assert.equal(h.snapshots.at(-1).text, 'mac size', 'the screen keeps refreshing at the host size');
  assert.equal(h.open('session.own_block').length, 0, 'the glasses do not fight for the block');

  h.client.view();
  h.answer('session.own_block', { blocks: [{ block_id: BLOCK, owner: SELF }] });
  await flush();
  h.answer('com.superlogical.terminal.resize', {});
  await flush();
  assert.equal(h.client.state().phase, 'attached');

  h.ownerChanged(MAC);
  h.ownerChanged(SELF);
  assert.equal(h.client.state().phase, 'attached', 'the block coming back ends the notice');
});

test('bells, titles and program activity map to the Terminal events', async () => {
  const h = harness();
  const heard = [];
  h.client.onBell((socket, at) => heard.push(['bell', socket, at]));
  h.client.onTitle((socket, title) => heard.push(['title', socket, title]));
  h.client.onActivity((socket, at) => heard.push(['activity', socket, at]));
  await h.connect();
  h.timers.advance(1234);
  h.blockEvent('bell');
  h.blockEvent('title_changed', { title: 'vim' });
  h.blockEvent('progress_report', { state: 'set', progress: 40 });
  h.blockEvent('size_changed', { columns: 80, rows: 24 });
  assert.deepEqual(heard, [['bell', BLOCK, 1234], ['title', BLOCK, 'vim'], ['activity', BLOCK, 1234]]);
});

test('a lost connection reconnects inside the client and re-claims the viewed block', async () => {
  const h = harness();
  await h.connect();
  await h.viewAsOwner();
  h.socket().handlers.onClose(1006, '');
  assert.equal(h.client.state().phase, 'connecting');
  assert.equal(h.client.state().retryable, true);
  h.timers.advance(REX_RECONNECT_MIN_DELAY_MS);
  await h.handshake();
  h.answer('session.attach', { client_id: SELF, view: WORK });
  await flush();
  assert.equal(h.open('session.own_block').length, 1);
});

test('a launch creates a session with one shell block running the preset', async () => {
  const h = harness();
  await h.connect();
  const launched = h.client.launchSession('htop -d 5');
  assert.deepEqual(h.open('session.create')[0].payload, {
    initial_windows: [{ layout: { block: { flavor: 'com.superlogical.terminal.shell', options: { command: ['htop', '-d', '5'] } } } }],
  });
  h.answer('session.create', { session_id: 'session:new', initial_windows: [{ window_id: 'window:new', block_ids: ['block:new'], revision: 1 }] });
  assert.equal(await launched, 'block:new');

  h.client.launchSession('shell').catch(() => {});
  assert.deepEqual(h.open('session.create')[0].payload.initial_windows[0].layout.block, { flavor: 'com.superlogical.terminal.shell' });
  await assert.rejects(h.client.launchSession('rm -rf "$HOME"'));
});
