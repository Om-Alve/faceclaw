/**
 * The pure half of one Rex data connection to a terminal block: the binary
 * handshake, the stream split into terminal output and Rex messages, the
 * seed lifecycle, and what to do when the connection ends. The caller owns
 * the socket, the timers, the clock and the emulator, and carries out the
 * actions this module returns, in order. See "Data Connections" and "The
 * Terminal Stream" in the Rex client API, revision 18.
 */

const HELLO = 0x01;
const RESUME = 0x02;
const WELCOME = 0x81;
const REJECT = 0x82;
const TOKEN_BYTES = 16;
const TOKEN_OFFSET = 1;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_BITS_PER_CHAR = 6;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
const RESUME_BYTES = 25;
const RESUME_COUNT_OFFSET = 17;
const WELCOME_BYTES = 32;
const WELCOME_NONCE_OFFSET = 24;
const REJECT_BYTES = 2;
const REJECT_REASON_OFFSET = 1;
const UINT32_RANGE = 2 ** 32;
const UINT32_BYTES = 4;

const ESC = 0x1b;
const BACKSLASH = 0x5c;
const APC_TERMINATOR_BYTES = 2;

/**
 * A Rex message longer than this without its terminator is not one. Rex's
 * messages are small JSON objects, and the API caps every data message at
 * 65,536 bytes ("Data Connections", step 6), so a Rex message cannot need
 * more. Past it, the held bytes go out as terminal output.
 */
export const MAX_REX_MESSAGE_BYTES = 65_536;

/** Stream silence that triggers a re-seed after a seed that overlapped output. */
export const RESEED_QUIET_MS = 300;

/** "When a Data Connection Closes" in the Rex client API. */
const CLOSE_RECONNECT_REQUIRED = 1013;
const CLOSE_BLOCK_CLOSED = 4000;

export type RejectReason =
  | "invalid-ticket"
  | "already-connected"
  | "stream-unavailable"
  | "limit"
  | "malformed"
  | "server-failed"
  | "wrong-subprotocol"
  | "unknown";

const REJECT_REASONS: ReadonlyMap<number, RejectReason> = new Map([
  [0x01, "invalid-ticket"],
  [0x02, "already-connected"],
  [0x03, "stream-unavailable"],
  [0x04, "limit"],
  [0x05, "malformed"],
  [0x06, "server-failed"],
  [0x07, "wrong-subprotocol"],
]);

export type Welcome = {
  /** Reconnect token for the next RESUME. */
  readonly token: Uint8Array;
  /** Channel nonce in decimal, as Rex writes it in its messages. */
  readonly nonce: string;
};

export type HandshakeReply =
  | { kind: "welcome"; welcome: Welcome }
  | { kind: "reject"; reason: RejectReason }
  | { kind: "invalid" };

/** HELLO: 0x01, then the 16 bytes of the ticket from `data.connect`. */
export function helloFrame(ticket: string): Uint8Array {
  if (!TICKET_PATTERN.test(ticket)) throw new Error("Rex data ticket is not 22 base64url characters");
  const frame = new Uint8Array(TOKEN_OFFSET + TOKEN_BYTES);
  frame[0] = HELLO;
  let bits = 0;
  let bitCount = 0;
  let at = TOKEN_OFFSET;
  for (const char of ticket) {
    bits = (bits << BASE64_BITS_PER_CHAR) | BASE64URL_ALPHABET.indexOf(char);
    bitCount += BASE64_BITS_PER_CHAR;
    if (bitCount >= BITS_PER_BYTE) {
      bitCount -= BITS_PER_BYTE;
      frame[at++] = (bits >> bitCount) & BYTE_MASK;
    }
  }
  return frame;
}

/** The server's first message on a data connection, a WELCOME or a REJECT. */
export function parseHandshakeReply(frame: Uint8Array): HandshakeReply {
  if (frame.length === WELCOME_BYTES && frame[0] === WELCOME) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const nonce = view.getBigUint64(WELCOME_NONCE_OFFSET, true);
    if (nonce === 0n) return { kind: "invalid" };
    return { kind: "welcome", welcome: { token: frame.slice(TOKEN_OFFSET, TOKEN_OFFSET + TOKEN_BYTES), nonce: nonce.toString() } };
  }
  if (frame.length === REJECT_BYTES && frame[0] === REJECT) {
    return { kind: "reject", reason: REJECT_REASONS.get(frame[REJECT_REASON_OFFSET]) ?? "unknown" };
  }
  return { kind: "invalid" };
}

