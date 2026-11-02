# Herdr app implementation

Feature playbook steps (from pstack feature.md), plus the throughput checkpoint.

- [x] 1. `how` over the affected subsystem (T3 Code worker, Terminal connections, Glanceboard widgets, herdr-even protocol).
- [x] 2. `architect`: one-window app, typed protocol boundary, pure model + reader + client, worker paints; shape written before code.
- [x] 3. Throughput checkpoint:
  - Blocking first steps: protocol/model/machines/client/reader/glance foundation (this branch).
  - Independent workstreams: worker UI | glance widget + registration | tests.
  - Shared mutable state: none; each delegate owns disjoint files in its own git worktree.
  - Smallest safe decomposition: three delegates, because the worker is one large file and the rest are separate surfaces.
- [ ] 4. Delegate code-writing to deepseek-v4.1-flash subagents at high effort, one worktree each.
- [ ] 5. Verify on the matching surface: `npx tsc -p tests/tsconfig.json`, `npm test`, `./lint.sh app/apps/herdr app/apps/glanceboard`, and `npx tsc -p tsconfig.json` for the app bundle.
- [ ] 6. Rebase into small ordered commits on `herdr-app`.
- [ ] 7. Design is not contested; skip interrogate (single approved plan).
- [ ] 8. Opening a PR: n/a, local repo has no remote configured for this branch.

## Decisions

- Client speaks protocol 2 today and uses protocol-3 ops only when `hello.protocol >= 3`.
- Bridge patch lives in `~/herdr-even` (not a git repo); out of this branch's scope.
- One window, screens: setup, machines, hub, workspace, pane, subagent, compose, review, keys mode.
