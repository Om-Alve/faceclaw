// Probes the real local Rex server through scripts/rex-relay.mjs, then stops
// the relay and checks that a Rex client explains the failure in time.
// Skipped unless REX_LIVE=1. REX_RELAY_PORT picks the relay port; REX_BIN the
// rex CLI, else `rex` on PATH. A 403 needs Rex's Tailscale node, so it is not
// covered here.
//
//   REX_LIVE=1 REX_RELAY_PORT=8798 node --test tests/rex-pairing-live.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { RexClient } = require('../.test-build/app/apps/terminal/rex-client.js');
const { parseRexConnectionString } = require('../.test-build/app/apps/terminal/rex/connection-string.js');
const { probeRex } = require('../.test-build/app/apps/terminal/rex/pairing.js');
const { RexProbedClient } = require('../.test-build/app/apps/terminal/rex/probed-client.js');

const LIVE = process.env.REX_LIVE === '1';
const FAILURE_MESSAGE_BUDGET_MS = 5000;
// Reserved for documentation (RFC 5737), so nothing answers and the probe has to time out.
const SILENT_HOST = 'rex://192.0.2.1:8798';

/** RexHttpHead over node:http: one request, redirects not followed. */
function nodeHead(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'HEAD', timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end();
  });
}

function nodeSocket(url, subprotocol, handlers) {
  const ws = new WebSocket(url, subprotocol);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (message) => handlers.onMessage(String(message.data));
  ws.onclose = (event) => handlers.onClose(event.code, event.reason);
  return {
    send(text) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(text);
      return true;
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

function waitForState(client, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (predicate(client.state())) return resolve(client.state());
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no matching state within ${timeoutMs} ms; last: ${JSON.stringify(client.state().status)}`));
    }, timeoutMs);
    const unsubscribe = client.onStateChange((state) => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    });
  });
}

test('the probe tells a running Rex server from a stopped relay', { skip: !LIVE && 'set REX_LIVE=1 to run against the local Rex server' }, async () => {
  const { startRelay } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'rex-relay.mjs')).href);
  const relay = await startRelay({ port: Number(process.env.REX_RELAY_PORT ?? 0), log: () => {} });
  const endpoint = parseRexConnectionString(`rex://127.0.0.1:${relay.port}`);
  console.log(`relay on 127.0.0.1:${relay.port}`);

  let started = Date.now();
  const reachable = await probeRex(endpoint, nodeHead);
  console.log(`relay up: probe ${reachable} in ${Date.now() - started} ms`);
  assert.equal(reachable, 'reachable');

  const client = new RexProbedClient(
    new RexClient({
      endpoint,
      createSocket: nodeSocket,
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle) },
      now: () => Date.now(),
      cols: 58,
      rows: 11,
    }),
    endpoint,
    nodeHead,
  );
  try {
    client.start();
    const connected = await waitForState(client, (state) => state.phase === 'connected', FAILURE_MESSAGE_BUDGET_MS);
    console.log(`relay up: client ${connected.phase}, "${connected.status}"`);

    started = Date.now();
    await relay.close();
    const failed = await waitForState(client, (state) => state.phase === 'failed', FAILURE_MESSAGE_BUDGET_MS);
    const elapsed = Date.now() - started;
    console.log(`relay stopped: client ${failed.phase} after ${elapsed} ms, "${failed.status}"`);
    assert.equal(failed.status, `Can't reach 127.0.0.1:${relay.port}. Check that the relay is running.`);
    assert.ok(elapsed < FAILURE_MESSAGE_BUDGET_MS);

    started = Date.now();
    const unreachable = await probeRex(endpoint, nodeHead);
    console.log(`relay stopped: probe ${unreachable} in ${Date.now() - started} ms`);
    assert.equal(unreachable, 'unreachable');
  } finally {
    client.stop();
  }
});

test('a host that never answers is unreachable inside the failure budget', { skip: !LIVE && 'set REX_LIVE=1 to run the network probe' }, async () => {
  const started = Date.now();
  const result = await probeRex(parseRexConnectionString(SILENT_HOST), nodeHead);
  const elapsed = Date.now() - started;
  console.log(`silent host: probe ${result} in ${elapsed} ms`);
  assert.equal(result, 'unreachable');
  assert.ok(elapsed < FAILURE_MESSAGE_BUDGET_MS);
});
