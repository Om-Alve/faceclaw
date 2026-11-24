/**
 * The Rex client API's control connection (rex.control.v1) at API revision
 * 18: what the client sends, and a parser that validates what the server
 * sends once, where it enters. Field names follow the wire in what the client
 * sends and are camelCase in what it parses.
 */

export const REX_API_REVISION = 18;
export const REX_CONTROL_SUBPROTOCOL = "rex.control.v1";

export const RexMethod = {
  bootstrap: "session.bootstrap",
  view: "session.view",
  blockEvent: "block.event",
  terminalWrite: "com.superlogical.terminal.write",
} as const;

export type RexClientInfo = {
  kind: "app" | "cli" | "agent" | "other";
  name: string;
  version: string;
  platform?: string;
  label?: string;
};

export type RexHello = {
  type: "hello";
  api_revision: number;
  api_min_revision: number;
  client: RexClientInfo;
  reconnect_token?: string;
};

export type RexRequest = { type: "request"; id: string; method: string; payload?: unknown };

export type RexWelcome = {
  protocol: string;
  apiRevision: number;
  maxMessageBytes: number;
  /** Null when the server can't resume clients. */
  client: { id: string; reconnectToken: string; resumed: boolean } | null;
};

export type RexErrorBody = { code: string; message: string; status: number };

export type RexResponseOutcome = { status: "ok"; payload: unknown } | { status: "error"; error: RexErrorBody };

export type RexServerMessage =
  | { type: "welcome"; welcome: RexWelcome }
  | { type: "response"; id: string; seq: number; outcome: RexResponseOutcome }
  | { type: "event"; seq: number; event: RexEvent }
  /** A message type this client doesn't know. The API requires skipping it. */
  | { type: "skip"; wireType: string }
  | { type: "invalid"; reason: string };

export type RexEvent =
  | { name: "session_created"; sessionId: string; label: string }
  | { name: "session_destroyed"; sessionId: string }
  | { name: "session_event"; sessionId: string; event: RexSessionEvent }
  | { name: "other"; wireName: string };

export type RexSessionEvent =
  | { name: "session_view_changed"; revision: number }
  /** A block_event, or a block_owner_changed, which is the session event that names one block. */
  | { name: "block"; blockId: string; event: RexBlockEvent }
  | { name: "other"; wireName: string };

export type RexProgramStatusRecord = {
  /** Left out for the root record. */
  id?: string;
  state: string;
  kind?: string;
  progress?: number;
  app?: string;
  effectiveApp?: string;
  title?: string;
  msg?: string;
  updatedAt: string;
};

export type RexProcess = { pid: number; name: string; argv0?: string; script?: string; cwd?: string };

export type RexBlockEvent =
  | { name: "bell" }
  | { name: "title_changed"; title: string }
  | { name: "program_status_changed"; id: string; record: RexProgramStatusRecord }
  | { name: "program_status_removed"; ids: string[]; reason: string }
  | { name: "desktop_notification"; title: string; body: string }
  | { name: "process_changed"; generation: number; foreground: RexProcess | null }
  | { name: "size_changed"; columns: number; rows: number; owner?: string }
  | { name: "child_exited"; exitCode: number; error?: string }
  | { name: "progress_report"; state: string; progress?: number }
  | { name: "block_owner_changed"; owner?: string; previous?: string; reason?: string }
  | { name: "other"; wireName: string };

export type RexBlockInfo = { blockId: string; label: string; creatorName: string; flavor: string; owner?: string };
export type RexWindowView = { windowId: string; label: string; focusedBlockId?: string; blocks: RexBlockInfo[] };
export type RexSessionView = {
  sessionId: string;
  label: string;
  revision: number;
  activeWindowId?: string;
  windows: RexWindowView[];
};

export type RexSessionSummary = { sessionId: string; label: string };
export type RexBootstrap = { clientId: string; sessions: RexSessionSummary[] };

