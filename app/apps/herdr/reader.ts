/**
 * Pane reader layout: turn a chat window (entries, prompt, queue, durable
 * outcomes) into display lines, and keep the wearer's place by entry id rather
 * than by line number.
 *
 * The worker supplies the wrapping function (it owns the font), so this module
 * stays pure and testable. Scroll position is `{ entryId, lineOffset }`:
 * incoming output can prepend/append lines without moving the text the wearer
 * is reading. A null anchor means "follow the live tail".
 */
import type { ChatEntry, QueuedItem, QueueOutcomeEntry } from "./protocol";

export type ReaderLineKind = "entry" | "prompt" | "queue" | "outcome" | "marker" | "spacer";

export type ReaderLine = {
  text: string;
  kind: ReaderLineKind;
  value: number;
  indent: number;
  /** The transcript entry this line belongs to, for scroll anchoring. */
  entryId?: string;
  /** Which display line of that entry this is. */
  entryLine?: number;
};

export type ReaderInput = {
  entries: readonly ChatEntry[];
  /** While blocked: the cleaned prompt dialog. */
  prompt: string | null;
  queue: readonly QueuedItem[];
  /** Protocol 3 durable outcomes (canceled, undelivered) for the open pane. */
  outcomes?: readonly QueueOutcomeEntry[];
  /** Entry id that starts the unread stretch, when the pane was opened from a done marker. */
  firstUnreadEntryId?: string | null;
  /** Whether older pages remain (a leading hint line). */
  hasOlder?: boolean;
  /** The source the bridge used; screen text is rendered verbatim. */
  source?: "transcript" | "screen" | null;
  /** Wrap one logical line to the available width. */
  wrap: (text: string) => string[];
};

const VALUE = {
  entry: 205,
  user: 235,
  tool: 165,
  subagent: 195,
  system: 130,
  screen: 185,
  prompt: 240,
  queue: 165,
  outcome: 200,
  marker: 220,
  spacer: 0,
} as const;

/** Prefix for an entry's first line. */
function prefix(entry: ChatEntry): string {
  switch (entry.kind) {
    case "user":
      return "▸ ";
    case "tool":
      return "● ";
    case "subagent":
      return "↳ ";
    case "question":
      return "? ";
    case "screen":
      return "";
    default:
      return "";
  }
}

function entryValue(entry: ChatEntry): number {
  switch (entry.kind) {
    case "user":
      return VALUE.user;
    case "tool":
      return VALUE.tool;
    case "subagent":
      return VALUE.subagent;
    case "system":
      return VALUE.system;
    case "screen":
      return VALUE.screen;
    default:
      return VALUE.entry;
  }
}

/** Tool calls collapse to one line; everything else keeps its paragraphs. */
function entryText(entry: ChatEntry): string {
  const text = entry.text.trim();
  if (entry.kind === "tool") return text.split("\n")[0] ?? "";
  if (entry.kind === "question") {
    const questions = entry.questions.map((question) => question.prompt).join(" / ");
    return questions || text;
  }
  return text;
}

export function layoutReader(input: ReaderInput): ReaderLine[] {
  const lines: ReaderLine[] = [];
  const push = (text: string, kind: ReaderLineKind, value: number, indent = 0, entryId?: string, entryLine?: number) => {
    lines.push({ text, kind, value, indent, ...(entryId ? { entryId } : {}), ...(entryLine !== undefined ? { entryLine } : {}) });
  };

  if (input.hasOlder) {
    push("(scroll up for earlier output)", "spacer", 80);
    push("", "spacer", 0);
  }

  let previousKind: ChatEntry["kind"] | null = null;
  const firstUnread = input.firstUnreadEntryId ?? null;
  for (const entry of input.entries) {
    const label = entryText(entry);
    if (!label) continue;
    if (firstUnread && entry.id === firstUnread) {
      if (lines.length) push("", "spacer", 0);
      push("— new —", "marker", VALUE.marker);
    }
    // A blank line separates messages, but consecutive tool lines stay a block.
    const toolBlock = entry.kind === "tool" && previousKind === "tool";
    if (lines.length && !toolBlock) push("", "spacer", 0);
    const textPrefix = prefix(entry);
    const wrapped = input.wrap(textPrefix + label);
    const value = entryValue(entry);
    const indent = entry.kind === "tool" ? 6 : 0;
    wrapped.forEach((line, index) => push(line, "entry", value, indent, entry.id, index));
    previousKind = entry.kind;
  }

  if (input.prompt) {
    if (lines.length) push("", "spacer", 0);
    push("PROMPT", "marker", VALUE.prompt);
    for (const line of input.wrap(input.prompt)) push(line, "prompt", VALUE.prompt);
  }

  const live = input.queue;
  if (live.length) {
    if (lines.length) push("", "spacer", 0);
    for (const item of live) {
      const wrapped = input.wrap(`⧗ queued: ${item.text}`);
      wrapped.forEach((line, index) => push(line, "queue", VALUE.queue, index ? 8 : 0, `queue:${item.id}`, index));
    }
  }

  // Outcomes that matter after a reconnect: undelivered items keep their text
  // and a deliberate retry action; canceled ones are kept but dimmed.
  for (const outcome of input.outcomes ?? []) {
    if (outcome.outcome !== "undelivered" && outcome.outcome !== "canceled") continue;
    if (lines.length) push("", "spacer", 0);
    const suffix = outcome.reason ? `: ${outcome.reason}` : "";
    const label = outcome.outcome === "undelivered" ? `✕ not sent${suffix}` : `canceled${suffix}`;
    const wrapped = input.wrap(`${label} — ${outcome.text}`);
    wrapped.forEach((line, index) => push(line, "outcome", VALUE.outcome, index ? 8 : 0, `outcome:${outcome.id}`, index));
  }

  return lines;
}

