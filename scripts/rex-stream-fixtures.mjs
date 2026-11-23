#!/usr/bin/env node
// Records real Rex data-stream bytes from a throwaway terminal into
// tests/fixtures/rex/stream-*.json, then destroys the terminal's session.
//
//   node scripts/rex-stream-fixtures.mjs
//
// Talks to the local Rex server through scripts/rex-relay.mjs.
// Strings that name this machine or its user are overwritten in place with
// same-length placeholders, so recorded byte counts stay exact.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startRelay } from "./rex-relay.mjs";

const API_REVISION = 18;
const DATA_SUBPROTOCOL = "rex.data.terminal.v1";
const CONTROL_SUBPROTOCOL = "rex.control.v1";
const SESSION_LABEL_PREFIX = "lane-leaf-stream-";
const HELLO = 0x01;
const RESUME = 0x02;
const WELCOME = 0x81;
const WELCOME_TOKEN_START = 1;
const WELCOME_TOKEN_END = 17;
const WELCOME_NONCE_OFFSET = 24;
const RESUME_BYTES = 25;
const RESUME_COUNT_OFFSET = 17;
const GRID = { columns: 80, rows: 24 };
const RESIZED_GRID = { columns: 60, rows: 12 };
const QUIET_MS = 400;
const QUIET_TIMEOUT_MS = 10000;
const POLL_MS = 10;
const RESUME_AFTER_BYTES = 1000;
const OFFLINE_MS = 300;
const TRICKLE_LINES = 300;
const TRICKLE = `for i in $(seq 1 ${TRICKLE_LINES}); do echo "line $i"; sleep 0.005; done\n`;
const CLIENT_CLOSE_NORMAL = 1000;
const OVERALL_TIMEOUT_MS = 90000;
const SHELL = "exec env -i TERM=xterm-256color HOME=/tmp PS1='$ ' /bin/bash --noprofile --norc\n";
const CLEAR_ALL = "printf '\\033[H\\033[2J\\033[3J'\n";
const FIXTURE_DIR = fileURLToPath(new URL("../tests/fixtures/rex/", import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A control connection with request/response calls and a throwaway session it owns. */
export async function openControl(port, clientName) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/control`, CONTROL_SUBPROTOCOL, { perMessageDeflate: false });
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", api_revision: API_REVISION, api_min_revision: API_REVISION, client: { kind: "app", platform: "other", name: clientName, version: "0" } })),
    );
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "welcome") resolve();
      else if (message.type === "response") {
        const call = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) call.reject(new Error(`${call.method}: ${JSON.stringify(message.error)}`));
        else call.resolve(message.payload);
      }
    });
  });
  const call = (method, payload) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++);
      pending.set(id, { method, resolve, reject });
      ws.send(JSON.stringify({ type: "request", id, method, payload }));
    });
  return { ws, call };
}

/** Creates a lane session with one bash terminal at GRID that this client owns. */
export async function createLaneTerminal(control, label) {
  const created = await control.call("session.create", {
    label,
    initial_windows: [{ layout: { block: { flavor: "com.superlogical.terminal.shell", options: { cwd: "/tmp" } } } }],
  });
  const sessionId = created.session_id;
  const blockId = created.initial_windows[0].block_ids[0];
  await control.call("session.attach", { session_id: sessionId });
  await control.call("session.own_block", { session_id: sessionId, block_ids: [blockId], mode: "take" });
  const terminal = (method, args = {}) => control.call(`com.superlogical.terminal.${method}`, { session_id: sessionId, block_id: blockId, args });
  await terminal("resize", GRID);
  await terminal("write", { data: SHELL });
  await sleep(QUIET_MS);
  await terminal("write", { data: CLEAR_ALL });
  await sleep(QUIET_MS);
  return { sessionId, blockId, terminal, destroy: () => control.call("session.destroy", { session_id: sessionId }) };
}

export async function laneSessionsLeft(control) {
  const listed = await control.call("session.list", {});
  return (listed.sessions || []).filter((session) => String(session.label || "").startsWith(SESSION_LABEL_PREFIX));
}

/**
 * One data connection. Records every binary message after the WELCOME with
 * its arrival time, and the server's close.
 */
function openData(port, firstMessage) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/data`, DATA_SUBPROTOCOL, { perMessageDeflate: false });
  const connection = { ws, welcome: null, reply: null, frames: [], bytes: 0, lastAt: 0, close: null, reading: true, startedAt: 0 };
  connection.ready = new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.on("open", () => ws.send(firstMessage));
    ws.on("message", (data) => {
      if (!connection.reading) return;
      const bytes = new Uint8Array(data);
      if (!connection.reply) {
        connection.reply = bytes;
        connection.startedAt = Date.now();
        if (bytes[0] === WELCOME) connection.welcome = parseWelcome(bytes);
        resolve(connection);
        return;
      }
      connection.lastAt = Date.now();
      connection.frames.push({ atMs: connection.lastAt - connection.startedAt, bytes });
      connection.bytes += bytes.length;
    });
    ws.on("close", (code, reason) => {
      connection.close = { code, reason: reason.toString() };
      resolve(connection);
    });
  });
  return connection;
}

