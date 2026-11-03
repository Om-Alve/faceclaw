/**
 * The herdr-even bridge wire protocol, pinned here so the app never depends on
 * a sibling checkout of the bridge.
 *
 * Transport: one WebSocket per machine at `wss://<machine>.<tailnet>.ts.net/ws`.
 * Framing: one JSON object per text message; requests carry `id` and their
 * reply echoes it. Protocol 2 is what the deployed bridge speaks today;
 * protocol 3 (step 2b of design/herdr/PLAN.md) adds stable terminal identity,
 * prompt-bound answers and per-pane queue summaries. Every protocol-3 field is
 * optional here, so one boundary accepts both.
 *
 * Rules for this file: no NativeScript or DOM imports, no side effects. It is
 * bundled into the worker and compiled by tests/tsconfig.json.
 */

export const PROTOCOL_VERSION = 2;
/** The version that adds terminal identity, prompt-bound answers and queue summaries. */
export const PROTOCOL_VERSION_3 = 3;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Herdr's `agent_session`: the identity of the agent conversation in a pane. */
export type AgentSession = { kind: string; value: string };

export interface PaneSummary {
  /** Unique on this machine: `${session}/${paneId}`, e.g. "default/w1:p1". */
  id: string;
  /** Herdr session name; "default" for `~/.config/herdr/herdr.sock`. */
  session: string;
  /** Herdr pane id within its session, e.g. "w1:p1". */
  paneId: string;
  workspace: string;
  tab: string;
  /** "claude" | "codex" | "cursor" | "opencode" | ...; null when no agent is detected. */
  agent: string | null;
  /** 'unknown' for non-agent panes. */
  status: AgentStatus;
  /** Terminal title, ANSI-free. */
  title: string;
  /** Which source the chat view uses for this pane. */
  chat: "transcript" | "screen";
  /** Number of subagents currently working (0 when none or no adapter). */
  subagents: number;
  /** Herdr `state_change_seq`; protocol 2's change identity. */
  stateSeq: number;
  /**
   * Protocol 3: the terminal instance in the pane. A bridge pane ID names a
   * slot; `terminalId` names the terminal in it, so a replaced terminal is
   * distinguishable behind a reused pane ID. Absent on protocol 2.
   */
  terminalId?: string;
  /** Protocol 3: the agent conversation, when Herdr knows one. */
  agentSession?: AgentSession | null;
  /** Protocol 3: "completed work, independently of who has viewed it". */
  completionSeq?: number;
  /** Protocol 3: the pane is focused in Herdr on its own machine. */
  focused?: boolean;
}

export type ChatEntryKind = "user" | "assistant" | "tool" | "subagent" | "system" | "screen" | "question";

interface EntryBase {
  /** Stable within one pane's chat (transcript record uuid, or "screen"). */
  id: string;
  /** Plain text, no ANSI, may contain newlines. */
  text: string;
  /** Epoch ms, when known. */
  ts?: number;
  /** For kind 'subagent': the SubagentSummary id this entry refers to. */
  subagent?: string;
}

export type ChatEntry =
  | (EntryBase & { kind: Exclude<ChatEntryKind, "question"> })
  | (EntryBase & {
      kind: "question";
      questions: { prompt: string; options: string[] }[];
      answered: boolean;
      reply: "message" | "keys";
    });

export interface SubagentSummary {
  /** Stable within its pane: Claude `agentId`, Codex thread id. */
  id: string;
  /** Claude `agentType` or Codex `agent_nickname`. */
  label: string;
  /** What it was asked to do (short). */
  description: string;
  status: "working" | "done" | "unknown";
  /** Epoch ms of its last transcript activity. */
  lastActivity?: number;
}

export interface QueuedItem {
  /** Unique within the bridge. */
  id: string;
  text: string;
  /** Epoch ms when it was queued. */
  ts: number;
}

export interface QueueSummary {
  /** Bridge pane ID. */
  pane: string;
  /** Items still waiting to be delivered. */
  pending: number;
  /** Items that will never be delivered, with their reason available in the ledger. */
  undelivered: number;
}

export interface Snippet {
  label: string;
  /** Key combos sent via Herdr `pane.send_keys`, e.g. ["ctrl+c"]. */
  keys?: string[];
  /** Literal text sent via Herdr `pane.send_text`. */
  text?: string;
  /** With `text`: also press enter afterwards. */
  enter?: boolean;
}

/** The durable outcome of a queue item, protocol 3. */
export type QueueOutcome = "pending" | "accepted" | "canceled" | "undelivered";

