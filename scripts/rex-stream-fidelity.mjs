#!/usr/bin/env node
// Live fidelity check for app/apps/terminal/rex/stream.ts against the local
// Rex server. Seeds @xterm/headless from `format` `vt`, applies the stream
// through RexStream, and compares the emulator's screen with Rex's own text
// at each checkpoint. Also drops the data connection mid-output and resumes
// it with RexStream's byte count, then sends a short count to see the server
// refuse it and starts over.
//
//   npx tsc -p tests/tsconfig.json && node scripts/rex-stream-fidelity.mjs
//
// Exits 0 when every checkpoint matches.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import * as live from "./rex-stream-fixtures.mjs";

const require = createRequire(import.meta.url);
const rex = require("../.test-build/app/apps/terminal/rex/stream.js");
const { Terminal } = require("@xterm/headless");

const RELAY_PORT = 8793;
const DATA_SUBPROTOCOL = "rex.data.terminal.v1";
const GLASSES = { columns: 58, rows: 11 };
const RESIZED = { columns: 40, rows: 8 };
const SCROLLBACK_LINES = 10000;
// Holds each `format` reply back, as a phone on the tailnet would see it, so
// that output from a busy pane overlaps the seed.
const SEED_DELAY_MS = 150;
const QUIET_MS = 500;
const QUIET_TIMEOUT_MS = 15000;
const POLL_MS = 10;
const OFFLINE_MS = 500;
const RESUME_AFTER_BYTES = 2000;
const RESUME_COUNT_OFFSET = 17;
const CLIENT_CLOSE_NORMAL = 1000;
const OVERALL_TIMEOUT_MS = 120000;
const VT_SEED_ARGS = {
  format: "vt",
  extra_cursor: true,
  extra_modes: true,
  extra_scrolling_region: true,
  extra_charsets: true,
  extra_style: true,
  extra_tabstops: true,
  extra_palette: true,
  extra_keyboard: true,
};

const log = (line) => console.log(line);

class Viewer {
  constructor(lane) {
    this.lane = lane;
    this.term = null;
    this.stream = null;
    this.nonce = null;
    this.socket = null;
    this.applying = Promise.resolve();
    this.lastByteAt = Date.now();
    this.seeds = 0;
    this.seedsInFlight = 0;
    this.timer = null;
  }

  async hello() {
    const { ticket } = await this.lane.control.call("data.connect", {
      session_id: this.lane.sessionId,
      block_id: this.lane.blockId,
      data_ref_id: "terminal",
      subprotocol: DATA_SUBPROTOCOL,
    });
    const reply = await this.open(rex.helloFrame(ticket));
    if (reply.kind !== "welcome") throw new Error(`HELLO refused: ${JSON.stringify(reply)}`);
    this.stream = new rex.RexStream(reply.welcome);
    this.nonce = reply.welcome.nonce;
    log("HELLO accepted");
  }

