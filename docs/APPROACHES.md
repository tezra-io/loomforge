# Loom V1 Approaches

## Context
We want a local workflow engine that supports:
- Linear-driven intake
- Codex builder runs
- Claude reviewer runs
- single `dev` branch worktree per project, rebased on `main` before each run
- durable state so OpenClaw is not babysitting dead cron sessions
- OpenClaw as the front door and planner (Loom owns the full execution-to-push pipeline)

## Approach 1: OpenClaw cron++, keep orchestration in prompts
Use the existing dev-build model and just tighten prompts/scripts.

### Pros
- fastest to start
- no new daemon/service
- stays close to current workflow

### Cons
- keeps the same isolated-session continuity problems
- still needs monitor/restart glue
- hard to reason about durable state and handoffs
- orchestration logic stays smeared across prompts

## Approach 2: Minimal local conductor daemon with SQLite and worktrees
Build a small long-lived local service that owns run state, worktree lifecycle, builder/reviewer handoff, and recovery.

### Pros
- directly attacks the real pain: continuity and orchestration tax
- much smaller than Paperclip
- cleanly supports Codex + Claude + Linear without org hierarchy
- OpenClaw can stay the control plane and shipper

### Cons
- new codebase to maintain
- need to design local API/CLI boundaries carefully
- still some non-trivial runner/worktree plumbing

## Approach 3: Paperclip-lite platform clone
Build a reduced version of Paperclip with projects, agents, goals, routines, approvals, and UI trimmed down.

### Pros
- future-flexible
- familiar model if Paperclip ideas are appealing

### Cons
- too much platform gravity for the actual need
- high risk of rebuilding Paperclip badly
- adds hierarchy/abstractions before they are justified

## Recommendation
Choose **Approach 2**.

That matches the agreed V1: no fake CEO hierarchy, just role-based workflow orchestration with durable local state.

## Working decision for initial design draft
Proceed assuming:
- one local daemon/service
- SQLite for durable state
- one project registry/config layer
- single `dev` branch worktree per project, rebased on `main` before each run
- Codex = builder (commits + pushes), Claude = reviewer (read-only)
- Loom owns Linear integration (fetch + status sync) and the full build-to-push pipeline
- OpenClaw = planner and trigger only (selects issues, decides when to merge `dev` into `main`)
- no UI in V1, CLI + MCP + logs only
