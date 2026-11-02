const test = require('node:test');
const assert = require('node:assert/strict');
const { HerdrMachineClient, RECONNECT_MIN_MS } = require('../.test-build/app/apps/herdr/client.js');

/** A manual timer queue so tests drive the client's backoff and timeouts. */
function fakeTimers() {
  let nextId = 1;
  let clock = 0;
  const timeouts = new Map();
  const intervals = new Map();

  const timers = {
    setTimeout(callback, ms) {
      const id = nextId++;
      timeouts.set(id, { callback, at: clock + ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback, ms) {
      const id = nextId++;
      intervals.set(id, { callback, every: Math.max(1, ms), at: clock + Math.max(1, ms) });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    /** Fire everything due within `ms`, in time order; intervals repeat. */
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        let pick = null;
        for (const [id, entry] of timeouts) {
          if (entry.at <= target && (!pick || entry.at < pick.at || (entry.at === pick.at && id < pick.id))) pick = { type: 'timeout', id, at: entry.at };
        }
        for (const [id, entry] of intervals) {
          if (entry.at <= target && (!pick || entry.at < pick.at || (entry.at === pick.at && id < pick.id))) pick = { type: 'interval', id, at: entry.at };
        }
        if (!pick) break;
        clock = pick.at;
        if (pick.type === 'timeout') {
          const entry = timeouts.get(pick.id);
          timeouts.delete(pick.id);
          entry.callback();
        } else {
          const entry = intervals.get(pick.id);
          if (!entry) continue;
          entry.at = clock + entry.every;
          entry.callback();
        }
      }
      clock = target;
    },
    now: () => clock,
    pendingTimeouts: () => timeouts.size,
    pendingIntervals: () => intervals.size,
  };
  return timers;
}

const hello = (protocol = 2) => ({ t: 'hello', protocol, machine: 'mac', herdrVersion: '0.4.1', user: 'om', snippets: [] });

function harness(options = {}) {
  const timers = fakeTimers();
  const sockets = [];
  const client = new HerdrMachineClient({
    machine: { id: 'm1', label: 'mac', url: 'https://mac.example' },
    ...options,
    createSocket: (url, handlers) => {
      const socket = {
        url,
        handlers,
        sent: [],
        closed: null,
        send(text) {
          socket.sent.push(JSON.parse(text));
        },
        close(code, reason) {
          socket.closed = { code, reason };
        },
      };
      sockets.push(socket);
      return socket;
    },
    timers,
    now: () => timers.now(),
  });
  const current = () => sockets[sockets.length - 1];
  const open = (socket = current()) => socket.handlers.onOpen();
  const receive = (message, socket = current()) => socket.handlers.onMessage(typeof message === 'string' ? message : JSON.stringify(message));
  const drop = (reason, socket = current()) => socket.handlers.onClose(reason);
  return {
    client,
    timers,
    sockets,
    current,
    open,
    receive,
    drop,
    sent: () => current().sent,
    last: () => current().sent.at(-1),
    /** Start, open the socket, and complete the hello handshake. */
    connect(protocol = 2) {
      client.start();
      open();
      receive(hello(protocol));
      return current();
    },
  };
}

function pane(id, overrides = {}) {
  return {
    id,
    session: 'default',
    paneId: id.split('/')[1] ?? id,
    workspace: 'faceclaw',
    tab: 'main',
    agent: 'claude',
    status: 'idle',
    title: 'claude',
    chat: 'transcript',
    subagents: 0,
    stateSeq: 1,
    ...overrides,
  };
}

const entry = (id, text, kind = 'assistant') => ({ id, text, kind });

test('hello moves to connected and records the bridge identity', () => {
  const h = harness();
  h.client.start();
  assert.equal(h.client.snapshot.phase, 'connecting');
  h.open();
  h.receive({ ...hello(2), machine: 'mac-mini', snippets: [{ label: 'yes', keys: ['y'] }] });

  const snapshot = h.client.snapshot;
  assert.equal(snapshot.machineId, 'm1');
  assert.equal(snapshot.label, 'mac');
  assert.equal(snapshot.phase, 'connected');
  assert.equal(snapshot.protocol, 2);
  assert.equal(snapshot.machine, 'mac-mini');
  assert.equal(snapshot.herdrVersion, '0.4.1');
  assert.equal(snapshot.status, 'Connected (protocol 2)');
  assert.deepEqual(snapshot.snippets, [{ label: 'yes', keys: ['y'] }]);
  assert.equal(h.client.connectedProtocol, 2);
  assert.equal(h.client.supportsProtocol3(), false);
  assert.equal(h.current().url, 'wss://mac.example/ws');
});

test('protocol 3 hello enables protocol-3 features', () => {
  const h = harness();
  h.connect(3);
  assert.equal(h.client.snapshot.protocol, 3);
  assert.equal(h.client.snapshot.status, 'Connected');
  assert.equal(h.client.supportsProtocol3(), true);
});

test('panes replace the previous list', () => {
  const h = harness();
  h.connect();
  h.receive({ t: 'panes', panes: [pane('default/w1:p1')] });
  assert.deepEqual(h.client.snapshot.panes.map((item) => item.id), ['default/w1:p1']);
  h.receive({ t: 'panes', panes: [pane('default/w2:p1'), pane('default/w2:p2')] });
  assert.deepEqual(h.client.snapshot.panes.map((item) => item.id), ['default/w2:p1', 'default/w2:p2']);
});

test('openView subscribes; switching sends close then open', () => {
  const h = harness();
  h.connect();
  h.client.openView('default/w1:p1');
  assert.deepEqual(h.last(), { t: 'open', id: h.last().id, pane: 'default/w1:p1' });
  assert.equal(h.client.snapshot.view.pane, 'default/w1:p1');

  h.client.openView('default/w1:p2');
  const frames = h.sent();
  const close = frames.find((frame) => frame.t === 'close');
  const reopen = frames.at(-1);
  assert.equal(close.pane, undefined);
  assert.equal(reopen.t, 'open');
  assert.equal(reopen.pane, 'default/w1:p2');
  assert.equal(h.client.snapshot.view.pane, 'default/w1:p2');
  assert.deepEqual(h.client.snapshot.view.entries, []);

  // Reopening the same view is a no-op.
  const before = h.sent().length;
  h.client.openView('default/w1:p2');
  assert.equal(h.sent().length, before);
});

test('chat snapshot, append, update and older update the open view', () => {
  const h = harness();
  h.connect();
  h.client.openView('default/w1:p1');
  const openId = h.last().id;

  h.receive({
    t: 'chat',
    id: openId,
    pane: 'default/w1:p1',
    source: 'transcript',
    entries: [entry('a1', 'first'), entry('u1', 'do it', 'user')],
    hasOlder: true,
  });
  let view = h.client.snapshot.view;
  assert.equal(view.source, 'transcript');
  assert.equal(view.hasOlder, true);
  assert.equal(view.prompt, null);
  assert.deepEqual(view.entries.map((item) => item.text), ['first', 'do it']);
  assert.equal(h.timers.pendingTimeouts(), 0, 'the chat reply resolves the open request');

  h.receive({ t: 'chat.append', pane: 'default/w1:p1', entries: [entry('a2', 'second')] });
  assert.deepEqual(h.client.snapshot.view.entries.map((item) => item.id), ['a1', 'u1', 'a2']);

  h.receive({ t: 'chat.update', pane: 'default/w1:p1', entries: [entry('a1', 'first, revised'), entry('a3', 'appended')] });
  view = h.client.snapshot.view;
  assert.deepEqual(view.entries.map((item) => item.id), ['a1', 'u1', 'a2', 'a3']);
  assert.equal(view.entries[0].text, 'first, revised');
  assert.equal(view.entries[3].text, 'appended');

  h.receive({ t: 'chat.older', id: 'r2', pane: 'default/w1:p1', entries: [entry('a0', 'older'), entry('a1', 'duplicate')], hasOlder: false });
  view = h.client.snapshot.view;
  assert.deepEqual(view.entries.map((item) => item.id), ['a0', 'a1', 'u1', 'a2', 'a3']);
  assert.equal(view.hasOlder, false);
  assert.equal(view.entries[1].text, 'first, revised', 'a known id from the older page does not replace the live entry');
});

test('a message for a view the client already left is dropped', () => {
  const h = harness();
  h.connect();
  h.client.openView('default/w1:p1');
  h.receive({ t: 'chat', pane: 'default/w1:p1', source: 'transcript', entries: [entry('a1', 'old pane')], hasOlder: false });
  h.client.openView('default/w1:p2');

  h.receive({ t: 'chat', pane: 'default/w1:p1', source: 'transcript', entries: [entry('a9', 'late')], hasOlder: false });
  h.receive({ t: 'chat.append', pane: 'default/w1:p1', entries: [entry('a10', 'late append')] });
  assert.deepEqual(h.client.snapshot.view.entries, []);

  h.receive({ t: 'chat', id: 'r9', pane: 'default/w1:p2', source: 'screen', entries: [entry('s1', 'now')], hasOlder: false });
  assert.deepEqual(h.client.snapshot.view.entries.map((item) => item.id), ['s1']);
  assert.equal(h.client.snapshot.view.source, 'screen');
});

test('queue, subagents, outcomes and prompt apply only to the matching view', () => {
  const h = harness();
  h.connect();
  h.client.openView('default/w1:p1');
  h.receive({ t: 'chat', pane: 'default/w1:p1', source: 'transcript', entries: [], hasOlder: false });

  h.receive({ t: 'queue', pane: 'default/w1:p2', items: [{ id: 'i9', text: 'wrong pane', ts: 1 }] });
  h.receive({ t: 'subagents', pane: 'default/w1:p2', subagents: [{ id: 's9', label: 'Wrong', description: '', status: 'working' }] });
  h.receive({ t: 'prompt', pane: 'default/w1:p2', text: 'wrong prompt' });
  assert.deepEqual(h.client.snapshot.view.queue, []);
  assert.deepEqual(h.client.snapshot.view.subagents, []);
  assert.equal(h.client.snapshot.view.prompt, null);

  h.receive({ t: 'queue', pane: 'default/w1:p1', items: [{ id: 'i1', text: 'later', ts: 2 }] });
  h.receive({ t: 'subagents', pane: 'default/w1:p1', subagents: [{ id: 's1', label: 'Explore', description: 'find it', status: 'working' }] });
  h.receive({ t: 'prompt', pane: 'default/w1:p1', text: 'Allow npm test?' });
  assert.deepEqual(h.client.snapshot.view.queue.map((item) => item.id), ['i1']);
  assert.deepEqual(h.client.snapshot.view.subagents.map((item) => item.id), ['s1']);
  assert.equal(h.client.snapshot.view.prompt, 'Allow npm test?');

  h.receive({ t: 'queue.outcomes', pane: 'default/w1:p1', items: [{ id: 'i0', text: 'gone', ts: 1, outcome: 'undelivered', reason: 'agent changed' }] });
  assert.equal(h.client.snapshot.view.outcomes.length, 1);

  h.receive({ t: 'prompt', pane: 'default/w1:p1', text: null });
  assert.equal(h.client.snapshot.view.prompt, null);
});

test('queue.summary is machine-wide and survives view switches', () => {
  const h = harness();
  h.connect();
  h.receive({ t: 'queue.summary', panes: [{ pane: 'default/w1:p1', pending: 2, undelivered: 1 }] });
  assert.equal(h.client.snapshot.queueSummaries.get('default/w1:p1').pending, 2);
  h.client.openView('default/w1:p2');
  assert.equal(h.client.snapshot.queueSummaries.size, 1);
});

test('ok resolves a write', async () => {
  const h = harness();
  h.connect();
  const result = h.client.sendKeys('default/w1:p1', ['enter']);
  const frame = h.last();
  assert.deepEqual(frame, { t: 'keys', id: frame.id, pane: 'default/w1:p1', keys: ['enter'] });
  h.receive({ t: 'ok', id: frame.id });
  assert.deepEqual(await result, { status: 'ok' });
});

test('error resolves a write with the bridge code', async () => {
  const h = harness();
  h.connect();
  const result = h.client.sendKeys('default/w1:p1', ['y']);
  const frame = h.last();
  h.receive({ t: 'error', id: frame.id, code: 'unknown_pane', message: 'Pane is gone.' });
  assert.deepEqual(await result, { status: 'error', code: 'unknown_pane', message: 'Pane is gone.' });
  assert.equal(h.client.snapshot.lastError, 'Pane is gone.');
});

test('a write with no reply reports unknown and is never retried', async () => {
  const h = harness();
  h.connect();
  const result = h.client.sendKeys('default/w1:p1', ['enter']);
  assert.equal(h.sent().length, 1);
  h.timers.advance(10_000);
  assert.deepEqual(await result, { status: 'unknown', message: 'No reply; it may or may not have been sent.' });
  assert.equal(h.sent().length, 1, 'no automatic retry');
});

test('a dropped socket reconnects after backoff and reopens the desired view', () => {
  const h = harness();
  h.connect();
  h.client.openView('default/w1:p1');
  h.receive({ t: 'chat', pane: 'default/w1:p1', source: 'transcript', entries: [entry('a1', 'held')], hasOlder: false });

  h.drop('network gone');
  assert.equal(h.client.snapshot.phase, 'retrying');
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.client.snapshot.view.entries, [], 'the view is reset while disconnected');

  h.timers.advance(RECONNECT_MIN_MS - 1);
  assert.equal(h.sockets.length, 1, 'nothing before the backoff elapses');
  h.timers.advance(1);
  assert.equal(h.sockets.length, 2);

  const second = h.current();
  h.open(second);
  h.receive(hello(2), second);
  const openFrame = second.sent.find((frame) => frame.t === 'open');
  assert.equal(openFrame.pane, 'default/w1:p1', 'the desired view is reopened');
  assert.equal(h.client.snapshot.phase, 'connected');
});

