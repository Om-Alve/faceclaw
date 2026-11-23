import type { G2MirrorHistoryReply, G2MirrorState, TerminalClient } from "../terminal-client";
import type { RexEndpoint } from "./connection-string";
import { probeRex, rexFailureNotice, type RexHttpHead, type RexProbeResult } from "./pairing";

/**
 * A Rex TerminalClient that says why it cannot connect. RexClient retries a
 * lost connection on its own and only ever reports that it is connecting,
 * since the native WebSocket hides the HTTP status of a refused upgrade. On
 * each attempt this wrapper probes the server over plain HTTP. While the probe
 * fails, it reports a failed state that retrying cannot fix, which the
 * Terminal hub shows as a row that reconnects when selected. RexClient keeps
 * retrying underneath, so a server that comes back still connects.
 */
export class RexProbedClient implements TerminalClient {
  /** Set only while the inner client is connecting. */
  private failure: Exclude<RexProbeResult, "reachable"> | null = null;
  private pendingProbe: Promise<RexProbeResult> | null = null;
  private readonly stateListeners = new Set<(state: G2MirrorState) => void>();

  constructor(
    private readonly inner: TerminalClient,
    private readonly endpoint: RexEndpoint,
    private readonly head: RexHttpHead,
  ) {
    inner.onStateChange((state) => {
      if (state.phase === "connecting") {
        this.probe();
      } else {
        this.failure = null;
        this.pendingProbe = null;
      }
      this.emitState();
    });
  }

  state(): G2MirrorState {
    const state = this.inner.state();
    if (!this.failure || state.phase !== "connecting") return state;
    const { line, hint } = rexFailureNotice(this.endpoint, this.failure);
    return { ...state, phase: "failed", status: `${line}. ${hint}.`, retryable: false };
  }

  onStateChange(listener: (state: G2MirrorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** A start while the inner client is already retrying probes again, so a retry from the UI gets a fresh answer. */
  start(): void {
    this.inner.start();
    this.probe();
  }

  stop(): void {
    this.failure = null;
    this.pendingProbe = null;
    this.inner.stop();
  }

  private probe(): void {
    if (this.pendingProbe || this.inner.state().phase !== "connecting") return;
    const probe = probeRex(this.endpoint, this.head);
    this.pendingProbe = probe;
    void probe.then((result) => {
      if (this.pendingProbe !== probe) return;
      this.pendingProbe = null;
      this.failure = result === "reachable" ? null : result;
      this.emitState();
    });
  }

  private emitState(): void {
    const state = this.state();
    for (const listener of [...this.stateListeners]) listener(state);
  }

  onTerminalData(listener: (data: Uint8Array, kind: "snapshot" | "output") => void): () => void {
    return this.inner.onTerminalData(listener);
  }
  onSessionAttached(listener: (command: string) => void): () => void {
    return this.inner.onSessionAttached(listener);
  }
  onSessionDetached(listener: (reason: string) => void): () => void {
    return this.inner.onSessionDetached(listener);
  }
  onBell(listener: (socket: string, lastBellAtMs: number) => void): () => void {
    return this.inner.onBell(listener);
  }
  onActivity(listener: (socket: string, lastOutputAtMs: number) => void): () => void {
    return this.inner.onActivity(listener);
  }
  onTitle(listener: (socket: string, title: string) => void): () => void {
    return this.inner.onTitle(listener);
  }
  onSnapshot(listener: (historyNext: number, historyOldest: number) => void): () => void {
    return this.inner.onSnapshot(listener);
  }
  onHistoryLines(listener: (reply: G2MirrorHistoryReply) => void): () => void {
    return this.inner.onHistoryLines(listener);
  }
  setViewport(cols: number, rows: number): void {
    this.inner.setViewport(cols, rows);
  }
  listSessions(): void {
    this.inner.listSessions();
  }
  launchSession(preset: string): Promise<string> {
    return this.inner.launchSession(preset);
  }
  connectSession(socket: string): void {
    this.inner.connectSession(socket);
  }
  disconnectSession(): void {
    this.inner.disconnectSession();
  }
  view(): void {
    this.inner.view();
  }
  unview(): void {
    this.inner.unview();
  }
  requestHistory(before: number, limit?: number): void {
    this.inner.requestHistory(before, limit);
  }
  sendInput(text: string): void {
    this.inner.sendInput(text);
  }
  submitInput(text: string): void {
    this.inner.submitInput(text);
  }
}
