// Drives RexClient's data stream against the real local Rex server through
// scripts/rex-relay.mjs, with a Node WebSocket as the data socket. Skipped
// unless REX_LIVE=1. What the client delivers is applied to @xterm/headless
// the way the Terminal worker applies it, and compared with `rex capture`.
// tests/helpers/rex-live.cjs names the environment it reads.
//
//   REX_LIVE=1 node --test tests/rex-client-stream-live.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');

const { RexClient } = require('../.test-build/app/apps/terminal/rex-client.js');
const { RESEED_QUIET_MS } = require('../.test-build/app/apps/terminal/rex/stream.js');
const { REX_DATA_SUBPROTOCOL } = require('../.test-build/app/apps/terminal/rex/protocol.js');
const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');
const { timers, nodeSocket, startRelay, rex, rexJson, controlConnection } = require('./helpers/rex-live.cjs');

const LIVE = process.env.REX_LIVE === '1';
const SESSION_LABEL = 'lane-r3-owner';
const GLASSES = { cols: 58, rows: 11 };
const SCROLLBACK_LINES = 10_000;
const WAIT_MS = 15_000;
const POLL_MS = 50;
const QUIET_MS = 1_000;
const IDLE_MS = 20_000;
const SLOW_LINES = 30;
const SLOW_LINE_S = 0.2;
const FLOOD_DELIVERIES_BEFORE_DROP = 20;
const FORMAT_METHOD = 'com.superlogical.terminal.format';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Node stand-in for openRexDataSocket. Keeps each ws so the test can drop one without a close frame. */
function nodeDataSockets() {
  const opened = [];
  const open = (url, listener) => {
    const ws = new WebSocket(url, REX_DATA_SUBPROTOCOL, { perMessageDeflate: false });
    ws.binaryType = 'nodebuffer';
    opened.push(ws);
    ws.on('open', () => listener.onOpen());
    ws.on('message', (data) => listener.onBinaryMessage(new Uint8Array(data)));
    ws.on('close', (code, reason) => listener.onClosed(code, reason.toString()));
    ws.on('error', (error) => listener.onFailure(error.message));
    return {
      sendBinary(bytes) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(bytes);
        return true;
      },
      close: (code, reason) => ws.close(code, reason),
    };
  };
  return { open, opened };
}