function parseWelcome(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { token: bytes.slice(WELCOME_TOKEN_START, WELCOME_TOKEN_END), nonce: view.getBigUint64(WELCOME_NONCE_OFFSET, true).toString() };
}

function helloMessage(ticket) {
  return Buffer.concat([Buffer.from([HELLO]), Buffer.from(ticket, "base64url")]);
}

function resumeMessage(token, count) {
  const message = Buffer.alloc(RESUME_BYTES);
  message[0] = RESUME;
  Buffer.from(token).copy(message, 1);
  message.writeBigUInt64LE(BigInt(count), RESUME_COUNT_OFFSET);
  return message;
}

async function connectHello(port, lane) {
  const ticket = await lane.control.call("data.connect", { session_id: lane.sessionId, block_id: lane.blockId, data_ref_id: "terminal", subprotocol: DATA_SUBPROTOCOL });
  return openData(port, helloMessage(ticket.ticket)).ready;
}

/** Waits until the connection has had no stream bytes for QUIET_MS. */
async function quiet(connection) {
  const since = Date.now();
  const deadline = since + QUIET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (connection.close || Date.now() - Math.max(connection.lastAt, since) >= QUIET_MS) return;
    await sleep(POLL_MS);
  }
  throw new Error("stream never went quiet");
}

async function waitForBytes(connection, count) {
  const deadline = Date.now() + QUIET_TIMEOUT_MS;
  while (connection.bytes < count) {
    if (Date.now() > deadline) throw new Error(`stream stopped at ${connection.bytes} bytes`);
    await sleep(1);
  }
}

function closeData(connection) {
  if (connection.close) return Promise.resolve();
  return new Promise((resolve) => {
    connection.ws.once("close", () => resolve());
    connection.ws.close(CLIENT_CLOSE_NORMAL);
  });
}

/** The lane shell runs with HOME=/tmp and PS1='$ ', so only paths and the host name (in OSC 7) can leak. */
function identifyingStrings() {
  const host = os.hostname();
  return [os.homedir(), host, host.split(".")[0]].sort((a, b) => b.length - a.length);
}

function scrub(bytes, secrets) {
  const out = Buffer.from(bytes);
  for (const secret of secrets) {
    const needle = Buffer.from(secret, "utf8");
    const placeholder = Buffer.alloc(needle.length, "x");
    for (let at = out.indexOf(needle); at >= 0; at = out.indexOf(needle, at + needle.length)) placeholder.copy(out, at);
  }
  for (const secret of secrets) {
    if (out.includes(Buffer.from(secret, "utf8"))) throw new Error("scrub left an identifying string");
  }
  return out;
}

function fixtureConnection(connection, secrets) {
  return {
    frames: connection.frames.map((frame) => ({ atMs: frame.atMs, base64: scrub(frame.bytes, secrets).toString("base64") })),
    close: connection.closedByServer ? connection.close : null,
  };
}

