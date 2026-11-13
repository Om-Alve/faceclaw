/**
 * Pure Herdr domain model: pane identities, urgency, workspace grouping, hub
 * rows, read markers, drafts, send actions and machine URLs. No NativeScript,
 * no drawing, no sockets — the worker paints from this and the tests exercise
 * it directly.
 *
 * Ported from the herdr-even plugin's model rules (urgency, grouping, row
 * labels) with the design/herdr/PLAN.md changes: a pane identity that includes
 * the machine, completion-based unread tracking, prompt-bound answers, and a
 * draft with a fixed target.
 */
import type { AgentStatus, AgentSession, ChatEntry, PaneSummary, QueueSummary, Snippet, SubagentSummary } from "./protocol";

/** A pane from one machine. `machineId` is the local machine record id. */
export type PaneRef = {
  machineId: string;
  /** Display label ("mac", "oms-macbook-pro"); the record's label or hello.machine. */
  machine: string;
  pane: PaneSummary;
};

/** Selection/read key: one bridge pane slot on one machine. */
export const paneKey = (machineId: string, paneId: string): string => `${machineId}|${paneId}`;
export const refKey = (ref: PaneRef): string => paneKey(ref.machineId, ref.pane.id);

/**
 * Full identity, including the terminal and agent session where the bridge
 * reports them. Two panes with the same full key are the same terminal with the
 * same conversation; a reused bridge pane ID behind a new terminal is not.
 */
export function fullPaneKey(ref: PaneRef): string {
  return `${refKey(ref)}|${ref.pane.terminalId ?? ""}|${ref.pane.agentSession?.value ?? ""}`;
}

/** seen[key] = the completion/change sequence the wearer has read. */
export type ReadMarkers = Record<string, number>;

/** What marks a completed pane unread: protocol 3's completion sequence, else protocol 2's state sequence. */
export const completionIdentity = (pane: PaneSummary): number => pane.completionSeq ?? pane.stateSeq;

/**
 * Read identity: the pane slot plus its terminal, since a replaced terminal is
 * a different conversation. Protocol 2 has no terminal id, so the key falls
 * back to the slot and stays compatible with markers already stored.
 */
export function readKey(ref: PaneRef): string {
  const base = refKey(ref);
  return ref.pane.terminalId ? `${base}|${ref.pane.terminalId}` : base;
}

export function isDoneUnseen(ref: PaneRef, markers: ReadMarkers): boolean {
  return ref.pane.status === "done" && markers[readKey(ref)] !== completionIdentity(ref.pane);
}

/** blocked 0 -> done-and-unseen 1 -> working 2 -> idle agents (incl. seen done) 3 -> other panes 4. */
export function urgency(ref: PaneRef, markers: ReadMarkers): number {
  const pane = ref.pane;
  if (pane.status === "blocked") return 0;
  if (isDoneUnseen(ref, markers)) return 1;
  if (pane.status === "working") return 2;
  if (pane.agent && (pane.status === "idle" || pane.status === "done")) return 3;
  return 4;
}

export function sortPanes(refs: readonly PaneRef[], markers: ReadMarkers): PaneRef[] {
  return [...refs].sort(
    (a, b) =>
      urgency(a, markers) - urgency(b, markers) ||
      a.machine.localeCompare(b.machine) ||
      a.pane.workspace.localeCompare(b.pane.workspace) ||
      a.pane.tab.localeCompare(b.pane.tab) ||
      a.pane.id.localeCompare(b.pane.id, undefined, { numeric: true }),
  );
}

const STATUS_LABEL: Record<AgentStatus, string> = { idle: "IDLE", working: "WORKING", blocked: "BLOCKED", done: "DONE", unknown: "" };
export const statusLabel = (status: AgentStatus): string => STATUS_LABEL[status] ?? "";

/** `[machine/]workspace · agent-or-title · STATUS[ · N sub]`. */
export function rowLabel(ref: PaneRef, multiMachine: boolean, withStatus = true): string {
  const pane = ref.pane;
  const workspace = (multiMachine ? `${ref.machine}/` : "") + pane.workspace;
  const tail = [pane.agent ?? (pane.title || "shell")];
  const status = withStatus ? statusLabel(pane.status) : "";
  if (status) tail.push(status);
  if (withStatus && pane.subagents > 0) tail.push(`${pane.subagents} sub`);
  return oneLine(`${workspace} · ${tail.join(" · ")}`);
}

