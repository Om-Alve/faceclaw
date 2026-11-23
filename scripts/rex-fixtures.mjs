#!/usr/bin/env node
// Records real control-connection messages from the local Rex server into
// tests/fixtures/rex/control-messages.json, for tests/rex-protocol.test.cjs.
//
//   node scripts/rex-fixtures.mjs
//
// It creates a throwaway session, drives one /bin/sh pane through every event
// the fixtures need, and destroys the session. It keeps only messages about
// that session, replaces IDs, tokens, names, paths, PIDs and times with stable
// placeholders, and renumbers request IDs and seqs in order. It writes nothing
// unless it recorded every key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "./rex-relay.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "rex", "control-messages.json");
const SESSION_LABEL = "lane-r1-fixtures";
const NESTED_LABEL = "lane-r2-fixtures-nested";
const API_REVISION = 18;
const SUBPROTOCOL = "rex.control.v1";
const PROMPT = "$";
const WAIT_MS = 5_000;
const POLL_MS = 50;
const OWNED_SIZE = { columns: 100, rows: 30 };
const FIXED_PID = 4242;
const FIXED_TIME = "2026-01-01T00:00:00Z";
const FIXED_HASH = "0".repeat(64);
// Small enough that format splits the pane's content and blob_read returns the rest.
const FORMAT_PART_BYTES = 256;
const SHELL_FLAVOR = "com.superlogical.terminal.shell";
const SHELL_OPTIONS = { shell: "none", command: ["/bin/sh"], login: false, cwd: "/tmp" };

const BLOCK_EVENTS = [
  "bell",
  "title_changed",
  "desktop_notification",
  "progress_report",
  "program_status_changed",
  "program_status_removed",
  "process_changed",
  "size_changed",
  "child_exited",
];
const KEYS = [
  "welcome",
  "response_bootstrap",
  "response_view",
  "response_format_text",
  "response_format_vt",
  "response_program_status",
  "response_error_method_not_found",
  "response_error_bad_request",
  "event_session_created",
  "event_session_view_changed",
  "event_block_owner_changed",
  "event_session_destroyed",
  ...BLOCK_EVENTS.map((name) => `event_block_${name}`),
  "response_create",
  "response_own_block",
  "response_disown_block",
  "response_format_vt_part",
  "response_blob_read",
  "response_view_nested",
];

// Typed into the pane in one write: a bell, an OSC 9 notification, an OSC 0
// title, an OSC 9;4 progress report, an OSC 7501 blocked report, then a marker.
const SIGNALS =
  "printf '\\a'; printf '\\033]9;rex fixture\\a'; printf '\\033]0;rex-fixture-title\\a'; " +
  "printf '\\033]9;4;1;40\\a'; printf '\\033]7501;state=blocked:kind=permission:app=rex-fixture:msg=QXBwcm92ZT8=\\033\\\\'; " +
  "sleep 0.2; echo rex-fixture-ok\n";

const recorded = {};
const events = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, predicate) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

