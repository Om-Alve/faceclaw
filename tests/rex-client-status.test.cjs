const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { RexClient } = require('../.test-build/app/apps/terminal/rex-client.js');
const { REX_RECONNECT_MIN_DELAY_MS } = require('../.test-build/app/apps/terminal/rex/control.js');
const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');

// Recorded from the live Rex server by scripts/rex-status-fixtures.mjs.
const fixture = (name) => require(path.join(__dirname, 'fixtures', 'rex', name));
const READ = fixture('status-read.json');
const REREAD = fixture('status-read-reconnect.json');
const EVENTS = fixture('status-events.json');
const BLOCKED_MSG = 'Approve edit to naïve.ts? ✅ 日本語';
const BLOCKED = { state: 'blocked', kind: 'permission', msg: BLOCKED_MSG };
const AGENT_2_BLOCKED = EVENTS[2].payload;
const AGENT_2_WORKING = EVENTS[5].payload;
const NOTIFICATION = EVENTS.find((e) => e.name === 'desktop_notification').payload;

const PROGRAM_STATUS = 'com.superlogical.terminal.program_status';
const SELF = 'client:glasses';
const WORK = 'session:work';
const PLAY = 'session:play';
const A = 'block:0000000a-0000-0000-0000-00000000000a';
const B = 'block:0000000b-0000-0000-0000-00000000000b';
const C = 'block:0000000c-0000-0000-0000-00000000000c';
const NOT_TERMINAL = 'block:0000000d-0000-0000-0000-00000000000d';
const EMPTY = { records: [] };

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

const block = (id, creator = 'com.superlogical.terminal') => ({ block_id: id, label: 'shell', creator_name: creator, flavor: `${creator}.shell` });
const view = (sessionId, label, blocks) => ({
  revision: 1,
  session_id: sessionId,
  label,
  windows: [{ window_id: `window:${sessionId}`, label: '', layers: [{ layer_id: 'layer:0', kind: 'tiled', bounds: [0, 0, 1, 1], layout: null, blocks }] }],
});
const WORK_VIEW = view(WORK, 'work', [block(A), block(B), block(NOT_TERMINAL, 'com.superlogical.onboarding')]);
const PLAY_VIEW = view(PLAY, 'play', [block(C)]);

function harness() {
  const timers = fakeTimers();
  const sockets = [];
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
    timers,
    now: timers.now,
    cols: 58,
    rows: 11,
    log: (line) => logs.push(line),
  });
  const bells = [];
  const states = [];
  client.onBell((socket, at) => bells.push([socket, at]));
  client.onStateChange((state) => states.push(state));
  const socket = () => sockets.at(-1);
  const receive = (message) => socket().handlers.onMessage(JSON.stringify(message));
  const open = (method) => socket().sent.filter((m) => m.type === 'request' && !socket().answered.has(m.id) && m.method === method);
  const reply = (request, body) => {
    socket().answered.add(request.id);
    receive({ type: 'response', id: request.id, seq: 0, ...body });
  };
  const answer = (method, payload) => {
    const [request] = open(method);
    assert.ok(request, `a ${method} request is waiting`);
    reply(request, { payload });
    return request;
  };
  const statusRequest = (blockId) => open(PROGRAM_STATUS).find((request) => request.payload.block_id === blockId);
  /** Answer the status read of each block in `results`, by block ID; an Error answers with a server error. */
  async function answerStatus(results) {
    for (const [blockId, result] of Object.entries(results)) {
      const request = statusRequest(blockId);
      assert.ok(request, `a status read for ${blockId} is waiting`);
      reply(request, result instanceof Error ? { error: { code: 'internal', message: result.message, status: 500 } } : { payload: result });
    }
    await flush();
  }
  async function handshake(views) {
    socket().handlers.onOpen();
    receive({ type: 'welcome', protocol: 'rex.control.v1', api_revision: 18, limits: { max_message_bytes: 1048576 }, client: { id: SELF, reconnect_token: 't' } });
    answer('session.bootstrap', { client_id: SELF, attach_all: { sessions: views.map((v) => ({ session_id: v.session_id, label: v.label })) } });
    for (const v of views) answer('session.view', v);
    await flush();
  }
  async function connect(views = [WORK_VIEW, PLAY_VIEW]) {
    client.start();
    await handshake(views);
  }
  async function reconnect(views = [WORK_VIEW, PLAY_VIEW]) {
    socket().handlers.onClose(1006, '');
    timers.advance(REX_RECONNECT_MIN_DELAY_MS);
    await handshake(views);
  }
  const sessionEvent = (sessionId, inner) => receive({ type: 'event', seq: 0, payload: { type: 'session_event', payload: { session_id: sessionId, event: inner } } });
  const blockEvent = (blockId, name, payload = {}) => sessionEvent(blockId === C ? PLAY : WORK, { type: 'block_event', payload: { block_id: blockId, name, payload } });
  const statusOf = (blockId) => client.state().sessions.find((row) => row.socket === blockId)?.status;
  return { client, timers, logs, bells, states, socket, open, answer, answerStatus, statusRequest, connect, reconnect, receive, blockEvent, statusOf };
}

