/**
 * Rex backend for the Terminal app: lists, views and types into the panes of
 * a Rex server through the same TerminalClient model as g2mirror sessions.
 * Each terminal block is one "session"; its block ID plays the part of
 * g2mirror's session socket.
 *
 * One RexControl connection carries everything. Viewing a block claims it
 * (session.own_block in take mode) and resizes it to the glasses grid, so
 * full-screen programs fit; leaving gives it back, and Rex returns it to its
 * previous owner at that owner's size. While another client owns the block,
 * the screen shows at its size with a notice, and viewing again takes it back.
 *
 * With a data socket, the viewed block's screen comes from its data
 * connection (rex/stream.ts): a seed from com.superlogical.terminal.format as
 * VT, screen and scrollback, delivered as a snapshot, then the stream's bytes
 * as output. The worker's emulator stays at the glasses grid, so while the
 * stream is at another client's size its output only triggers snapshots, and
 * when it comes back to the glasses grid the stream starts over for a fresh
 * seed. Without a data socket (iOS), or while the stream waits to start over,
 * snapshots are read after input, on block events and on a timer, all through
 * refreshIn(). A dropped control connection reconnects inside RexControl, and
 * the view re-attaches and re-claims itself; the data connection outlives it.
 */
import type { G2MirrorHistoryReply, G2MirrorPhase, G2MirrorSession, G2MirrorState, TerminalClient } from "./terminal-client";
import type { RexEndpoint } from "./rex/connection-string";
import {
  RexCallError,
  RexControl,
  type RexBlockNotice,
  type RexControlState,
  type RexInput,
  type RexKeyPress,
  type RexSocketFactory,
  type RexTimers,
} from "./rex/control";
import {
  REX_DATA_SUBPROTOCOL,
  RexMethod,
  parseBlobPart,
  parseCreated,
  parseDataTicket,
  parseFormatPart,
  type RexBlockInfo,
  type RexClientInfo,
  type RexSessionView,
  type RexTextPart,
  type RexWindowView,
} from "./rex/protocol";
import { RexStream, helloFrame, nextStepAfter, parseHandshakeReply, type DataEnd, type StreamAction } from "./rex/stream";
import { encodeUtf8 } from "./tmux-client";

export const REX_SNAPSHOT_AFTER_INPUT_MS = 50;
export const REX_SNAPSHOT_INTERVAL_MS = 500;
/** Snapshot delay after stream output while the stream is at another client's size. */
export const REX_SNAPSHOT_AFTER_OUTPUT_MS = 100;
/** A data connection is retried after this, doubled for each failure since one stayed up REX_DATA_STABLE_MS. */
export const REX_DATA_RETRY_MIN_MS = 250;
export const REX_DATA_RETRY_MAX_MS = 30_000;
export const REX_DATA_STABLE_MS = 10_000;
/** Wait before asking again for a seed whose read failed, or that was due while the data connection was down. */
export const REX_SEED_RETRY_MS = 1_000;
/** The most one format or blob_read reply may carry (rex-api-r18.md, com.superlogical.terminal.format). */
export const REX_FORMAT_PART_BYTES = 983_040;
export const REX_OTHER_OWNER_NOTICE = "Mac has this pane";

const REX_CLIENT_INFO: RexClientInfo = { kind: "app", name: "Faceclaw", version: "1" };
const TERMINAL_CREATOR = "com.superlogical.terminal";
const SHELL_FLAVOR = "com.superlogical.terminal.shell";
const SHELL_PRESET = "shell";
const TAKE = "take";
const TERMINAL_DATA_REF = "terminal";
/** Closing a data connection with 1000 ends its stream on the server. */
const DATA_CLOSE_NORMAL = 1000;
const DATA_CLOSE_REASON = "faceclaw leaving the pane";
// The same characters TmuxClient lets through to a launch command.
const SAFE_LAUNCH_COMMAND = /^[A-Za-z0-9 ._/+:=@%,-]+$/;
/** Rex's default window and block labels end with this many hex digits of the ID. */
const DEFAULT_LABEL_ID_DIGITS = 8;
const ENTER_KEY: RexKeyPress = {
  key: "enter",
  mods: "",
  consumed_mods: "",
  text: "\r",
  unshifted_codepoint: 0,
  composing: false,
  action: "press",
};
const SNAPSHOT_ARGS = {
  format: "vt",
  extra_charsets: true,
  extra_cursor: true,
  extra_hyperlink: true,
  extra_keyboard: true,
  extra_kitty_keyboard: true,
  extra_modes: true,
  extra_palette: true,
  extra_protection: true,
  extra_pwd: true,
  extra_scrolling_region: true,
  extra_style: true,
  extra_tabstops: true,
  max_bytes: REX_FORMAT_PART_BYTES,
};

