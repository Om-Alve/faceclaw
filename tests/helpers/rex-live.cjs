// What the Rex live tests (tests/rex-*live*.test.cjs) share: Node adapters for
// RexControl and RexClient, the relay to the local Rex server, and the rex CLI.
// REX_RELAY_PORT picks the relay port, else a free one. REX_BIN picks the rex
// CLI, else `rex` on PATH, else the one inside Rex.app. Needs
// `tsc -p tests/tsconfig.json`.
const { execFileSync } = require('node:child_process');
const relay = require('../../scripts/rex-relay.mjs');
const { REX_API_REVISION, REX_CONTROL_SUBPROTOCOL } = require('../../.test-build/app/apps/terminal/rex/protocol.js');

const CLOSE_NORMAL = 1000;
const CLOSE_ABNORMAL = 1006;

const timers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle) };

/** RexSocketFactory over Node's WebSocket. */
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

/** Starts scripts/rex-relay.mjs on `port`, else on REX_RELAY_PORT, else on a free port. */
function startRelay({ port = Number(process.env.REX_RELAY_PORT ?? 0), log = () => {} } = {}) {
  return relay.startRelay({ port, log });
}

/** Runs the rex CLI and returns what it printed. */
const rex = (...args) => execFileSync(relay.rexCli(), args, { encoding: 'utf8' });

const rexJson = (...args) => JSON.parse(rex(...args));

/**
 * A bare control connection, the way another Rex client such as Rex.app on
 * the Mac holds one. `onEvent` gets every event message.
 */
function controlConnection(port, name, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/control`, REX_CONTROL_SUBPROTOCOL);
    const pending = new Map();
    let nextId = 1;
    const connection = {
      id: null,
      call: (method, payload) =>
        new Promise((done, fail) => {
          if (ws.readyState !== WebSocket.OPEN) return fail(new Error(`${name}: not connected`));
          const id = String(nextId++);
          pending.set(id, { done, fail });
          ws.send(JSON.stringify({ type: 'request', id, method, payload }));
        }),
      close: () => ws.close(CLOSE_NORMAL),
    };
    const lost = () => {
      const error = new Error(`${name}: connection lost`);
      reject(error);
      for (const entry of pending.values()) entry.fail(error);
      pending.clear();
    };
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'hello', api_revision: REX_API_REVISION, api_min_revision: REX_API_REVISION, client: { kind: 'app', name, version: '1' } }));
    ws.onerror = lost;
    ws.onclose = lost;
    ws.onmessage = (message) => {
      const parsed = JSON.parse(String(message.data));
      if (parsed.type === 'welcome') {
        connection.id = parsed.client.id;
        resolve(connection);
      } else if (parsed.type === 'response') {
        const entry = pending.get(parsed.id);
        pending.delete(parsed.id);
        if (parsed.error) entry.fail(new Error(`${parsed.error.code}: ${parsed.error.message}`));
        else entry.done(parsed.payload);
      } else if (parsed.type === 'event') onEvent(parsed);
    };
  });
}

module.exports = { timers, nodeSocket, startRelay, rex, rexJson, controlConnection };
