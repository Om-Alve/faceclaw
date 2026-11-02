# Herdr

A glasses client for [Herdr](https://herdr.dev) panes across machines. One
launcher entry opens a hub of panes that need attention, workspaces, and a
readable conversation view for each pane. Input, queueing and the Glanceboard
widget follow the design in `design/herdr/PLAN.md`.

## Shape

- `protocol.ts` pins the herdr-even wire protocol, with protocol-3 fields
  optional so one boundary accepts the deployed bridge and the next one.
- `machines.ts` stores machine records as one JSON value under
  `herdr.machines` (the Terminal app's `connections.ts` pattern). A machine is
  added by scanning a QR code of its bridge URL or typing the URL in the phone
  editor; no rebuild is needed.
- `model.ts` is the pure domain: pane identity, urgency, workspace grouping,
  hub rows, read markers, drafts, send actions and machine URLs.
- `client.ts` owns one WebSocket per machine: reconnect with backoff, validated
  messages, correlated replies, one open view subscription, and no automatic
  retry of a timed-out write.
- `reader.ts` turns a chat window into display lines and keeps scroll position
  by entry id, so stream updates cannot pull the wearer off the text.
- `glance.ts` builds the Glanceboard snapshot the worker publishes.
- `herdr-app.worker.ts` is the one-window UI: setup, hub, workspace, pane,
  subagent, compose, review and Keys mode, plus assistant tools.

## Protocol versions

- Protocol 2 (deployed): read-only views, `keys`, `text`, `unqueue`. A message
  with `enter` is sent as text then Enter; agents refuse text while blocked.
- Protocol 3: `terminalId`, `agentSession`, `completionSeq` and `focused` on
  each pane; typed `prompt`/`run`/`type`; prompt-bound `answer`; queue
  summaries and a durable outcome ledger. The app uses these only when
  `hello.protocol >= 3` and otherwise falls back to protocol 2.

Bridge-side changes are specified in `design/herdr/BRIDGE_PROTOCOL_3.md`.

## Verifying the bridge

`node scripts/herdr-smoke.mjs https://<machine>.<tailnet>.ts.net` checks
`/health`, the WebSocket upgrade, `hello`, the pane list, disconnect and
reconnect from a tailnet machine. It prints the expected 403 text when the
caller's Tailscale identity is not the bridge owner.