export interface QueueOutcomeEntry {
  id: string;
  text: string;
  ts: number;
  outcome: QueueOutcome;
  /** Why an item was not delivered ("agent session changed", ...). */
  reason?: string;
}

// ---------------------------------------------------------------- server to client

export type ServerMsg =
  | {
      t: "hello";
      protocol: number;
      /** Short machine label (hostname without domain). */
      machine: string;
      herdrVersion: string | null;
      /** Tailscale login of the connected user. */
      user: string | null;
      snippets: Snippet[];
    }
  /** Full pane list, after hello and whenever anything changes (debounced). */
  | { t: "panes"; panes: PaneSummary[] }
  /** Latest window of a pane's chat; replaces everything held for that pane. */
  | {
      t: "chat";
      id?: string;
      pane: string;
      subagent?: string;
      source: "transcript" | "screen";
      entries: ChatEntry[];
      hasOlder: boolean;
    }
  | { t: "chat.append"; pane: string; subagent?: string; entries: ChatEntry[] }
  /** Replace entries with the same ids (screen text changed, a tool result arrived). */
  | { t: "chat.update"; pane: string; subagent?: string; entries: ChatEntry[] }
  | { t: "chat.older"; id: string; pane: string; subagent?: string; entries: ChatEntry[]; hasOlder: boolean }
  /** The open pane's queued messages, oldest first. */
  | { t: "queue"; pane: string; items: QueuedItem[] }
  /** Protocol 3: queue counts for every pane on the machine, not only the open one. */
  | { t: "queue.summary"; panes: QueueSummary[] }
  /** Protocol 3: durable queue outcomes, so a discard survives a reconnect. */
  | { t: "queue.outcomes"; pane: string; items: QueueOutcomeEntry[] }
  /** The open pane's subagents, oldest first. */
  | { t: "subagents"; pane: string; subagents: SubagentSummary[] }
  /** While the open pane is blocked: the cleaned prompt dialog. `null` clears it. */
  | { t: "prompt"; pane: string; text: string | null }
  | { t: "pong"; id: string }
  | { t: "ok"; id: string }
  | { t: "error"; id?: string; code: ErrorCode; message: string };

export type ErrorCode =
  | "bad_request"
  | "unknown_pane"
  | "unknown_subagent"
  | "unknown_item"
  | "key_not_allowed"
  | "herdr_unavailable"
  | "herdr_error"
  | "internal"
  // Protocol 3
  | "stale_prompt"
  | "terminal_changed"
  | "agent_blocked"
  | "queue_closed";

// ---------------------------------------------------------------- client to server

export type ClientMsg =
  | { t: "open"; id: string; pane: string; subagent?: string }
  | { t: "close"; id: string }
  | { t: "older"; id: string; pane: string; subagent?: string; before: string; limit?: number }
  /** Raw keys; protocol 3 also guards against a reused pane ID holding another terminal. */
  | { t: "keys"; id: string; pane: string; keys: string[]; terminalId?: string }
  /**
   * Protocol 2 text write. With `enter` the bridge pauses then presses Enter;
   * with `queue` it holds the text until the agent is idle. `terminalId` is a
   * protocol-3 guard the bridge checks when it understands it.
   */
  | { t: "text"; id: string; pane: string; text: string; enter: boolean; queue?: boolean; terminalId?: string }
  | { t: "unqueue"; id: string; pane: string; item: string }
  | { t: "ping"; id: string }
  | { t: "log"; level: "info" | "warn" | "error"; msg: string; data?: unknown }
  // Protocol 3 typed operations. Each carries the terminal it was composed
  // for, so a request for a replaced terminal is refused before any input.
  | { t: "prompt"; id: string; pane: string; terminalId: string; text: string; queue?: boolean }
  | { t: "run"; id: string; pane: string; terminalId: string; text: string }
  /** Insert literal text without Enter. */
  | { t: "type"; id: string; pane: string; terminalId: string; text: string }
  /** Answer a prompt, bound to the revision the wearer saw. */
  | { t: "answer"; id: string; pane: string; terminalId: string; revision: string; keys: string[] };

/** Key combos the bridge accepts for `keys` (Herdr `pane.send_keys` syntax). */
export const KEY_RE =
  /^(?:(?:ctrl|alt|shift)\+)*(?:enter|esc|tab|backspace|delete|space|up|down|left|right|home|end|pageup|pagedown|minus|f(?:[1-9]|1[0-2])|[a-z0-9])$/;

export const isAllowedKey = (key: string): boolean => KEY_RE.test(key);

/** GET /health → { ok: true, protocol: PROTOCOL_VERSION, machine }. No auth, no pane data. */
export type Health = { ok: true; protocol: number; machine: string };