test('a 403 close goes forbidden and does not schedule a reconnect', () => {
  const h = harness();
  h.connect();
  h.drop('WebSocket error: Expected HTTP 101 response but was 403 Forbidden');
  assert.equal(h.client.snapshot.phase, 'forbidden');
  assert.equal(h.timers.pendingTimeouts(), 0);
  h.timers.advance(60_000);
  assert.equal(h.sockets.length, 1);
});

test('protocol 3 sendText picks prompt, run and type with the terminal id', async () => {
  const h = harness();
  h.connect(3);
  const target = pane('default/w1:p1', { terminalId: 'term-1' });

  const message = h.client.sendText(target, 'message', 'fix it', { terminalId: 'term-1' });
  assert.deepEqual(h.last(), { t: 'prompt', id: h.last().id, pane: 'default/w1:p1', terminalId: 'term-1', text: 'fix it' });
  h.receive({ t: 'ok', id: h.last().id });
  assert.deepEqual(await message, { status: 'ok' });

  const queued = h.client.sendText(target, 'message', 'later', { terminalId: 'term-1', queue: true });
  assert.equal(h.last().queue, true);
  h.receive({ t: 'ok', id: h.last().id });
  await queued;

  const command = h.client.sendText(target, 'command', 'npm test', { terminalId: 'term-1' });
  assert.deepEqual(h.last(), { t: 'run', id: h.last().id, pane: 'default/w1:p1', terminalId: 'term-1', text: 'npm test' });
  h.receive({ t: 'ok', id: h.last().id });
  await command;

  const typed = h.client.sendText(target, 'type', '/compact', { terminalId: 'term-1' });
  assert.deepEqual(h.last(), { t: 'type', id: h.last().id, pane: 'default/w1:p1', terminalId: 'term-1', text: '/compact' });
  h.receive({ t: 'ok', id: h.last().id });
  await typed;
});

