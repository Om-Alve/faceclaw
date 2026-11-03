#!/usr/bin/env node
/**
 * Deterministic herdr-even bridge for testing the Faceclaw Herdr app without a
 * tailnet or a real Herdr. Serves `/health` and `/ws` on localhost with a fixed
 * pane set: a blocked Claude pane with an approval prompt, a working Codex pane
 * with a queued message, a done Claude pane, a plain shell, and a screen-only
 * pane.
 *
 *   node scripts/herdr-mock-bridge.mjs --port 8791 --protocol 3
 *
 * Protocol 2 (the default) refuses text to a blocked agent with
 * `agent_blocked`; protocol 3 also accepts `prompt`/`run`/`type`/`answer` and
 * publishes queue summaries. Writes are logged. No dependencies.
 */
import http from "node:http";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const PORT = Number(option("port", "8791"));
const PROTOCOL = Number(option("protocol", "2"));
const MACHINE = option("machine", "mock-mac");
const QUIET = args.includes("--quiet");

const log = (...parts) => {
  if (!QUIET) console.log(...parts);
};

const now = () => Date.now();
let serial = 1;

/** The bridge's prompt revision, matching app/apps/herdr/protocol.ts. */
function normalizePromptText(text) {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
}
function hash32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function promptRevision(terminalId, stateSeq, text) {
  return hash32(`${terminalId}\u0000${stateSeq}`) + hash32(`${terminalId}\u0000${normalizePromptText(text)}`);
}
const nextId = (prefix) => `${prefix}${serial++}`;

const panes = [
  {
    id: "default/w1:p1",
    session: "default",
    paneId: "w1:p1",
    workspace: "api",
    tab: "claude",
    agent: "claude",
    status: "blocked",
    title: "Claude Code",
    chat: "transcript",
    subagents: 1,
    stateSeq: 10,
    terminalId: "term_mock_api",
    agentSession: { kind: "id", value: "90000000-0000-4000-8000-000000000001" },
    completionSeq: 2,
    focused: false,
  },
  {
    id: "default/w1:p2",
    session: "default",
    paneId: "w1:p2",
    workspace: "site",
    tab: "codex",
    agent: "codex",
    status: "working",
    title: "Codex",
    chat: "transcript",
    subagents: 0,
    stateSeq: 11,
    terminalId: "term_mock_site",
    agentSession: { kind: "id", value: "90000000-0000-4000-8000-000000000002" },
    completionSeq: 3,
    focused: true,
  },
  {
    id: "default/w2:p1",
    session: "default",
    paneId: "w2:p1",
    workspace: "logs",
    tab: "claude",
    agent: "claude",
    status: "done",
    title: "Claude Code",
    chat: "transcript",
    subagents: 0,
    stateSeq: 12,
    terminalId: "term_mock_logs",
    agentSession: { kind: "id", value: "90000000-0000-4000-8000-000000000003" },
    completionSeq: 7,
    focused: false,
  },
  {
    id: "default/w2:p2",
    session: "default",
    paneId: "w2:p2",
    workspace: "logs",
    tab: "shell",
    agent: null,
    status: "unknown",
    title: "zsh",
    chat: "screen",
    subagents: 0,
    stateSeq: 13,
    terminalId: "term_mock_shell",
    agentSession: null,
    completionSeq: 0,
    focused: false,
  },
  {
    id: "work/w1:p1",
    session: "work",
    paneId: "w1:p1",
    workspace: "deploy",
    tab: "opencode",
    agent: "opencode",
    status: "idle",
    title: "OpenCode",
    chat: "screen",
    subagents: 0,
    stateSeq: 14,
    terminalId: "term_mock_deploy",
    agentSession: null,
    completionSeq: 4,
    focused: false,
  },
];

const summaries = () =>
  panes.map((pane) => (PROTOCOL >= 3 ? pane : stripV3(pane)));

function stripV3(pane) {
  const { terminalId, agentSession, completionSeq, focused, ...rest } = pane;
  return rest;
}

const transcripts = {
  "default/w1:p1": [
    { id: "e1", kind: "user", text: "Add a retry to the uploader", ts: now() - 240_000 },
    { id: "e2", kind: "assistant", text: "I'll look at the uploader and its tests.", ts: now() - 230_000 },
    { id: "e3", kind: "tool", text: "Bash: rg -n uploader src/", ts: now() - 220_000 },
    { id: "e4", kind: "assistant", text: "Found it. The retry should wrap the fetch, not the parse.", ts: now() - 200_000 },
  ],
  "default/w1:p2": [
    { id: "e1", kind: "user", text: "Make the landing page faster", ts: now() - 90_000 },
    { id: "e2", kind: "tool", text: "Bash: npm run build", ts: now() - 60_000 },
  ],
  "default/w2:p1": [
    { id: "e1", kind: "user", text: "Check the deploy log", ts: now() - 600_000 },
    { id: "e2", kind: "assistant", text: "The deploy succeeded at 14:02.", ts: now() - 590_000 },
  ],
  "work/w1:p1": [
    { id: "screen", kind: "screen", text: "$ git status\nOn branch main\nnothing to commit, working tree clean\n$\n" },
  ],
};