// ---------------------------------------------------------------- validation

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];
const CHAT_KINDS: readonly ChatEntryKind[] = ["user", "assistant", "tool", "subagent", "system", "screen", "question"];
const SUBAGENT_STATUSES = ["working", "done", "unknown"] as const;

function parseAgentSession(value: unknown): AgentSession | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const kind = str(value.kind);
  const sessionValue = str(value.value);
  return kind !== null && sessionValue !== null ? { kind, value: sessionValue } : undefined;
}

/** Validate one pane summary; unknown-but-well-formed fields are ignored. */
export function parsePaneSummary(value: unknown): PaneSummary | null {
  if (!isObject(value)) return null;
  const id = str(value.id);
  const session = str(value.session);
  const paneId = str(value.paneId);
  const workspace = str(value.workspace);
  const tab = str(value.tab);
  const agent = value.agent === null ? null : str(value.agent);
  const status = str(value.status);
  const title = str(value.title);
  const chat = str(value.chat);
  const subagents = num(value.subagents);
  const stateSeq = num(value.stateSeq);
  if (
    id === null ||
    session === null ||
    paneId === null ||
    workspace === null ||
    tab === null ||
    status === null ||
    !AGENT_STATUSES.includes(status as AgentStatus) ||
    title === null ||
    (chat !== "transcript" && chat !== "screen") ||
    subagents === null ||
    stateSeq === null
  ) {
    return null;
  }
  const pane: PaneSummary = {
    id,
    session,
    paneId,
    workspace,
    tab,
    agent,
    status: status as AgentStatus,
    title,
    chat,
    subagents: Math.max(0, Math.floor(subagents)),
    stateSeq,
  };
  const terminalId = str(value.terminalId);
  if (terminalId !== null && terminalId.length > 0) pane.terminalId = terminalId;
  const agentSession = parseAgentSession(value.agentSession);
  if (agentSession !== undefined) pane.agentSession = agentSession;
  const completionSeq = num(value.completionSeq);
  if (completionSeq !== null) pane.completionSeq = completionSeq;
  const focused = bool(value.focused);
  if (focused !== null) pane.focused = focused;
  return pane;
}

function parseChatEntry(value: unknown): ChatEntry | null {
  if (!isObject(value)) return null;
  const id = str(value.id);
  const text = str(value.text);
  const kind = str(value.kind);
  if (id === null || text === null || kind === null || !CHAT_KINDS.includes(kind as ChatEntryKind)) return null;
  const base: EntryBase = { id, text };
  const ts = num(value.ts);
  if (ts !== null) base.ts = ts;
  const subagent = str(value.subagent);
  if (subagent !== null) base.subagent = subagent;
  if (kind !== "question") return { ...base, kind: kind as Exclude<ChatEntryKind, "question"> };
  const rawQuestions = Array.isArray(value.questions) ? value.questions : [];
  const questions = rawQuestions
    .map((question) => {
      if (!isObject(question)) return null;
      const prompt = str(question.prompt);
      const options = Array.isArray(question.options) ? question.options.filter((option): option is string => typeof option === "string") : [];
      return prompt === null ? null : { prompt, options };
    })
    .filter((question): question is { prompt: string; options: string[] } => question !== null);
  return {
    ...base,
    kind: "question",
    questions,
    answered: value.answered === true,
    reply: value.reply === "keys" ? "keys" : "message",
  };
}

function parseQueuedItem(value: unknown): QueuedItem | null {
  if (!isObject(value)) return null;
  const id = str(value.id);
  const text = str(value.text);
  const ts = num(value.ts);
  return id === null || text === null || ts === null ? null : { id, text, ts };
}

function parseSubagent(value: unknown): SubagentSummary | null {
  if (!isObject(value)) return null;
  const id = str(value.id);
  const label = str(value.label);
  const description = str(value.description);
  const status = str(value.status);
  if (id === null || label === null || description === null || status === null) return null;
  if (!(SUBAGENT_STATUSES as readonly string[]).includes(status)) return null;
  const summary: SubagentSummary = { id, label, description, status: status as SubagentSummary["status"] };
  const lastActivity = num(value.lastActivity);
  if (lastActivity !== null) summary.lastActivity = lastActivity;
  return summary;
}

function parseSnippet(value: unknown): Snippet | null {
  if (!isObject(value)) return null;
  const label = str(value.label);
  if (label === null) return null;
  const snippet: Snippet = { label };
  if (Array.isArray(value.keys)) {
    const keys = value.keys.filter((key): key is string => typeof key === "string" && isAllowedKey(key));
    if (keys.length) snippet.keys = keys;
  }
  const text = str(value.text);
  if (text !== null) snippet.text = text;
  const enter = bool(value.enter);
  if (enter !== null) snippet.enter = enter;
  return snippet;
}

