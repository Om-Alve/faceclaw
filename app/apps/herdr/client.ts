/**
 * One connection to one Herdr bridge, with the reconnect, request/reply and
 * view-subscription behaviour design/herdr/PLAN.md calls for:
 *
 * - one persistent WebSocket per enabled machine, reconnecting with the
 *   Terminal app's backoff;
 * - one `open` view subscription at a time (the pane being displayed), closed
 *   when switching panes and reopened after a reconnect;
 * - incoming JSON validated once, at this boundary;
 * - writes correlated by request id and never retried automatically: a
 *   timeout reports "unknown" because the bridge may have executed it;
 * - protocol-3 operations used only when the bridge advertises them.
 *
 * No NativeScript imports: sockets and timers are injected, so tests drive it
 * with a fake bridge.
 */
import {
  clientMessages,
  isAllowedKey,
  parseServerMessage,
  PROTOCOL_VERSION_3,
  type ChatEntry,
  type ClientMsg,
  type ErrorCode,
  type PaneSummary,
  type QueueOutcomeEntry,
  type QueueSummary,
  type QueuedItem,
  type ServerMsg,
  type Snippet,
  type SubagentSummary,
} from "./protocol";
import { parseBridgeUrl } from "./model";

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
const HELLO_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;

export type ClientPhase = "idle" | "connecting" | "connected" | "retrying" | "forbidden" | "unreachable" | "off";

export type SocketHandlers = {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(reason: string): void;
};

export type HerdrSocket = {
  send(text: string): boolean | void;
  close(code?: number, reason?: string): void;
};

export type SocketFactory = (url: string, handlers: SocketHandlers) => HerdrSocket;

export type Timers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export type ViewState = {
  pane: string;
  subagent?: string;
  source: "transcript" | "screen" | null;
  entries: ChatEntry[];
  hasOlder: boolean;
  /** While blocked: the cleaned prompt the wearer is answering. */
  prompt: string | null;
  queue: QueuedItem[];
  subagents: SubagentSummary[];
  outcomes: QueueOutcomeEntry[];
  /** A protocol-3 read was refused (pane replaced/gone). */
  error: string | null;
};

export type ClientSnapshot = {
  machineId: string;
  label: string;
  url: string;
  phase: ClientPhase;
  protocol: number;
  /** `hello.machine`, null before the first hello. */
  machine: string | null;
  herdrVersion: string | null;
  snippets: Snippet[];
  panes: PaneSummary[];
  queueSummaries: ReadonlyMap<string, QueueSummary>;
  view: ViewState | null;
  /** A short human explanation of phase, for the hub's machine line. */
  status: string;
  lastError: string;
};

export type WriteResult =
  | { status: "ok" }
  | { status: "error"; code: ErrorCode; message: string }
  /** No reply arrived; the bridge may or may not have executed the write. */
  | { status: "unknown"; message: string };

export type HerdrClientOptions = {
  machine: { id: string; label: string; url: string };
  /** Derived WS URL; defaults to replacing the base URL's scheme and appending /ws. */
  wsUrl?: string;
  createSocket: SocketFactory;
  onChange?: () => void;
  log?: (message: string) => void;
  timers?: Timers;
  now?: () => number;
};

type Pending = {
  kind: "write" | "read";
  /** The view generation this request belonged to; older replies are dropped on view changes. */
  viewToken: number | null;
  resolve: (result: WriteResult) => void;
  timer: unknown;
};

const initialView = (pane: string, subagent?: string): ViewState => ({
  pane,
  ...(subagent ? { subagent } : {}),
  source: null,
  entries: [],
  hasOlder: false,
  prompt: null,
  queue: [],
  subagents: [],
  outcomes: [],
  error: null,
});

