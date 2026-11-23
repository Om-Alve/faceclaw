/**
 * Program status for Rex panes: OSC 7501 records as Rex reports them, reduced
 * to one status per block, and the decision to raise attention.
 * https://www.superlogical.com/rex/docs/build/program-status.md
 */

const PROGRAM_STATES = ["idle", "working", "done", "blocked", "error"] as const;
const BLOCKED_KINDS = ["permission", "question", "auth"] as const;
/** Highest first: the row shows the first state any record of the block is in. */
const ROW_STATE_PRIORITY = ["blocked", "error", "done", "working"] as const;

const ROOT_RECORD_ID = "";
const STATUS_CHANGED_EVENT = "program_status_changed";
const STATUS_REMOVED_EVENT = "program_status_removed";
const NOTIFICATION_EVENT = "desktop_notification";
const BELL_EVENT = "bell";

export type ProgramState = (typeof PROGRAM_STATES)[number];
export type BlockedKind = (typeof BLOCKED_KINDS)[number];
export type RexRowState = (typeof ROW_STATE_PRIORITY)[number];

/** One OSC 7501 record. `id` is "" for the root record and "a/b" for a child of "a". */
export type ProgramStatusRecord = {
  id: string;
  state: ProgramState;
  kind?: BlockedKind;
  /** Rex decodes the report's base64, so this is display text. */
  msg?: string;
};

/** What a session row shows for a Rex pane. Absent when every record is idle. */
export type RexRowStatus = {
  state: RexRowState;
  kind?: BlockedKind;
  msg?: string;
};

export type ProgramStatusEvent =
  | { type: "changed"; record: ProgramStatusRecord }
  | { type: "removed"; ids: string[] }
  /** A desktop notification (OSC 9 or 777) or a bell. */
  | { type: "alert" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

function parseRecord(raw: unknown, id: string): ProgramStatusRecord | null {
  if (!isObject(raw)) return null;
  const record: ProgramStatusRecord = { id, state: oneOf(PROGRAM_STATES, raw.state) ?? "idle" };
  const kind = oneOf(BLOCKED_KINDS, raw.kind);
  if (kind) record.kind = kind;
  if (typeof raw.msg === "string" && raw.msg) record.msg = raw.msg;
  return record;
}

/** Parses the result of `com.superlogical.terminal.program_status`. */
export function parseProgramStatus(result: unknown): ProgramStatusRecord[] {
  if (!isObject(result) || !Array.isArray(result.records)) return [];
  return result.records.flatMap((raw) => {
    const id = isObject(raw) && typeof raw.id === "string" ? raw.id : ROOT_RECORD_ID;
    return parseRecord(raw, id) ?? [];
  });
}

/** Parses a terminal `block_event` by its name. Null for events that carry no status. */
export function parseStatusEvent(name: string, payload: unknown): ProgramStatusEvent | null {
  switch (name) {
    case STATUS_CHANGED_EVENT: {
      if (!isObject(payload) || typeof payload.id !== "string") return null;
      const record = parseRecord(payload.record, payload.id);
      return record && { type: "changed", record };
    }
    case STATUS_REMOVED_EVENT: {
      if (!isObject(payload) || !Array.isArray(payload.ids)) return null;
      return { type: "removed", ids: payload.ids.filter((id): id is string => typeof id === "string") };
    }
    case NOTIFICATION_EVENT:
    case BELL_EVENT:
      return { type: "alert" };
    default:
      return null;
  }
}

function reduceRowStatus(records: Iterable<ProgramStatusRecord>): RexRowStatus | null {
  const byId = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const state of ROW_STATE_PRIORITY) {
    const winner = byId.find((record) => record.state === state);
    if (!winner) continue;
    const status: RexRowStatus = { state };
    if (winner.kind) status.kind = winner.kind;
    if (winner.msg) status.msg = winner.msg;
    return status;
  }
  return null;
}

function enteredBlocked(previous: ProgramStatusRecord | undefined, next: ProgramStatusRecord): boolean {
  return next.state === "blocked" && previous?.state !== "blocked";
}

/**
 * Holds every block's records. A record raises attention when it enters
 * `blocked`, identified by block and record id, so re-reading the same
 * blocked record after a reconnect does not raise it again, and a record
 * that leaves `blocked` or is removed raises again when it next blocks.
 * Keep one tracker across reconnects for that to hold.
 */
export class ProgramStatusTracker {
  private readonly blocks = new Map<string, Map<string, ProgramStatusRecord>>();

  /** Replaces a block's records with a full read. Returns whether to raise attention. */
  read(blockId: string, records: readonly ProgramStatusRecord[], viewing: boolean): boolean {
    const previous = this.blocks.get(blockId);
    this.blocks.set(blockId, new Map(records.map((record) => [record.id, record])));
    return !viewing && records.some((record) => enteredBlocked(previous?.get(record.id), record));
  }

  /** Applies one block event. Returns whether to raise attention. */
  apply(blockId: string, event: ProgramStatusEvent, viewing: boolean): boolean {
    switch (event.type) {
      case "changed": {
        let records = this.blocks.get(blockId);
        if (!records) this.blocks.set(blockId, (records = new Map()));
        const previous = records.get(event.record.id);
        records.set(event.record.id, event.record);
        return !viewing && enteredBlocked(previous, event.record);
      }
      case "removed": {
        const records = this.blocks.get(blockId);
        for (const id of event.ids) records?.delete(id);
        return false;
      }
      case "alert":
        return !viewing;
    }
  }

  rowStatus(blockId: string): RexRowStatus | null {
    return reduceRowStatus(this.blocks.get(blockId)?.values() ?? []);
  }

  /** Drops a closed block. */
  forget(blockId: string): void {
    this.blocks.delete(blockId);
  }
}