/** Opens one Rex data connection speaking REX_DATA_SUBPROTOCOL, as openRexDataSocket in app/native/rex-data-socket.ts does. */
export type RexDataSocketFactory = (
  url: string,
  listener: {
    onOpen(): void;
    onBinaryMessage(bytes: Uint8Array): void;
    onClosed(code: number, reason: string): void;
    onFailure(message: string): void;
  },
) => { sendBinary(bytes: Uint8Array): boolean; close(code: number, reason: string): void };

export type RexClientOptions = {
  endpoint: RexEndpoint;
  createSocket: RexSocketFactory;
  /** Without one, the viewed block is shown from snapshots alone. */
  openDataSocket?: RexDataSocketFactory;
  timers: RexTimers;
  /** Unix epoch ms, for bell and activity times. */
  now(): number;
  /** Grid the glasses view blocks at. */
  cols: number;
  rows: number;
  log?: (line: string) => void;
};

type Target = { sessionId: string; blockId: string };

type Grid = { cols: number; rows: number };

/** One data connection. Callbacks from a link that is no longer the feed's are ignored. */
type Link = { socket: ReturnType<RexDataSocketFactory> | null };

/**
 * One terminal stream, across the connections that resume it. `grid` is its
 * size from the last seed or resize, null before the first seed. `timer` is
 * its pending check-at or seed retry; the stream never needs both at once.
 */
type FeedStream = { rex: RexStream; grid: Grid | null; timer: unknown };

/**
 * The viewed block's data connection. `attempt` counts connections that
 * failed since one stayed up for REX_DATA_STABLE_MS.
 * - ticket: data.connect is in flight.
 * - hello, resuming: the HELLO or RESUME is sent; the WELCOME is due.
 * - waiting: retrying after a delay, resuming `stream`, or starting over when it is null.
 */
type Feed =
  | { kind: "none" }
  | { kind: "ticket"; target: Target; attempt: number }
  | { kind: "hello"; target: Target; attempt: number; link: Link }
  | { kind: "resuming"; target: Target; attempt: number; link: Link; stream: FeedStream }
  | { kind: "live"; target: Target; attempt: number; link: Link; stream: FeedStream; since: number }
  | { kind: "waiting"; target: Target; attempt: number; timer: unknown; stream: FeedStream | null };

/**
 * How snapshots are read for the viewed block: on change and on a timer
 * (`poll`), on change only (`follow`), or not at all while the stream
 * drives the screen or is about to (`off`).
 */
type SnapshotMode = "poll" | "follow" | "off";

/** What this client does with one block. */
type Pane =
  | { kind: "none" }
  /** Waiting for the connection or for session.attach; `after` is the state to reach. */
  | { kind: "attaching"; target: Target; after: "attached" | "owner" | "foreign" }
  | { kind: "attached"; target: Target }
  | { kind: "claiming"; target: Target }
  | { kind: "owner"; target: Target }
  | { kind: "foreign"; target: Target };

type Viewing = Extract<Pane, { kind: "owner" | "foreign" }>;

/**
 * Terminal session rows for every terminal block, in the server's order. A
 * row's label is the session label, then the window label after ":", then the
 * block label after ".". Window and block labels Rex made up are left out,
 * but a window or block that has siblings keeps its position instead, so rows
 * stay distinct.
 */
export function rexSessionRows(sessions: readonly RexSessionView[]): G2MirrorSession[] {
  const rows: G2MirrorSession[] = [];
  for (const session of sessions) {
    session.windows.forEach((window, windowIndex) => {
      window.blocks.forEach((block, blockIndex) => {
        if (block.creatorName !== TERMINAL_CREATOR) return;
        rows.push({
          socket: block.blockId,
          pid: 0,
          cwdHint: "",
          lastBellAt: null,
          lastOutputAt: null,
          title: rowLabel(session, window, windowIndex, block, blockIndex),
        });
      });
    });
  }
  return rows;
}

function rowLabel(session: RexSessionView, window: RexWindowView, windowIndex: number, block: RexBlockInfo, blockIndex: number): string {
  let label = session.label;
  const windowLabel = window.label === defaultLabel("Window", window.windowId) ? "" : window.label;
  if (windowLabel || session.windows.length > 1) label += `:${windowLabel || windowIndex + 1}`;
  const blockLabel = isDefaultBlockLabel(block) ? "" : block.label;
  if (blockLabel || window.blocks.length > 1) label += `.${blockLabel || blockIndex + 1}`;
  return label;
}

function defaultLabel(kind: "Window" | "Block", id: string): string {
  return `${kind} ${id.slice(-DEFAULT_LABEL_ID_DIGITS)}`;
}

/** A new block is labelled with its flavor's short name; a cleared label falls back to one made from its ID. */
function isDefaultBlockLabel(block: RexBlockInfo): boolean {
  const flavorName = block.flavor.slice(block.flavor.lastIndexOf(".") + 1);
  return block.label === "" || block.label === flavorName || block.label === defaultLabel("Block", block.blockId);
}