export type ScrollAnchor = { entryId: string; lineOffset: number };

/**
 * The entry and offset at the top of the viewport. Lines without an entry
 * (prompt, queue, spacers) anchor to the nearest following entry, so a scroll
 * position that starts on a divider still survives appends.
 */
export function anchorAt(lines: readonly ReaderLine[], firstLine: number): ScrollAnchor | null {
  if (firstLine < 0 || firstLine >= lines.length) return null;
  for (let index = firstLine; index >= 0; index--) {
    const line = lines[index];
    if (!line?.entryId) continue;
    return { entryId: line.entryId, lineOffset: firstLine - index };
  }
  for (let index = firstLine; index < lines.length; index++) {
    const line = lines[index];
    if (line?.entryId) return { entryId: line.entryId, lineOffset: 0 };
  }
  return null;
}

/** The first line of `anchor`, or null when that entry is no longer retained. */
export function lineForAnchor(lines: readonly ReaderLine[], anchor: ScrollAnchor): number | null {
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.entryId === anchor.entryId && lines[index]?.entryLine === 0) return index;
  }
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.entryId === anchor.entryId) return index;
  }
  return null;
}

/** Clamp a restored anchor to the viewport, returning null for "follow live". */
export function resolveScroll(lines: readonly ReaderLine[], anchor: ScrollAnchor | null, visibleLines: number): number | null {
  if (!anchor) return null;
  const line = lineForAnchor(lines, anchor);
  if (line === null) return null;
  const maxFirst = Math.max(0, lines.length - visibleLines);
  if (maxFirst === 0) return null;
  return Math.min(maxFirst, Math.max(0, line + anchor.lineOffset));
}

/** From the top visible line, produce the anchor to keep across appends. */
export function scrollFromFirstLine(lines: readonly ReaderLine[], firstLine: number, visibleLines: number): { anchor: ScrollAnchor | null; firstLine: number | null } {
  const maxFirst = Math.max(0, lines.length - visibleLines);
  if (firstLine >= maxFirst) return { anchor: null, firstLine: null };
  return { anchor: anchorAt(lines, Math.max(0, firstLine)), firstLine: Math.max(0, firstLine) };
}

/**
 * The first entry a wearer should see when opening a done-but-unread pane: the
 * agent's response after the last message they sent, or the first entry.
 */
export function firstUnreadEntryId(entries: readonly ChatEntry[]): string | null {
  if (!entries.length) return null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind !== "user") continue;
    const next = entries[index + 1];
    return next?.id ?? null;
  }
  return entries[0]?.id ?? null;
}

/**
 * Bound retained transcript entries so an all-day pane cannot grow without
 * limit. A scroll anchor older than the window keeps its entry (plus context)
 * instead of being trimmed away the moment an older page arrives.
 */
export function trimEntries(entries: readonly ChatEntry[], limit = 800, keepId?: string | null): ChatEntry[] {
  if (entries.length <= limit) return [...entries];
  let start = entries.length - limit;
  if (keepId) {
    const index = entries.findIndex((entry) => entry.id === keepId);
    if (index >= 0 && index < start) start = Math.max(0, index - 20);
  }
  return entries.slice(start);
}

/** `N new lines` marker shown while the wearer is scrolled back. */
export function newOutputCount(lines: readonly ReaderLine[], anchor: ScrollAnchor | null, previousCount: number): number {
  if (!anchor) return 0;
  const line = lineForAnchor(lines, anchor);
  if (line === null) return 0;
  return Math.max(0, lines.length - (line + Math.max(1, previousCount)));
}

/** One-line summary for a pane row: the latest tool call, else the last entry. */
export function latestActivity(entries: readonly ChatEntry[], maxLength = 80): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    const text = entryText(entry).split("\n")[0]?.trim() ?? "";
    if (!text) continue;
    const label = entry.kind === "tool" ? `tool: ${text}` : text;
    return label.length <= maxLength ? label : `${label.slice(0, maxLength - 1)}…`;
  }
  return "";
}
