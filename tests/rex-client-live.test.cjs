// Drives RexClient against the real local Rex server through
// scripts/rex-relay.mjs. Skipped unless REX_LIVE=1. A second plain control
// connection stands in for the Mac: it owns the pane at its own size first, so
// handing the pane back is observable. tests/helpers/rex-live.cjs names the
// environment it reads.
//
//   REX_LIVE=1 node --test tests/rex-client-live.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

const { RexClient, REX_OTHER_OWNER_NOTICE } = require('../.test-build/app/apps/terminal/rex-client.js');
const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');
const { timers, nodeSocket, startRelay, rexJson, controlConnection } = require('./helpers/rex-live.cjs');

const LIVE = process.env.REX_LIVE === '1';
const SESSION_LABEL = 'lane-r2-owner';
const GLASSES = { cols: 58, rows: 11 };
const MAC = { columns: 120, rows: 40 };
const TERMINAL_CREATOR = 'com.superlogical.terminal';
const WAIT_MS = 10_000;
const POLL_MS = 100;
// Enough of a line to show the prompt and the command without the palette the snapshot starts with.
const ECHO_TAIL_CHARS = 24;

function newClient(port) {
  return new RexClient({
    endpoint: parseRexConnectionString(`rex://127.0.0.1:${port}`),
    createSocket: nodeSocket,
    timers,
    now: () => Date.now(),
    cols: GLASSES.cols,
    rows: GLASSES.rows,
    log: (line) => console.log(`  [client] ${line}`),
  });
}

/** A bare control connection, the way Rex.app on the Mac would hold a pane, with the owner changes it hears. */
async function macConnection(port) {
  const ownerEvents = [];
  const mac = await controlConnection(port, 'mac-standin', (message) => {
    if (message.payload.type === 'session_event' && message.payload.payload.event.type === 'block_owner_changed') ownerEvents.push(message.payload.payload.event.payload);
  });
  return { ...mac, ownerEvents };
}

const terminalSize = (sessionId, blockId) => rexJson('api', 'call', '-s', sessionId, 'com.superlogical.terminal.size', JSON.stringify({ block_id: blockId, args: {} }));