function writeFixture(name, fixture) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `stream-${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

/** Records one HELLO connection around `act`, then closes it as the client. */
async function recordScenario(port, lane, act) {
  const connection = await connectHello(port, lane);
  if (!connection.welcome) throw new Error(`HELLO refused: ${Buffer.from(connection.reply).toString("hex")}`);
  await quiet(connection);
  await act(connection);
  await quiet(connection);
  connection.closedByServer = Boolean(connection.close);
  await closeData(connection);
  return connection;
}

async function record() {
  const relay = await startRelay({ port: 0, log: () => {} });
  const port = relay.port;
  const control = await openControl(port, "faceclaw-rex-stream-fixtures");
  const secrets = identifyingStrings();
  let lane = null;
  const timeout = setTimeout(() => {
    console.error("TIMEOUT");
    process.exit(2);
  }, OVERALL_TIMEOUT_MS);
  try {
    lane = { control, ...(await createLaneTerminal(control, `${SESSION_LABEL_PREFIX}fixtures`)) };
    const { terminal } = lane;

    const output = await recordScenario(port, lane, () =>
      terminal("write", { data: "printf '\\033[31mred\\033[0m and progress 10%%\\r progress 99%%\\n'; seq 1 5\n" }),
    );
    writeFixture("output", { grid: GRID, nonce: output.welcome.nonce, connections: [fixtureConnection(output, secrets)] });

    let spoofNonces = null;
    const spoof = await recordScenario(port, lane, (connection) => {
      const nonce = BigInt(connection.welcome.nonce);
      spoofNonces = [(nonce + 1n).toString(), `${nonce}0`];
      const apcs = spoofNonces.map((wrong) => `\\033_rex1;${wrong};{\\"type\\":\\"resize\\",\\"cols\\":7,\\"rows\\":3}\\033\\\\`).join("");
      return terminal("write", { data: `printf '${apcs}after spoof\\n'\n` });
    });
    writeFixture("spoof", { grid: GRID, nonce: spoof.welcome.nonce, spoofNonces, connections: [fixtureConnection(spoof, secrets)] });

    const resize = await recordScenario(port, lane, async (connection) => {
      await terminal("write", { data: "seq 1 3\n" });
      await quiet(connection);
      await terminal("resize", RESIZED_GRID);
      await quiet(connection);
      await terminal("write", { data: "seq 4 6\n" });
      await quiet(connection);
      await terminal("resize", GRID);
    });
    writeFixture("resize", { grid: GRID, resizedGrid: RESIZED_GRID, nonce: resize.welcome.nonce, connections: [fixtureConnection(resize, secrets)] });

    await terminal("write", { data: "for i in $(seq 1 60); do echo busy $i; sleep 0.01; done\n" });
    const busyTicket = await control.call("data.connect", { session_id: lane.sessionId, block_id: lane.blockId, data_ref_id: "terminal", subprotocol: DATA_SUBPROTOCOL });
    const busy = await openData(port, helloMessage(busyTicket.ticket)).ready;
    await quiet(busy);
    busy.closedByServer = Boolean(busy.close);
    await closeData(busy);
    writeFixture("busy", { grid: GRID, nonce: busy.welcome.nonce, connections: [fixtureConnection(busy, secrets)] });

    const first = await connectHello(port, lane);
    await quiet(first);
    await terminal("write", { data: TRICKLE });
    await waitForBytes(first, first.bytes + RESUME_AFTER_BYTES);
    first.reading = false;
    first.ws.terminate();
    await sleep(OFFLINE_MS);
    const resumeBytes = first.bytes;
    const second = await openData(port, resumeMessage(first.welcome.token, resumeBytes)).ready;
    if (!second.welcome) throw new Error(`RESUME refused: ${Buffer.from(second.reply).toString("hex")}`);
    if (second.welcome.nonce !== first.welcome.nonce) throw new Error("resumed WELCOME changed the nonce");
    await quiet(second);
    second.closedByServer = Boolean(second.close);
    await closeData(second);
    writeFixture("resume", {
      grid: GRID,
      nonce: first.welcome.nonce,
      lines: TRICKLE_LINES,
      resumeBytes,
      connections: [fixtureConnection(first, secrets), fixtureConnection(second, secrets)],
    });

    const exit = await recordScenario(port, lane, () => terminal("write", { data: "exit 3\n" }));
    writeFixture("exit", { grid: GRID, nonce: exit.welcome.nonce, connections: [fixtureConnection(exit, secrets)] });
  } finally {
    clearTimeout(timeout);
    if (lane) await lane.destroy().catch((error) => console.error(`destroy failed: ${error.message}`));
    const left = await laneSessionsLeft(control);
    console.log(`lane sessions left: ${left.length}`);
    control.ws.close(CLIENT_CLOSE_NORMAL);
    relay.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  record().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