/** Header line for the pane reader: `agent · STATUS · machine/workspace`. */
export function chatHeader(ref: PaneRef | undefined, multiMachine: boolean): string {
  if (!ref) return "pane gone";
  const pane = ref.pane;
  const status = statusLabel(pane.status);
  const where = (multiMachine ? `${ref.machine}/` : "") + pane.workspace;
  return oneLine([pane.agent ?? (pane.title || "shell"), status, where].filter(Boolean).join(" · "));
}

export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- subagents

/** Working subagents first, then newest (lastActivity, then later in the list). */
export function sortSubagents(subagents: readonly SubagentSummary[]): SubagentSummary[] {
  return subagents
    .map((subagent, index) => ({ subagent, index }))
    .sort(
      (a, b) =>
        (a.subagent.status === "working" ? 0 : 1) - (b.subagent.status === "working" ? 0 : 1) ||
        (b.subagent.lastActivity ?? 0) - (a.subagent.lastActivity ?? 0) ||
        b.index - a.index,
    )
    .map(({ subagent }) => subagent);
}

export const subStatus = (status: SubagentSummary["status"]): string => (status === "unknown" ? "" : status.toUpperCase());

/** `label · STATUS · description`. */
export function subRow(subagent: SubagentSummary): string {
  return oneLine([subagent.label, subStatus(subagent.status), subagent.description].filter(Boolean).join(" · "));
}

/** Header of a subagent view: `↳ label · STATUS · workspace`. */
export function subHeader(subagent: SubagentSummary | undefined, ref: PaneRef | undefined, multiMachine: boolean): string {
  const workspace = ref ? (multiMachine ? `${ref.machine}/` : "") + ref.pane.workspace : "";
  return oneLine(["↳ " + (subagent?.label ?? "subagent"), subagent ? subStatus(subagent.status) : "", workspace].filter(Boolean).join(" · "));
}

// ---------------------------------------------------------------- workspaces

export type WorkspaceGroup = {
  key: string;
  machineId: string;
  machine: string;
  session: string;
  workspace: string;
  /** Most urgent first. */
  refs: PaneRef[];
  /** The pane whose status is the workspace rollup. */
  top: PaneRef;
  urgency: number;
  /** Working subagents summed over the group's panes. */
  subagents: number;
};

export const workspaceKey = (machineId: string, session: string, workspace: string): string => `${machineId}|${session}|${workspace}`;

export function groupWorkspaces(refs: readonly PaneRef[], markers: ReadMarkers): WorkspaceGroup[] {
  const byKey = new Map<string, PaneRef[]>();
  for (const ref of sortPanes(refs, markers)) {
    const key = workspaceKey(ref.machineId, ref.pane.session, ref.pane.workspace);
    const group = byKey.get(key);
    if (group) group.push(ref);
    else byKey.set(key, [ref]);
  }
  const groups: WorkspaceGroup[] = [];
  for (const [key, groupRefs] of byKey) {
    const top = groupRefs[0]!;
    groups.push({
      key,
      machineId: top.machineId,
      machine: top.machine,
      session: top.pane.session,
      workspace: top.pane.workspace,
      refs: groupRefs,
      top,
      urgency: urgency(top, markers),
      subagents: groupRefs.reduce((total, ref) => total + (ref.pane.subagents || 0), 0),
    });
  }
  return groups.sort(
    (a, b) =>
      a.urgency - b.urgency ||
      a.machine.localeCompare(b.machine) ||
      a.workspace.localeCompare(b.workspace) ||
      a.session.localeCompare(b.session),
  );
}

/** `[machine/]workspace · STATUS · n panes[ · N working][ · N sub]`. */
export function workspaceRowLabel(group: WorkspaceGroup, multiMachine: boolean): string {
  const workspace = (multiMachine ? `${group.machine}/` : "") + group.workspace;
  const working = group.refs.filter((ref) => ref.pane.status === "working").length;
  const status = statusLabel(group.top.pane.status);
  const tail = [status, `${group.refs.length} pane${group.refs.length === 1 ? "" : "s"}`];
  if (working) tail.push(`${working} working`);
  if (group.subagents > 0) tail.push(`${group.subagents} sub`);
  return oneLine(`${workspace} · ${tail.filter(Boolean).join(" · ")}`);
}

/** `agent-or-title · STATUS[ · N sub]` on the workspace screen. */
export function paneRowLabel(ref: PaneRef): string {
  const pane = ref.pane;
  const tail = [pane.agent ?? (pane.title || "shell")];
  const status = statusLabel(pane.status);
  if (status) tail.push(status);
  if (pane.subagents > 0) tail.push(`${pane.subagents} sub`);
  return oneLine(tail.join(" · "));
}