/** Every terminal block on the server, from `rex ls` and `rex api call session.view`. */
function rexTerminalBlocks() {
  const blocks = [];
  for (const session of rexJson('ls', '--json').sessions) {
    let view;
    try {
      view = rexJson('api', 'call', '-s', session.session_id, 'session.view');
    } catch {
      continue; // destroyed between the listing and the view
    }
    for (const window of view.windows ?? []) {
      for (const layer of window.layers ?? []) {
        for (const block of layer.blocks ?? []) if (block.creator_name === TERMINAL_CREATOR) blocks.push(block.block_id);
      }
    }
  }
  return blocks;
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

const showSize = (label, size, mac) => console.log(`${label}: ${size.columns}x${size.rows} owner=${size.owner === mac.id ? 'mac' : size.owner}`);

test('RexClient lists, views, types into and gives back a real pane', { skip: !LIVE && 'set REX_LIVE=1 to run against the local Rex server' }, async () => {
  const relay = await startRelay();
  console.log(`relay on 127.0.0.1:${relay.port}`);
  const mac = await macConnection(relay.port);
  const hub = newClient(relay.port);
  const viewer = newClient(relay.port);
  const created = [];
  try {
    const session = await mac.call('session.create', {
      label: SESSION_LABEL,
      initial_windows: [{ layout: { block: { flavor: 'com.superlogical.terminal.shell', options: { shell: 'none', command: ['/bin/sh'], login: false, cwd: '/tmp' } } } }],
    });
    created.push(session.session_id);
    const sessionId = session.session_id;
    const blockId = session.initial_windows[0].block_ids[0];
    await mac.call('session.attach', { session_id: sessionId });
    await mac.call('session.own_block', { session_id: sessionId, block_ids: [blockId], mode: 'take' });
    await mac.call('com.superlogical.terminal.resize', { session_id: sessionId, block_id: blockId, args: MAC });
    await waitFor('the mac size', () => terminalSize(sessionId, blockId).columns === MAC.columns);
    showSize('mac owns the pane', terminalSize(sessionId, blockId), mac);

    hub.start();
    await waitFor('the hub connected', () => hub.state().phase === 'connected');
    const rows = await waitFor('hub rows to match rex ls and session.view', () => {
      const expected = rexTerminalBlocks().sort();
      const actual = hub.state().sessions.map((row) => row.socket).sort();
      return JSON.stringify(expected) === JSON.stringify(actual) ? hub.state().sessions : null;
    });
    console.log(`hub rows (${rows.length}) match rex ls: ${rows.map((row) => row.title).join(' | ')}`);
    assert.equal(rows.find((row) => row.socket === blockId)?.title, SESSION_LABEL);

    let screen = '';
    viewer.onTerminalData((data, kind) => {
      assert.equal(kind, 'snapshot');
      screen = Buffer.from(data).toString('utf8');
    });
    viewer.onStateChange((state) => {
      if (state.phase === 'connected' && state.status.startsWith('Connected')) viewer.connectSession(blockId);
    });
    viewer.onSessionAttached(() => viewer.view());
    viewer.start();
    const viewed = await waitFor('the glasses grid', () => {
      const size = terminalSize(sessionId, blockId);
      return size.columns === GLASSES.cols && size.rows === GLASSES.rows ? size : null;
    });
    showSize('glasses view the pane', viewed, mac);
    const taker = mac.ownerEvents.findLast((event) => event.block_id === blockId && event.reason === 'take');
    assert.notEqual(viewed.owner, mac.id);
    assert.equal(viewed.owner, taker.owner, 'the client that took the pane owns it');
    assert.equal(viewer.state().phase, 'attached');

    viewer.submitInput('echo rex-r2-ok');
    await waitFor('rex-r2-ok in a snapshot', () => /\nrex-r2-ok\r?\n/.test(screen));
    const echoed = screen.split(/\r?\n/).filter((line) => line.endsWith('rex-r2-ok')).map((line) => JSON.stringify(line.slice(-ECHO_TAIL_CHARS)));
    console.log(`snapshot lines ending in rex-r2-ok: ${echoed.join(' ')}`);

    await mac.call('session.own_block', { session_id: sessionId, block_ids: [blockId], mode: 'take' });
    await waitFor('the notice', () => viewer.state().status === REX_OTHER_OWNER_NOTICE);
    showSize(`mac takes the pane back, glasses say "${viewer.state().status}"`, terminalSize(sessionId, blockId), mac);
    viewer.view();
    await waitFor('the glasses taking over', () => terminalSize(sessionId, blockId).columns === GLASSES.cols && viewer.state().phase === 'attached');
    showSize('glasses take over', terminalSize(sessionId, blockId), mac);

    viewer.unview();
    const unviewed = await waitFor('the mac size after unview', () => {
      const size = terminalSize(sessionId, blockId);
      return size.owner === mac.id && size.columns === MAC.columns && size.rows === MAC.rows ? size : null;
    });
    showSize('after unview', unviewed, mac);

    viewer.view();
    await waitFor('the glasses grid again', () => terminalSize(sessionId, blockId).columns === GLASSES.cols);
    viewer.stop();
    const stopped = await waitFor('the mac size after stop', () => {
      const size = terminalSize(sessionId, blockId);
      return size.owner === mac.id && size.columns === MAC.columns ? size : null;
    });
    showSize('after stop (close frame)', stopped, mac);

    const launchedBlock = await hub.launchSession('shell');
    await waitFor('the launched pane in the hub', () => hub.state().sessions.some((row) => row.socket === launchedBlock));
    const launchedSession = rexJson('ls', '--json').sessions.find((candidate) => {
      try {
        return JSON.stringify(rexJson('api', 'call', '-s', candidate.session_id, 'session.view')).includes(launchedBlock);
      } catch {
        return false;
      }
    });
    assert.ok(launchedSession, 'rex ls shows the launched session');
    created.push(launchedSession.session_id);
    console.log(`launched ${launchedBlock} in session "${launchedSession.label}", hub row "${hub.state().sessions.find((row) => row.socket === launchedBlock).title}"`);
  } finally {
    viewer.stop();
    for (const id of created) {
      await mac
        .call('session.attach', { session_id: id })
        .then(() => mac.call('session.destroy', { session_id: id }))
        .catch((error) => console.log(`destroy ${id}: ${error.message}`));
    }
    hub.stop();
    mac.close();
    await relay.close();
    const left = rexJson('ls', '--json').sessions.filter((session) => created.includes(session.session_id));
    console.log(`sessions left from this test: ${left.length}`);
    assert.equal(left.length, 0);
  }
});
