// Drives RexClient's program status against the real local Rex server through
// scripts/rex-relay.mjs. Skipped unless REX_LIVE=1. The pane is driven with
// the rex CLI, which talks to the server's socket directly, so it keeps
// working while the relay is down. REX_RELAY_PORT picks the relay port;
// REX_BIN the rex CLI, else `rex` on PATH.
//
//   REX_LIVE=1 REX_RELAY_PORT=8799 node --test tests/rex-status-live.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { RexClient } = require('../.test-build/app/apps/terminal/rex-client.js');
const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');

const LIVE = process.env.REX_LIVE === '1';
const REX = process.env.REX_BIN ?? 'rex';
const PORT = Number(process.env.REX_RELAY_PORT ?? 0);
const SESSION_LABEL = 'lane-r4-owner';
const PROGRAM_STATUS = 'com.superlogical.terminal.program_status';
const BLOCKED_MSG = 'Allow edit to lane-r4.txt? ✅ naïve';
const NOTIFICATION = 'lane-r4 build finished';
const REPORT_BUDGET_MS = 1_000;
const WAIT_MS = 15_000;
const POLL_MS = 10;
const QUIET_MS = 500;

const timers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle) };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const rexJson = (...args) => JSON.parse(execFileSync(REX, args, { encoding: 'utf8' }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Node WebSocket that also counts the program_status responses it receives, by block. */
function tappedSocketFactory(statusReads) {
  return (url, subprotocol, handlers) => {
    const ws = new WebSocket(url, subprotocol);
    const asked = new Map();
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (message) => {
      const text = String(message.data);
      const parsed = JSON.parse(text);
      if (parsed.type === 'response' && asked.has(parsed.id)) statusReads.push(asked.get(parsed.id));
      handlers.onMessage(text);
    };
    ws.onclose = (event) => handlers.onClose(event.code, event.reason);
    return {
      send(text) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        const request = JSON.parse(text);
        if (request.method === PROGRAM_STATUS) asked.set(request.id, request.payload.block_id);
        ws.send(text);
        return true;
      },
      close: (code, reason) => ws.close(code, reason),
    };
  };
}

async function waitFor(what, predicate) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

test('a Rex pane that reports blocked shows on its row and raises attention once, across a relay restart', { skip: !LIVE && 'set REX_LIVE=1 to run against the local Rex server' }, async () => {
  const { startRelay } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'rex-relay.mjs')).href);
  let relay = await startRelay({ port: PORT, log: () => {} });
  console.log(`relay on 127.0.0.1:${relay.port}`);
  const statusReads = [];
  const hub = new RexClient({
    endpoint: parseRexConnectionString(`rex://127.0.0.1:${relay.port}`),
    createSocket: tappedSocketFactory(statusReads),
    timers,
    now: () => Date.now(),
    cols: 58,
    rows: 11,
    log: (line) => console.log(`  [client] ${line}`),
  });
  const bells = [];
  hub.onBell((socket, at) => bells.push({ socket, at }));
  let sessionId = null;
  try {
    const created = rexJson('api', 'call', 'session.create', JSON.stringify({
      label: SESSION_LABEL,
      initial_windows: [{ layout: { block: { flavor: 'com.superlogical.terminal.shell', options: { shell: 'none', command: ['/bin/sh'], login: false, cwd: '/tmp' } } } }],
    }));
    sessionId = created.session_id;
    const blockId = created.initial_windows[0].block_ids[0];
    const print = (escape) => {
      rexJson('api', 'call', '-s', sessionId, 'com.superlogical.terminal.write', JSON.stringify({ block_id: blockId, args: { data: `printf '${escape}'\n` } }));
    };
    const row = () => hub.state().sessions.find((candidate) => candidate.socket === blockId);
    const bellsFor = () => bells.filter((bell) => bell.socket === blockId).length;

    hub.start();
    await waitFor('the hub row for the lane pane', () => hub.state().phase === 'connected' && row());
    await waitFor('the first status read of the lane pane', () => statusReads.includes(blockId));
    console.log(`connected; row "${row().title}" status=${JSON.stringify(row().status ?? null)} bells=${bellsFor()}`);
    assert.equal(row().status, undefined);

    const sent = Date.now();
    print(`\\033]7501;state=blocked:kind=permission:msg=${b64(BLOCKED_MSG)}\\033\\\\`);
    await waitFor('the blocked row', () => row().status?.state === 'blocked');
    const elapsed = Date.now() - sent;
    console.log(`blocked report to row in ${elapsed} ms: ${JSON.stringify(row().status)}`);
    assert.deepEqual(row().status, { state: 'blocked', kind: 'permission', msg: BLOCKED_MSG });
    assert.ok(elapsed <= REPORT_BUDGET_MS, `row showed blocked in ${elapsed} ms`);
    await sleep(QUIET_MS);
    console.log(`attention raised ${bellsFor()} time(s)`);
    assert.equal(bellsFor(), 1);

    await relay.close();
    await waitFor('the hub to see the relay go', () => hub.state().phase === 'connecting');
    console.log(`relay stopped; phase=${hub.state().phase}; row status=${JSON.stringify(row()?.status ?? null)}`);
    relay = await startRelay({ port: relay.port, log: () => {} });
    const readsBefore = statusReads.filter((id) => id === blockId).length;
    await waitFor('the hub back and the lane pane re-read', () => hub.state().phase === 'connected' && statusReads.filter((id) => id === blockId).length > readsBefore);
    await sleep(QUIET_MS);
    console.log(`relay restarted; re-read done; row status=${JSON.stringify(row().status)}; attention raised ${bellsFor()} time(s) in total`);
    assert.deepEqual(row().status, { state: 'blocked', kind: 'permission', msg: BLOCKED_MSG });
    assert.equal(bellsFor(), 1);

    print('\\033]7501;state=clear\\033\\\\');
    await waitFor('the row to clear', () => row().status === undefined);
    console.log('clear report: row status cleared');

    print(`\\033]9;${NOTIFICATION}\\007`);
    await waitFor('attention for the notification', () => bellsFor() === 2);
    console.log(`OSC 9 notification: attention raised, ${bellsFor()} in total`);
  } finally {
    hub.stop();
    await relay.close();
    if (sessionId) {
      try {
        execFileSync(REX, ['api', 'call', '-s', sessionId, 'session.destroy']);
      } catch (error) {
        console.log(`destroy ${sessionId}: ${error.message}`);
      }
    }
    const left = rexJson('ls', '--json').sessions.filter((session) => session.session_id === sessionId || session.label === SESSION_LABEL);
    console.log(`sessions left from this test: ${left.length}`);
    assert.equal(left.length, 0);
  }
});