/** The program a launch preset runs, or null for the user's shell. Throws when it can't be passed on safely. */
function launchCommand(preset: string): string[] | null {
  const command = preset.trim();
  if (command === SHELL_PRESET || command === "") return null;
  if (!SAFE_LAUNCH_COMMAND.test(command)) throw new Error(`Launch preset "${preset}" has characters that can't be passed to Rex.`);
  return command.split(/\s+/);
}

function findTarget(sessions: readonly RexSessionView[], blockId: string): Target | null {
  for (const session of sessions) {
    for (const window of session.windows) {
      if (window.blocks.some((block) => block.blockId === blockId)) return { sessionId: session.sessionId, blockId };
    }
  }
  return null;
}

function attachedTarget(pane: Pane): Target | null {
  return pane.kind === "none" || pane.kind === "attaching" ? null : pane.target;
}

function viewing(pane: Pane): Viewing | null {
  return pane.kind === "owner" || pane.kind === "foreign" ? pane : null;
}

/** The block the pane is viewing or will view again once its control connection is back, which keeps its stream. */
function feedTarget(pane: Pane): Target | null {
  switch (pane.kind) {
    case "owner":
    case "foreign":
    case "claiming":
      return pane.target;
    case "attaching":
      return pane.after === "attached" ? null : pane.target;
    default:
      return null;
  }
}

function sameGrid(a: Grid, b: Grid): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

function isConnectionLoss(error: unknown): boolean {
  return error instanceof RexCallError && (error.failure.kind === "disconnected" || error.failure.kind === "not-ready");
}

export class RexClient implements TerminalClient {
  private readonly control: RexControl;
  private readonly log: (line: string) => void;
  private grid: Grid;
  private pane: Pane = { kind: "none" };
  /** Bumped whenever a snapshot in flight may no longer match what is viewed. */
  private viewSerial = 0;
  private snapshotInFlight = false;
  private snapshotAgain = false;
  private lastSnapshot: string | null = null;
  private refreshTimer: { handle: unknown; at: number } | null = null;
  private feed: Feed = { kind: "none" };
  private notice = "";

  private readonly stateListeners = new Set<(state: G2MirrorState) => void>();
  private readonly terminalDataListeners = new Set<(data: Uint8Array, kind: "snapshot" | "output") => void>();
  private readonly snapshotListeners = new Set<(historyNext: number, historyOldest: number) => void>();
  private readonly historyListeners = new Set<(reply: G2MirrorHistoryReply) => void>();
  private readonly attachedListeners = new Set<(command: string) => void>();
  private readonly detachedListeners = new Set<(reason: string) => void>();
  private readonly bellListeners = new Set<(socket: string, lastBellAtMs: number) => void>();
  private readonly activityListeners = new Set<(socket: string, lastOutputAtMs: number) => void>();
  private readonly titleListeners = new Set<(socket: string, title: string) => void>();

  constructor(private readonly options: RexClientOptions) {
    this.log = options.log ?? (() => {});
    this.grid = { cols: options.cols, rows: options.rows };
    this.control = new RexControl({
      url: options.endpoint.controlUrl,
      client: REX_CLIENT_INFO,
      createSocket: options.createSocket,
      timers: options.timers,
      log: this.log,
    });
    this.control.onStateChange((state) => this.handleControlState(state));
    this.control.onModelChange(() => this.handleModel());
    this.control.onBlockEvent((notice) => this.handleBlockEvent(notice));
  }

  state(): G2MirrorState & { retryable: boolean } {
    const control = this.control.state();
    const { phase, status } = this.describe(control);
    return {
      phase,
      status,
      sessions: rexSessionRows(this.control.sessions()),
      attachedCommand: this.labelOf(attachedTarget(this.pane)),
      serverName: control.phase === "ready" ? this.options.endpoint.displayHost : "",
      retryable: control.phase !== "failed",
    };
  }

  onStateChange(listener: (state: G2MirrorState) => void): () => void {
    return subscribe(this.stateListeners, listener);
  }
  onTerminalData(listener: (data: Uint8Array, kind: "snapshot" | "output") => void): () => void {
    return subscribe(this.terminalDataListeners, listener);
  }
  onSnapshot(listener: (historyNext: number, historyOldest: number) => void): () => void {
    return subscribe(this.snapshotListeners, listener);
  }
  onHistoryLines(listener: (reply: G2MirrorHistoryReply) => void): () => void {
    return subscribe(this.historyListeners, listener);
  }
  onSessionAttached(listener: (command: string) => void): () => void {
    return subscribe(this.attachedListeners, listener);
  }
  onSessionDetached(listener: (reason: string) => void): () => void {
    return subscribe(this.detachedListeners, listener);
  }
  onBell(listener: (socket: string, lastBellAtMs: number) => void): () => void {
    return subscribe(this.bellListeners, listener);
  }
  onActivity(listener: (socket: string, lastOutputAtMs: number) => void): () => void {
    return subscribe(this.activityListeners, listener);
  }
  onTitle(listener: (socket: string, title: string) => void): () => void {
    return subscribe(this.titleListeners, listener);
  }