export const rollupLabel = (group: WorkspaceGroup): string => statusLabel(group.top.pane.status);

// ---------------------------------------------------------------- hub rows

export type HubRow =
  | { kind: "heading"; key: string; label: string }
  | { kind: "tag"; key: string; label: string }
  | { kind: "pane"; key: string; ref: PaneRef }
  | { kind: "workspace"; key: string; group: WorkspaceGroup };

export type Hub = {
  rows: HubRow[];
  needsYou: PaneRef[];
  groups: WorkspaceGroup[];
};

/**
 * The hub's rows: panes needing the wearer (blocked or done-unseen) first, then
 * workspaces across every machine. A workspace with one pane still appears as a
 * workspace row; the caller opens its pane directly.
 */
export function buildHub(refs: readonly PaneRef[], markers: ReadMarkers, _multiMachine: boolean): Hub {
  const needsYou = sortPanes(refs, markers).filter((ref) => {
    if (ref.pane.status === "blocked") return true;
    return isDoneUnseen(ref, markers);
  });
  const groups = groupWorkspaces(refs, markers);
  const rows: HubRow[] = [];
  if (needsYou.length) {
    rows.push({ kind: "heading", key: "heading:needs", label: "Needs you" });
    for (const ref of needsYou) {
      rows.push({ kind: "pane", key: `needs:${refKey(ref)}`, ref });
    }
  }
  if (groups.length) {
    rows.push({ kind: "heading", key: "heading:workspaces", label: "Workspaces" });
    for (const group of groups) {
      rows.push({ kind: "workspace", key: `ws:${group.key}`, group });
    }
  } else if (!needsYou.length) {
    rows.push({ kind: "tag", key: "empty", label: "No panes yet" });
  }
  return { rows, needsYou, groups };
}

/** Count of panes the hub calls out as needing the wearer. */
export const needingCount = (hub: Hub): number => hub.needsYou.length;

// ---------------------------------------------------------------- read markers

/** Whether a pane view has reached its live tail, which clears a completion marker. */
export function markRead(markers: ReadMarkers, ref: PaneRef): ReadMarkers {
  const key = readKey(ref);
  const identity = completionIdentity(ref.pane);
  if (markers[key] === identity) return markers;
  return { ...markers, [key]: identity };
}

/** Keeping only the newest markers keeps the settings value bounded. */
export function pruneReadMarkers(markers: ReadMarkers, refs: readonly PaneRef[], limit = 200): ReadMarkers {
  const live = new Set(refs.map(readKey));
  const kept: ReadMarkers = {};
  for (const [key, value] of Object.entries(markers)) if (live.has(key)) kept[key] = value;
  const entries = Object.entries(kept);
  if (entries.length <= limit) return kept;
  return Object.fromEntries(entries.slice(-limit));
}

// ---------------------------------------------------------------- drafts and sends

export type DraftTarget = {
  machineId: string;
  machine: string;
  /** Bridge pane id. */
  paneId: string;
  /** Protocol 3's terminal identity, when known. */
  terminalId?: string;
  /** The agent conversation the text is for, when known. */
  agentSession?: AgentSession | null;
  /** The prompt revision an answer is bound to. */
  promptRevision?: string;
  /** The prompt text the wearer saw for that revision. */
  promptText?: string;
};

export type Draft = { target: DraftTarget; text: string };

export function draftTarget(ref: PaneRef, prompt?: { text: string; revision: string } | null): DraftTarget {
  return {
    machineId: ref.machineId,
    machine: ref.machine,
    paneId: ref.pane.id,
    terminalId: ref.pane.terminalId,
    agentSession: ref.pane.agentSession ?? null,
    promptRevision: prompt?.revision,
    promptText: prompt?.text,
  };
}

export type DraftProblem = "pane_gone" | "terminal_changed" | "session_changed" | "prompt_changed" | "offline";

/**
 * Revalidate a draft against the pane it names before enabling Send. Text is
 * never silently retargeted: a changed terminal or agent session leaves the
 * draft intact and asks the wearer to choose again.
 */