test('protocol 2 sendText uses the text primitive, and falls back when no terminal is known', async () => {
  const h = harness();
  h.connect(2);
  const target = pane('default/w1:p1', { terminalId: 'term-1' });

  const message = h.client.sendText(target, 'message', 'fix it', { terminalId: 'term-1', queue: true });
  assert.deepEqual(h.last(), {
    t: 'text',
    id: h.last().id,
    pane: 'default/w1:p1',
    text: 'fix it',
    enter: true,
    queue: true,
    terminalId: 'term-1',
  });
  h.receive({ t: 'ok', id: h.last().id });
  await message;

  const typed = h.client.sendText(target, 'type', 'literal', { queue: true });
  assert.equal(h.last().t, 'text');
  assert.equal(h.last().enter, false);
  assert.equal(h.last().queue, undefined, 'queue is only meaningful for a message');
  assert.equal(h.last().terminalId, undefined);
  h.receive({ t: 'ok', id: h.last().id });
  await typed;

  // A protocol-3 bridge without a terminal id cannot use typed operations.
  const v3 = harness();
  v3.connect(3);
  const fallback = v3.client.sendText(undefined, 'command', 'ls');
  assert.equal(v3.last().t, 'text');
  assert.equal(v3.last().pane, '');
  v3.receive({ t: 'ok', id: v3.last().id });
  await fallback;
});