  /** Opens a data connection, sends `first`, and resolves with the parsed handshake reply. */
  open(first) {
    const socket = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/api/data`, DATA_SUBPROTOCOL, { perMessageDeflate: false });
    socket.binaryType = "nodebuffer";
    this.socket = socket;
    let reply = null;
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.on("open", () => socket.send(first));
      socket.on("message", (data) => {
        if (socket !== this.socket) return;
        const bytes = new Uint8Array(data);
        if (!reply) {
          reply = rex.parseHandshakeReply(bytes);
          resolve(reply);
          return;
        }
        this.lastByteAt = Date.now();
        this.run(this.stream.receive(bytes, Date.now()));
      });
      socket.on("close", (code, reason) => {
        if (!reply) resolve({ kind: "closed", code, reason: reason.toString() });
      });
    });
  }

  run(actions) {
    for (const action of actions) {
      switch (action.type) {
        case "request-seed":
          this.requestSeed();
          break;
        case "seed":
          this.seeds++;
          this.applying = this.applying.then(() => {
            if (!this.term) this.term = new Terminal({ cols: action.cols, rows: action.rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
            this.term.reset();
            this.term.resize(action.cols, action.rows);
            return write(this.term, action.vt);
          });
          break;
        case "output":
          this.applying = this.applying.then(() => write(this.term, action.bytes));
          break;
        case "resize":
          this.applying = this.applying.then(() => this.term.resize(action.cols, action.rows));
          break;
        case "exited":
          log(`program exited with ${action.exitCode}`);
          break;
        case "check-at":
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.run(this.stream.tick(Date.now())), Math.max(0, action.at - Date.now()));
          break;
      }
    }
  }

  async requestSeed() {
    this.seedsInFlight++;
    const stream = this.stream;
    const reply = await this.lane.terminal("format", VT_SEED_ARGS);
    await live.sleep(SEED_DELAY_MS);
    this.seedsInFlight--;
    if (stream === this.stream) this.run(stream.seedArrived(reply.content));
  }

  /** Drops the connection without a close frame and resumes with RexStream's count. */
  async dropAndResume(count = this.stream.bytesReceived) {
    const old = this.socket;
    this.socket = null;
    old.terminate();
    await live.sleep(OFFLINE_MS);
    const frame = this.stream.resumeFrame();
    if (count !== this.stream.bytesReceived) new DataView(frame.buffer).setBigUint64(RESUME_COUNT_OFFSET, BigInt(count), true);
    return this.open(frame);
  }

  async settle() {
    const deadline = Date.now() + QUIET_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error("stream never settled");
      if (this.term && this.seedsInFlight === 0 && Date.now() - this.lastByteAt >= QUIET_MS) break;
      await live.sleep(POLL_MS);
    }
    await this.applying;
    await write(this.term, "");
  }

  screen() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let row = 0; row < this.term.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row).translateToString(true).replace(/\s+$/, ""));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
}

function write(term, data) {
  return new Promise((resolve) => term.write(data, resolve));
}

function lastLines(text, count) {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const tail = lines.slice(-count).map((line) => line.replace(/\s+$/, ""));
  while (tail.length && tail[tail.length - 1] === "") tail.pop();
  return tail;
}

async function checkpoint(viewer, label) {
  await viewer.settle();
  // A re-seed scheduled by the last output fires RESEED_QUIET_MS after it.
  await live.sleep(rex.RESEED_QUIET_MS);
  await viewer.settle();
  const rexText = await viewer.lane.terminal("format", { format: "text" });
  const got = viewer.screen();
  const want = lastLines(rexText.content, viewer.term.rows).slice(-got.length);
  const ok = got.length > 0 && JSON.stringify(got) === JSON.stringify(want);
  log(`${ok ? "MATCH" : "DIFF "} ${label} (grid ${viewer.term.cols}x${viewer.term.rows}, seeds ${viewer.seeds}, bytes ${viewer.stream.bytesReceived})`);
  if (!ok) log(`   rex: ${JSON.stringify(want)}\n   emu: ${JSON.stringify(got)}`);
  return ok;
}

async function main() {
  const relay = await live.startRelay(RELAY_PORT);
  const control = await live.openControl(RELAY_PORT, "faceclaw-rex-stream-fidelity");
  let lane = null;
  let failures = 0;
  const check = async (viewer, label) => {
    if (!(await checkpoint(viewer, label))) failures++;
  };
  const timeout = setTimeout(() => {
    log("TIMEOUT");
    process.exit(2);
  }, OVERALL_TIMEOUT_MS);
  try {
    lane = { control, ...(await live.createLaneTerminal(control, "lane-leaf-stream-fidelity")) };
    await lane.terminal("resize", GLASSES);
    await lane.terminal("write", { data: "for i in $(seq 1 120); do echo busy $i; sleep 0.01; done\n" });
    await live.sleep(POLL_MS);

    const viewer = new Viewer(lane);
    await viewer.hello();
    await check(viewer, "busy output overlapping the seed");
    log(`seeds so far ${viewer.seeds} (more than 1 means the overlap re-seeded)`);

    const steps = [
      ["plain output", "seq 1 40\n"],
      ["colors and a carriage-return overwrite", "printf '\\033[31mred\\033[0m and progress 10%%\\r progress 99%%\\n'\n"],
      ["long line wraps", "printf '%0.sx' $(seq 1 130); echo\n"],
      ["cursor addressing", "printf '\\033[2J\\033[H\\033[5;10HMID\\033[1;1HTOP\\n'\n"],
      ["alternate screen", "printf '\\033[?1049h\\033[HALTSCREEN line\\n'\n"],
      ["back from the alternate screen", "printf '\\033[?1049l'; echo back\n"],
      ["look-alike APC with a wrong nonce", null],
      ["resize mid-stream", "resize"],
    ];
    for (const [label, command] of steps) {
      if (command === "resize") {
        await lane.terminal("write", { data: "for i in $(seq 1 30); do echo r $i; sleep 0.01; done\n" });
        await live.sleep(100);
        await lane.terminal("resize", RESIZED);
      } else if (command === null) {
        const wrong = (BigInt(viewer.nonce) + 1n).toString();
        await lane.terminal("write", { data: `printf '\\033_rex1;${wrong};{"type":"resize","cols":7,"rows":3}\\033\\\\spoof ignored\\n'\n` });
      } else {
        await lane.terminal("write", { data: command });
      }
      await check(viewer, label);
    }

    await lane.terminal("write", { data: "for i in $(seq 1 300); do echo \"line $i\"; sleep 0.005; done\n" });
    const before = viewer.stream.bytesReceived;
    while (viewer.stream.bytesReceived < before + RESUME_AFTER_BYTES) await live.sleep(1);
    const count = viewer.stream.bytesReceived;
    const resumed = await viewer.dropAndResume();
    const accepted = resumed.kind === "welcome" && viewer.stream.resumed(resumed.welcome);
    log(`RESUME with ${count} bytes: ${accepted ? "accepted, same nonce" : `refused ${JSON.stringify(resumed)}`}`);
    if (!accepted) failures++;
    await check(viewer, "after RESUME mid-output");

    const short = viewer.stream.bytesReceived - 1;
    const refused = await viewer.dropAndResume(short);
    const step = refused.kind === "reject" ? rex.nextStepAfter({ kind: "rejected", reason: refused.reason }) : "unexpected";
    log(`RESUME one byte short (${short}): ${JSON.stringify(refused)}, next step ${step}`);
    if (step !== "restart") failures++;
    await viewer.hello();
    await check(viewer, "after starting over with a new ticket");

    viewer.socket.close(CLIENT_CLOSE_NORMAL);
    log(`checkpoints failed ${failures}`);
  } finally {
    clearTimeout(timeout);
    if (lane) await lane.destroy().catch((error) => log(`destroy failed: ${error.message}`));
    log(`lane sessions left: ${(await live.laneSessionsLeft(control)).length}`);
    control.ws.close(CLIENT_CLOSE_NORMAL);
    relay.close();
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (failures) => process.exit(failures === 0 ? 0 : 1),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
