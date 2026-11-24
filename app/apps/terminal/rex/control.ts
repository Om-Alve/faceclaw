/**
 * One control connection to a Rex server. It runs the hello and welcome
 * handshake, keeps the newest reconnect token, matches responses to requests,
 * keeps a model of every session's view, passes block events on, and sends
 * input one request at a time. Sockets and timers are injected.
 */
import {
  RexMethod,
  REX_API_REVISION,
  REX_CONTROL_SUBPROTOCOL,
  buildHello,
  buildRequest,
  parseBootstrap,
  parseServerMessage,
  parseSessionView,
  type RexBlockEvent,
  type RexClientInfo,
  type RexEvent,
  type RexSessionView,
  type RexWelcome,
} from "./protocol";

// The same backoff as the Terminal worker's control reconnects (RECONNECT_*_DELAY_MS in terminal-app.worker.ts).
export const REX_RECONNECT_MIN_DELAY_MS = 1_000;
export const REX_RECONNECT_MAX_DELAY_MS = 60_000;
export const REX_CALL_TIMEOUT_MS = 10_000;
export const REX_HANDSHAKE_TIMEOUT_MS = 10_000;

const CLOSE_NORMAL = 1000;
const CLOSE_REASON = "faceclaw closing";
const CLOSE_POLICY_VIOLATION = 1008;
const NO_COMMON_REVISION_REASON = "no common API revision";
const SESSION_NOT_FOUND = "session_not_found";

export type RexSocketHandlers = {
  onOpen(): void;
  onMessage(text: string): void;
  /** Called once, when the socket closes or fails to open. */
  onClose(code: number, reason: string): void;
};

export type RexSocket = {
  /** False when the message was refused. */
  send(text: string): boolean;
  close(code: number, reason: string): void;
};

export type RexSocketFactory = (url: string, subprotocol: string, handlers: RexSocketHandlers) => RexSocket;

export type RexTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type RexControlOptions = {
  /** The control endpoint, such as ws://127.0.0.1:8792/api/control. */
  url: string;
  client: RexClientInfo;
  createSocket: RexSocketFactory;
  timers: RexTimers;
  log?: (line: string) => void;
};

export type RexControlState =
  | { phase: "idle" }
  | { phase: "connecting"; attempt: number }
  | { phase: "awaiting-welcome"; attempt: number }
  | { phase: "syncing"; attempt: number; clientId: string | null; resumed: boolean }
  | { phase: "ready"; clientId: string | null; resumed: boolean }
  | { phase: "backoff"; attempt: number; delayMs: number; reason: string }
  /** Retrying can't help, such as when the server shares no API revision with this client. */
  | { phase: "failed"; reason: string };

export type RexCallFailure =
  | { kind: "server"; code: string; status: number; message: string }
  /** No response in time. The server may have run the request. */
  | { kind: "timeout" }
  /** The connection closed before the response. The server may have run the request. */
  | { kind: "disconnected" }
  | { kind: "not-ready" };

export class RexCallError extends Error {
  constructor(
    readonly method: string,
    readonly failure: RexCallFailure,
  ) {
    super(describeFailure(method, failure));
    this.name = "RexCallError";
  }
}

export type RexKeyPress = {
  key: string;
  mods: string;
  consumed_mods: string;
  text: string;
  unshifted_codepoint: number;
  composing: boolean;
  action: string;
};

export type RexInput =
  | { kind: "write"; sessionId: string; blockId: string; data: string }
  | { kind: "paste"; sessionId: string; blockId: string; text: string }
  | { kind: "key"; sessionId: string; blockId: string; key: RexKeyPress };

export type RexKnownBlockEvent = Exclude<RexBlockEvent, { name: "other" }>;
export type RexBlockNotice = { sessionId: string; blockId: string; event: RexKnownBlockEvent };

type Settled = { status: "ok"; payload: unknown; seq: number } | { status: "error"; error: RexCallError };

type Pending = { method: string; settle: (result: Settled) => void; timer: unknown };

type Link = { socket: RexSocket | null; pending: Map<string, Pending> };

type Track = { view: RexSessionView | null; wantRevision: number; fetching: boolean };