export function validateDraft(draft: Draft, current: PaneRef | undefined, online: boolean, promptText?: string | null): DraftProblem | null {
  if (!online) return "offline";
  if (!current || current.pane.id !== draft.target.paneId || current.machineId !== draft.target.machineId) return "pane_gone";
  if (draft.target.terminalId && current.pane.terminalId && draft.target.terminalId !== current.pane.terminalId) return "terminal_changed";
  const before = draft.target.agentSession?.value ?? null;
  const now = current.pane.agentSession?.value ?? null;
  if (before && before !== now) return "session_changed";
  if (draft.target.promptRevision && promptText !== undefined && promptText !== null && normalizeForCompare(promptText) !== normalizeForCompare(draft.target.promptText ?? "")) {
    return "prompt_changed";
  }
  return null;
}

const normalizeForCompare = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();

/** What a tap on a pane opens. */
export type PrimaryAction = "answer" | "compose" | "command" | "read";

export function primaryAction(pane: PaneSummary | undefined, readOnly: boolean): PrimaryAction {
  if (!pane || readOnly) return "read";
  if (pane.status === "blocked") return "answer";
  return pane.agent ? "compose" : "command";
}

/** The text-write primitive a pane's kind uses. */
export type WriteMode = "prompt" | "input" | "literal";

export function writeMode(pane: PaneSummary | undefined, kind: "message" | "command" | "type"): WriteMode {
  if (kind === "type") return "literal";
  if (kind === "command") return "input";
  return pane?.agent ? "prompt" : "input";
}

/** Whether a message may be queued: agents while working, never shells, blocked panes or subagents. */
export function canQueue(pane: PaneSummary | undefined, readOnly: boolean): boolean {
  if (readOnly || !pane || !pane.agent) return false;
  return pane.status !== "blocked";
}

/** The label for the queue action, naming what it does for this agent. */
export function sendNowLabel(pane: PaneSummary | undefined): string {
  if (!pane?.agent) return "Run now";
  return pane.status === "working" ? "Send now (mid-turn)" : "Send message";
}

// ---------------------------------------------------------------- keys

export type KeyAction = { label: string; keys: string[] };

/** The pane key palette, in menu order. Every entry is a valid bridge key combo. */
export const KEY_PALETTE: readonly KeyAction[] = [
  { label: "Enter", keys: ["enter"] },
  { label: "Escape", keys: ["esc"] },
  { label: "Ctrl+C", keys: ["ctrl+c"] },
  { label: "Tab", keys: ["tab"] },
  { label: "Shift+Tab", keys: ["shift+tab"] },
  { label: "↑", keys: ["up"] },
  { label: "↓", keys: ["down"] },
  { label: "←", keys: ["left"] },
  { label: "→", keys: ["right"] },
  { label: "y", keys: ["y"] },
  { label: "n", keys: ["n"] },
  { label: "1", keys: ["1"] },
  { label: "2", keys: ["2"] },
  { label: "3", keys: ["3"] },
];

/** Snippets from the bridge plus the built-in palette, deduplicated by label. */
export function snippetActions(snippets: readonly Snippet[]): Array<{ label: string; keys?: string[]; text?: string; enter?: boolean }> {
  return snippets.filter((snippet) => (snippet.keys?.length ?? 0) > 0 || snippet.text !== undefined);
}

// ---------------------------------------------------------------- transcript cleanup

/** Happy's transcript skip list, applied to raw system records the bridge may pass through. */
const SKIPPED_RECORD_TYPES = new Set(["file-history-snapshot", "change", "queue-operation"]);

/**
 * Drop records that carry no conversation: raw JSON of the types Happy skips,
 * empty text and ANSI-only leftovers. Normalizes line endings and trailing
 * whitespace so the reader's line wrapping is stable.
 */
export function cleanEntries<T extends { kind: string; text: string }>(entries: readonly T[]): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    const text = entry.text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
    if (!text.trim()) continue;
    if (entry.kind === "system" && isSkippedRecord(text)) continue;
    out.push(text === entry.text ? entry : { ...entry, text });
  }
  return out;
}

function isSkippedRecord(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return typeof parsed.type === "string" && SKIPPED_RECORD_TYPES.has(parsed.type);
  } catch {
    return false;
  }
}

/**
 * Options for a structured question, as numbered keys. Only offered when one
 * question is on screen: with several, the same numbers would answer the first
 * question while the label describes another.
 */
export function questionChoices(entries: readonly ChatEntry[]): Array<{ label: string; keys: string[] }> {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || entry.kind !== "question" || entry.answered) continue;
    const question = entry.questions[0];
    if (entry.questions.length !== 1 || !question) return [];
    return question.options.slice(0, 9).map((label, optionIndex) => ({ label, keys: [String(optionIndex + 1)] }));
  }
  return [];
}