async function waitFor(what, predicate, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/** The last `count` lines before any trailing blank ones, with trailing spaces cut. */
function trimmedTail(lines, count) {
  const trimmed = lines.map((line) => line.replace(/\s+$/, ''));
  while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed.slice(-count);
}

test('RexClient streams a real pane: echo as output, a flood, an idle minute, a RESUME and a kill', { skip: !LIVE && 'set REX_LIVE=1 to run against the local Rex server' }, async () => {
  const relayLines = [];
  const relay = await startRelay({ log: (line) => relayLines.push(line) });
  console.log(`relay on 127.0.0.1:${relay.port}`);
  const helper = await controlConnection(relay.port, 'lane-r3-helper');
  const data = nodeDataSockets();
  const clientLogs = [];
  const viewer = new RexClient({
    endpoint: parseRexConnectionString(`rex://127.0.0.1:${relay.port}`),
    createSocket: nodeSocket,
    openDataSocket: data.open,
    timers,
    now: () => Date.now(),
    cols: GLASSES.cols,
    rows: GLASSES.rows,
    log: (line) => {
      clientLogs.push(line);
      console.log(`  [client] ${line}`);
    },
  });
  const term = new Terminal({ cols: GLASSES.cols, rows: GLASSES.rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
  const deliveries = [];
  let applied = Promise.resolve();
  viewer.onTerminalData((bytes, kind) => {
    const copy = bytes.slice();
    deliveries.push({ kind, at: Date.now(), text: Buffer.from(copy).toString('utf8') });
    applied = applied.then(
      () =>
        new Promise((resolve) => {
          if (kind === 'snapshot') term.reset();
          term.write(copy, resolve);
        }),
    );
  });
  const detached = [];
  viewer.onSessionDetached((reason) => detached.push(reason));
  let sessionId = null;
  try {
    const session = await helper.call('session.create', {
      label: SESSION_LABEL,
      initial_windows: [{ layout: { block: { flavor: 'com.superlogical.terminal.shell', options: { shell: 'none', command: ['/bin/sh'], login: false, cwd: '/tmp' } } } }],
    });
    sessionId = session.session_id;
    const blockId = session.initial_windows[0].block_ids[0];
    const capture = () => rex('capture', '-s', sessionId, '-b', blockId, '--trim');
    const settle = async () => {
      await waitFor('the stream to go quiet', () => deliveries.length && Date.now() - deliveries.at(-1).at >= QUIET_MS + RESEED_QUIET_MS);
      await applied;
    };
    const compare = async (label) => {
      await settle();
      const buffer = term.buffer.active;
      const screen = [];
      for (let row = 0; row < term.rows; row++) screen.push(buffer.getLine(buffer.viewportY + row).translateToString(true));
      const got = trimmedTail(screen, term.rows);
      const want = trimmedTail(capture().split('\n'), term.rows).slice(-got.length);
      const match = got.length > 0 && JSON.stringify(got) === JSON.stringify(want);
      console.log(`${match ? 'MATCH' : 'DIFF '} ${label}: last line ${JSON.stringify(got.at(-1))}`);
      if (!match) console.log(`  rex capture: ${JSON.stringify(want)}\n  delivered:   ${JSON.stringify(got)}`);
      assert.ok(match, label);
    };

    viewer.onStateChange((state) => {
      if (state.phase === 'connected' && state.status.startsWith('Connected')) viewer.connectSession(blockId);
    });
    viewer.onSessionAttached(() => viewer.view());
    viewer.start();
    await waitFor('the seed', () => deliveries.some((piece) => piece.kind === 'snapshot'));
    console.log(`seeded: ${deliveries.filter((piece) => piece.kind === 'snapshot').length} snapshot(s)`);
    await settle();

    const typedFrom = deliveries.length;
    viewer.submitInput('echo rex-r3-ok');
    const echo = await waitFor('the echo', () => deliveries.slice(typedFrom).find((piece) => /rex-r3-ok\r?\n/.test(piece.text)));
    console.log(`echo arrived as ${echo.kind}; kinds since typing: ${[...new Set(deliveries.slice(typedFrom).map((piece) => piece.kind))].join(',')}`);
    assert.equal(echo.kind, 'output');
    await compare('after echo rex-r3-ok');

    viewer.submitInput('seq 1 2000');
    await waitFor('2000 on screen', () => deliveries.some((piece) => piece.text.includes('2000')));
    await compare('after seq 1 2000');

    const idleFrom = relayLines.length;
    const idleStart = Date.now();
    await sleep(IDLE_MS);
    const idleLines = relayLines.slice(idleFrom);
    const idleRequests = idleLines.filter((line) => line.includes(' request '));
    const idleFormats = idleRequests.filter((line) => line.includes(`method=${FORMAT_METHOD}`));
    console.log(`idle ${Math.round((Date.now() - idleStart) / 1000)} s: relay logged ${idleLines.length} lines, ${idleRequests.length} control requests, ${idleFormats.length} format requests`);
    for (const line of idleLines) console.log(`  [relay] ${line}`);
    assert.equal(idleFormats.length, 0);
    const allFormats = relayLines.filter((line) => line.includes(`method=${FORMAT_METHOD}`)).length;
    console.log(`the relay logged ${allFormats} format requests before the idle window, so it does see them`);
    assert.ok(allFormats > 0);

    // Rex keeps only what it has not sent yet, so bytes in flight when a
    // connection drops make the RESUME fail. Dropping right after a line of a
    // slow loop leaves nothing in flight; dropping in a fast flood may not.
    const dropFrom = deliveries.length;
    viewer.submitInput(`for i in $(seq 1 ${SLOW_LINES}); do echo "slow $i"; sleep ${SLOW_LINE_S}; done`);
    await waitFor('the slow loop', () => deliveries.slice(dropFrom).some((piece) => piece.text.includes('slow 3')));
    const dropped = data.opened.at(-1);
    dropped.terminate();
    console.log('dropped the data connection without a close frame between two lines of the slow loop');
    await waitFor('the RESUME accepted', () => clientLogs.some((line) => line.startsWith('rex data: RESUME accepted')));
    await waitFor(`slow ${SLOW_LINES}`, () => deliveries.some((piece) => piece.text.includes(`slow ${SLOW_LINES}`)), WAIT_MS * 2);
    assert.notEqual(data.opened.at(-1), dropped);
    await compare('after a RESUME mid-output');
    const seedsAfterDrop = deliveries.slice(dropFrom).filter((piece) => piece.kind === 'snapshot').length;
    console.log(`snapshots since the drop: ${seedsAfterDrop}`);
    assert.equal(seedsAfterDrop, 0, 'a RESUME needs no new seed');

    const floodFrom = deliveries.length;
    const floodLogsFrom = clientLogs.length;
    viewer.submitInput('for i in $(seq 1 400); do echo "line $i"; sleep 0.005; done');
    await waitFor('the flood', () => deliveries.length - floodFrom >= FLOOD_DELIVERIES_BEFORE_DROP);
    data.opened.at(-1).terminate();
    console.log(`dropped the data connection in a fast flood after ${deliveries.length - floodFrom} deliveries`);
    await waitFor('line 400', () => deliveries.some((piece) => piece.text.includes('line 400')), WAIT_MS * 2);
    const outcome = clientLogs.slice(floodLogsFrom).filter((line) => line.startsWith('rex data: RESUME accepted') || line.includes('reject'));
    console.log(`flood drop outcome: ${JSON.stringify(outcome)}`);
    await compare('after a drop in a fast flood');

    rex('kill', sessionId);
    console.log(`rex kill ${sessionId}`);
    await waitFor('the pane closed', () => viewer.state().status === 'Pane closed.');
    const dataEnd = clientLogs.find((line) => line.startsWith('rex data: ended'));
    console.log(`client status "${viewer.state().status}", detached ${JSON.stringify(detached)}, closed by ${dataEnd ?? 'session_destroyed on the control connection'}`);
    assert.deepEqual(detached, ['session closed']);
    sessionId = null;
  } finally {
    viewer.stop();
    if (sessionId) await helper.call('session.attach', { session_id: sessionId }).then(() => helper.call('session.destroy', { session_id: sessionId })).catch((error) => console.log(`destroy: ${error.message}`));
    helper.close();
    await relay.close();
    const left = rexJson('ls', '--json').sessions.filter((session) => session.label === SESSION_LABEL);
    console.log(`lane sessions left: ${left.length}`);
    assert.equal(left.length, 0);
  }
});
