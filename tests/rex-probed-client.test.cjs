const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');
const { RexProbedClient } = require('../.test-build/app/apps/terminal/rex/probed-client.js');

const tailnet = parseRexConnectionString('https://rex.tail1234.ts.net');
const UNREACHABLE = "Can't reach rex.tail1234.ts.net. Check that Tailscale is on.";
const REFUSED = 'Rex refused this device. Sign the phone into the same tailnet account.';

/** Stands in for RexClient: start() connects and stays connecting until told otherwise. */
function fakeRexClient() {
  const listeners = new Set();
  let state = { phase: 'idle', status: 'Not connected.', sessions: [], attachedCommand: '', serverName: '', retryable: true };
  const client = {
    starts: 0,
    state: () => state,
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(phase, status, rest = {}) {
      state = { ...state, ...rest, phase, status };
      for (const listener of [...listeners]) listener(state);
    },
    start() {
      client.starts++;
      if (state.phase === 'idle') client.set('connecting', 'Connecting to rex.tail1234.ts.net...');
    },
    stop() {
      client.set('idle', 'Not connected.');
    },
  };
  return client;
}

/** A HEAD whose answers the test hands out one request at a time. */
function scriptedHead() {
  const requests = [];
  const head = () =>
    new Promise((resolve, reject) => {
      requests.push({ resolve, reject });
    });
  return { head, requests };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function probed() {
  const inner = fakeRexClient();
  const { head, requests } = scriptedHead();
  const client = new RexProbedClient(inner, tailnet, head);
  const seen = [];
  client.onStateChange((state) => seen.push(state));
  return { inner, client, requests, seen };
}

test('an unreachable server turns connecting into a failure the user must fix', async () => {
  const { client, requests, seen } = probed();
  client.start();
  assert.equal(requests.length, 1);
  assert.equal(client.state().phase, 'connecting');
  requests[0].reject(new Error('Unable to resolve host'));
  await settle();
  assert.deepEqual(
    { phase: client.state().phase, status: client.state().status, retryable: client.state().retryable },
    { phase: 'failed', status: UNREACHABLE, retryable: false },
  );
  assert.equal(seen.at(-1).status, UNREACHABLE);
});

test('a 403 says Rex refused this device', async () => {
  const { client, requests } = probed();
  client.start();
  requests[0].resolve(403);
  await settle();
  assert.equal(client.state().status, REFUSED);
});

test('a reachable server leaves the client to report its own progress', async () => {
  const { inner, client, requests } = probed();
  client.start();
  requests[0].resolve(200);
  await settle();
  assert.equal(client.state().status, 'Connecting to rex.tail1234.ts.net...');
  inner.set('connected', 'Connected to rex.tail1234.ts.net.');
  assert.equal(client.state().phase, 'connected');
});

test("a session's program status comes through unchanged", async () => {
  const { inner, client, requests, seen } = probed();
  client.start();
  requests[0].resolve(200);
  await settle();
  const sessions = [
    {
      socket: 'b1',
      pid: 0,
      cwdHint: '~/code',
      lastBellAt: null,
      lastOutputAt: null,
      title: null,
      status: { state: 'blocked', kind: 'permission', msg: 'Allow Edit?' },
    },
  ];
  inner.set('connected', 'Connected to rex.tail1234.ts.net.', { sessions });
  assert.deepEqual(client.state().sessions, sessions);
  assert.deepEqual(seen.at(-1).sessions, sessions);
});

test('connecting clears the failure, and a probe answered after that is ignored', async () => {
  const { inner, client, requests } = probed();
  client.start();
  requests[0].reject(new Error('timeout'));
  await settle();
  assert.equal(client.state().phase, 'failed');
  inner.set('connecting', 'Reconnecting to rex.tail1234.ts.net...');
  assert.equal(requests.length, 2);
  inner.set('connected', 'Connected to rex.tail1234.ts.net.');
  requests[1].reject(new Error('timeout'));
  await settle();
  assert.equal(client.state().phase, 'connected');
  inner.set('connecting', 'Reconnecting to rex.tail1234.ts.net...');
  assert.equal(client.state().status, 'Reconnecting to rex.tail1234.ts.net...');
});

test('one probe at a time, and a retry from the UI probes again', async () => {
  const { inner, client, requests } = probed();
  client.start();
  inner.set('connecting', 'Reconnecting to rex.tail1234.ts.net...');
  assert.equal(requests.length, 1);
  requests[0].reject(new Error('timeout'));
  await settle();
  client.start();
  assert.equal(inner.starts, 2);
  assert.equal(requests.length, 2);
  requests[1].resolve(200);
  await settle();
  assert.equal(client.state().phase, 'connecting');
});

test('stopping drops the failure and the probe in flight', async () => {
  const { client, requests } = probed();
  client.start();
  requests[0].reject(new Error('timeout'));
  await settle();
  client.start();
  client.stop();
  requests[1].resolve(403);
  await settle();
  assert.deepEqual({ phase: client.state().phase, status: client.state().status }, { phase: 'idle', status: 'Not connected.' });
  client.start();
  assert.equal(client.state().status, 'Connecting to rex.tail1234.ts.net...');
  assert.equal(requests.length, 3);
});

test('a reconnect while a probe is open sends no second probe', () => {
  const { inner, client, requests } = probed();
  client.start();
  inner.set('connected', 'Connected to rex.tail1234.ts.net.');
  inner.set('connecting', 'Reconnecting to rex.tail1234.ts.net...');
  assert.equal(requests.length, 1);
});

test('a probe open across a connected spell is not reported, and a fresh probe answers', async () => {
  const { inner, client, requests } = probed();
  client.start();
  inner.set('connected', 'Connected to rex.tail1234.ts.net.');
  inner.set('connecting', 'Reconnecting to rex.tail1234.ts.net...');
  requests[0].resolve(403);
  await settle();
  assert.equal(client.state().status, 'Reconnecting to rex.tail1234.ts.net...');
  assert.equal(requests.length, 2);
  requests[1].reject(new Error('timeout'));
  await settle();
  assert.equal(client.state().status, UNREACHABLE);
});
