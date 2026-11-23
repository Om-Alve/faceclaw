#!/usr/bin/env node
// Records Rex program-status fixtures from the live local Rex server.
//
// It creates a throwaway session, prints OSC 7501 reports, an OSC 9
// notification and a bell from its shell, and records what Rex returns:
//
//   tests/fixtures/rex/status-reports.json            the OSC 7501 bodies printed, in order
//   tests/fixtures/rex/status-read.json               program_status result with nested records
//   tests/fixtures/rex/status-read-reconnect.json     the same read from a fresh connection
//   tests/fixtures/rex/status-events.json             status block events, in arrival order
//
// Timestamps and process IDs are normalised so two runs write the same files.
// The session is destroyed before exit.
//
//   node scripts/rex-status-fixtures.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "tests/fixtures/rex");
const socketPath = join(homedir(), "Library/Application Support/rex/server.sock");
const RELAY_PORT = 8795;
const API_REVISION = 18;
const SESSION_LABEL = "lane-status-fixtures";
const EVENT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 20;
const SHELL_READY_TIMEOUT_MS = 10000;
const RUN_TIMEOUT_MS = 60000;
const STATUS_EVENTS = new Set(["program_status_changed", "program_status_removed", "desktop_notification", "bell"]);
const TERMINAL = "com.superlogical.terminal";
const NORMALISED_PID = 1000;

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

// OSC 7501 report bodies. Free text is base64 of UTF-8, as the protocol requires.
const ROOT_WORKING = `state=working:app=claude-code:msg=${b64("Working on café ☕")}`;
const AGENT_1_WORKING = `state=working:id=agent-1:title=${b64("Refactor parser")}:msg=${b64("Reading files")}`;
const AGENT_2_BLOCKED = `state=blocked:kind=permission:id=agent-2:title=${b64("Fix tests")}:msg=${b64("Approve edit to naïve.ts? ✅ 日本語")}`;
const AGENT_2_CHECK_WORKING = `state=working:id=agent-2/check:msg=${b64("Waiting")}`;
const AGENT_2_WORKING = `state=working:id=agent-2:title=${b64("Fix tests")}:msg=${b64("Editing naïve.ts")}`;
const AGENT_1_DONE = `state=done:id=agent-1:title=${b64("Refactor parser")}:msg=${b64("Parser refactored")}`;
const AGENT_2_ERROR = `state=error:id=agent-2:title=${b64("Fix tests")}:msg=${b64("Tests failed")}`;
const CLEAR_AGENT_2 = "state=clear:id=agent-2";
const CLEAR_ALL = "state=clear";

let nextRequestId = 1;
const reports = [];
const statusEvents = [];
let sessionId = null;
let control = null;

const relay = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});