  setViewport(cols: number, rows: number): void {
    if (cols === this.grid.cols && rows === this.grid.rows) return;
    this.grid = { cols, rows };
    if (this.pane.kind === "owner") this.claim(this.pane.target);
  }

  start(): void {
    const phase = this.control.state().phase;
    if (phase !== "idle" && phase !== "failed") return;
    this.setPane({ kind: "none" });
    this.notice = "";
    this.control.start();
  }

  /** Closing the connection with a close frame ends this Rex client at once, which hands an owned block back. */
  stop(): void {
    this.setPane({ kind: "none" });
    this.control.stop();
    this.emitState();
  }

  listSessions(): void {
    // The control connection pushes every change.
  }

  async launchSession(preset: string): Promise<string> {
    const command = launchCommand(preset);
    const block = command ? { flavor: SHELL_FLAVOR, options: { command } } : { flavor: SHELL_FLAVOR };
    const created = parseCreated(await this.control.call(RexMethod.create, { initial_windows: [{ layout: { block } }] }));
    const blockId = created.windows[0]?.blockIds[0];
    if (!blockId) throw new Error(`Launch of "${preset}" created no pane.`);
    return blockId;
  }

  connectSession(blockId: string): void {
    if (this.control.state().phase !== "ready") return;
    if (this.pane.kind !== "none") this.disconnectSession();
    const target = findTarget(this.control.sessions(), blockId);
    if (!target) {
      this.sessionGone("That pane no longer exists.", "session not found");
      return;
    }
    this.notice = "";
    this.attach({ kind: "attaching", target, after: "attached" });
    this.emitState();
  }

  disconnectSession(): void {
    if (this.pane.kind === "none") return;
    this.unview();
    this.setPane({ kind: "none" });
    this.emitState();
  }

  view(): void {
    const pane = this.pane;
    if (pane.kind === "attaching") this.pane = { ...pane, after: "owner" };
    else if (pane.kind === "attached" || pane.kind === "foreign") this.claim(pane.target);
  }

  unview(): void {
    const pane = this.pane;
    if (pane.kind === "attaching") {
      this.pane = { ...pane, after: "attached" };
      return;
    }
    if (pane.kind !== "claiming" && pane.kind !== "owner" && pane.kind !== "foreign") return;
    const { sessionId, blockId } = pane.target;
    this.control.call(RexMethod.disownBlock, { session_id: sessionId, block_ids: [blockId] }).catch((error) => {
      if (!isConnectionLoss(error)) this.log(`rex: disown failed: ${String(error)}`);
    });
    this.setPane({ kind: "attached", target: pane.target });
    this.emitState();
  }

  /** The snapshot carries all scrollback Rex keeps, so there is never an older page to fetch. */
  requestHistory(before: number): void {
    if (!attachedTarget(this.pane)) return;
    for (const listener of [...this.historyListeners]) listener({ start: before, oldest: 0, next: 0, lines: [] });
  }

  sendInput(text: string): void {
    const target = attachedTarget(this.pane);
    if (!target || !text) return;
    this.queueInput({ kind: "write", ...target, data: text });
  }

  submitInput(text: string): void {
    const target = attachedTarget(this.pane);
    if (!target) return;
    if (text) this.queueInput({ kind: "paste", ...target, text });
    this.queueInput({ kind: "key", ...target, key: ENTER_KEY });
  }

  // ---- connection ----

  private handleControlState(state: RexControlState): void {
    const pane = this.pane;
    if (state.phase === "ready") {
      if (pane.kind === "attaching") this.attach(pane);
    } else if (pane.kind !== "none" && pane.kind !== "attaching") {
      const after = pane.kind === "attached" ? "attached" : pane.kind === "foreign" ? "foreign" : "owner";
      this.setPane({ kind: "attaching", target: pane.target, after });
    }
    this.emitState();
  }

  private attach(pane: Extract<Pane, { kind: "attaching" }>): void {
    this.setPane(pane);
    if (this.control.state().phase !== "ready") return;
    const { target } = pane;
    this.control.call(RexMethod.attach, { session_id: target.sessionId }).then(
      () => {
        const current = this.pane;
        if (current.kind !== "attaching" || current.target !== target) return;
        if (current.after === "owner") {
          this.claim(target);
        } else if (current.after === "foreign") {
          this.watch(target);
        } else {
          this.setPane({ kind: "attached", target });
          this.emitState();
          const label = this.labelOf(target);
          for (const listener of [...this.attachedListeners]) listener(label);
        }
      },
      (error) => {
        const current = this.pane;
        if (current.kind !== "attaching" || current.target !== target || isConnectionLoss(error)) return;
        this.sessionGone("That pane no longer exists.", "session not found");
      },
    );
  }