const queues = new Map([["default/w1:p2", [{ id: "q1", text: "Then run the tests", ts: now() - 30_000 }]]]);
const outcomes = new Map();
const promptText = "Allow Bash? npm test\n\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No";
let promptOpen = new Map([["default/w1:p1", promptText]]);
const subagents = {
  "default/w1:p1": [
    { id: "s1", label: "general-purpose", description: "Find uploader tests", status: "working", lastActivity: now() - 20_000 },
  ],
};

const sockets = new Set();

function send(socket, message) {
  if (socket.destroyed) return;
  writeFrame(socket, JSON.stringify(message));
}

function broadcastSummary() {
  const payload = panes
    .map((pane) => ({
      pane: pane.id,
      pending: queues.get(pane.id)?.length ?? 0,
      undelivered: (outcomes.get(pane.id) ?? []).filter((entry) => entry.outcome === "undelivered").length,
    }))
    .filter((summary) => summary.pending || summary.undelivered);
  for (const socket of sockets) send(socket, { t: "queue.summary", panes: payload });
}

function broadcastPanes() {
  for (const socket of sockets) send(socket, { t: "panes", panes: summaries() });
}

function openView(socket, paneId, subagentId) {
  const pane = panes.find((candidate) => candidate.id === paneId);
  if (!pane) return send(socket, { t: "error", code: "unknown_pane", message: `unknown pane: ${paneId}` });
  if (subagentId) {
    if (!(subagents[paneId] ?? []).some((subagent) => subagent.id === subagentId)) {
      return send(socket, { t: "error", code: "unknown_subagent", message: `unknown subagent: ${subagentId}` });
    }
    return send(socket, {
      t: "chat",
      pane: paneId,
      subagent: subagentId,
      source: "transcript",
      entries: [{ id: "s1e1", kind: "assistant", text: "Reading the uploader tests now.", ts: now() }],
      hasOlder: false,
    });
  }
  socket.view = { paneId, subagent: undefined };
  send(socket, {
    t: "chat",
    pane: paneId,
    source: pane.chat,
    entries: transcripts[paneId] ?? [],
    hasOlder: false,
  });
  send(socket, { t: "queue", pane: paneId, items: queues.get(paneId) ?? [] });
  send(socket, { t: "subagents", pane: paneId, subagents: subagents[paneId] ?? [] });
  if (PROTOCOL >= 3) {
    send(socket, {
      t: "queue.outcomes",
      pane: paneId,
      items: [
        ...(outcomes.get(paneId) ?? []),
        ...(queues.get(paneId) ?? []).map((item) => ({ ...item, outcome: "pending" })),
      ],
    });
  }
  send(socket, { t: "prompt", pane: paneId, text: promptOpen.get(paneId) ?? null });
}

function finishWrite(socket, id, paneId, text, kind) {
  const pane = panes.find((candidate) => candidate.id === paneId);
  if (!pane) return send(socket, { t: "error", id, code: "unknown_pane", message: `unknown pane: ${paneId}` });
  if (pane.status === "blocked") return send(socket, { t: "error", id, code: "agent_blocked", message: "the agent is blocked" });
  send(socket, { t: "ok", id });
  pane.status = "working";
  const entry = { id: nextId("w"), kind: kind === "type" ? "user" : "user", text: kind === "type" ? `(typed) ${text}` : text, ts: now() };
  transcripts[paneId] = [...(transcripts[paneId] ?? []), entry];
  if (socket.view?.paneId === paneId) send(socket, { t: "chat.append", pane: paneId, entries: [entry] });
  broadcastPanes();
  if (kind === "type") return;
  setTimeout(() => {
    pane.status = "done";
    pane.stateSeq += 1;
    pane.completionSeq += 1;
    const reply = { id: nextId("w"), kind: "assistant", text: "Done. I ran the command and the output looked right.", ts: now() };
    transcripts[paneId] = [...(transcripts[paneId] ?? []), reply];
    if (socket.view?.paneId === paneId) send(socket, { t: "chat.append", pane: paneId, entries: [reply] });
    broadcastPanes();
  }, 900);
}

