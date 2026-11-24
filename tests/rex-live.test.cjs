// Drives the real local Rex server through scripts/rex-relay.mjs. Skipped
// unless REX_LIVE=1. REX_RELAY_PORT picks the relay port; it defaults to a
// free one.
//
//   REX_LIVE=1 REX_RELAY_PORT=8792 node --test tests/rex-live.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { RexControl } = require('../.test-build/app/apps/terminal/rex/control.js');

const LIVE = process.env.REX_LIVE === '1';
const SESSION_LABEL = 'lane-r1-live';
const CONNECTS = 20;
const FORMAT_CALLS = 50;
const CONNECT_BUDGET_MS = 200;
const FORMAT_BUDGET_MS = 20;
const WAIT_MS = 5_000;
const POLL_MS = 50;
const P95 = 0.95;
const CLOSE_ABNORMAL = 1006;

const timers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle) };

function nodeSocket(url, subprotocol, handlers) {
  const ws = new WebSocket(url, subprotocol);
  let closed = false;
  const close = (code, reason) => {
    if (closed) return;
    closed = true;
    handlers.onClose(code, reason);
  };
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (message) => handlers.onMessage(String(message.data));
  // Node's WebSocket fires only error, never close, when a connect is refused.
  ws.onerror = () => close(CLOSE_ABNORMAL, 'socket error');
  ws.onclose = (event) => close(event.code, event.reason);
  return {
    send(text) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(text);
      return true;
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

function newControl(port, log) {
  return new RexControl({
    url: `ws://127.0.0.1:${port}/api/control`,
    client: { kind: 'app', name: 'faceclaw-rex-live', version: '1' },
    createSocket: nodeSocket,
    timers,
    log,
  });
}

function ready(control) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not ready: ${JSON.stringify(control.state())}`)), WAIT_MS);
    const off = control.onStateChange((state) => {
      if (state.phase !== 'ready') return;
      clearTimeout(timer);
      off();
      resolve(state);
    });
    control.start();
  });
}

async function waitFor(what, predicate) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return { median: at(0.5), p95: at(P95) };
}

const ms = (value) => value.toFixed(2);

test('a pane round trip and the perf probe through the relay', { skip: !LIVE && 'set REX_LIVE=1 to run against the local Rex server' }, async () => {
  const { startRelay } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'rex-relay.mjs')).href);
  const relay = await startRelay({ port: Number(process.env.REX_RELAY_PORT ?? 0), log: () => {} });
  const control = newControl(relay.port, (line) => console.log(line));
  let sessionId = null;
  try {
    const state = await ready(control);
    console.log(`ready client=${state.clientId} resumed=${state.resumed}`);
    console.log(`bootstrap session count: ${control.sessions().length}`);

    const created = await control.call('session.create', {
      label: SESSION_LABEL,
      initial_windows: [{ layout: { block: { flavor: 'com.superlogical.terminal.shell' } } }],
    });
    sessionId = created.session_id;
    const blockId = created.initial_windows[0].block_ids[0];
    await waitFor('the pane in the model', () => control.sessions().some((view) => view.windows.some((window) => window.blocks.some((block) => block.blockId === blockId))));
    console.log(`created pane ${blockId} in ${SESSION_LABEL}`);

    const target = { session_id: sessionId, block_id: blockId };
    const format = () => control.call('com.superlogical.terminal.format', { ...target, args: { format: 'text', trim: true } });
    await control.sendInput({ kind: 'write', sessionId, blockId, data: 'echo rex-ok\n' });
    const screen = await waitFor('rex-ok on the screen', async () => {
      const { content } = await format();
      return /^rex-ok$/m.test(content) ? content : null;
    });
    console.log(`read back: ${screen.split('\n').find((line) => line === 'rex-ok')}`);

    const formatTimes = [];
    for (let i = 0; i < FORMAT_CALLS; i++) {
      const started = performance.now();
      await format();
      formatTimes.push(performance.now() - started);
    }

    const connectTimes = [];
    for (let i = 0; i < CONNECTS; i++) {
      const probe = newControl(relay.port);
      const started = performance.now();
      await ready(probe);
      connectTimes.push(performance.now() - started);
      probe.stop();
    }

    const connect = summary(connectTimes);
    const roundTrip = summary(formatTimes);
    console.log(`connect-to-model over ${CONNECTS} connects: median ${ms(connect.median)} ms, p95 ${ms(connect.p95)} ms (budget median ${CONNECT_BUDGET_MS} ms)`);
    console.log(`format round trip over ${FORMAT_CALLS} calls: median ${ms(roundTrip.median)} ms, p95 ${ms(roundTrip.p95)} ms (budget median ${FORMAT_BUDGET_MS} ms)`);
    assert.ok(connect.median <= CONNECT_BUDGET_MS);
    assert.ok(roundTrip.median <= FORMAT_BUDGET_MS);
  } finally {
    if (sessionId) {
      await control.call('session.destroy', { session_id: sessionId });
      await waitFor('the pane gone from the model', () => !control.sessions().some((view) => view.sessionId === sessionId));
      console.log(`destroyed ${SESSION_LABEL}`);
    }
    control.stop();
    await relay.close();
  }
});