export class HerdrMachineClient {
  private socket: HerdrSocket | null = null;
  private phase: ClientPhase = "idle";
  private protocol = 0;
  private machine: string | null = null;
  private herdrVersion: string | null = null;
  private snippets: Snippet[] = [];
  private panes: PaneSummary[] = [];
  private queueSummaries = new Map<string, QueueSummary>();
  private view: ViewState | null = null;
  /** What the window wants open; survives a reconnect. */
  private desiredView: { pane: string; subagent?: string } | null = null;
  private viewToken = 0;
  private attempt = 0;
  private stopped = true;
  private socketOpen = false;
  private connected = false;
  private connectTimer: unknown = null;
  private helloTimer: unknown = null;
  private pingTimer: unknown = null;
  private lastError = "";
  private status = "";
  private readonly pending = new Map<string, Pending>();
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private requestSerial = 1;

  constructor(private readonly options: HerdrClientOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  get machineId(): string {
    return this.options.machine.id;
  }

  /** The label to show: the wearer's name, else the reported machine, else the URL host. */
  get label(): string {
    return this.options.machine.label || this.machine || hostOf(this.options.machine.url);
  }

  get wsUrl(): string {
    return this.options.wsUrl ?? deriveWsUrl(this.options.machine.url);
  }

  get snapshot(): ClientSnapshot {
    return {
      machineId: this.options.machine.id,
      label: this.label,
      url: this.options.machine.url,
      phase: this.phase,
      protocol: this.protocol,
      machine: this.machine,
      herdrVersion: this.herdrVersion,
      snippets: this.snippets,
      panes: this.panes,
      queueSummaries: this.queueSummaries,
      view: this.view,
      status: this.status,
      lastError: this.lastError,
    };
  }

  get connectedProtocol(): number {
    return this.connected ? this.protocol : 0;
  }

  supportsProtocol3(): boolean {
    return this.connected && this.protocol >= PROTOCOL_VERSION_3;
  }

  /** Start (or resume) connecting. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.socketOpen = false;
    this.clearConnectTimer();
    this.clearHelloTimer();
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "closing");
    } catch {
      // The socket may already be gone.
    }
    this.failPending("closed", "The connection closed.");
    this.setPhase("off", "Disconnected");
  }

  /** A user-initiated retry: reset backoff and connect now if not already. */
  retryNow(): void {
    this.clearConnectTimer();
    this.attempt = 0;
    if (this.connected) return;
    if (!this.stopped) this.connect();
    else this.start();
  }

  /** Reconfigure in place; a changed URL reconnects. */
  updateConfig(machine: { id: string; label: string; url: string }): void {
    const urlChanged = machine.url !== this.options.machine.url;
    this.options.machine = machine;
    if (urlChanged && !this.stopped) {
      this.disconnectSocket();
      this.attempt = 0;
      this.connect();
    }
    this.emit();
  }

  // ---------------------------------------------------------------- views

  /**
   * Subscribe to a pane (or one of its subagents). Replaces the previous view
   * subscription; retained while disconnected and reopened on reconnect.
   */
  openView(paneId: string, subagent?: string): void {
    const same = this.desiredView?.pane === paneId && this.desiredView?.subagent === subagent;
    if (same && this.view) return;
    if (this.desiredView && this.connected) this.sendRequest(clientMessages.close(this.nextId()), { kind: "read", viewToken: this.viewToken });
    this.desiredView = subagent ? { pane: paneId, subagent } : { pane: paneId };
    this.view = initialView(paneId, subagent);
    this.viewToken++;
    if (this.connected) this.sendOpen();
    this.emit();
  }

  closeView(): void {
    this.desiredView = null;
    this.view = null;
    this.viewToken++;
    if (this.connected) this.sendRequest(clientMessages.close(this.nextId()), { kind: "read", viewToken: null });
    this.emit();
  }

  /** Long-lived socket reopened: re-request the view. */
  private sendOpen(): void {
    const desired = this.desiredView;
    if (!desired) return;
    this.sendRequest(clientMessages.open(this.nextId(), desired.pane, desired.subagent), {
      kind: "read",
      viewToken: this.viewToken,
    });
  }

  /** Page older entries; the `chat.older` push updates the view. */
  requestOlder(before: string, limit = 60): Promise<WriteResult> {
    const desired = this.desiredView;
    if (!desired || !this.connected) return Promise.resolve({ status: "error" as const, code: "internal" as const, message: "Not connected." });
    return this.sendRequest(clientMessages.older(this.nextId(), desired.pane, before, desired.subagent, limit), {
      kind: "read",
      viewToken: this.viewToken,
    });
  }

  // ---------------------------------------------------------------- writes

  sendKeys(paneId: string, keys: readonly string[]): Promise<WriteResult> {
    const invalid = keys.find((key) => !isAllowedKey(key));
    if (invalid) return Promise.resolve({ status: "error", code: "key_not_allowed", message: `Key not allowed: ${invalid}` });
    if (!this.connected) return Promise.resolve(offline("keys", keys.join(" ")));
    return this.sendRequest(clientMessages.keys(this.nextId(), paneId, [...keys]), { kind: "write", viewToken: null });
  }

  /**
   * Send text with the primitive that fits the pane and the bridge version:
   * protocol 3's typed `prompt`/`run`/`type`, or protocol 2's `text`.
   */
  sendText(
    pane: PaneSummary | undefined,
    kind: "message" | "command" | "type",
    text: string,
    options: { queue?: boolean; terminalId?: string } = {},
  ): Promise<WriteResult> {
    if (!this.connected) return Promise.resolve(offline(kind, text));
    const terminalId = options.terminalId;
    if (this.supportsProtocol3() && terminalId) {
      const id = this.nextId();
      if (kind === "message") return this.sendRequest(clientMessages.prompt(id, paneIdOf(pane), terminalId, text, options.queue), { kind: "write", viewToken: null });
      if (kind === "command") return this.sendRequest(clientMessages.run(id, paneIdOf(pane), terminalId, text), { kind: "write", viewToken: null });
      return this.sendRequest(clientMessages.type(id, paneIdOf(pane), terminalId, text), { kind: "write", viewToken: null });
    }
    const enter = kind !== "type";
    return this.sendRequest(clientMessages.text(this.nextId(), paneIdOf(pane), text, { enter, queue: options.queue && kind === "message", terminalId }), {
      kind: "write",
      viewToken: null,
    });
  }

  /**
   * Answer a blocked prompt. Protocol 3 binds the answer to the revision the
   * wearer saw; protocol 2 falls back to keys, checked by the caller against
   * its latest view.
   */
  answer(pane: PaneSummary, keys: readonly string[], revision?: string): Promise<WriteResult> {
    const invalid = keys.find((key) => !isAllowedKey(key));
    if (invalid) return Promise.resolve({ status: "error", code: "key_not_allowed", message: `Key not allowed: ${invalid}` });
    if (!this.connected) return Promise.resolve(offline("answer", keys.join(" ")));
    if (this.supportsProtocol3() && pane.terminalId && revision) {
      return this.sendRequest(clientMessages.answer(this.nextId(), pane.id, pane.terminalId, revision, [...keys]), { kind: "write", viewToken: null });
    }
    return this.sendRequest(clientMessages.keys(this.nextId(), pane.id, [...keys]), { kind: "write", viewToken: null });
  }

  unqueue(paneId: string, itemId: string): Promise<WriteResult> {
    if (!this.connected) return Promise.resolve(offline("unqueue", itemId));
    return this.sendRequest(clientMessages.unqueue(this.nextId(), paneId, itemId), { kind: "write", viewToken: null });
  }

  // ---------------------------------------------------------------- connection

  private connect(): void {
    if (this.stopped) return;
    this.clearConnectTimer();
    this.setPhase(this.attempt === 0 ? "connecting" : "retrying", this.attempt === 0 ? "Connecting…" : "Reconnecting…");
    let socket: HerdrSocket;
    const url = this.wsUrl;
    try {
      socket = this.options.createSocket(url, {
        onOpen: () => {
          if (this.socket !== socket) return;
          this.socketOpen = true;
          this.armHelloTimeout();
        },
        onMessage: (text) => {
          if (this.socket !== socket) return;
          this.handleMessage(text);
        },
        onClose: (reason) => {
          if (this.socket !== socket) return;
          this.handleClose(reason);
        },
      });
    } catch (error) {
      this.handleClose(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    this.connected = false;
    this.stopPing();
    this.clearHelloTimer();
    try {
      socket?.close(1000, "reconnecting");
    } catch {
      // Already gone.
    }
  }

  private handleClose(reason: string): void {
    this.socket = null;
    this.socketOpen = false;
    this.connected = false;
    this.stopPing();
    this.clearHelloTimer();
    this.view = this.desiredView ? initialView(this.desiredView.pane, this.desiredView.subagent) : null;
    if (this.stopped) {
      this.setPhase("off", "Disconnected");
      return;
    }
    this.failPending("closed", reason || "The connection closed.");
    const kind = classifyClose(reason);
    if (kind === "forbidden") {
      // A rejected identity will not fix itself by retrying.
      this.setPhase("forbidden", this.lastError);
      return;
    }
    this.attempt++;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempt - 1, 6));
    this.setPhase("retrying", this.attempt > 1 ? `Reconnecting in ${Math.round(delay / 1000)}s…` : "Reconnecting…");
    this.connectTimer = this.timers.setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(text: string): void {
    const message = parseServerMessage(text);
    if (!message) {
      this.log(`ignored malformed bridge message (${text.slice(0, 80)})`);
      return;
    }
    this.handleServerMessage(message);
  }

  private handleServerMessage(message: ServerMsg): void {
    switch (message.t) {
      case "hello":
        this.clearHelloTimer();
        this.machine = message.machine;
        this.protocol = message.protocol;
        this.herdrVersion = message.herdrVersion;
        this.snippets = message.snippets;
        this.attempt = 0;
        this.connected = true;
        this.setPhase("connected", message.protocol >= PROTOCOL_VERSION_3 ? "Connected" : "Connected (protocol 2)");
        this.startPing();
        this.sendOpen();
        this.emit();
        return;
      case "panes":
        this.panes = message.panes;
        this.emit();
        return;
      case "queue.summary":
        this.queueSummaries = new Map(message.panes.map((summary) => [summary.pane, summary]));
        this.emit();
        return;
      case "chat": {
        if (!this.matchesView(message.pane, message.subagent)) return;
        // A chat snapshot supersedes any queue/outcome state from a previous view.
        this.view = {
          pane: message.pane,
          ...(message.subagent ? { subagent: message.subagent } : {}),
          source: message.source,
          entries: message.entries,
          hasOlder: message.hasOlder,
          prompt: null,
          queue: this.view?.queue ?? [],
          subagents: [],
          outcomes: [],
          error: null,
        };
        this.resolvePending(message.id);
        this.emit();
        return;
      }
      case "chat.append": {
        if (!this.matchesView(message.pane, message.subagent) || !this.view) return;
        this.view = { ...this.view, entries: [...this.view.entries, ...message.entries] };
        this.emit();
        return;
      }
      case "chat.update": {
        if (!this.matchesView(message.pane, message.subagent) || !this.view) return;
        const byId = new Map(message.entries.map((entry) => [entry.id, entry]));
        const seen = new Set<string>();
        const entries = this.view.entries.map((entry) => {
          const update = byId.get(entry.id);
          if (!update) return entry;
          seen.add(entry.id);
          return update;
        });
        for (const update of message.entries) if (!seen.has(update.id)) entries.push(update);
        this.view = { ...this.view, entries };
        this.emit();
        return;
      }
      case "chat.older": {
        if (!this.matchesView(message.pane, message.subagent) || !this.view) return;
        const known = new Set(this.view.entries.map((entry) => entry.id));
        const older = message.entries.filter((entry) => !known.has(entry.id));
        this.view = { ...this.view, entries: [...older, ...this.view.entries], hasOlder: message.hasOlder };
        this.resolvePending(message.id);
        this.emit();
        return;
      }
      case "queue":
        if (!this.matchesView(message.pane, undefined) || !this.view) return;
        this.view = { ...this.view, queue: message.items };
        this.emit();
        return;
      case "queue.outcomes":
        if (!this.matchesView(message.pane, undefined) || !this.view) return;
        this.view = { ...this.view, outcomes: message.items };
        this.emit();
        return;
      case "subagents":
        if (!this.matchesView(message.pane, undefined) || !this.view) return;
        this.view = { ...this.view, subagents: message.subagents };
        this.emit();
        return;
      case "prompt":
        if (!this.matchesView(message.pane, undefined) || !this.view) return;
        this.view = { ...this.view, prompt: message.text };
        this.emit();
        return;
      case "pong":
      case "ok":
        this.resolvePending(message.id, { status: "ok" });
        return;
      case "error":
        this.lastError = message.message;
        if (message.id) {
          const pending = this.pending.get(message.id);
          this.resolvePending(message.id, { status: "error", code: message.code, message: message.message });
          // A refused view read leaves a visible error instead of a blank pane.
          if (!pending || pending.kind === "read") {
            if (this.view && (message.code === "unknown_pane" || message.code === "unknown_subagent" || message.code === "terminal_changed")) {
              this.view = { ...this.view, error: message.message };
            }
          }
        }
        this.emit();
        return;
    }
  }

  private matchesView(pane: string, subagent: string | undefined): boolean {
    const desired = this.desiredView;
    if (!desired || !this.view) return false;
    return desired.pane === pane && (desired.subagent ?? undefined) === (subagent ?? undefined);
  }

  // ---------------------------------------------------------------- requests

  private nextId(): string {
    return `h${this.requestSerial++}`;
  }

  private sendRequest(message: ClientMsg, options: { kind: "write" | "read"; viewToken: number | null }): Promise<WriteResult> {
    const id = (message as { id?: string }).id;
    if (!id) return Promise.resolve({ status: "error", code: "internal", message: "request without id" });
    if (!this.connected || !this.socket) return Promise.resolve(offline("write", id));
    return new Promise<WriteResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        resolve({
          status: "unknown",
          message: options.kind === "write" ? "No reply; it may or may not have been sent." : "The bridge did not answer.",
        });
      }, options.kind === "write" ? WRITE_TIMEOUT_MS : HELLO_TIMEOUT_MS);
      this.pending.set(id, { kind: options.kind, viewToken: options.viewToken, resolve, timer });
      try {
        this.socket?.send(JSON.stringify(message));
      } catch (error) {
        this.timers.clearTimeout(timer);
        this.pending.delete(id);
        resolve({ status: "error", code: "internal", message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private resolvePending(id: string | undefined, result?: WriteResult): void {
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    // A view reply that belongs to a view the wearer already left is stale.
    if (pending.viewToken !== null && pending.viewToken !== this.viewToken) {
      this.timers.clearTimeout(pending.timer);
      this.pending.delete(id);
      return;
    }
    this.timers.clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(result ?? { status: "ok" });
  }

  /** An outgoing request whose reply is informational; replies are handled in handleServerMessage. */
  private sendInformational(message: ClientMsg): void {
    if (!this.connected || !this.socket) return;
    const id = (message as { id?: string }).id;
    if (id) this.pending.set(id, { kind: "read", viewToken: this.viewToken, resolve: () => {}, timer: null });
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      if (id) this.pending.delete(id);
    }
  }

  private failPending(_reason: string, message: string): void {
    for (const [id, pending] of this.pending) {
      this.timers.clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({ status: "unknown", message });
    }
  }

  // ---------------------------------------------------------------- timers

  private armHelloTimeout(): void {
    this.clearHelloTimer();
    this.helloTimer = this.timers.setTimeout(() => {
      this.helloTimer = null;
      if (this.connected) return;
      this.lastError = "The bridge accepted the connection but did not say hello.";
      this.disconnectSocket();
      this.handleClose(this.lastError);
    }, HELLO_TIMEOUT_MS);
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      this.timers.clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = this.timers.setInterval(() => {
      if (!this.connected) return;
      this.sendInformational(clientMessages.ping(this.nextId()));
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setPhase(phase: ClientPhase, status: string): void {
    const changed = this.phase !== phase || this.status !== status;
    this.phase = phase;
    this.status = status;
    if (phase === "unreachable" || phase === "forbidden") this.lastError = status;
    if (changed) this.emit();
  }

  private emit(): void {
    this.options.onChange?.();
  }
}

function paneIdOf(pane: PaneSummary | undefined): string {
  return pane?.id ?? "";
}

function offline(_kind: string, _text: string): WriteResult {
  return { status: "error", code: "internal", message: "Not connected; nothing was sent." };
}

function hostOf(url: string): string {
  return parseBridgeUrl(url)?.host ?? url;
}

/** https://host[/ws] -> wss://host/ws; http -> ws (local development). */
export function deriveWsUrl(baseUrl: string): string {
  return parseBridgeUrl(baseUrl)?.wsUrl ?? baseUrl;
}

function classifyClose(reason: string): "forbidden" | "unreachable" {
  if (/\b(401|403)\b|forbidden|unauthori[sz]ed|not authorized/i.test(reason)) return "forbidden";
  return "unreachable";
}

/** Human text for a socket failure, shared by the app and the health probe. */
export function describeSocketFailure(message: string): string {
  const text = String(message).replace(/^[\w.]*(Exception|Error):\s*/, "").trim();
  if (/\b(401|403)\b|forbidden|unauthori[sz]ed/i.test(text)) return "This phone's Tailscale identity was refused.";
  if (/Expected HTTP 101 response but was '403/i.test(text)) return "Bridge refused this phone's identity (403).";
  if (/ENOTFOUND|No route to host|ECONNREFUSED|Connection refused|Failed to connect/i.test(text)) return "Can't reach the bridge.";
  if (/timeout|timed out/i.test(text)) return "The bridge did not answer.";
  if (/certificate|SSL|TLS/i.test(text)) return "TLS failed; check the tailnet certificate.";
  return text || "Connection failed.";
}

/** The HTTP health probe step 1 asks for: no auth, tells "unreachable" from "forbidden". */
export type HealthProbe = { ok: true; protocol: number; machine: string } | { ok: false; kind: "unreachable" | "forbidden" | "bad_response"; message: string };

export function healthProbe(fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>, baseUrl: string): Promise<HealthProbe> {
  const url = `${baseUrl.replace(/\/+$/, "")}/health`;
  return fetchImpl(url).then(
    async (response) => {
      if (response.status === 403) return { ok: false as const, kind: "forbidden" as const, message: "Bridge refused this phone's identity (403)." };
      if (!response.ok) return { ok: false as const, kind: "bad_response" as const, message: `Health check returned HTTP ${response.status}.` };
      try {
        const body = await response.json();
        if (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
          const protocol = Number((body as { protocol?: unknown }).protocol);
          const machine = String((body as { machine?: unknown }).machine ?? "");
          if (Number.isFinite(protocol) && machine) return { ok: true as const, protocol, machine };
        }
        return { ok: false as const, kind: "bad_response" as const, message: "The health reply did not look like a Herdr bridge." };
      } catch {
        return { ok: false as const, kind: "bad_response" as const, message: "The health reply was not JSON." };
      }
    },
    (error: unknown) => ({ ok: false as const, kind: "unreachable" as const, message: describeSocketFailure(error instanceof Error ? error.message : String(error)) }),
  );
}