function connect(port, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/control`, SUBPROTOCOL);
    const pending = new Map();
    let nextId = 1;
    const conn = {
      raw: (method, payload) =>
        new Promise((done, fail) => {
          const id = String(nextId++);
          pending.set(id, { done, fail });
          ws.send(JSON.stringify({ type: "request", id, method, payload }));
        }),
      call: async (method, payload) => {
        const response = await conn.raw(method, payload);
        if (response.error) throw new Error(`${method}: ${response.error.code} ${response.error.message}`);
        return response;
      },
      close: () => ws.close(1000),
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", api_revision: API_REVISION, api_min_revision: API_REVISION, client: { kind: "cli", name: "faceclaw-rex-fixtures", version: "1" } }));
    // Node's WebSocket can fire error without close, or close without error.
    const lost = () => {
      const error = new Error("control connection lost");
      reject(error);
      for (const request of pending.values()) request.fail(error);
      pending.clear();
    };
    ws.onerror = lost;
    ws.onclose = lost;
    ws.onmessage = (message) => {
      const parsed = JSON.parse(String(message.data));
      if (parsed.type === "welcome") resolve({ ...conn, welcome: parsed });
      else if (parsed.type === "response") {
        pending.get(parsed.id)?.done(parsed);
        pending.delete(parsed.id);
      } else if (parsed.type === "event") onEvent(parsed);
    };
  });
}

function hasForeground(message) {
  return message.payload.payload.event.payload.payload.foreground != null;
}

function eventKey(message, sessionId) {
  const event = message.payload;
  if (event.type === "session_created") return event.payload.session.session_id === sessionId ? "event_session_created" : null;
  if (event.type === "session_destroyed") return event.payload.session_id === sessionId ? "event_session_destroyed" : null;
  if (event.type !== "session_event" || event.payload.session_id !== sessionId) return null;
  const inner = event.payload.event;
  if (inner.type === "block_event") return `event_block_${inner.payload.name}`;
  return `event_${inner.type}`;
}

function wordPattern(text) {
  return new RegExp(`\\b${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
}

/** Replace everything that identifies this machine, its account, or a run with stable placeholders. */
function normalize(value) {
  const uuids = new Map();
  const user = os.userInfo().username;
  const host = os.hostname().replace(/\.local$/, "");
  const home = os.homedir();
  const scrubText = (text) =>
    text
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) => {
        if (!uuids.has(uuid)) uuids.set(uuid, `00000000-0000-0000-0000-${String(uuids.size + 1).padStart(12, "0")}`);
        return uuids.get(uuid);
      })
      .split(home)
      .join("/home/user")
      .replace(wordPattern(host), "host")
      .replace(wordPattern(user), "user")
      // Rex makes a default label from the last 8 hex digits of the ID, so keep that link.
      .replace(/\b(Window|Block) ([0-9a-f]{8})\b/g, (_, kind, suffix) => {
        for (const [uuid, placeholder] of uuids) if (uuid.endsWith(suffix)) return `${kind} ${placeholder.slice(-8)}`;
        return `${kind} 00000000`;
      });
  const walk = (node, key) => {
    if (typeof node === "string") {
      if (key === "reconnect_token") return "<reconnect-token>";
      if (key === "hash") return FIXED_HASH;
      if (key.endsWith("_at")) return FIXED_TIME;
      return scrubText(node);
    }
    if (typeof node === "number" && key === "pid") return FIXED_PID;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    return node;
  };
  return walk(value, "");
}