test('answer binds to the revision on protocol 3 and falls back to keys on protocol 2', async () => {
  const v3 = harness();
  v3.connect(3);
  const target = pane('default/w1:p1', { status: 'blocked', terminalId: 'term-1' });
  const bound = v3.client.answer(target, ['y'], 'rev-1');
  assert.deepEqual(v3.last(), {
    t: 'answer',
    id: v3.last().id,
    pane: 'default/w1:p1',
    terminalId: 'term-1',
    revision: 'rev-1',
    keys: ['y'],
  });
  v3.receive({ t: 'ok', id: v3.last().id });
  assert.deepEqual(await bound, { status: 'ok' });

  // Without a revision the bridge cannot check the prompt, so send raw keys.
  const raw = v3.client.answer(target, ['n']);
  assert.equal(v3.last().t, 'keys');
  assert.deepEqual(v3.last().keys, ['n']);
  v3.receive({ t: 'ok', id: v3.last().id });
  await raw;

  const v2 = harness();
  v2.connect(2);
  const keys = v2.client.answer(target, ['y'], 'rev-1');
  assert.deepEqual(v2.last(), { t: 'keys', id: v2.last().id, pane: 'default/w1:p1', keys: ['y'] });
  v2.receive({ t: 'ok', id: v2.last().id });
  assert.deepEqual(await keys, { status: 'ok' });
});