/** How a data connection ended: the server's REJECT, or the socket's close status (null when it dropped without one). */
export type DataEnd = { kind: "rejected"; reason: RejectReason } | { kind: "closed"; code: number | null };

/**
 * `resume`: send `RexStream.resumeFrame()` on a new connection.
 * `restart`: get a new ticket from `data.connect`, send a HELLO, and start a new `RexStream`.
 * `pane-closed`: the block is gone; do not reconnect.
 * A connection that ends before its first WELCOME has no stream to resume, so restart then.
 */
export type NextStep = "resume" | "restart" | "pane-closed";

export function nextStepAfter(end: DataEnd): NextStep {
  if (end.kind === "rejected") return "restart";
  if (end.code === CLOSE_BLOCK_CLOSED) return "pane-closed";
  if (end.code === CLOSE_RECONNECT_REQUIRED) return "restart";
  return "resume";
}

type Grid = { cols: number; rows: number };

type StreamEvent =
  | { type: "output"; bytes: Uint8Array }
  | ({ type: "resize" } & Grid)
  | { type: "exited"; exitCode: number | null };

/**
 * What the caller does next, in order:
 * - `request-seed`: call `format` with `format` `vt`, and pass the content to `seedArrived`.
 * - `seed`: reset the emulator to `cols` x `rows` and write `vt`.
 * - `output`: write the bytes to the emulator.
 * - `resize`: resize the emulator.
 * - `exited`: the program exited; no more output follows.
 * - `check-at`: call `tick` at time `at`, on the caller's clock.
 */
export type StreamAction =
  | StreamEvent
  | { type: "request-seed" }
  | ({ type: "seed"; vt: string } & Grid)
  | { type: "check-at"; at: number };

/**
 * - awaiting-marker: the Ghostty snapshot is still arriving; its bytes are dropped.
 * - seeding: a `format` request is out; stream events wait in `held`.
 * - live: the emulator matches the stream.
 * - stale: the seed overlapped stream events, so re-seed once the stream has
 *   been quiet for RESEED_QUIET_MS after `lastActivityAt`.
 */
type SeedState =
  | { phase: "awaiting-marker" }
  | { phase: "seeding"; grid: Grid; held: StreamEvent[]; lastActivityAt: number }
  | { phase: "live" }
  | { phase: "stale"; grid: Grid; lastActivityAt: number };

/** One terminal stream, across every data connection that carries it. */
export class RexStream {
  private token: Uint8Array;
  private readonly nonce: string;
  private readonly demux: Demux;
  private state: SeedState = { phase: "awaiting-marker" };
  private received = 0;

  constructor(welcome: Welcome) {
    this.token = welcome.token;
    this.nonce = welcome.nonce;
    this.demux = new Demux(welcome.nonce);
  }

  /**
   * Every stream byte passed to `receive`, across connections: the snapshot,
   * Rex's messages, look-alikes, and a partial message still held. The held
   * part stays here across a resume, so the server continues after it.
   */
  get bytesReceived(): number {
    return this.received;
  }

  /** RESUME for a new connection. Stop passing the old connection's messages to `receive` first. */
  resumeFrame(): Uint8Array {
    const frame = new Uint8Array(RESUME_BYTES);
    frame[0] = RESUME;
    frame.set(this.token, TOKEN_OFFSET);
    const view = new DataView(frame.buffer);
    view.setUint32(RESUME_COUNT_OFFSET, this.received % UINT32_RANGE, true);
    view.setUint32(RESUME_COUNT_OFFSET + UINT32_BYTES, Math.floor(this.received / UINT32_RANGE), true);
    return frame;
  }

  /** The WELCOME answering a RESUME. False if it belongs to another stream; restart then. */
  resumed(welcome: Welcome): boolean {
    if (welcome.nonce !== this.nonce) return false;
    this.token = welcome.token;
    return true;
  }

  /** One binary message after the WELCOME. Output actions view `chunk`, so do not reuse it. */
  receive(chunk: Uint8Array, now: number): StreamAction[] {
    this.received += chunk.length;
    const events = this.demux.push(chunk);
    const state = this.state;
    switch (state.phase) {
      case "awaiting-marker":
        for (const [index, event] of events.entries()) {
          if (event.type !== "resize") continue;
          const grid = { cols: event.cols, rows: event.rows };
          this.state = { phase: "seeding", grid, held: events.slice(index + 1), lastActivityAt: now };
          return [{ type: "request-seed" }];
        }
        return [];
      case "seeding":
        state.held.push(...events);
        state.lastActivityAt = now;
        return [];
      case "live":
        return events;
      case "stale":
        state.lastActivityAt = now;
        return this.release(state, events);
    }
  }