function parseQueueSummary(value: unknown): QueueSummary | null {
  if (!isObject(value)) return null;
  const pane = str(value.pane);
  const pending = num(value.pending);
  const undelivered = num(value.undelivered);
  if (pane === null || pending === null || undelivered === null) return null;
  return { pane, pending: Math.max(0, Math.floor(pending)), undelivered: Math.max(0, Math.floor(undelivered)) };
}

function parseQueueOutcome(value: unknown): QueueOutcomeEntry | null {
  if (!isObject(value)) return null;
  const id = str(value.id);
  const text = str(value.text);
  const ts = num(value.ts);
  const outcome = str(value.outcome);
  if (id === null || text === null || ts === null || outcome === null) return null;
  if (outcome !== "pending" && outcome !== "accepted" && outcome !== "canceled" && outcome !== "undelivered") return null;
  const entry: QueueOutcomeEntry = { id, text, ts, outcome };
  const reason = str(value.reason);
  if (reason !== null) entry.reason = reason;
  return entry;
}

const ERROR_CODES: readonly ErrorCode[] = [
  "bad_request",
  "unknown_pane",
  "unknown_subagent",
  "unknown_item",
  "key_not_allowed",
  "herdr_unavailable",
  "herdr_error",
  "internal",
  "stale_prompt",
  "terminal_changed",
  "agent_blocked",
  "queue_closed",
];

const bad = (why: string): never => {
  throw new Error(`herdr protocol: ${why}`);
};

/**
 * Parse one server message, returning null for anything malformed. A bad
 * message never takes the connection down; the caller logs and ignores it.
 */
export function parseServerMessage(text: string): ServerMsg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const t = str(raw.t);
  if (t === null) return null;
  try {
    switch (t) {
      case "hello": {
        const protocol = num(raw.protocol);
        const machine = str(raw.machine);
        if (protocol === null || machine === null) return null;
        const herdrVersion = raw.herdrVersion === null ? null : str(raw.herdrVersion);
        const user = raw.user === null ? null : str(raw.user);
        const snippets = Array.isArray(raw.snippets)
          ? raw.snippets.map(parseSnippet).filter((snippet): snippet is Snippet => snippet !== null)
          : [];
        return { t, protocol, machine, herdrVersion, user, snippets };
      }
      case "panes": {
        if (!Array.isArray(raw.panes)) return null;
        const panes = raw.panes.map(parsePaneSummary).filter((pane): pane is PaneSummary => pane !== null);
        return { t, panes };
      }
      case "chat": {
        const pane = str(raw.pane);
        const source = str(raw.source);
        if (pane === null || (source !== "transcript" && source !== "screen") || !Array.isArray(raw.entries)) return null;
        const entries = raw.entries.map(parseChatEntry).filter((entry): entry is ChatEntry => entry !== null);
        const message: ServerMsg = { t, pane, source, entries, hasOlder: raw.hasOlder === true };
        const id = str(raw.id);
        if (id !== null) message.id = id;
        const subagent = str(raw.subagent);
        if (subagent !== null) message.subagent = subagent;
        return message;
      }
      case "chat.append":
      case "chat.update": {
        const pane = str(raw.pane);
        if (pane === null || !Array.isArray(raw.entries)) return null;
        const entries = raw.entries.map(parseChatEntry).filter((entry): entry is ChatEntry => entry !== null);
        const subagent = str(raw.subagent);
        return subagent !== null ? { t, pane, entries, subagent } : { t, pane, entries };
      }
      case "chat.older": {
        const id = str(raw.id);
        const pane = str(raw.pane);
        if (id === null || pane === null || !Array.isArray(raw.entries)) return null;
        const entries = raw.entries.map(parseChatEntry).filter((entry): entry is ChatEntry => entry !== null);
        const base = { t, id, pane, entries, hasOlder: raw.hasOlder === true } as const;
        const subagent = str(raw.subagent);
        return subagent !== null ? { ...base, subagent } : base;
      }
      case "queue": {
        const pane = str(raw.pane);
        if (pane === null || !Array.isArray(raw.items)) return null;
        const items = raw.items.map(parseQueuedItem).filter((item): item is QueuedItem => item !== null);
        return { t, pane, items };
      }
      case "queue.summary": {
        if (!Array.isArray(raw.panes)) return null;
        const panes = raw.panes.map(parseQueueSummary).filter((summary): summary is QueueSummary => summary !== null);
        return { t, panes };
      }
      case "queue.outcomes": {
        const pane = str(raw.pane);
        if (pane === null || !Array.isArray(raw.items)) return null;
        const items = raw.items.map(parseQueueOutcome).filter((entry): entry is QueueOutcomeEntry => entry !== null);
        return { t, pane, items };
      }
      case "subagents": {
        const pane = str(raw.pane);
        if (pane === null || !Array.isArray(raw.subagents)) return null;
        const subagents = raw.subagents.map(parseSubagent).filter((sub): sub is SubagentSummary => sub !== null);
        return { t, pane, subagents };
      }
      case "prompt": {
        const pane = str(raw.pane);
        if (pane === null) return null;
        const text = raw.text === null ? null : str(raw.text);
        if (raw.text !== null && text === null) return null;
        return { t, pane, text };
      }
      case "pong":
      case "ok": {
        const id = str(raw.id);
        return id === null ? null : { t, id };
      }
      case "error": {
        const code = str(raw.code);
        const message = str(raw.message);
        if (code === null || message === null || !ERROR_CODES.includes(code as ErrorCode)) return null;
        const reply: ServerMsg = { t, code: code as ErrorCode, message };
        const id = str(raw.id);
        if (id !== null) reply.id = id;
        return reply;
      }
      default:
        return null;
    }
  } catch (error) {
    if (String(error).includes("herdr protocol")) return null;
    return null;
  }
}