function handle(socket, message) {
  const id = typeof message.id === "string" ? message.id : undefined;
  const paneId = typeof message.pane === "string" ? message.pane : "";
  switch (message.t) {
    case "ping":
      return send(socket, { t: "pong", id });
    case "open":
      if (typeof message.subagent === "string") return openView(socket, paneId, message.subagent);
      return openView(socket, paneId);
    case "close":
      socket.view = null;
      return send(socket, { t: "ok", id });
    case "older":
      return send(socket, { t: "chat.older", id, pane: paneId, entries: [], hasOlder: false });
    case "keys": {
      const pane = panes.find((candidate) => candidate.id === paneId);
      if (!pane) return send(socket, { t: "error", id, code: "unknown_pane", message: "unknown pane" });
      log(`keys ${paneId}: ${(message.keys ?? []).join(" ")}`);
      if (promptOpen.has(paneId)) {
        promptOpen.delete(paneId);
        pane.status = "idle";
        pane.stateSeq += 1;
        send(socket, { t: "ok", id });
        if (socket.view?.paneId === paneId) send(socket, { t: "prompt", pane: paneId, text: null });
        broadcastPanes();
        return;
      }
      return send(socket, { t: "ok", id });
    }
    case "text": {
      if (typeof message.text !== "string" || !message.text) return send(socket, { t: "error", id, code: "bad_request", message: "text required" });
      if (message.queue === true) {
        const items = queues.get(paneId) ?? [];
        items.push({ id: nextId("q"), text: message.text, ts: now() });
        queues.set(paneId, items);
        send(socket, { t: "ok", id });
        if (socket.view?.paneId === paneId) send(socket, { t: "queue", pane: paneId, items });
        broadcastSummary();
        return;
      }
      return finishWrite(socket, id, paneId, message.text, "message");
    }
    case "prompt":
      if (typeof message.text !== "string" || !message.text) return send(socket, { t: "error", id, code: "bad_request", message: "text required" });
      if (message.queue === true) {
        const items = queues.get(paneId) ?? [];
        items.push({ id: nextId("q"), text: message.text, ts: now() });
        queues.set(paneId, items);
        send(socket, { t: "ok", id });
        if (socket.view?.paneId === paneId) send(socket, { t: "queue", pane: paneId, items });
        broadcastSummary();
        return;
      }
      return finishWrite(socket, id, paneId, message.text, "message");
    case "run":
    case "type":
      return finishWrite(socket, id, paneId, String(message.text ?? ""), message.t);
    case "answer": {
      if (!promptOpen.has(paneId)) return send(socket, { t: "error", id, code: "stale_prompt", message: "no open prompt" });
      const pane = panes.find((candidate) => candidate.id === paneId);
      const expected = promptRevision(pane.terminalId, pane.stateSeq, promptOpen.get(paneId));
      if (message.revision !== expected) return send(socket, { t: "error", id, code: "stale_prompt", message: "revision mismatch" });
      promptOpen.delete(paneId);
      pane.status = "idle";
      pane.stateSeq += 1;
      send(socket, { t: "ok", id });
      if (socket.view?.paneId === paneId) send(socket, { t: "prompt", pane: paneId, text: null });
      broadcastPanes();
      return;
    }
    case "unqueue": {
      const items = queues.get(paneId) ?? [];
      const index = items.findIndex((item) => item.id === message.item);
      if (index < 0) return send(socket, { t: "error", id, code: "unknown_item", message: "already delivered or unknown" });
      const [removed] = items.splice(index, 1);
      queues.set(paneId, items);
      const list = outcomes.get(paneId) ?? [];
      list.push({ ...removed, outcome: "canceled" });
      outcomes.set(paneId, list.slice(-20));
      send(socket, { t: "ok", id });
      if (socket.view?.paneId === paneId) send(socket, { t: "queue", pane: paneId, items });
      broadcastSummary();
      return;
    }
    case "log":
      return;
    default:
      return send(socket, { t: "error", id, code: "bad_request", message: `unknown message type: ${message.t}` });
  }
}

// ---------------------------------------------------------------- WebSocket

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, protocol: PROTOCOL, machine: MACHINE }));
    return;
  }
  response.writeHead(404).end("not found");
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
  );
  socket.view = null;
  sockets.add(socket);
  log(`client connected (${sockets.size})`);

  send(socket, {
    t: "hello",
    protocol: PROTOCOL,
    machine: MACHINE,
    herdrVersion: "mock",
    user: "mock-user",
    snippets: [{ label: "Continue", text: "continue", enter: true }, { label: "Ctrl+C", keys: ["ctrl+c"] }],
  });
  send(socket, { t: "panes", panes: summaries() });
  send(socket, {
    t: "queue.summary",
    panes: [{ pane: "default/w1:p2", pending: 1, undelivered: 0 }],
  });

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = readFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.length);
      if (frame.opcode === 0x8) {
        socket.destroy();
        return;
      }
      if (frame.opcode === 0x9) {
        writeFrame(socket, frame.payload, 0xa);
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      let message;
      try {
        message = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        send(socket, { t: "error", code: "bad_request", message: "invalid JSON" });
        continue;
      }
      log(`<- ${message.t}${message.pane ? ` ${message.pane}` : ""}`);
      handle(socket, message);
    }
  });
  socket.on("close", () => {
    sockets.delete(socket);
    log(`client disconnected (${sockets.size})`);
  });
  socket.on("error", () => sockets.delete(socket));
});

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  let payload = buffer.subarray(offset, offset + length);
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  }
  return { fin, opcode, payload, length: offset + length };
}

function writeFrame(socket, payload, opcode = 0x1) {
  if (socket.destroyed) return;
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(Buffer.concat([header, data]));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`herdr mock bridge on http://127.0.0.1:${PORT} (protocol ${PROTOCOL}, machine ${MACHINE})`);
  console.log(`use: https://127.0.0.1:${PORT} in the app (the WebSocket is /ws; no TLS)`);
});