type Held = { seq: number; event: RexEvent };

type Sync = { stage: "bootstrap"; held: Held[] } | { stage: "views"; tracks: Map<string, Track> };

type State =
  | { phase: "idle" }
  | { phase: "connecting" | "awaiting-welcome"; attempt: number; link: Link; handshakeTimer: unknown }
  | { phase: "syncing"; attempt: number; link: Link; welcome: RexWelcome; sync: Sync }
  | { phase: "ready"; link: Link; welcome: RexWelcome; tracks: Map<string, Track> }
  | { phase: "backoff"; attempt: number; delayMs: number; reason: string; timer: unknown }
  | { phase: "failed"; reason: string };

type QueuedInput = { input: RexInput; resolve: () => void; reject: (error: RexCallError) => void };

export class RexControl {
  private current: State = { phase: "idle" };
  private reconnectToken: string | null = null;
  private nextRequestId = 1;
  private sessionViews: readonly RexSessionView[] = [];
  private readonly inputQueue: QueuedInput[] = [];
  private inputBusy = false;
  private readonly stateListeners = new Set<(state: RexControlState) => void>();
  private readonly modelListeners = new Set<(sessions: readonly RexSessionView[]) => void>();
  private readonly blockListeners = new Set<(notice: RexBlockNotice) => void>();
  private readonly log: (line: string) => void;

  constructor(private readonly options: RexControlOptions) {
    this.log = options.log ?? (() => {});
  }

  state(): RexControlState {
    const state = this.current;
    switch (state.phase) {
      case "idle":
        return { phase: "idle" };
      case "connecting":
      case "awaiting-welcome":
        return { phase: state.phase, attempt: state.attempt };
      case "syncing":
        return { phase: "syncing", attempt: state.attempt, clientId: state.welcome.client?.id ?? null, resumed: state.welcome.client?.resumed ?? false };
      case "ready":
        return { phase: "ready", clientId: state.welcome.client?.id ?? null, resumed: state.welcome.client?.resumed ?? false };
      case "backoff":
        return { phase: "backoff", attempt: state.attempt, delayMs: state.delayMs, reason: state.reason };
      case "failed":
        return { phase: "failed", reason: state.reason };
    }
  }

  /** Every session's view, in the order the server listed them. Updated only while ready, so a reconnect shows the last model until the new one is complete. */
  sessions(): readonly RexSessionView[] {
    return this.sessionViews;
  }