export function buildHello(client: RexClientInfo, reconnectToken: string | null): RexHello {
  const hello: RexHello = {
    type: "hello",
    api_revision: REX_API_REVISION,
    api_min_revision: REX_API_REVISION,
    client,
  };
  if (reconnectToken) hello.reconnect_token = reconnectToken;
  return hello;
}

export function buildRequest(id: string, method: string, payload?: unknown): RexRequest {
  return payload === undefined ? { type: "request", id, method } : { type: "request", id, method, payload };
}

class RexParseError extends Error {}

type Fields = Record<string, unknown>;

function object(value: unknown, what: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RexParseError(`${what} is not an object`);
  return value as Fields;
}

function string(fields: Fields, key: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new RexParseError(`${key} is not a string`);
  return value;
}

function integer(fields: Fields, key: string): number {
  const value = fields[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new RexParseError(`${key} is not an integer`);
  return value;
}

function optionalString(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  return value === undefined || value === null ? undefined : string(fields, key);
}

function optionalInteger(fields: Fields, key: string): number | undefined {
  const value = fields[key];
  return value === undefined || value === null ? undefined : integer(fields, key);
}

/** Go encodes an empty list as null. */
function list(fields: Fields, key: string): unknown[] {
  const value = fields[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RexParseError(`${key} is not an array`);
  return value;
}

export function parseServerMessage(raw: string): RexServerMessage {
  try {
    const message = object(JSON.parse(raw), "message");
    const type = string(message, "type");
    switch (type) {
      case "welcome":
        return { type, welcome: parseWelcome(message) };
      case "response": {
        if (typeof message.id !== "string" || message.id === "") return { type: "invalid", reason: "response without id" };
        const seq = integer(message, "seq");
        if (message.error !== undefined && message.error !== null) {
          const error = object(message.error, "error");
          return {
            type,
            id: message.id,
            seq,
            outcome: { status: "error", error: { code: string(error, "code"), message: string(error, "message"), status: integer(error, "status") } },
          };
        }
        return { type, id: message.id, seq, outcome: { status: "ok", payload: message.payload ?? {} } };
      }
      case "event":
        return { type, seq: integer(message, "seq"), event: parseEvent(object(message.payload, "event")) };
      default:
        return { type: "skip", wireType: type };
    }
  } catch (error) {
    return { type: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

function parseWelcome(message: Fields): RexWelcome {
  const limits = object(message.limits, "limits");
  let client: RexWelcome["client"] = null;
  if (message.client !== undefined && message.client !== null) {
    const fields = object(message.client, "client");
    client = { id: string(fields, "id"), reconnectToken: string(fields, "reconnect_token"), resumed: fields.resumed === true };
  }
  return {
    protocol: string(message, "protocol"),
    apiRevision: optionalInteger(message, "api_revision") ?? 0,
    maxMessageBytes: integer(limits, "max_message_bytes"),
    client,
  };
}

function parseEvent(event: Fields): RexEvent {
  const name = string(event, "type");
  const payload = object(event.payload ?? {}, name);
  switch (name) {
    case "session_created": {
      const session = object(payload.session, "session");
      return { name, sessionId: string(session, "session_id"), label: string(session, "label") };
    }
    case "session_destroyed":
      return { name, sessionId: string(payload, "session_id") };
    case "session_event":
      return { name, sessionId: string(payload, "session_id"), event: parseSessionEvent(object(payload.event, "session event")) };
    default:
      return { name: "other", wireName: name };
  }
}

function parseSessionEvent(event: Fields): RexSessionEvent {
  const name = string(event, "type");
  const payload = object(event.payload ?? {}, name);
  switch (name) {
    case "session_view_changed":
      return { name, revision: integer(payload, "revision") };
    case "block_event":
      return { name: "block", blockId: string(payload, "block_id"), event: parseBlockEvent(string(payload, "name"), object(payload.payload ?? {}, "block event")) };
    case "block_owner_changed":
      return {
        name: "block",
        blockId: string(payload, "block_id"),
        event: {
          name,
          owner: optionalString(payload, "owner"),
          previous: optionalString(payload, "previous"),
          reason: optionalString(payload, "reason"),
        },
      };
    default:
      return { name: "other", wireName: name };
  }
}

function parseBlockEvent(name: string, payload: Fields): RexBlockEvent {
  switch (name) {
    case "bell":
      return { name };
    case "title_changed":
      return { name, title: string(payload, "title") };
    case "program_status_changed":
      return { name, id: string(payload, "id"), record: parseProgramStatusRecord(object(payload.record, "record")) };
    case "program_status_removed":
      return { name, ids: list(payload, "ids").map((id) => String(id)), reason: string(payload, "reason") };
    case "desktop_notification":
      return { name, title: string(payload, "title"), body: string(payload, "body") };
    case "process_changed": {
      const foreground = payload.foreground === undefined || payload.foreground === null ? null : parseProcess(object(payload.foreground, "foreground"));
      return { name, generation: integer(payload, "generation"), foreground };
    }
    case "size_changed":
      return { name, columns: integer(payload, "columns"), rows: integer(payload, "rows"), owner: optionalString(payload, "owner") };
    case "child_exited":
      return { name, exitCode: integer(payload, "exit_code"), error: optionalString(payload, "error") };
    case "progress_report":
      return { name, state: string(payload, "state"), progress: optionalInteger(payload, "progress") };
    default:
      return { name: "other", wireName: name };
  }
}

export function parseProgramStatusRecord(record: unknown): RexProgramStatusRecord {
  const fields = object(record, "record");
  return {
    id: optionalString(fields, "id"),
    state: string(fields, "state"),
    kind: optionalString(fields, "kind"),
    progress: optionalInteger(fields, "progress"),
    app: optionalString(fields, "app"),
    effectiveApp: optionalString(fields, "effective_app"),
    title: optionalString(fields, "title"),
    msg: optionalString(fields, "msg"),
    updatedAt: string(fields, "updated_at"),
  };
}

function parseProcess(fields: Fields): RexProcess {
  return {
    pid: integer(fields, "pid"),
    name: string(fields, "name"),
    argv0: optionalString(fields, "argv0"),
    script: optionalString(fields, "script"),
    cwd: optionalString(fields, "cwd"),
  };
}

/** Parse a session.view result, or the view inside a session.attach or session.bootstrap result. Throws on a malformed view. */
export function parseSessionView(payload: unknown): RexSessionView {
  const view = object(payload, "view");
  const windows = list(view, "windows").map((raw) => {
    const window = object(raw, "window");
    const blocks = list(window, "layers").flatMap((layer) =>
      list(object(layer, "layer"), "blocks").map((rawBlock) => {
        const block = object(rawBlock, "block");
        return {
          blockId: string(block, "block_id"),
          label: optionalString(block, "label") ?? "",
          creatorName: optionalString(block, "creator_name") ?? "",
          flavor: optionalString(block, "flavor") ?? "",
          owner: optionalString(block, "owner"),
        };
      }),
    );
    return {
      windowId: string(window, "window_id"),
      label: optionalString(window, "label") ?? "",
      focusedBlockId: optionalString(window, "focused_block_id"),
      blocks,
    };
  });
  return {
    sessionId: string(view, "session_id"),
    label: optionalString(view, "label") ?? "",
    revision: integer(view, "revision"),
    activeWindowId: optionalString(view, "active_window_id"),
    windows,
  };
}

/** Parse a session.bootstrap result. Throws on a malformed result. */
export function parseBootstrap(payload: unknown): RexBootstrap {
  const result = object(payload, "bootstrap");
  const sessions = list(object(result.attach_all, "attach_all"), "sessions").map((raw) => {
    const session = object(raw, "session");
    return { sessionId: string(session, "session_id"), label: string(session, "label") };
  });
  return { clientId: string(result, "client_id"), sessions };
}
