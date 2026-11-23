/**
 * Program status for Rex panes: OSC 7501 records, as protocol.ts parses them,
 * reduced to one status per block, and the decision to raise attention.
 * https://www.superlogical.com/rex/docs/build/program-status.md
 */
import type { SessionStatus } from "../../../native/terminal-session-types";
import type { RexBlockEvent, RexProgramStatusRecord } from "./protocol";

type SessionState = SessionStatus["state"];
type BlockedKind = NonNullable<SessionStatus["kind"]>;
type ProgramState = "idle" | SessionState;

const PROGRAM_STATES: readonly ProgramState[] = ["idle", "working", "done", "blocked", "error"];
const BLOCKED_KINDS: readonly BlockedKind[] = ["permission", "question", "auth"];
/** Highest first: the row shows the first state any record of the block is in. */
const ROW_STATE_PRIORITY: readonly SessionState[] = ["blocked", "error", "done", "working"];
const ROOT_RECORD_ID = "";

/** One record. `id` is "" for the root record and "a/b" for a child of "a". Rex sends `msg` already decoded from the report's base64. */
type ProgramStatusRecord = { id: string; state: ProgramState; kind?: BlockedKind; msg?: string };

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | undefined {
  return values.find((candidate) => candidate === value);
}

/** An unknown state reads as idle and an unknown kind as absent, as the API asks. */
function programStatusRecord(id: string, raw: RexProgramStatusRecord): ProgramStatusRecord {
  const record: ProgramStatusRecord = { id, state: oneOf(PROGRAM_STATES, raw.state) ?? "idle" };
  const kind = oneOf(BLOCKED_KINDS, raw.kind);
  if (kind) record.kind = kind;
  if (raw.msg) record.msg = raw.msg;
  return record;
}

function reduceRowStatus(records: Iterable<ProgramStatusRecord>): SessionStatus | null {
  const byId = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const state of ROW_STATE_PRIORITY) {
    const winner = byId.find((record) => record.state === state);
    if (!winner) continue;
    const status: SessionStatus = { state };
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

  /** Replaces a block's records with the result of com.superlogical.terminal.program_status. Returns whether to raise attention. */
  read(blockId: string, raw: readonly RexProgramStatusRecord[], viewing: boolean): boolean {
    const records = raw.map((record) => programStatusRecord(record.id ?? ROOT_RECORD_ID, record));
    const previous = this.blocks.get(blockId);
    this.blocks.set(blockId, new Map(records.map((record) => [record.id, record])));
    return !viewing && records.some((record) => enteredBlocked(previous?.get(record.id), record));
  }

  /** Applies one block event. A bell or a desktop notification raises attention too. Returns whether to raise attention. */
  apply(blockId: string, event: RexBlockEvent, viewing: boolean): boolean {
    switch (event.name) {
      case "program_status_changed": {
        const record = programStatusRecord(event.id, event.record);
        let records = this.blocks.get(blockId);
        if (!records) this.blocks.set(blockId, (records = new Map()));
        const previous = records.get(record.id);
        records.set(record.id, record);
        return !viewing && enteredBlocked(previous, record);
      }
      case "program_status_removed": {
        const records = this.blocks.get(blockId);
        for (const id of event.ids) records?.delete(id);
        return false;
      }
      case "bell":
      case "desktop_notification":
        return !viewing;
      default:
        return false;
    }
  }

  rowStatus(blockId: string): SessionStatus | null {
    return reduceRowStatus(this.blocks.get(blockId)?.values() ?? []);
  }

  /** Drops every block not in `blockIds`, which are the blocks still open. */
  retain(blockIds: ReadonlySet<string>): void {
    for (const blockId of [...this.blocks.keys()]) if (!blockIds.has(blockId)) this.blocks.delete(blockId);
  }
}