/** Apply chat.update semantics: entries with a known id replace, new ids append. */
export function mergeUpdatedEntries<T extends { id: string }>(entries: readonly T[], updates: readonly T[]): T[] {
  const byId = new Map(updates.map((entry) => [entry.id, entry]));
  let changed = false;
  const next = entries.map((entry) => {
    const update = byId.get(entry.id);
    if (!update) return entry;
    changed = true;
    return update;
  });
  for (const update of updates) {
    if (!entries.some((entry) => entry.id === update.id)) {
      next.push(update);
      changed = true;
    }
  }
  return changed ? next : [...entries];
}

// ---------------------------------------------------------------- queue outcomes

export function queueOutcomeLabel(outcome: "pending" | "accepted" | "canceled" | "undelivered"): string {
  switch (outcome) {
    case "pending":
      return "pending";
    case "accepted":
      return "delivered";
    case "canceled":
      return "canceled";
    case "undelivered":
      return "undelivered";
  }
}

export function queueSummaryText(summary: QueueSummary | undefined): string {
  if (!summary) return "";
  const parts: string[] = [];
  if (summary.pending) parts.push(`${summary.pending} queued`);
  if (summary.undelivered) parts.push(`${summary.undelivered} undelivered`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- machines

export type ParsedBridgeUrl = {
  /** HTTPS base, no trailing slash. */
  baseUrl: string;
  /** WebSocket URL, ending in /ws. */
  wsUrl: string;
  /** host[:port], for a default label. */
  host: string;
};

/**
 * Parse what the wearer types or scans: `https://host`, `https://host/ws`,
 * `wss://host/ws`, `host`, or the bridge's pair URL. Rejects anything with a
 * path other than `/ws`, credentials, queries or spaces.
 */
export function parseBridgeUrl(input: string): ParsedBridgeUrl | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  let text = raw;
  if (/^herdr:\/\//i.test(text)) text = "https://" + text.slice("herdr://".length);
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "https://" + text;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(text);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!;
  const path = (match[3] ?? "").replace(/\/+$/, "");
  let secure: boolean;
  if (scheme === "https" || scheme === "wss") secure = true;
  else if (scheme === "http" || scheme === "ws") secure = false;
  else return null;
  if (authority.includes("@")) return null;
  const hostMatch = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!hostMatch) return null;
  const hostname = hostMatch[1]!;
  const portText = hostMatch[2];
  if (portText !== undefined) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  if (path !== "" && path !== "/ws") return null;
  const host = hostname.toLowerCase() + (portText ? `:${portText}` : "");
  return {
    baseUrl: `${secure ? "https" : "http"}://${host}`,
    wsUrl: `${secure ? "wss" : "ws"}://${host}${path || "/ws"}`,
    host,
  };
}

/** A short, stable local id for a machine URL (not derived from the label the server reports). */
export function machineIdForUrl(parsed: ParsedBridgeUrl): string {
  const slug = parsed.host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return `herdr-${slug || "machine"}`;
}

/** Extract a URL from a scanned QR payload (plain URL, or JSON with a url field). */
export function urlFromQrPayload(payload: string): string | null {
  const text = payload.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of ["url", "bridge", "ws", "origin"]) {
        const value = parsed[key];
        if (typeof value === "string" && parseBridgeUrl(value)) return value;
      }
    } catch {
      return null;
    }
    return null;
  }
  return parseBridgeUrl(text) ? text : null;
}

/**
 * Which machine records are duplicates of an earlier record reporting the same
 * `hello.machine`. The first enabled record wins; duplicates are reported so
 * the worker can stop them instead of showing every pane twice.
 */
export function duplicateMachineIds(order: readonly string[], reported: ReadonlyMap<string, string>): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const id of order) {
    const machine = reported.get(id);
    if (!machine) continue;
    const existing = seen.get(machine);
    if (existing) duplicates.push(id);
    else seen.set(machine, id);
  }
  return duplicates;
}

// ---------------------------------------------------------------- time

export function formatAge(ts: number | undefined, nowMs: number): string {
  if (!ts) return "";
  const seconds = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A bounded number of lines, keeping the tail (the newest output). */
export function tailLines(text: string, limit: number): string[] {
  const lines = text.split("\n");
  return lines.length <= limit ? lines : lines.slice(lines.length - limit);
}