  private handleModel(): void {
    const target = this.pane.kind === "none" ? null : this.pane.target;
    if (target && !findTarget(this.control.sessions(), target.blockId)) {
      this.sessionGone("Pane closed.", "session closed");
      return;
    }
    this.emitState();
  }

  private sessionGone(status: string, reason: string): void {
    this.setPane({ kind: "none" });
    this.notice = status;
    this.emitState();
    for (const listener of [...this.detachedListeners]) listener(reason);
  }

  private handleBlockEvent({ blockId, event }: RexBlockNotice): void {
    switch (event.name) {
      case "bell":
        for (const listener of [...this.bellListeners]) listener(blockId, this.options.now());
        break;
      case "title_changed":
        for (const listener of [...this.titleListeners]) listener(blockId, event.title);
        break;
      case "progress_report":
      case "program_status_changed":
      case "process_changed":
        for (const listener of [...this.activityListeners]) listener(blockId, this.options.now());
        break;
      case "block_owner_changed":
        this.ownerChanged(blockId, event.owner);
        break;
      default:
        break;
    }
    if (viewing(this.pane)?.target.blockId === blockId) this.refreshIn(0);
  }

  private ownerChanged(blockId: string, owner: string | undefined): void {
    const pane = this.pane;
    const self = this.clientId();
    if (pane.kind === "owner" && pane.target.blockId === blockId && owner !== self) {
      this.watch(pane.target);
    } else if (pane.kind === "foreign" && pane.target.blockId === blockId && owner === self) {
      // The block came back to this client, which Rex then sizes as it last asked.
      this.setPane({ kind: "owner", target: pane.target });
      this.emitState();
    }
  }

  /** This connection's Rex client ID, which is what block owners name. */
  private clientId(): string | null {
    const state = this.control.state();
    return state.phase === "ready" ? state.clientId : null;
  }

  // ---- ownership ----

  private claim(target: Target): void {
    const pane: Pane = { kind: "claiming", target };
    this.setPane(pane);
    this.emitState();
    const block = { session_id: target.sessionId, block_id: target.blockId };
    void (async () => {
      try {
        await this.control.call(RexMethod.ownBlock, { session_id: target.sessionId, block_ids: [target.blockId], mode: TAKE });
        await this.control.call(RexMethod.terminalResize, { ...block, args: { columns: this.grid.cols, rows: this.grid.rows } });
        if (this.pane !== pane) return;
        this.setPane({ kind: "owner", target });
        this.emitState();
        this.refreshIn(0);
      } catch (error) {
        if (this.pane !== pane || isConnectionLoss(error)) return;
        this.log(`rex: could not take the pane: ${String(error)}`);
        this.setPane({ kind: "attached", target });
        this.emitState();
      }
    })();
  }

  /** View the block while another client owns it, at that client's size. */
  private watch(target: Target): void {
    this.setPane({ kind: "foreign", target });
    this.emitState();
    this.refreshIn(0);
  }

  // ---- snapshots ----

  /**
   * Schedule a snapshot `delayMs` from now, unless one is due sooner. This is
   * the only place a refresh is triggered from: after input, on block events,
   * on stream output at another size, and every REX_SNAPSHOT_INTERVAL_MS
   * while polling.
   */
  private refreshIn(delayMs: number): void {
    if (!viewing(this.pane) || this.snapshotMode() === "off") return;
    const at = this.options.now() + delayMs;
    if (this.refreshTimer) {
      if (this.refreshTimer.at <= at) return;
      this.options.timers.clearTimeout(this.refreshTimer.handle);
    }
    const handle = this.options.timers.setTimeout(() => {
      if (this.refreshTimer?.handle !== handle) return;
      this.refreshTimer = null;
      this.takeSnapshot();
    }, delayMs);
    this.refreshTimer = { handle, at };
  }

  /** One format read in flight at a time, so snapshots arrive in the order they were read. */
  private takeSnapshot(): void {
    const pane = viewing(this.pane);
    if (!pane || this.snapshotMode() === "off") return;
    if (this.snapshotInFlight) {
      this.snapshotAgain = true;
      return;
    }
    this.snapshotInFlight = true;
    const serial = this.viewSerial;
    this.readScreen(pane.target).then(
      (text) => {
        this.snapshotInFlight = false;
        if (serial === this.viewSerial && this.snapshotMode() !== "off") this.deliver(text);
        this.afterSnapshot();
      },
      (error) => {
        this.snapshotInFlight = false;
        if (!isConnectionLoss(error)) this.log(`rex: snapshot failed: ${String(error)}`);
        this.afterSnapshot();
      },
    );
  }

  private afterSnapshot(): void {
    if (this.snapshotAgain) {
      this.snapshotAgain = false;
      this.takeSnapshot();
    } else if (this.snapshotMode() === "poll") {
      this.refreshIn(REX_SNAPSHOT_INTERVAL_MS);
    }
  }