async function main() {
  const relay = await startRelay({ port: 0, log: () => {} });
  let sessionId = null;
  let nestedId = null;
  const control = await connect(relay.port, (message) => {
    events.push(message);
    for (const event of sessionId ? events.splice(0) : []) {
      const key = eventKey(event, sessionId);
      if (key && KEYS.includes(key) && !recorded[key] && (key !== "event_block_process_changed" || hasForeground(event))) recorded[key] = event;
    }
  });
  recorded.welcome = control.welcome;
  try {
    await control.call("session.bootstrap", { event_scope: "all", attach_session_ids: [] });
    const created = await control.call("session.create", {
      label: SESSION_LABEL,
      initial_windows: [{ layout: { block: { flavor: SHELL_FLAVOR, options: SHELL_OPTIONS } } }],
    });
    recorded.response_create = created;
    sessionId = created.payload.session_id;
    const blockId = created.payload.initial_windows[0].block_ids[0];
    const block = (method, args = {}) => control.call(`com.superlogical.terminal.${method}`, { session_id: sessionId, block_id: blockId, args });

    const second = await connect(relay.port, () => {});
    const bootstrap = await second.call("session.bootstrap", { event_scope: "session", attach_session_ids: [] });
    second.close();
    const sessions = bootstrap.payload.attach_all.sessions.filter((session) => session.session_id === sessionId);
    bootstrap.payload.attach_all.sessions = sessions;
    bootstrap.payload.server_status.session_count = sessions.length;
    recorded.response_bootstrap = bootstrap;

    await control.call("session.attach", { session_id: sessionId });
    recorded.response_own_block = await control.call("session.own_block", { session_id: sessionId, block_ids: [blockId], mode: "take" });
    await block("resize", OWNED_SIZE);
    recorded.response_disown_block = await control.call("session.disown_block", { session_id: sessionId, block_ids: [blockId] });
    recorded.response_view = await control.call("session.view", { session_id: sessionId });

    await waitFor("the prompt", async () => (await block("format", { format: "text", trim: true })).payload.content.includes(PROMPT));
    await block("write", { data: SIGNALS });
    await waitFor("the marker", async () => (await block("format", { format: "text", trim: true })).payload.content.includes("rex-fixture-ok\n"));
    recorded.response_format_text = await block("format", { format: "text", trim: true });
    recorded.response_format_vt = await block("format", { format: "vt", extra_cursor: true, extra_modes: true });
    recorded.response_format_vt_part = await block("format", { format: "vt", max_bytes: FORMAT_PART_BYTES });
    const part = recorded.response_format_vt_part.payload;
    recorded.response_blob_read = await block("blob_read", { id: part.id, offset: Buffer.byteLength(part.content) });
    recorded.response_program_status = await waitFor("a status record", async () => {
      const status = await block("program_status");
      return status.payload.records.length ? status : null;
    });
    recorded.response_error_method_not_found = await control.raw("com.superlogical.terminal.no_such_method", { session_id: sessionId, block_id: blockId, args: {} });
    recorded.response_error_bad_request = await control.raw("session.view", {});

    // A second session with two windows, one split, and labels both generated and set.
    const shell = (label) => ({ block: { flavor: SHELL_FLAVOR, options: SHELL_OPTIONS, ...(label ? { label } : {}) } });
    const nested = await control.call("session.create", {
      label: NESTED_LABEL,
      initial_windows: [
        { layout: shell() },
        { window_label: "editor", layout: { split: { direction: "horizontal", before: shell("logs"), after: shell() } } },
      ],
    });
    nestedId = nested.payload.session_id;
    recorded.response_view_nested = await control.call("session.view", { session_id: nestedId });

    await block("write", { data: "exit\n" });
    await waitFor("child_exited", () => recorded.event_block_child_exited);
  } finally {
    if (nestedId) await control.call("session.destroy", { session_id: nestedId });
    if (sessionId) await control.call("session.destroy", { session_id: sessionId });
  }
  await waitFor("session_destroyed", () => recorded.event_session_destroyed);
  const leftover = (await control.call("session.list", {})).payload.sessions.filter((session) => session.label === SESSION_LABEL || session.label === NESTED_LABEL);
  control.close();
  await relay.close();

  const missing = KEYS.filter((key) => !recorded[key]);
  if (missing.length) throw new Error(`not recorded: ${missing.join(", ")}`);
  if (leftover.length) throw new Error(`${leftover.length} throwaway session(s) left behind`);
  const fixtures = normalize(Object.fromEntries(KEYS.map((key) => [key, recorded[key]])));
  // Request IDs count the polls before each request, and seqs count every event
  // the server sent, other sessions' too, so both vary between runs. Renumber
  // IDs in order, and each seq as the number of recorded events at or below it,
  // which keeps where a response falls among this session's recorded events.
  const messages = Object.values(fixtures);
  const eventSeqs = messages.filter((message) => message.type === "event").map((message) => message.seq);
  let responseId = 0;
  for (const message of messages) {
    if (message.type === "response") message.id = String(++responseId);
    if (message.seq !== undefined) message.seq = eventSeqs.filter((seq) => seq <= message.seq).length;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(fixtures, null, 2)}\n`);
  console.log(`wrote ${KEYS.length} fixtures to ${path.relative(process.cwd(), OUT)}: ${KEYS.join(" ")}`);
  console.log(`leftover throwaway sessions: ${leftover.length}`);
}

main().catch((error) => {
  console.error(`rex-fixtures failed: ${error.message}`);
  process.exit(1);
});
