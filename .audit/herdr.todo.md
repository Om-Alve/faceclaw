# Herdr app implementation

Feature playbook steps (from pstack feature.md), plus the throughput checkpoint.

- [x] 1. `how` over the affected subsystem (T3 Code worker, Terminal connections, Glanceboard widgets, herdr-even protocol).
- [x] 2. `architect`: one-window app, typed protocol boundary, pure model + reader + client, worker paints; shape written before code.
- [x] 3. Throughput checkpoint:
  - Blocking first steps: protocol/model/machines/client/reader/glance foundation.
  - Independent workstreams: worker UI | glance widget + registration | tests, each in its own worktree.
  - Shared mutable state: none; disjoint files per delegate.
  - Smallest safe decomposition: three delegates; the worker is one large file, the rest are separate surfaces.
- [x] 4. Delegated to deepseek-v4.1-flash subagents at high effort, one worktree each; worker delegate's session died after writing, so its file was reviewed and finished in place.
- [x] 5. Verified: app tsc, tests tsc + node tests (1144 pass), oxlint clean on herdr/glanceboard/all-apps, smoke script against the mock bridge (6/6).
- [x] 6. Rebases into ordered commits on `herdr-app`; worktrees and delegate branches removed.
- [x] 7. Design not contested; skip interrogate (single approved plan).
- [x] 8. Opening a PR: n/a, this checkout has no remote for `herdr-app`.

## Decisions

- Client speaks protocol 2 today and uses protocol-3 ops only when `hello.protocol >= 3`.
- Bridge patch lives in `~/herdr-even` (not a git repo); specified in `design/herdr/BRIDGE_PROTOCOL_3.md`, out of this branch's scope.
- One window, screens: setup, machines, hub, workspace, pane, subagent, compose, review, keys mode.
- Unread clears only at the live tail or Mark read; screen panes require Mark read.
- Raw keys carry terminal identity only on protocol 3; protocol 2 ignores the extra field.

## Deliberate gaps

- Structured approvals (Claude hooks / channel relay) are specified but not prototyped; they need the bridge patch and one live Claude pane.
- The step-3 screen-text toggle for agent panes is deferred: protocol 2's `open` carries no source choice, so it needs the step-4 `pane.read` subscription or a new wire field.
- The client keeps the session's full entry list (the reader trims its window); a very long pane grows the worker's view array until the window closes.
- Device measurements (blocked-to-display, scroll latency, two live machines, sleeping/waking) require the phone and glasses.
- The worker has no headless harness; verification is typecheck, lint, and review over the pure modules it composes.
