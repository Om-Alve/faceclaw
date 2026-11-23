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
 * The screen comes from com.superlogical.terminal.format as VT, screen and
 * scrollback, delivered as a snapshot. It is refreshed after input, on block
 * events and on a timer, all through refreshIn(). A dropped connection
 * reconnects inside RexControl, and the view re-attaches and re-claims itself.
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
  RexMethod,
  parseBlobPart,
  parseCreated,
  parseFormatPart,
  type RexBlockInfo,
  type RexClientInfo,
  type RexSessionView,
  type RexTextPart,
  type RexWindowView,
} from "./rex/protocol";
import { encodeUtf8 } from "./tmux-client";

export const REX_SNAPSHOT_AFTER_INPUT_MS = 50;
export const REX_SNAPSHOT_INTERVAL_MS = 500;
/** The most one format or blob_read reply may carry (rex-api-r18.md, com.superlogical.terminal.format). */
export const REX_FORMAT_PART_BYTES = 983_040;
export const REX_OTHER_OWNER_NOTICE = "Mac has this pane";

const REX_CLIENT_INFO: RexClientInfo = { kind: "app", name: "Faceclaw", version: "1" };
const TERMINAL_CREATOR = "com.superlogical.terminal";
const SHELL_FLAVOR = "com.superlogical.terminal.shell";
const SHELL_PRESET = "shell";
const TAKE = "take";
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

export type RexClientOptions = {
  endpoint: RexEndpoint;
  createSocket: RexSocketFactory;
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
   * and every REX_SNAPSHOT_INTERVAL_MS while viewing.
   */
  private refreshIn(delayMs: number): void {
    if (!viewing(this.pane)) return;
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
    if (!pane) return;
    if (this.snapshotInFlight) {
      this.snapshotAgain = true;
      return;
    }
    this.snapshotInFlight = true;
    const serial = this.viewSerial;
    this.readScreen(pane.target).then(
      (text) => {
        this.snapshotInFlight = false;
        if (serial === this.viewSerial) this.deliver(text);
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
    } else {
      this.refreshIn(REX_SNAPSHOT_INTERVAL_MS);
    }
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
    if (text === this.lastSnapshot) return;
    this.lastSnapshot = text;
    const bytes = encodeUtf8(text);
    for (const listener of [...this.terminalDataListeners]) listener(bytes, "snapshot");
    for (const listener of [...this.snapshotListeners]) listener(0, 0);
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

  /** Every pane change ends the snapshot cycle of the pane before it. */
  private setPane(next: Pane): void {
    const wasViewing = viewing(this.pane);
    const nowViewing = viewing(next);
    if (!wasViewing || !nowViewing || wasViewing.target !== nowViewing.target) {
      this.viewSerial++;
      this.lastSnapshot = null;
      if (this.refreshTimer) this.options.timers.clearTimeout(this.refreshTimer.handle);
      this.refreshTimer = null;
    }
    this.pane = next;
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
