# Herdr bridge changes for the Faceclaw app

The Faceclaw app in `app/apps/herdr/` speaks the herdr-even wire protocol pinned
in `app/apps/herdr/protocol.ts`. It works against the bridge deployed today
(protocol 2) for reading and for protocol-2 control. This file records the
bridge-side work the plan calls for, so the two repositories stay in step. The
bridge source lives in `~/herdr-even` and is not a git checkout here; apply
these changes there.

## Step 2a: control on protocol 2 (no wire change)

Goal: close the retype-on-retry bug and let Herdr refuse new turns to a blocked
agent.

1. `packages/bridge/src/herdr.ts`: add `agent.prompt` to `ALLOWED_METHODS`.
   Keep every create/close/split/focus/rename/move/start/server method
   forbidden. Add `pane.send_input` only in step 2b, after the paste probe.
2. `packages/bridge/src/sessions.ts`:
   - When `sendText(pane, text, enter === true)` targets a pane whose
     `agent` is non-null, call `agent.prompt` with the text and let Herdr
     submit the turn. Do not send text, wait 150 ms, then press Enter.
   - Keep `pane.send_text` for `enter === false` and for shell panes.
   - Queue delivery uses the same agent path, so a retry after a failed Enter
     cannot retype the message.
   - A blocked agent now returns Herdr's `agent_blocked`; map it to
     `ErrorCode.agent_blocked` in the WebSocket error reply.
3. No `hello.protocol` bump, no new messages, no client change.

Acceptance: a message sent to a blocked agent is refused with `agent_blocked`
and nothing is typed; a queued message is delivered once, not once per retry.

## Step 2b: protocol 3

`PROTOCOL_VERSION = 3`. Protocol-2 clients keep working: every new field is
additive, and the bridge continues to accept `text`, `keys` and `unqueue`.

### Pane summary additions

```ts
interface PaneSummary {
  // existing fields unchanged
  terminalId: string;                 // Herdr terminal_id, e.g. "term_65eab92bf072b2"
  agentSession: { kind: string; value: string } | null;
  completionSeq: number;              // Herdr completion_seq
  focused: boolean;                   // pane.focused
}
```

`packages/bridge/src/model.ts` and `sessions.ts` already carry `terminal_id`
and `agent_session`; expose them on the summary. `completion_seq` and
`focused` come from the same `session.snapshot` / `pane.list` entries.

### New client messages

```ts
| { t: "prompt"; id: string; pane: string; terminalId: string; text: string; queue?: boolean }
| { t: "run";    id: string; pane: string; terminalId: string; text: string }
| { t: "type";   id: string; pane: string; terminalId: string; text: string }
| { t: "answer"; id: string; pane: string; terminalId: string; revision: string; keys: string[] }
```

- `prompt` → `agent.prompt` (queue uses the existing session-aware queue).
- `run` → `pane.send_input` with `text` plus `keys: ["enter"]`.
- `type` → `pane.send_text` without Enter.
- `answer` → verify the pane's `terminal_id` still matches, recompute the
  prompt revision (below), and reject with `stale_prompt` before typing when
  it differs. Then send the keys. `terminal_changed` when the pane ID now
  holds another terminal.
- Every new write carries `terminalId`; `text`, `keys` and `unqueue` gain an
  optional `terminalId` guard and reject with `terminal_changed` on mismatch.

Prompt revision (same function as `protocol.ts` in the app):

```
hash32(terminalId + "\0" + state_change_seq) + hash32(terminalId + "\0" + normalizePromptText(latest prompt text))
```

`normalizePromptText` strips CR, trailing spaces per line, and trailing blank
lines. The bridge re-reads the pane immediately before sending.

### New server messages

```ts
| { t: "queue.summary"; panes: { pane: string; pending: number; undelivered: number }[] }
| { t: "queue.outcomes"; pane: string; items: QueueOutcomeEntry[] }
```

Publish `queue.summary` on every machine stream whenever any pane's counts
change (not only for the socket's open pane, which is today's limitation), so
the hub and widget can show undelivered items for panes that are not open.

`queue.outcomes` answers an `open` (after `queue`) with the bounded, persistent
ledger for that pane: pending, accepted, canceled, undelivered with a reason.
Cap it per pane and per machine; it is UI state, not an audit log.

### Queue ledger

`packages/bridge/src/queue.ts` gains a `Map<itemId, QueueOutcomeEntry>` that
survives a bridge restart beside the queue file. Every state transition writes
one entry: added (`pending`), accepted by Herdr, canceled by the wearer, or
undelivered with a reason (agent session changed, bridge stopping, Herdr
refused). Never infer delivery from an item disappearing from the pending
list.

### `pair` command

`packages/bridge/src/main.ts` gains `herdr-even pair`: print the machine's
`https://<machine>.<tailnet>.ts.net` URL as a terminal QR code. No wire change;
any QR code of the URL works with the app's scanner.

### Paste probe before enabling `run`

`pane.send_input` puts `text` and `keys` in one ordered submission. Probe it on
a shell and on an interactive TUI (one that treats a paste specially) before
adding it to `ALLOWED_METHODS`: the Enter must arrive as a key, not as part of
the pasted text. If it does not, keep `run` on `pane.send_text` + Enter and
leave `pane.send_input` forbidden.

### Structured approvals (optional, after the probe)

Prototype both prior-art paths on one Claude pane and adopt the cheaper one:
the cc-g2 non-blocking `PermissionRequest` hook posting `tool_name` and input
to the bridge, or Claude Code's channel permission relay with its five-letter
request id. Map an approval to `answer` with the hook's request identity; the
desktop dialog stays authoritative and the first answer wins. Agents without
hooks keep key answers plus Herdr's `blocked` status.