test('unqueue names the item', async () => {
  const h = harness();
  h.connect();
  const result = h.client.unqueue('default/w1:p1', 'i1');
  assert.deepEqual(h.last(), { t: 'unqueue', id: h.last().id, pane: 'default/w1:p1', item: 'i1' });
  h.receive({ t: 'ok', id: h.last().id });
  assert.deepEqual(await result, { status: 'ok' });
});

test('an invalid key is rejected before anything is sent', async () => {
  const h = harness();
  h.connect();
  const target = pane('default/w1:p1', { terminalId: 'term-1' });
  const before = h.sent().length;

  assert.deepEqual(await h.client.sendKeys('default/w1:p1', ['ctrl++']), {
    status: 'error',
    code: 'key_not_allowed',
    message: 'Key not allowed: ctrl++',
  });
  assert.deepEqual(await h.client.answer(target, ['Y']), {
    status: 'error',
    code: 'key_not_allowed',
    message: 'Key not allowed: Y',
  });
  assert.equal(h.sent().length, before);
});

test('stop goes off and does not reconnect', () => {
  const h = harness();
  h.connect();
  h.client.stop();
  assert.equal(h.client.snapshot.phase, 'off');
  assert.equal(h.current().closed.code, 1000);
  h.timers.advance(60_000);
  assert.equal(h.sockets.length, 1);
});

test('updateConfig with a new URL reconnects to the new host', () => {
  const h = harness();
  h.connect();
  h.client.updateConfig({ id: 'm1', label: 'mac', url: 'https://other.example' });
  assert.equal(h.sockets.length, 2);
  assert.equal(h.current().url, 'wss://other.example/ws');
  assert.equal(h.client.snapshot.phase, 'connecting');
  assert.equal(h.sockets[0].closed.code, 1000);

  // The same URL keeps the live socket.
  h.client.updateConfig({ id: 'm1', label: 'renamed', url: 'https://other.example' });
  assert.equal(h.sockets.length, 2);
  assert.equal(h.client.snapshot.label, 'renamed');
});

test('a malformed frame is ignored instead of breaking the connection', () => {
  const h = harness();
  h.connect();
  h.receive('{not json');
  h.receive({ t: 'no.such.message' });
  assert.equal(h.client.snapshot.phase, 'connected');
  assert.equal(h.client.snapshot.protocol, 2);
});
