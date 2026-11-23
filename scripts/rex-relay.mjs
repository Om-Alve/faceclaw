#!/usr/bin/env node
// Forwards 127.0.0.1:<port> to the local Rex server's unix socket, so the
// phone (through `adb reverse`) and Node tests can reach Rex over TCP.
//
//   node scripts/rex-relay.mjs --port 8792
//
// It logs each connection, the method of each control request, and byte
// counts per connection every minute and on close. It never logs payloads,
// because a hello carries a reconnect token. It removes permessage-deflate
// from the upgrade request so that the frames it reads are not compressed.
// Set REX_BIN to the rex CLI if `rex` is not on PATH and Rex.app is not in
// /Applications.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK = "127.0.0.1";
const REX_APP_CLI = "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";
const STATS_INTERVAL_MS = 60_000;
const HEADER_END = "\r\n\r\n";
const MAX_HEADER_BYTES = 64 * 1024;
const CONTROL_PATH = "/api/control";

const FIN_BIT = 0x80;
const OPCODE_MASK = 0x0f;
const MASK_BIT = 0x80;
const LENGTH_MASK = 0x7f;
const LENGTH_16 = 126;
const LENGTH_64 = 127;
const MASK_KEY_BYTES = 4;
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const FIRST_CONTROL_OPCODE = 0x8;

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The rex CLI: REX_BIN, else `rex` on PATH, else the one inside Rex.app. */
export function rexCli() {
  if (process.env.REX_BIN) return process.env.REX_BIN;
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "rex")).find(isExecutable);
  if (onPath) return onPath;
  if (isExecutable(REX_APP_CLI)) return REX_APP_CLI;
  throw new Error("rex CLI not found: set REX_BIN, put rex on PATH, or install Rex.app in /Applications");
}

/** The unix socket path of the primary listener that `rex server status` reports. */
export function rexSocketPath() {
  const status = JSON.parse(execFileSync(rexCli(), ["server", "status", "--json"], { encoding: "utf8" }));
  const listener = (status.listeners ?? []).find((entry) => entry.primary && entry.transport === "unix");
  const address = listener?.addresses?.[0];
  if (!address) throw new Error(`rex server status reported no unix listener: ${status.endpoint}`);
  return address;
}

/** Start the relay. Resolves once it listens; `port` 0 picks a free port. */
export function startRelay({ port, socketPath = rexSocketPath(), log = (line) => console.log(line) }) {
  let nextConnection = 1;
  const open = new Set();
  const server = net.createServer((client) => {
    const conn = { id: nextConnection++, path: "?", up: 0, down: 0, reportedUp: 0, reportedDown: 0 };
    const say = (text) => log(`${new Date().toISOString()} conn=${conn.id} ${conn.path} ${text}`);
    const upstream = net.connect(socketPath);
    open.add(conn);
    conn.report = () => {
      say(`bytes up=+${conn.up - conn.reportedUp} down=+${conn.down - conn.reportedDown} total_up=${conn.up} total_down=${conn.down}`);
      conn.reportedUp = conn.up;
      conn.reportedDown = conn.down;
    };
    let head = Buffer.alloc(0);
    let readFrames = null;
    client.on("data", (chunk) => {
      conn.up += chunk.length;
      if (readFrames) {
        readFrames(chunk);
        upstream.write(chunk);
        return;
      }
      if (conn.path !== "?") {
        upstream.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEADER_END);
      if (end < 0) {
        if (head.length > MAX_HEADER_BYTES) client.destroy();
        return;
      }
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const [method, path] = lines[0].split(" ");
      conn.path = path ?? "?";
      const kept = lines.filter((line) => !/^sec-websocket-extensions:/i.test(line));
      say(`open ${method}`);
      upstream.write(kept.join("\r\n") + HEADER_END);
      const rest = head.subarray(end + HEADER_END.length);
      if (conn.path.startsWith(CONTROL_PATH)) {
        readFrames = frameReader((text) => logControlMessage(text, say));
        readFrames(rest);
      }
      upstream.write(rest);
    });
    upstream.on("data", (chunk) => {
      conn.down += chunk.length;
      client.write(chunk);
    });
    conn.finish = () => {
      if (!open.delete(conn)) return;
      say(`close total_up=${conn.up} total_down=${conn.down}`);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", conn.finish);
    upstream.on("close", conn.finish);
    client.on("error", () => {});
    upstream.on("error", (error) => say(`upstream error ${error.message}`));
  });
  const stats = setInterval(() => {
    for (const conn of open) conn.report();
  }, STATS_INTERVAL_MS);
  stats.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK, () => {
      const address = server.address();
      log(`${new Date().toISOString()} relay listening ${LOOPBACK}:${address.port} -> ${socketPath}`);
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            clearInterval(stats);
            server.close(() => done());
            for (const conn of [...open]) conn.finish();
          }),
      });
    });
  });
}

function logControlMessage(text, say) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    say("request unparsed");
    return;
  }
  if (message.type === "request") say(`request id=${message.id} method=${message.method}`);
  else if (message.type === "hello") say(`hello api_revision=${message.api_revision} reconnect=${message.reconnect_token ? "yes" : "no"}`);
  else say(`message type=${message.type}`);
}

/** Reads the masked frames a WebSocket client sends and passes on each whole text message. */
function frameReader(onText) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let messageOpcode = OPCODE_TEXT;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & FIN_BIT) !== 0;
      const opcode = buffer[0] & OPCODE_MASK;
      const masked = (buffer[1] & MASK_BIT) !== 0;
      let length = buffer[1] & LENGTH_MASK;
      let offset = 2;
      if (length === LENGTH_16) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === LENGTH_64) {
        if (buffer.length < offset + 8) return;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      const maskBytes = masked ? MASK_KEY_BYTES : 0;
      if (buffer.length < offset + maskBytes + length) return;
      const mask = buffer.subarray(offset, offset + maskBytes);
      const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % MASK_KEY_BYTES];
      buffer = buffer.subarray(offset + maskBytes + length);
      if (opcode >= FIRST_CONTROL_OPCODE) continue;
      if (opcode !== OPCODE_CONTINUATION) messageOpcode = opcode;
      fragments.push(payload);
      if (!fin) continue;
      const whole = Buffer.concat(fragments);
      fragments = [];
      if (messageOpcode === OPCODE_TEXT) onText(whole.toString("utf8"));
    }
  };
}

function parsePort(argv) {
  const index = argv.indexOf("--port");
  const port = Number(argv[index + 1]);
  if (index < 0 || !Number.isInteger(port) || port <= 0) throw new Error("usage: node scripts/rex-relay.mjs --port <n>");
  return port;
}

// No top-level await, so tests/helpers/rex-live.cjs can require this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRelay({ port: parsePort(process.argv.slice(2)) }).then((relay) => {
    const shutdown = () => relay.close().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