  onStateChange(listener: (state: RexControlState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onModelChange(listener: (sessions: readonly RexSessionView[]) => void): () => void {
    this.modelListeners.add(listener);
    return () => this.modelListeners.delete(listener);
  }

  onBlockEvent(listener: (notice: RexBlockNotice) => void): () => void {
    this.blockListeners.add(listener);
    return () => this.blockListeners.delete(listener);
  }

  start(): void {
    if (this.current.phase !== "idle" && this.current.phase !== "failed") return;
    this.connect(0);
  }

  stop(): void {
    if (this.current.phase === "idle") return;
    this.leave({ phase: "idle" });
    if (this.sessionViews.length) {
      this.sessionViews = [];
      this.emitModel();
    }
  }

  /** Call a method. Rejects with RexCallError. */
  call(method: string, payload?: unknown): Promise<unknown> {
    const state = this.current;
    if (state.phase !== "ready") return Promise.reject(new RexCallError(method, { kind: "not-ready" }));
    return new Promise((resolve, reject) => {
      this.send(state.link, method, payload, (result) => (result.status === "ok" ? resolve(result.payload) : reject(result.error)));
    });
  }

  /**
   * Send input after every earlier input has its response. The server runs
   * terminal writes and block events in different orders, so only this keeps
   * typing in order. A failed or timed-out input is never sent again.
   */
  sendInput(input: RexInput): Promise<void> {
    if (this.current.phase !== "ready") return Promise.reject(new RexCallError(inputMethod(input), { kind: "not-ready" }));
    return new Promise((resolve, reject) => {
      this.inputQueue.push({ input, resolve, reject });
      this.pumpInput();
    });
  }

  private pumpInput(): void {
    const state = this.current;
    if (this.inputBusy || state.phase !== "ready") return;
    const next = this.inputQueue.shift();
    if (!next) return;
    this.inputBusy = true;
    this.send(state.link, inputMethod(next.input), inputPayload(next.input), (result) => {
      this.inputBusy = false;
      if (result.status === "ok") next.resolve();
      else next.reject(result.error);
      this.pumpInput();
    });
  }

  private connect(attempt: number): void {
    const link: Link = { socket: null, pending: new Map() };
    const handshakeTimer = this.options.timers.setTimeout(() => this.drop(link, "no welcome in time"), REX_HANDSHAKE_TIMEOUT_MS);
    this.setState({ phase: "connecting", attempt, link, handshakeTimer });
    try {
      link.socket = this.options.createSocket(this.options.url, REX_CONTROL_SUBPROTOCOL, {
        onOpen: () => this.handleOpen(link),
        onMessage: (text) => this.handleMessage(link, text),
        onClose: (code, reason) => this.drop(link, `closed ${code} ${reason}`.trim(), code),
      });
    } catch (error) {
      this.drop(link, error instanceof Error ? error.message : String(error));
    }
  }

  private isCurrent(link: Link): boolean {
    return "link" in this.current && this.current.link === link;
  }

  private handleOpen(link: Link): void {
    const state = this.current;
    if (state.phase !== "connecting" || state.link !== link) return;
    const hello = JSON.stringify(buildHello(this.options.client, this.reconnectToken));
    if (!link.socket?.send(hello)) {
      this.drop(link, "hello refused by the socket");
      return;
    }
    this.setState({ ...state, phase: "awaiting-welcome" });
  }

  private handleMessage(link: Link, text: string): void {
    if (!this.isCurrent(link)) return;
    const message = parseServerMessage(text);
    switch (message.type) {
      case "invalid":
        this.log(`rex: ignored a malformed message: ${message.reason}`);
        return;
      case "skip":
        return;
      case "welcome":
        this.handleWelcome(link, message.welcome);
        return;
      case "response": {
        const pending = link.pending.get(message.id);
        if (!pending) return;
        link.pending.delete(message.id);
        this.options.timers.clearTimeout(pending.timer);
        const outcome = message.outcome;
        pending.settle(
          outcome.status === "ok"
            ? { status: "ok", payload: outcome.payload, seq: message.seq }
            : { status: "error", error: new RexCallError(pending.method, { kind: "server", ...outcome.error }) },
        );
        return;
      }
      case "event":
        this.handleEvent(message.seq, message.event);
        return;
    }
  }

  private handleWelcome(link: Link, welcome: RexWelcome): void {
    const state = this.current;
    if (state.phase !== "awaiting-welcome" || state.link !== link) return;
    this.options.timers.clearTimeout(state.handshakeTimer);
    if (welcome.protocol !== REX_CONTROL_SUBPROTOCOL || welcome.apiRevision !== REX_API_REVISION) {
      this.leave({ phase: "failed", reason: `server speaks ${welcome.protocol} at API revision ${welcome.apiRevision}` });
      return;
    }
    if (welcome.client) this.reconnectToken = welcome.client.reconnectToken;
    this.log(`rex: welcome protocol=${welcome.protocol} api_revision=${welcome.apiRevision} client=${welcome.client?.id ?? "none"} resumed=${welcome.client?.resumed ?? false}`);
    this.setState({ phase: "syncing", attempt: state.attempt, link, welcome, sync: { stage: "bootstrap", held: [] } });
    this.send(link, RexMethod.bootstrap, { event_scope: "all", attach_session_ids: [] }, (result) => this.handleBootstrap(link, result));
  }

  private handleBootstrap(link: Link, result: Settled): void {
    const state = this.current;
    if (state.phase !== "syncing" || state.link !== link || state.sync.stage !== "bootstrap") return;
    if (result.status === "error") {
      this.drop(link, `bootstrap failed: ${result.error.message}`);
      return;
    }
    let sessionIds: string[];
    try {
      sessionIds = parseBootstrap(result.payload).sessions.map((session) => session.sessionId);
    } catch (error) {
      this.drop(link, `bootstrap result malformed: ${String(error)}`);
      return;
    }
    const held = state.sync.held;
    const tracks = new Map<string, Track>(sessionIds.map((id) => [id, { view: null, wantRevision: 0, fetching: false }]));
    this.setState({ ...state, sync: { stage: "views", tracks } });
    for (const id of tracks.keys()) this.refreshView(link, tracks, id);
    for (const { seq, event } of held) if (seq > result.seq) this.applyEvent(link, tracks, event);
    this.modelChanged();
  }

  private handleEvent(seq: number, event: RexEvent): void {
    const state = this.current;
    if (state.phase === "syncing" && state.sync.stage === "bootstrap") state.sync.held.push({ seq, event });
    else if (state.phase === "syncing" && state.sync.stage === "views") this.applyEvent(state.link, state.sync.tracks, event);
    else if (state.phase === "ready") this.applyEvent(state.link, state.tracks, event);
  }

  private applyEvent(link: Link, tracks: Map<string, Track>, event: RexEvent): void {
    switch (event.name) {
      case "session_created":
        if (!tracks.has(event.sessionId)) tracks.set(event.sessionId, { view: null, wantRevision: 0, fetching: false });
        this.refreshView(link, tracks, event.sessionId);
        return;
      case "session_destroyed":
        if (tracks.delete(event.sessionId)) this.modelChanged();
        return;
      case "session_event": {
        const inner = event.event;
        if (inner.name === "session_view_changed") {
          const track = tracks.get(event.sessionId);
          if (!track) return;
          track.wantRevision = Math.max(track.wantRevision, inner.revision);
          this.refreshView(link, tracks, event.sessionId);
        } else if (inner.name === "block" && inner.event.name !== "other") {
          const notice: RexBlockNotice = { sessionId: event.sessionId, blockId: inner.blockId, event: inner.event };
          for (const listener of [...this.blockListeners]) listener(notice);
        }
        return;
      }
      case "other":
        return;
    }
  }

  /** Fetch a session's view unless one is in flight or the view already has the newest revision seen. */
  private refreshView(link: Link, tracks: Map<string, Track>, sessionId: string): void {
    const track = tracks.get(sessionId);
    if (!track || track.fetching) return;
    if (track.view && track.wantRevision <= track.view.revision) return;
    track.fetching = true;
    this.send(link, RexMethod.view, { session_id: sessionId }, (result) => {
      track.fetching = false;
      if (!this.isCurrent(link) || tracks.get(sessionId) !== track) return;
      if (result.status === "error") {
        const failure = result.error.failure;
        if (failure.kind === "server" && failure.code === SESSION_NOT_FOUND) {
          tracks.delete(sessionId);
          this.modelChanged();
        } else {
          this.drop(link, `session.view failed: ${result.error.message}`);
        }
        return;
      }
      let view: RexSessionView;
      try {
        view = parseSessionView(result.payload);
      } catch (error) {
        this.drop(link, `session.view result malformed: ${String(error)}`);
        return;
      }
      if (!track.view || view.revision > track.view.revision) track.view = view;
      this.refreshView(link, tracks, sessionId);
      this.modelChanged();
    });
  }

  private modelChanged(): void {
    const state = this.current;
    if (state.phase === "syncing" && state.sync.stage === "views") {
      const tracks = state.sync.tracks;
      for (const track of tracks.values()) if (!track.view || track.fetching) return;
      this.sessionViews = viewsOf(tracks);
      this.setState({ phase: "ready", link: state.link, welcome: state.welcome, tracks });
      this.emitModel();
      this.pumpInput();
    } else if (state.phase === "ready") {
      this.commitModel(state.tracks);
    }
  }

  private commitModel(tracks: Map<string, Track>): void {
    const views = viewsOf(tracks);
    const same = views.length === this.sessionViews.length && views.every((view, index) => view === this.sessionViews[index]);
    if (same) return;
    this.sessionViews = views;
    this.emitModel();
  }

  private send(link: Link, method: string, payload: unknown, settle: (result: Settled) => void): void {
    const id = String(this.nextRequestId++);
    if (!link.socket?.send(JSON.stringify(buildRequest(id, method, payload)))) {
      settle({ status: "error", error: new RexCallError(method, { kind: "disconnected" }) });
      return;
    }
    const timer = this.options.timers.setTimeout(() => {
      link.pending.delete(id);
      settle({ status: "error", error: new RexCallError(method, { kind: "timeout" }) });
    }, REX_CALL_TIMEOUT_MS);
    link.pending.set(id, { method, settle, timer });
  }

  /** The connection is lost or unusable: close it and retry after the backoff, or stop retrying if retrying can't help. */
  private drop(link: Link, reason: string, closeCode?: number): void {
    const state = this.current;
    if (!("link" in state) || state.link !== link) return;
    this.log(`rex: connection lost: ${reason}`);
    if (closeCode === CLOSE_POLICY_VIOLATION && reason.includes(NO_COMMON_REVISION_REASON)) {
      this.leave({ phase: "failed", reason });
      return;
    }
    const attempt = (state.phase === "ready" ? 0 : state.attempt) + 1;
    const delayMs = Math.min(REX_RECONNECT_MAX_DELAY_MS, REX_RECONNECT_MIN_DELAY_MS * 2 ** (attempt - 1));
    const timer = this.options.timers.setTimeout(() => {
      if (this.current.phase === "backoff" && this.current.timer === timer) this.connect(attempt);
    }, delayMs);
    this.leave({ phase: "backoff", attempt, delayMs, reason, timer });
  }

  /** Move to a phase without a connection, closing the current one and failing everything that waited on it. */
  private leave(next: State): void {
    const previous = this.current;
    if (previous.phase === "connecting" || previous.phase === "awaiting-welcome") this.options.timers.clearTimeout(previous.handshakeTimer);
    if (previous.phase === "backoff") this.options.timers.clearTimeout(previous.timer);
    this.setState(next);
    if (!("link" in previous)) return;
    const link = previous.link;
    try {
      link.socket?.close(CLOSE_NORMAL, CLOSE_REASON);
    } catch {
      // The socket may already be closed.
    }
    const pending = [...link.pending.values()];
    link.pending.clear();
    for (const entry of pending) {
      this.options.timers.clearTimeout(entry.timer);
      entry.settle({ status: "error", error: new RexCallError(entry.method, { kind: "disconnected" }) });
    }
    for (const queued of this.inputQueue.splice(0)) queued.reject(new RexCallError(inputMethod(queued.input), { kind: "disconnected" }));
  }

  private setState(next: State): void {
    const changed = next.phase !== this.current.phase;
    this.current = next;
    if (!changed) return;
    const snapshot = this.state();
    for (const listener of [...this.stateListeners]) listener(snapshot);
  }

  private emitModel(): void {
    const sessions = this.sessionViews;
    for (const listener of [...this.modelListeners]) listener(sessions);
  }
}

function viewsOf(tracks: Map<string, Track>): RexSessionView[] {
  return [...tracks.values()].flatMap((track) => (track.view ? [track.view] : []));
}

function inputMethod(input: RexInput): string {
  return input.kind === "write" ? RexMethod.terminalWrite : RexMethod.blockEvent;
}

function inputPayload(input: RexInput): unknown {
  const target = { session_id: input.sessionId, block_id: input.blockId };
  switch (input.kind) {
    case "write":
      return { ...target, args: { data: input.data } };
    case "paste":
      return { ...target, event: { type: "paste", payload: { text: input.text } } };
    case "key":
      return { ...target, event: { type: "key", payload: input.key } };
  }
}

function describeFailure(method: string, failure: RexCallFailure): string {
  switch (failure.kind) {
    case "server":
      return `${method}: ${failure.code} (${failure.status}): ${failure.message}`;
    case "timeout":
      return `${method}: no response in ${REX_CALL_TIMEOUT_MS} ms; it may have run`;
    case "disconnected":
      return `${method}: the connection closed before a response; it may have run`;
    case "not-ready":
      return `${method}: not connected`;
  }
}
