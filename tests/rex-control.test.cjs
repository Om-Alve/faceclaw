const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RexControl,
  RexCallError,
  REX_CALL_TIMEOUT_MS,
  REX_RECONNECT_MIN_DELAY_MS,
  REX_RECONNECT_MAX_DELAY_MS,
} = require('../.test-build/app/apps/terminal/rex/control.js');

function fakeTimers() {
  let nextId = 1;
  let clock = 0;
  const timeouts = new Map();
  return {
    setTimeout(callback, ms) {
      const id = nextId++;
      timeouts.set(id, { callback, at: clock + ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    /** Fire everything due within `ms`, in time order. */
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

const session = (id, revision, blocks) => ({ id, revision, blocks });

const viewPayload = ({ id, revision, blocks }) => ({
  revision,
  session_id: id,
  label: id,
  windows: [
    {
      window_id: `window:${id}`,
      label: 'main',
      layers: [{ layer_id: `layer:${id}`, kind: 'tiled', bounds: [0, 0, 1, 1], layout: null, blocks: blocks.map((block) => ({ block_id: block, label: 'shell' })) }],
    },
  ],
});

const sessionEvent = (sessionId, type, payload) => ({ type: 'session_event', payload: { session_id: sessionId, event: { type, payload } } });

function harness() {
  const timers = fakeTimers();
  const sockets = [];
  const control = new RexControl({
    url: 'ws://127.0.0.1:8792/api/control',
    client: { kind: 'app', name: 'faceclaw-test', version: '1' },
    timers,
    createSocket: (url, subprotocol, handlers) => {
      const socket = {
        url,
        subprotocol,
        handlers,
        sent: [],
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
  });
  const states = [];
  control.onStateChange((state) => states.push(state));
  const current = () => sockets.at(-1);
  const receive = (message, socket = current()) => socket.handlers.onMessage(JSON.stringify(message));
  const requests = (method, socket = current()) => socket.sent.filter((message) => message.type === 'request' && (!method || message.method === method));
  const respond = (request, payload, seq = 0) => receive({ type: 'response', id: request.id, seq, payload });
  const fail = (request, code, status) => receive({ type: 'response', id: request.id, seq: 0, error: { code, message: `${code} message`, status } });
  const event = (seq, payload) => receive({ type: 'event', seq, payload });
  const welcome = ({ id = 'client:1', token = 'token-1', resumed = false } = {}) =>
    receive({ type: 'welcome', protocol: 'rex.control.v1', api_revision: 18, limits: { max_message_bytes: 1048576 }, client: { id, reconnect_token: token, resumed } });
  const bootstrap = (sessions, seq = 0) =>
    respond(requests('session.bootstrap').at(-1), { client_id: 'client:1', attach_all: { sessions: sessions.map((s) => ({ session_id: s.id, label: s.id })) } }, seq);
  const viewRequest = (sessionId) => requests('session.view').filter((request) => request.payload.session_id === sessionId).at(-1);
  const answerViews = (sessions) => {
    for (const s of sessions) respond(viewRequest(s.id), viewPayload(s));
  };
  /** Open the current socket, finish the handshake, and answer bootstrap and every view. */
  const handshake = (sessions, welcomeOptions) => {
    current().handlers.onOpen();
    welcome(welcomeOptions);
    bootstrap(sessions);
    answerViews(sessions);
  };
  return { control, timers, sockets, states, current, receive, requests, respond, fail, event, welcome, bootstrap, viewRequest, answerViews, handshake };
}

const blockIds = (control) => control.sessions().flatMap((view) => view.windows.flatMap((window) => window.blocks.map((block) => block.blockId)));

test('hello asks for rex.control.v1 at revision 18 and the client becomes ready after every view arrives', () => {
  const h = harness();
  h.control.start();
  assert.equal(h.current().subprotocol, 'rex.control.v1');
  assert.equal(h.current().url, 'ws://127.0.0.1:8792/api/control');
  h.current().handlers.onOpen();
  const [hello] = h.current().sent;
  assert.equal(hello.type, 'hello');
  assert.equal(hello.api_revision, 18);
  assert.equal(hello.reconnect_token, undefined);
  h.welcome();
  assert.deepEqual(h.requests('session.bootstrap')[0].payload, { event_scope: 'all', attach_session_ids: [] });
  h.bootstrap([session('session:a', 1, ['block:a1']), session('session:b', 1, ['block:b1'])]);
  h.respond(h.viewRequest('session:a'), viewPayload(session('session:a', 1, ['block:a1'])));
  assert.equal(h.control.state().phase, 'syncing');
  h.respond(h.viewRequest('session:b'), viewPayload(session('session:b', 1, ['block:b1'])));
  assert.deepEqual(h.control.state(), { phase: 'ready', clientId: 'client:1', resumed: false });
  assert.deepEqual(blockIds(h.control), ['block:a1', 'block:b1']);
});

test('the newest reconnect token goes into the next hello', () => {
  const h = harness();
  h.control.start();
  h.handshake([], { token: 'token-1' });
  h.current().handlers.onClose(1006, '');
  h.timers.advance(REX_RECONNECT_MIN_DELAY_MS);
  h.current().handlers.onOpen();
  assert.equal(h.current().sent[0].reconnect_token, 'token-1');
  h.welcome({ token: 'token-2', resumed: true });
  h.bootstrap([]);
  assert.deepEqual(h.control.state(), { phase: 'ready', clientId: 'client:1', resumed: true });

  // A connection that drops before its welcome keeps the token it already had.
  h.current().handlers.onClose(1006, '');
  h.timers.advance(REX_RECONNECT_MIN_DELAY_MS);
  h.current().handlers.onOpen();
  assert.equal(h.current().sent[0].reconnect_token, 'token-2');
  h.current().handlers.onClose(1006, '');
  h.timers.advance(REX_RECONNECT_MAX_DELAY_MS);
  h.current().handlers.onOpen();
  assert.equal(h.current().sent[0].reconnect_token, 'token-2');
});

test('reconnects back off from 1 s to 60 s and reset once ready', () => {
  const h = harness();
  h.control.start();
  const delays = [];
  for (let i = 0; i < 9; i++) {
    h.current().handlers.onClose(1006, 'connection refused');
    const state = h.control.state();
    assert.equal(state.phase, 'backoff');
    delays.push(state.delayMs);
    const socketsBefore = h.sockets.length;
    h.timers.advance(state.delayMs - 1);
    assert.equal(h.sockets.length, socketsBefore, 'no socket before the delay');
    h.timers.advance(1);
    assert.equal(h.sockets.length, socketsBefore + 1);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  h.handshake([]);
  h.current().handlers.onClose(1006, '');
  assert.equal(h.control.state().delayMs, REX_RECONNECT_MIN_DELAY_MS);
});

test('a connection with no welcome in time is dropped and retried', () => {
  const h = harness();
  h.control.start();
  h.current().handlers.onOpen();
  h.timers.advance(10_000);
  assert.equal(h.control.state().phase, 'backoff');
  assert.deepEqual(h.sockets[0].closed?.code, 1000);
});

test('a server with no common API revision stops the retries', () => {
  const h = harness();
  h.control.start();
  h.current().handlers.onOpen();
  h.current().handlers.onClose(1008, 'no common API revision: update the client');
  assert.equal(h.control.state().phase, 'failed');
  h.timers.advance(REX_RECONNECT_MAX_DELAY_MS);
  assert.equal(h.sockets.length, 1);
});

test('session_view_changed fetches a view only for a newer revision and never applies an older view', () => {
  const h = harness();
  h.control.start();
  h.handshake([session('session:a', 5, ['block:1'])]);
  const views = () => h.requests('session.view').length;
  const revision = () => h.control.sessions()[0].revision;
  assert.equal(views(), 1);

  h.event(1, sessionEvent('session:a', 'session_view_changed', { revision: 5 }));
  assert.equal(views(), 1, 'a revision the view already has fetches nothing');

  h.event(2, sessionEvent('session:a', 'session_view_changed', { revision: 7 }));
  assert.equal(views(), 2);
  h.event(3, sessionEvent('session:a', 'session_view_changed', { revision: 6 }));
  h.event(4, sessionEvent('session:a', 'session_view_changed', { revision: 9 }));
  assert.equal(views(), 2, 'one fetch in flight at a time');

  h.respond(h.viewRequest('session:a'), viewPayload(session('session:a', 7, ['block:1', 'block:2'])));
  assert.equal(revision(), 7);
  assert.equal(views(), 3, 'revision 9 is still newer, so it fetches again');

  // Responses can be slower than events: a view older than the model is dropped.
  h.respond(h.viewRequest('session:a'), viewPayload(session('session:a', 4, ['block:old'])));
  assert.equal(revision(), 7);
  assert.deepEqual(blockIds(h.control), ['block:1', 'block:2']);
});

test('events at or below the bootstrap response seq are skipped, later ones are applied once', () => {
  const h = harness();
  const notices = [];
  h.control.onBlockEvent((notice) => notices.push(notice));
  h.control.start();
  h.current().handlers.onOpen();
  h.welcome();
  const bell = (sessionId, blockId) => sessionEvent(sessionId, 'block_event', { block_id: blockId, name: 'bell', payload: {} });
  h.event(1, { type: 'session_created', payload: { session: { session_id: 'session:b', label: 'b' } } });
  h.event(2, bell('session:b', 'block:b1'));
  h.event(3, { type: 'session_created', payload: { session: { session_id: 'session:c', label: 'c' } } });
  h.event(4, bell('session:c', 'block:c1'));
  h.bootstrap([session('session:a', 1, []), session('session:b', 1, [])], 2);
  assert.deepEqual(
    h.requests('session.view').map((request) => request.payload.session_id),
    ['session:a', 'session:b', 'session:c'],
  );
  assert.deepEqual(notices.map((notice) => notice.blockId), ['block:c1']);
  h.answerViews([session('session:a', 1, ['block:a1']), session('session:b', 1, ['block:b1']), session('session:c', 1, ['block:c1'])]);
  assert.equal(h.control.state().phase, 'ready');
  assert.deepEqual(blockIds(h.control), ['block:a1', 'block:b1', 'block:c1']);
});

test('a reconnect that does not resume rebuilds the model with no duplicate blocks', () => {
  const h = harness();
  const models = [];
  h.control.onModelChange((sessions) => models.push(sessions));
  h.control.start();
  h.handshake([session('session:a', 3, ['block:1', 'block:2']), session('session:gone', 1, ['block:9'])]);
  h.current().handlers.onClose(1006, '');
  h.timers.advance(REX_RECONNECT_MIN_DELAY_MS);
  assert.deepEqual(blockIds(h.control), ['block:1', 'block:2', 'block:9'], 'the old model stays until the new one is complete');
  h.handshake([session('session:a', 3, ['block:1', 'block:2'])], { id: 'client:2', token: 'token-2', resumed: false });
  assert.deepEqual(h.control.state(), { phase: 'ready', clientId: 'client:2', resumed: false });
  assert.deepEqual(blockIds(h.control), ['block:1', 'block:2']);
  assert.deepEqual(blockIds({ sessions: () => models.at(-1) }), ['block:1', 'block:2']);
});

test('session_created and session_destroyed add and drop sessions', () => {
  const h = harness();
  h.control.start();
  h.handshake([session('session:a', 1, ['block:a1'])]);
  h.event(1, { type: 'session_created', payload: { session: { session_id: 'session:b', label: 'b' } } });
  h.respond(h.viewRequest('session:b'), viewPayload(session('session:b', 1, ['block:b1'])));
  assert.deepEqual(blockIds(h.control), ['block:a1', 'block:b1']);
  h.event(2, { type: 'session_destroyed', payload: { session_id: 'session:a' } });
  assert.deepEqual(blockIds(h.control), ['block:b1']);
});

test('a session that vanishes while its view is fetched is dropped without a reconnect', () => {
  const h = harness();
  const models = [];
  h.control.onModelChange((sessions) => models.push(sessions));
  h.control.start();
  h.handshake([session('session:a', 1, ['block:a1']), session('session:b', 1, ['block:b1'])]);
  h.event(1, sessionEvent('session:a', 'session_view_changed', { revision: 2 }));
  h.fail(h.viewRequest('session:a'), 'session_not_found', 404);
  assert.equal(h.control.state().phase, 'ready');
  assert.equal(h.current().closed, null);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(blockIds(h.control), ['block:b1']);
  assert.deepEqual(blockIds({ sessions: () => models.at(-1) }), ['block:b1']);
});

test('block events reach listeners typed and routed by block id; unknown ones do not', () => {
  const h = harness();
  const notices = [];
  h.control.onBlockEvent((notice) => notices.push(notice));
  h.control.start();
  h.handshake([session('session:a', 1, ['block:1'])]);
  h.event(1, sessionEvent('session:a', 'block_event', { block_id: 'block:1', name: 'title_changed', payload: { title: 'vim' } }));
  h.event(2, sessionEvent('session:a', 'block_event', { block_id: 'block:1', name: 'url_clicked', payload: { url: 'https://x' } }));
  h.event(3, sessionEvent('session:a', 'block_owner_changed', { block_id: 'block:1', owner: 'client:mac', reason: 'take' }));
  h.receive({ type: 'telemetry' });
  assert.deepEqual(notices, [
    { sessionId: 'session:a', blockId: 'block:1', event: { name: 'title_changed', title: 'vim' } },
    { sessionId: 'session:a', blockId: 'block:1', event: { name: 'block_owner_changed', owner: 'client:mac', previous: undefined, reason: 'take' } },
  ]);
  assert.equal(h.control.state().phase, 'ready');
});

test('input requests go out one at a time, each after the previous response', async () => {
  const h = harness();
  h.control.start();
  h.handshake([session('session:a', 1, ['block:1'])]);
  const target = { sessionId: 'session:a', blockId: 'block:1' };
  const results = [
    h.control.sendInput({ kind: 'write', ...target, data: 'ls' }),
    h.control.sendInput({ kind: 'paste', ...target, text: 'echo hi' }),
    h.control.sendInput({ kind: 'key', ...target, key: { key: 'enter', mods: '', consumed_mods: '', text: '\r', unshifted_codepoint: 0, composing: false, action: 'press' } }),
  ];
  const inputs = () => h.requests().filter((request) => request.method !== 'session.bootstrap' && request.method !== 'session.view');
  assert.equal(inputs().length, 1);
  assert.deepEqual(inputs()[0].payload, { session_id: 'session:a', block_id: 'block:1', args: { data: 'ls' } });
  assert.equal(inputs()[0].method, 'com.superlogical.terminal.write');
  h.respond(inputs()[0], { bytes_written: 2 });
  assert.equal(inputs().length, 2);
  assert.equal(inputs()[1].method, 'block.event');
  assert.deepEqual(inputs()[1].payload.event, { type: 'paste', payload: { text: 'echo hi' } });
  h.respond(inputs()[1], {});
  assert.equal(inputs().length, 3);
  assert.equal(inputs()[2].payload.event.type, 'key');
  h.respond(inputs()[2], {});
  await Promise.all(results);
});

test('a timed-out write stays failed and is never sent again', async () => {
  const h = harness();
  h.control.start();
  h.handshake([session('session:a', 1, ['block:1'])]);
  const target = { sessionId: 'session:a', blockId: 'block:1' };
  const first = h.control.sendInput({ kind: 'write', ...target, data: 'one' });
  const second = h.control.sendInput({ kind: 'write', ...target, data: 'two' });
  const writes = () => h.sockets.flatMap((socket) => h.requests('com.superlogical.terminal.write', socket));
  h.timers.advance(REX_CALL_TIMEOUT_MS);
  await assert.rejects(first, (error) => error instanceof RexCallError && error.failure.kind === 'timeout');
  assert.deepEqual(writes().map((request) => request.payload.args.data), ['one', 'two']);
  h.respond(writes()[0], { bytes_written: 3 });
  h.respond(writes()[1], { bytes_written: 3 });
  await second;
  h.current().handlers.onClose(1006, '');
  h.timers.advance(REX_RECONNECT_MIN_DELAY_MS);
  h.handshake([session('session:a', 1, ['block:1'])], { resumed: true });
  assert.deepEqual(writes().map((request) => request.payload.args.data), ['one', 'two']);
});

test('a failed call rejects with the server error code and the connection stays open', async () => {
  const h = harness();
  h.control.start();
  h.handshake([]);
  const missing = h.control.call('no.such.method', {});
  h.fail(h.requests('no.such.method')[0], 'method_not_found', 404);
  await assert.rejects(missing, (error) => error instanceof RexCallError && error.failure.kind === 'server' && error.failure.code === 'method_not_found' && error.failure.status === 404);
  const bad = h.control.call('session.view', {});
  h.fail(h.requests('session.view').at(-1), 'bad_request', 400);
  await assert.rejects(bad, (error) => error.failure.code === 'bad_request');
  assert.equal(h.control.state().phase, 'ready');
  assert.equal(h.current().closed, null);
});

test('calls in flight fail as disconnected when the connection drops, and calls before ready fail at once', async () => {
  const h = harness();
  await assert.rejects(h.control.call('server.status'), (error) => error.failure.kind === 'not-ready');
  h.control.start();
  h.handshake([]);
  const pending = h.control.call('server.status');
  const queued = [
    h.control.sendInput({ kind: 'write', sessionId: 's', blockId: 'b', data: 'a' }),
    h.control.sendInput({ kind: 'write', sessionId: 's', blockId: 'b', data: 'b' }),
  ];
  h.current().handlers.onClose(1006, '');
  await assert.rejects(pending, (error) => error.failure.kind === 'disconnected');
  for (const input of queued) await assert.rejects(input, (error) => error.failure.kind === 'disconnected');
});

test('stop closes the connection, clears the model and cancels the retry', () => {
  const h = harness();
  h.control.start();
  h.handshake([session('session:a', 1, ['block:1'])]);
  h.control.stop();
  assert.deepEqual(h.control.state(), { phase: 'idle' });
  assert.deepEqual(h.control.sessions(), []);
  assert.equal(h.current().closed.code, 1000);
  h.timers.advance(REX_RECONNECT_MAX_DELAY_MS);
  assert.equal(h.sockets.length, 1);
});