/** Parse GET /health's body. */
export function parseHealth(value: unknown): Health | null {
  if (!isObject(value)) return null;
  if (value.ok !== true) return null;
  const protocol = num(value.protocol);
  const machine = str(value.machine);
  return protocol === null || machine === null ? null : { ok: true, protocol, machine };
}

// ---------------------------------------------------------------- prompt identity

/** Strip CR, trailing spaces and trailing blank lines before hashing a prompt. */
export function normalizePromptText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** FNV-1a, 32 bits, hex. Enough for a prompt revision, not a security primitive. */
function hash32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The prompt revision the bridge compares immediately before typing: a hash of
 * terminal identity, change sequence and the normalized prompt text. It needs
 * no stored state and survives a bridge restart.
 */
export function promptRevision(terminalId: string, stateSeq: number, promptText: string): string {
  const normalized = normalizePromptText(promptText);
  return `${hash32(`${terminalId}\u0000${stateSeq}`)}${hash32(`${terminalId}\u0000${normalized}`)}`;
}

// ---------------------------------------------------------------- request builders

let nextRequestSerial = 1;
/** Monotonic request id, distinct per worker. */
export function nextRequestId(prefix = "r"): string {
  return `${prefix}${nextRequestSerial++}`;
}

export const clientMessages = {
  open: (id: string, pane: string, subagent?: string): ClientMsg => (subagent ? { t: "open", id, pane, subagent } : { t: "open", id, pane }),
  close: (id: string): ClientMsg => ({ t: "close", id }),
  older: (id: string, pane: string, before: string, subagent?: string, limit?: number): ClientMsg => {
    const message: ClientMsg = { t: "older", id, pane, before };
    if (subagent) message.subagent = subagent;
    if (limit !== undefined) message.limit = limit;
    return message;
  },
  keys: (id: string, pane: string, keys: string[], terminalId?: string): ClientMsg =>
    terminalId ? { t: "keys", id, pane, keys, terminalId } : { t: "keys", id, pane, keys },
  text: (id: string, pane: string, text: string, options: { enter: boolean; queue?: boolean; terminalId?: string }): ClientMsg => {
    const message: ClientMsg = { t: "text", id, pane, text, enter: options.enter };
    if (options.queue) message.queue = true;
    if (options.terminalId) message.terminalId = options.terminalId;
    return message;
  },
  unqueue: (id: string, pane: string, item: string): ClientMsg => ({ t: "unqueue", id, pane, item }),
  ping: (id: string): ClientMsg => ({ t: "ping", id }),
  prompt: (id: string, pane: string, terminalId: string, text: string, queue?: boolean): ClientMsg =>
    queue ? { t: "prompt", id, pane, terminalId, text, queue } : { t: "prompt", id, pane, terminalId, text },
  run: (id: string, pane: string, terminalId: string, text: string): ClientMsg => ({ t: "run", id, pane, terminalId, text }),
  type: (id: string, pane: string, terminalId: string, text: string): ClientMsg => ({ t: "type", id, pane, terminalId, text }),
  answer: (id: string, pane: string, terminalId: string, revision: string, keys: string[]): ClientMsg => ({
    t: "answer",
    id,
    pane,
    terminalId,
    revision,
    keys,
  }),
};