function openControl() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/api/control`, "rex.control.v1", { perMessageDeflate: false });
    const pending = new Map();
    const client = {
      call(method, payload) {
        const id = String(nextRequestId++);
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ type: "request", id, method, payload }));
        });
      },
      onEvent: () => {},
      close() {
        ws.close(1000);
      },
    };
    ws.on("open", () => ws.send(JSON.stringify({
      type: "hello",
      api_revision: API_REVISION,
      api_min_revision: API_REVISION,
      client: { kind: "app", platform: "other", name: "faceclaw-rex-status-fixtures", version: "0" },
    })));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "welcome") resolve(client);
      else if (message.type === "response") {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.rej(new Error(`${message.error.code}: ${message.error.message}`));
        else request.res(message.payload);
      } else if (message.type === "event") client.onEvent(message.payload);
    });
    ws.on("error", reject);
  });
}

function waitFor(predicate, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
  });
}

async function run() {
  await new Promise((resolve) => relay.listen(RELAY_PORT, "127.0.0.1", resolve));
  control = await openControl();
  await control.call("session.bootstrap", { event_scope: "session", attach_session_ids: [] });
  const created = await control.call("session.create", {
    label: SESSION_LABEL,
    initial_windows: [{ layout: { block: { flavor: `${TERMINAL}.shell` } } }],
  });
  sessionId = created.session_id;
  const blockId = created.initial_windows[0].block_ids[0];
  let shellReady = false;
  control.onEvent = (event) => {
    if (event.type !== "session_event" || event.payload.session_id !== sessionId) return;
    const inner = event.payload.event;
    if (inner.type !== "block_event" || inner.payload.block_id !== blockId) return;
    if (inner.payload.name === "pwd_changed") shellReady = true;
    if (STATUS_EVENTS.has(inner.payload.name)) statusEvents.push({ name: inner.payload.name, payload: inner.payload.payload ?? {} });
  };
  await control.call("session.attach", { session_id: sessionId });
  const terminal = (method, args = {}) => control.call(`${TERMINAL}.${method}`, { session_id: sessionId, block_id: blockId, args });
  await waitFor(() => shellReady, SHELL_READY_TIMEOUT_MS, "the shell prompt");

  const step = async (command, eventName) => {
    const before = statusEvents.length;
    await terminal("write", { data: `${command}\n` });
    await waitFor(() => statusEvents.slice(before).some((e) => e.name === eventName), EVENT_TIMEOUT_MS, eventName);
  };
  const report = (body) => {
    reports.push(body);
    return step(`printf '\\033]7501;${body}\\033\\\\'`, body.startsWith("state=clear") ? "program_status_removed" : "program_status_changed");
  };

  await report(ROOT_WORKING);
  await report(AGENT_1_WORKING);
  await report(AGENT_2_BLOCKED);
  await report(AGENT_2_CHECK_WORKING);
  const read = await terminal("program_status");

  const second = await openControl();
  await second.call("session.attach", { session_id: sessionId });
  const reread = await second.call(`${TERMINAL}.program_status`, { session_id: sessionId, block_id: blockId, args: {} });
  second.close();

  await report(AGENT_2_BLOCKED);
  await report(AGENT_2_WORKING);
  await report(AGENT_2_BLOCKED);
  await report(CLEAR_AGENT_2);
  await report(AGENT_2_BLOCKED);
  await report(AGENT_1_DONE);
  await report(AGENT_2_ERROR);
  await report(CLEAR_ALL);
  await step("printf '\\033]9;Build finished\\007'", "desktop_notification");
  await step("printf '\\a'", "bell");

  const normalise = fixtureNormaliser();
  mkdirSync(fixtureDir, { recursive: true });
  const write = (name, value) => writeFileSync(join(fixtureDir, name), `${JSON.stringify(normalise(value), null, 2)}\n`);
  write("status-reports.json", reports);
  write("status-read.json", read);
  write("status-read-reconnect.json", reread);
  write("status-events.json", statusEvents);
}

// Maps each distinct server timestamp to a fixed one in order of first
// appearance, so equal timestamps stay equal across files and runs.
function fixtureNormaliser() {
  const seen = new Map();
  const visit = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    }
    if (key === "updated_at") {
      if (!seen.has(value)) seen.set(value, new Date(Date.UTC(2026, 0, 1, 0, 0, seen.size)).toISOString());
      return seen.get(value);
    }
    if (key === "pid") return NORMALISED_PID;
    return value;
  };
  return (value) => visit(value);
}

async function destroySession() {
  if (!sessionId) return;
  await control.call("session.destroy", { session_id: sessionId });
  const { sessions } = await control.call("session.list", {});
  if ((sessions ?? []).some((s) => s.session_id === sessionId)) throw new Error(`session ${sessionId} survived destroy`);
}

const timer = setTimeout(() => {
  console.error("timed out");
  destroySession().finally(() => process.exit(2));
}, RUN_TIMEOUT_MS);
let exitCode = 0;
try {
  await run();
  console.log(`wrote ${reports.length} reports and ${statusEvents.length} events to ${fixtureDir}`);
} catch (error) {
  console.error(error);
  exitCode = 1;
}
try {
  await destroySession();
} catch (error) {
  console.error("cleanup failed", error);
  exitCode = 1;
}
control?.close();
relay.close();
clearTimeout(timer);
process.exitCode = exitCode;