  private snapshotMode(): SnapshotMode {
    const feed = this.feed;
    if (feed.kind === "none" || (feed.kind === "waiting" && !feed.stream)) return "poll";
    const grid = this.feedStream()?.grid;
    return grid && !sameGrid(grid, this.grid) ? "follow" : "off";
  }

  private cancelRefresh(): void {
    if (this.refreshTimer) this.options.timers.clearTimeout(this.refreshTimer.handle);
    this.refreshTimer = null;
  }

  /** The block's screen and scrollback as VT, reading past the first reply with blob_read when it is too large for one. */
  private async readScreen(target: Target): Promise<string> {
    const block = { session_id: target.sessionId, block_id: target.blockId };
    let part: RexTextPart = parseFormatPart(await this.control.call(RexMethod.terminalFormat, { ...block, args: SNAPSHOT_ARGS }));
    let text = part.text;
    let offset = encodeUtf8(part.text).length;
    while (!part.complete) {
      part = parseBlobPart(
        await this.control.call(RexMethod.terminalBlobRead, { ...block, args: { id: part.blobId, offset, max_bytes: REX_FORMAT_PART_BYTES } }),
      );
      if (!part.text && !part.complete) throw new Error("blob_read returned nothing before the end");
      text += part.text;
      offset += encodeUtf8(part.text).length;
    }
    return text;
  }

  /** Skips a screen identical to the last one, so an idle pane doesn't reset the view's scroll position. */
  private deliver(text: string): void {
    if (text !== this.lastSnapshot) this.emitSnapshot(text);
  }

  private emitSnapshot(text: string): void {
    this.lastSnapshot = text;
    const bytes = encodeUtf8(text);
    for (const listener of [...this.terminalDataListeners]) listener(bytes, "snapshot");
    for (const listener of [...this.snapshotListeners]) listener(0, 0);
  }

  // ---- data stream ----

  /** Starts, keeps or ends the data connection to match the pane. */
  private followPane(): void {
    const want = feedTarget(this.pane);
    const feed = this.feed;
    if (feed.kind !== "none" && feed.target.blockId !== want?.blockId) this.endFeed();
    const pane = viewing(this.pane);
    if (this.feed.kind === "none" && pane && this.options.openDataSocket) this.connectFeed(pane.target, 0);
  }

  private connectFeed(target: Target, attempt: number): void {
    const feed: Feed = { kind: "ticket", target, attempt };
    this.feed = feed;
    const args = { session_id: target.sessionId, block_id: target.blockId, data_ref_id: TERMINAL_DATA_REF, subprotocol: REX_DATA_SUBPROTOCOL };
    this.control.call(RexMethod.dataConnect, args).then(
      (payload) => {
        if (this.feed !== feed) return;
        let hello: Uint8Array;
        try {
          hello = helloFrame(parseDataTicket(payload));
        } catch (error) {
          this.waitFeed(target, attempt + 1, null, `bad data ticket: ${String(error)}`);
          return;
        }
        const link: Link = { socket: null };
        this.feed = { kind: "hello", target, attempt, link };
        this.openLink(link, hello);
      },
      (error) => {
        if (this.feed === feed) this.waitFeed(target, attempt + 1, null, String(error));
      },
    );
  }

  private resumeFeed(target: Target, attempt: number, stream: FeedStream): void {
    const link: Link = { socket: null };
    this.feed = { kind: "resuming", target, attempt, link, stream };
    this.log(`rex data: RESUME at ${stream.rex.bytesReceived} bytes`);
    this.openLink(link, stream.rex.resumeFrame());
  }

  /** Opens a data connection that sends `first` once it is open. */
  private openLink(link: Link, first: Uint8Array): void {
    const openDataSocket = this.options.openDataSocket;
    if (!openDataSocket) return;
    const current = () => "link" in this.feed && this.feed.link === link;
    try {
      link.socket = openDataSocket(this.options.endpoint.dataUrl, {
        onOpen: () => {
          if (current() && !link.socket?.sendBinary(first)) this.linkEnded({ kind: "closed", code: null }, "handshake refused by the socket");
        },
        onBinaryMessage: (bytes) => {
          if (current()) this.linkMessage(bytes);
        },
        onClosed: (code, reason) => {
          if (current()) this.linkEnded({ kind: "closed", code }, reason);
        },
        onFailure: (message) => {
          if (current()) this.linkEnded({ kind: "closed", code: null }, message);
        },
      });
    } catch (error) {
      this.linkEnded({ kind: "closed", code: null }, String(error));
    }
  }

