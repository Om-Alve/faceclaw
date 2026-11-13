const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { HerdrMachineClient } = require('../.test-build/app/apps/herdr/client.js');
const { promptRevision } = require('../.test-build/app/apps/herdr/protocol.js');

const hasWebSocket = typeof WebSocket === 'function';
const MOCK = path.join(__dirname, '..', 'scripts', 'herdr-mock-bridge.mjs');

async function startMock(port) {
  const child = spawn(process.execPath, [MOCK, '--port', String(port), '--protocol', '3', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock bridge did not start')), 5000);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('herdr mock bridge on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`mock bridge exited ${code}`));
    });
  });
  return child;
}

function socketFactory(url, handlers) {
  const socket = new WebSocket(url);
  let closed = false;
  const close = (reason) => {
    if (closed) return;
    closed = true;
    handlers.onClose(reason);
  };
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event) => handlers.onMessage(String(event.data)));
  socket.addEventListener('close', (event) => close(`closed ${event.code}`));
  socket.addEventListener('error', () => close('socket error'));
  return {
    send: (text) => socket.send(text),
    close: () => socket.close(),
  };
}

function makeClient(port) {
  return new HerdrMachineClient({
    machine: { id: 'mock', label: 'mock', url: `http://127.0.0.1:${port}` },
    createSocket: socketFactory,
  });
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('client drives a real mock bridge: open, answer, prompt, queue, reconnect', { skip: !hasWebSocket && 'needs a global WebSocket' }, async (t) => {
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = await startMock(port);
  const client = makeClient(port);
  t.after(() => {
    client.stop();
    child.kill();
  });

  client.start();
  await waitFor(() => client.snapshot.phase === 'connected', 'connection');
  assert.equal(client.snapshot.protocol, 3);
  assert.equal(client.snapshot.panes.length, 5);
  assert.equal(client.supportsProtocol3(), true);

  const blocked = client.snapshot.panes.find((pane) => pane.id === 'default/w1:p1');
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.terminalId, /^term_/);

  client.openView(blocked.id);
  const view = await waitFor(() => {
    const candidate = client.snapshot.view;
    return candidate && candidate.source !== null && candidate.prompt && candidate.subagents.length ? candidate : null;
  }, 'chat snapshot, prompt and subagents');
  assert.equal(view.entries.length, 4);
  assert.match(view.prompt, /Allow Bash/);
  assert.ok(view.subagents.some((subagent) => subagent.id === 's1'));

  const revision = promptRevision(blocked.terminalId, blocked.stateSeq, view.prompt);
  const answered = await client.answer(blocked, ['enter'], revision);
  assert.deepEqual(answered, { status: 'ok' });
  await waitFor(() => client.snapshot.view && client.snapshot.view.prompt === null, 'prompt cleared');
  await waitFor(() => client.snapshot.panes.find((pane) => pane.id === blocked.id)?.status === 'idle', 'pane unblocked');

  const idle = client.snapshot.panes.find((pane) => pane.id === 'work/w1:p1');
  const sent = await client.sendText(idle, 'message', 'summarize the deploy', { terminalId: idle.terminalId });
  assert.deepEqual(sent, { status: 'ok' });
  await waitFor(() => client.snapshot.panes.find((pane) => pane.id === idle.id)?.status === 'working', 'prompt accepted');

  const working = client.snapshot.panes.find((pane) => pane.id === 'default/w1:p2');
  const queued = await client.sendText(working, 'message', 'then run the tests', { queue: true, terminalId: working.terminalId });
  assert.deepEqual(queued, { status: 'ok' });
  const summary = await waitFor(() => {
    const candidate = client.snapshot.queueSummaries.get(working.id);
    return candidate && candidate.pending === 2 ? candidate : null;
  }, 'queue summary');
  assert.equal(summary.pending, 2);

  client.openView(working.id);
  const workView = await waitFor(() => {
    const candidate = client.snapshot.view;
    return candidate && candidate.source !== null && candidate.queue.length === 2 ? candidate : null;
  }, 'working pane queue');
  const item = workView.queue[1];
  const removed = await client.unqueue(working.id, item.id);
  assert.deepEqual(removed, { status: 'ok' });
  await waitFor(() => client.snapshot.view.queue.length === 1, 'queue item removed');

  client.stop();
  client.start();
  await waitFor(() => client.snapshot.phase === 'connected', 'reconnect');
  const reopened = await waitFor(() => {
    const candidate = client.snapshot.view;
    return candidate && candidate.source !== null ? candidate : null;
  }, 'view reopened after reconnect');
  assert.equal(reopened.pane, working.id);
});