  /** The `content` of the `format` `vt` reply that `request-seed` asked for. */
  seedArrived(vt: string): StreamAction[] {
    const state = this.state;
    if (state.phase !== "seeding") return [];
    const actions: StreamAction[] = [{ type: "seed", vt, ...state.grid }];
    if (state.held.length === 0) {
      this.state = { phase: "live" };
      return actions;
    }
    const stale: SeedState = { phase: "stale", grid: state.grid, lastActivityAt: state.lastActivityAt };
    this.state = stale;
    actions.push(...this.release(stale, state.held));
    actions.push({ type: "check-at", at: state.lastActivityAt + RESEED_QUIET_MS });
    return actions;
  }

  /** A `check-at` time arrived. */
  tick(now: number): StreamAction[] {
    const state = this.state;
    if (state.phase !== "stale") return [];
    const due = state.lastActivityAt + RESEED_QUIET_MS;
    if (now < due) return [{ type: "check-at", at: due }];
    this.state = { phase: "seeding", grid: state.grid, held: [], lastActivityAt: now };
    return [{ type: "request-seed" }];
  }

  /** Passes events on while stale, tracking the grid the next re-seed uses. */
  private release(state: { grid: Grid }, events: StreamEvent[]): StreamAction[] {
    for (const event of events) {
      if (event.type === "resize") state.grid = { cols: event.cols, rows: event.rows };
    }
    return events;
  }
}

/**
 * Splits the stream into terminal output and Rex messages, which are APCs
 * `ESC _ rex1;<nonce>;<json> ESC \` carrying this stream's nonce. Any other
 * APC is program output and passes through unchanged. Bytes that may start
 * a Rex message wait for the next chunk.
 */
class Demux {
  private readonly prefix: Uint8Array;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(nonce: string) {
    this.prefix = asciiBytes(`\x1b_rex1;${nonce};`);
  }

  push(chunk: Uint8Array): StreamEvent[] {
    const buffer = this.pending.length === 0 ? chunk : concat(this.pending, chunk);
    this.pending = new Uint8Array(0);
    const events: StreamEvent[] = [];
    const emitOutput = (from: number, to: number) => {
      if (to > from) events.push({ type: "output", bytes: buffer.subarray(from, to) });
    };
    let outputFrom = 0;
    let scan = 0;
    for (;;) {
      const start = buffer.indexOf(ESC, scan);
      if (start < 0) break;
      const matched = matchLength(buffer, start, this.prefix);
      if (matched < this.prefix.length) {
        if (start + matched === buffer.length) {
          emitOutput(outputFrom, start);
          this.pending = buffer.slice(start);
          return events;
        }
        scan = start + 1;
        continue;
      }
      const end = findTerminator(buffer, start + this.prefix.length);
      if (end < 0) {
        if (buffer.length - start > MAX_REX_MESSAGE_BYTES) {
          scan = start + 1;
          continue;
        }
        emitOutput(outputFrom, start);
        this.pending = buffer.slice(start);
        return events;
      }
      emitOutput(outputFrom, start);
      const message = parseMessage(buffer.subarray(start + this.prefix.length, end));
      if (message) events.push(message);
      outputFrom = scan = end + APC_TERMINATOR_BYTES;
    }
    emitOutput(outputFrom, buffer.length);
    return events;
  }
}

function matchLength(buffer: Uint8Array, at: number, pattern: Uint8Array): number {
  let length = 0;
  while (length < pattern.length && at + length < buffer.length && buffer[at + length] === pattern[length]) length++;
  return length;
}

/** JSON cannot hold a raw ESC, so the first ESC \ ends a Rex message. */
function findTerminator(buffer: Uint8Array, from: number): number {
  for (let at = buffer.indexOf(ESC, from); at >= 0; at = buffer.indexOf(ESC, at + 1)) {
    if (buffer[at + 1] === BACKSLASH) return at;
  }
  return -1;
}

function parseMessage(json: Uint8Array): StreamEvent | null {
  // Latin-1 is enough, since only ASCII keys and numbers are read.
  let text = "";
  for (const byte of json) text += String.fromCharCode(byte);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const fields = message as Record<string, unknown>;
  if (fields.type === "resize") {
    const { cols, rows } = fields;
    if (!isPositiveInteger(cols) || !isPositiveInteger(rows)) return null;
    return { type: "resize", cols, rows };
  }
  if (fields.type === "child_exited") {
    return { type: "exited", exitCode: typeof fields.exit_code === "number" ? fields.exit_code : null };
  }
  return null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head);
  joined.set(tail, head.length);
  return joined;
}