  private linkMessage(bytes: Uint8Array): void {
    const feed = this.feed;
    if (feed.kind === "live") {
      this.run(feed.stream, feed.stream.rex.receive(bytes, this.options.now()));
      return;
    }
    if (feed.kind !== "hello" && feed.kind !== "resuming") return;
    const reply = parseHandshakeReply(bytes);
    if (reply.kind === "reject") {
      this.closeLink(feed.link);
      this.linkEnded({ kind: "rejected", reason: reply.reason }, "REJECT");
    } else if (reply.kind === "invalid") {
      this.closeLink(feed.link);
      this.linkEnded({ kind: "rejected", reason: "unknown" }, "malformed handshake reply");
    } else if (feed.kind === "hello") {
      this.log("rex data: WELCOME");
      this.feed = { ...feed, kind: "live", stream: { rex: new RexStream(reply.welcome), grid: null, timer: null }, since: this.options.now() };
    } else if (feed.stream.rex.resumed(reply.welcome)) {
      this.log(`rex data: RESUME accepted at ${feed.stream.rex.bytesReceived} bytes`);
      this.feed = { ...feed, kind: "live", since: this.options.now() };
    } else {
      this.closeLink(feed.link);
      this.linkEnded({ kind: "rejected", reason: "unknown" }, "RESUME answered for another stream");
    }
  }

  /** The current data connection ended: resume it, start over, or show the pane closed. */
  private linkEnded(end: DataEnd, why: string): void {
    const feed = this.feed;
    if (feed.kind !== "hello" && feed.kind !== "resuming" && feed.kind !== "live") return;
    const step = nextStepAfter(end);
    const reason = `${end.kind === "rejected" ? `reject ${end.reason}` : `close ${end.code ?? "without status"}`} (${why}), ${step}`;
    if (step === "pane-closed") {
      this.log(`rex data: ended, ${reason}`);
      this.endFeed();
      this.sessionGone("Pane closed.", "session closed");
      return;
    }
    const stable = feed.kind === "live" && this.options.now() - feed.since >= REX_DATA_STABLE_MS;
    const stream = step === "resume" && feed.kind !== "hello" ? feed.stream : null;
    if (!stream && feed.kind !== "hello") this.clearStreamTimer(feed.stream);
    this.waitFeed(feed.target, stable ? 0 : feed.attempt + 1, stream, reason);
  }

  /** Retry after the backoff for `attempt`, resuming `stream`, or starting over when it is null. */
  private waitFeed(target: Target, attempt: number, stream: FeedStream | null, reason: string): void {
    const delayMs = Math.min(REX_DATA_RETRY_MAX_MS, REX_DATA_RETRY_MIN_MS * 2 ** attempt);
    this.log(`rex data: ${reason}; retry in ${delayMs} ms`);
    const timer = this.options.timers.setTimeout(() => {
      const feed = this.feed;
      if (feed.kind !== "waiting" || feed.timer !== timer) return;
      if (stream) this.resumeFeed(target, attempt, stream);
      else this.connectFeed(target, attempt);
    }, delayMs);
    this.feed = { kind: "waiting", target, attempt, timer, stream };
    this.refreshIn(0);
  }

  private endFeed(): void {
    const feed = this.feed;
    this.feed = { kind: "none" };
    if (feed.kind === "waiting") this.options.timers.clearTimeout(feed.timer);
    if ("link" in feed) this.closeLink(feed.link);
    if ("stream" in feed && feed.stream) this.clearStreamTimer(feed.stream);
  }

  private closeLink(link: Link): void {
    const socket = link.socket;
    link.socket = null;
    try {
      socket?.close(DATA_CLOSE_NORMAL, DATA_CLOSE_REASON);
    } catch {
      // The socket may already be closed.
    }
  }

  private feedStream(): FeedStream | null {
    return "stream" in this.feed ? this.feed.stream : null;
  }

  private isLive(stream: FeedStream): boolean {
    return this.feed.kind === "live" && this.feed.stream === stream;
  }

  /** Carries out the stream's actions in order, stopping if one of them ends the stream. */
  private run(stream: FeedStream, actions: StreamAction[]): void {
    if (this.feed.kind === "none") return;
    const blockId = this.feed.target.blockId;
    let output = false;
    for (const action of actions) {
      if (this.feedStream() !== stream) return;
      switch (action.type) {
        case "output":
          output = true;
          this.output(action.bytes, stream);
          break;
        case "resize":
          this.resized(stream, { cols: action.cols, rows: action.rows });
          break;
        case "seed":
          this.seeded(stream, action.vt, { cols: action.cols, rows: action.rows });
          break;
        case "request-seed":
          this.requestSeed(stream);
          break;
        case "check-at":
          this.setStreamTimer(stream, action.at - this.options.now(), () => this.tick(stream));
          break;
        case "exited":
          this.log(`rex data: program exited with ${action.exitCode ?? "no code"}`);
          break;
      }
    }
    if (output) for (const listener of [...this.activityListeners]) listener(blockId, this.options.now());
  }

  /** While the stream is at another client's size, the emulator can't follow its bytes, so a snapshot shows them. */
  private output(bytes: Uint8Array, stream: FeedStream): void {
    if (stream.grid && !sameGrid(stream.grid, this.grid)) {
      this.refreshIn(REX_SNAPSHOT_AFTER_OUTPUT_MS);
      return;
    }
    this.lastSnapshot = null;
    for (const listener of [...this.terminalDataListeners]) listener(bytes, "output");
  }