test('status is read for every terminal block when the connection becomes ready, and rows carry it', async () => {
  const h = harness();
  await h.connect();
  assert.deepEqual(h.open(PROGRAM_STATUS).map((r) => r.payload), [
    { session_id: WORK, block_id: A, args: {} },
    { session_id: WORK, block_id: B, args: {} },
    { session_id: PLAY, block_id: C, args: {} },
  ]);
  const emitted = h.states.length;
  await h.answerStatus({ [A]: READ, [B]: EMPTY, [C]: { records: [AGENT_2_WORKING.record] } });
  assert.deepEqual(h.statusOf(A), BLOCKED);
  assert.equal(h.statusOf(B), undefined);
  assert.deepEqual(h.statusOf(C), { state: 'working', msg: 'Editing naïve.ts' });
  assert.ok(h.states.length > emitted, 'a status change repaints the rows');
  assert.deepEqual(h.states.at(-1).sessions.find((row) => row.socket === A).status, BLOCKED);
  assert.deepEqual(h.bells, [[A, 0]], 'a pane already blocked at the first connect raises attention once');
});

test('a record entering blocked on a block not viewed raises attention once, and clearing it clears the row', async () => {
  const h = harness();
  await h.connect();
  await h.answerStatus({ [A]: EMPTY, [B]: EMPTY, [C]: EMPTY });
  h.timers.advance(500);
  h.blockEvent(B, 'program_status_changed', AGENT_2_BLOCKED);
  assert.deepEqual(h.statusOf(B), BLOCKED);
  assert.deepEqual(h.bells, [[B, 500]]);
  h.blockEvent(B, 'program_status_changed', AGENT_2_BLOCKED);
  assert.equal(h.bells.length, 1, 'the same blocked record again raises nothing');
  h.blockEvent(B, 'program_status_removed', { ids: ['', 'agent-2'], reason: 'clear' });
  assert.equal(h.statusOf(B), undefined);
  h.blockEvent(B, 'program_status_changed', AGENT_2_BLOCKED);
  assert.deepEqual(h.bells, [[B, 500], [B, 500]], 'blocking again after a clear raises again');
});

test('a desktop notification and a bell raise attention', async () => {
  const h = harness();
  await h.connect();
  await h.answerStatus({ [A]: EMPTY, [B]: EMPTY, [C]: EMPTY });
  h.blockEvent(C, 'desktop_notification', NOTIFICATION);
  h.blockEvent(A, 'bell');
  assert.deepEqual(h.bells, [[C, 0], [A, 0]]);
  assert.equal(h.statusOf(C), undefined);
});

test('nothing raises attention for the block this client views', async () => {
  const h = harness();
  await h.connect();
  await h.answerStatus({ [A]: EMPTY, [B]: EMPTY, [C]: EMPTY });
  h.client.onSessionAttached(() => h.client.view());
  h.client.connectSession(A);
  h.answer('session.attach', { client_id: SELF, view: WORK_VIEW });
  await flush();
  h.answer('session.own_block', { blocks: [{ block_id: A, owner: SELF }] });
  await flush();
  h.answer('com.superlogical.terminal.resize', {});
  await flush();
  h.blockEvent(A, 'program_status_changed', AGENT_2_BLOCKED);
  h.blockEvent(A, 'bell');
  assert.deepEqual(h.statusOf(A), BLOCKED);
  assert.deepEqual(h.bells, []);
  h.blockEvent(B, 'program_status_changed', AGENT_2_BLOCKED);
  assert.deepEqual(h.bells, [[B, 0]]);
});

test('a reconnect re-reads status and raises nothing already reported', async () => {
  const h = harness();
  await h.connect();
  await h.answerStatus({ [A]: READ, [B]: EMPTY, [C]: EMPTY });
  assert.equal(h.bells.length, 1);
  await h.reconnect();
  assert.equal(h.open(PROGRAM_STATUS).length, 3);
  assert.deepEqual(h.statusOf(A), BLOCKED, 'the row keeps its status while the read is in flight');
  await h.answerStatus({ [A]: REREAD, [B]: EMPTY, [C]: EMPTY });
  assert.deepEqual(h.statusOf(A), BLOCKED);
  assert.equal(h.bells.length, 1);
});

test('a block that closes is forgotten, so it raises again if it comes back blocked', async () => {
  const h = harness();
  await h.connect();
  await h.answerStatus({ [A]: EMPTY, [B]: EMPTY, [C]: READ });
  assert.deepEqual(h.bells, [[C, 0]]);
  h.receive({ type: 'event', seq: 0, payload: { type: 'session_destroyed', payload: { session_id: PLAY } } });
  assert.equal(h.statusOf(C), undefined);
  await h.reconnect();
  await h.answerStatus({ [A]: EMPTY, [B]: EMPTY, [C]: READ });
  assert.deepEqual(h.bells, [[C, 0], [C, REX_RECONNECT_MIN_DELAY_MS]]);
});

test('a status read that arrives after its block closed is dropped', async () => {
  const h = harness();
  await h.connect();
  h.receive({ type: 'event', seq: 0, payload: { type: 'session_destroyed', payload: { session_id: PLAY } } });
  await h.answerStatus({ [A]: EMPTY, [B]: EMPTY, [C]: READ });
  assert.deepEqual(h.bells, []);
});

test('a failed status read for one block leaves the others working', async () => {
  const h = harness();
  await h.connect();
  await h.answerStatus({ [A]: new Error('boom'), [B]: { records: [{ state: 'working' }] }, [C]: READ });
  assert.equal(h.statusOf(A), undefined);
  assert.equal(h.statusOf(B), undefined);
  assert.deepEqual(h.statusOf(C), BLOCKED);
  assert.deepEqual(h.bells, [[C, 0]]);
  assert.equal(h.logs.filter((line) => line.startsWith('rex: status read failed')).length, 2);
  assert.match(h.logs.find((line) => line.includes(A)), /boom/);
  assert.match(h.logs.find((line) => line.includes(B)), /updated_at/);
  h.blockEvent(A, 'program_status_changed', AGENT_2_BLOCKED);
  assert.deepEqual(h.statusOf(A), BLOCKED, 'events still update a block whose read failed');
});