  private seeded(stream: FeedStream, vt: string, grid: Grid): void {
    stream.grid = grid;
    this.emitSnapshot(vt);
    if (this.snapshotMode() === "off") this.cancelRefresh();
  }

  /** Back at the glasses grid after another size, the emulator holds a snapshot, so the stream starts over from a fresh seed. */
  private resized(stream: FeedStream, grid: Grid): void {
    const before = stream.grid;
    stream.grid = grid;
    if (!sameGrid(grid, this.grid)) {
      this.refreshIn(0);
    } else if (before && !sameGrid(before, this.grid)) {
      const target = this.feed.kind === "none" ? null : this.feed.target;
      this.endFeed();
      if (target) this.connectFeed(target, 0);
    }
  }

  /** A seed is read only while the data connection is live, so the bytes it already shows can't arrive again after a RESUME. */
  private requestSeed(stream: FeedStream): void {
    const target = this.feed.kind === "none" ? null : this.feed.target;
    if (!target) return;
    if (!this.isLive(stream)) {
      this.setStreamTimer(stream, REX_SEED_RETRY_MS, () => this.requestSeed(stream));
      return;
    }
    this.readScreen(target).then(
      (vt) => {
        if (this.feedStream() !== stream) return;
        if (this.isLive(stream)) this.run(stream, stream.rex.seedArrived(vt));
        else this.setStreamTimer(stream, REX_SEED_RETRY_MS, () => this.requestSeed(stream));
      },
      (error) => {
        if (this.feedStream() !== stream) return;
        if (!isConnectionLoss(error)) this.log(`rex data: seed failed: ${String(error)}`);
        this.setStreamTimer(stream, REX_SEED_RETRY_MS, () => this.requestSeed(stream));
      },
    );
  }

  private tick(stream: FeedStream): void {
    if (this.isLive(stream)) this.run(stream, stream.rex.tick(this.options.now()));
    else this.setStreamTimer(stream, REX_SEED_RETRY_MS, () => this.tick(stream));
  }

  private setStreamTimer(stream: FeedStream, delayMs: number, callback: () => void): void {
    this.clearStreamTimer(stream);
    const timer = this.options.timers.setTimeout(() => {
      if (stream.timer !== timer) return;
      stream.timer = null;
      if (this.feedStream() === stream) callback();
    }, Math.max(0, delayMs));
    stream.timer = timer;
  }

  private clearStreamTimer(stream: FeedStream): void {
    if (stream.timer !== null) this.options.timers.clearTimeout(stream.timer);
    stream.timer = null;
  }

  // ---- input ----

  private queueInput(input: RexInput): void {
    this.log(`rex input sent ${input.kind}`);
    this.control.sendInput(input).then(
      () => this.refreshIn(REX_SNAPSHOT_AFTER_INPUT_MS),
      (error) => this.log(`rex: input failed: ${String(error)}`),
    );
  }

  // ---- shared ----

  /** Every pane change ends the snapshot cycle of the pane before it, and the stream of a block no longer viewed. */
  private setPane(next: Pane): void {
    const wasViewing = viewing(this.pane);
    const nowViewing = viewing(next);
    if (!wasViewing || !nowViewing || wasViewing.target !== nowViewing.target) {
      this.viewSerial++;
      this.lastSnapshot = null;
      this.cancelRefresh();
    }
    this.pane = next;
    this.followPane();
  }

  private describe(control: RexControlState): { phase: G2MirrorPhase; status: string } {
    const host = this.options.endpoint.displayHost;
    switch (control.phase) {
      case "idle":
        return { phase: "idle", status: "Not connected." };
      case "connecting":
      case "awaiting-welcome":
      case "syncing":
        return { phase: "connecting", status: `Connecting to ${host}...` };
      case "backoff":
        return { phase: "connecting", status: `Reconnecting to ${host}...` };
      case "failed":
        return { phase: "failed", status: `${host}: ${control.reason}` };
      case "ready":
        break;
    }
    switch (this.pane.kind) {
      case "attached":
      case "claiming":
      case "owner":
        return { phase: "attached", status: `Attached to ${this.labelOf(this.pane.target)}.` };
      case "foreign":
        return { phase: "connected", status: REX_OTHER_OWNER_NOTICE };
      case "attaching":
        return { phase: "connected", status: "Attaching..." };
      case "none":
        return { phase: "connected", status: this.notice || `Connected to ${host}.` };
    }
  }

  private labelOf(target: Target | null): string {
    if (!target) return "";
    return rexSessionRows(this.control.sessions()).find((row) => row.socket === target.blockId)?.title ?? "";
  }

  private emitState(): void {
    const state = this.state();
    for (const listener of [...this.stateListeners]) listener(state);
  }
}

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => set.delete(listener);
}
