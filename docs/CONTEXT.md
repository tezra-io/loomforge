# Loom V1 Context

## What Loom is
Loom is a slim local workflow engine for software delivery. It exists to keep the parts of Paperclip that actually help, while avoiding the org-chart and platform overhead we do not need.

## Why this exists
The previous OpenClaw `dev-build` path was powerful but too orchestration-heavy:
- cron prompt carried too much state and too many responsibilities
- ACP session continuity in cron context was awkward
- separate monitoring/restart logic was needed
- backlog/state handling leaked into cron prompts
- workflow maintenance tax kept growing

Paperclip showed a better direction in a few areas:
- durable run state
- clean worktree isolation
- local Codex/Claude adapter support
- explicit issue/project execution model

But Paperclip also includes a lot we probably do not want in V1:
- company/org hierarchy
- CEO/manager delegation model
- approvals/hiring flows
- generic goals/projects platform surface
- larger control plane/UI footprint

## V1 Product Goal
Build the minimum reliable workflow engine for:
1. accepting issue identifiers from OpenClaw and fetching details from Linear
2. optionally placing them into a durable ready queue
3. reusing a single `dev` branch worktree per project, rebased on `main` before each run
4. running a Codex builder against the issue (commits after build)
5. running a Claude reviewer on the result
6. looping fixes until review passes or a hard stop occurs
7. pushing the `dev` branch and marking the Linear issue Done

## System boundary
### Loom owns
- workflow state machine
- durable run state
- durable ready queue and single-run sequencing
- issue execution records
- worktree lifecycle
- builder/reviewer run handoff
- local logs and recovery

### OpenClaw owns
- chat with Sujeeth
- design workflow trigger
- selecting which issues enter Loom (by identifier only)
- optional human approval gates before submitting to Loom
- merging `dev` into `main` when ready
- user-facing reporting

## In scope for V1
- local config/project registry
- explicit issue submission from OpenClaw
- small durable ready queue owned by Loom
- SQLite state store
- git worktree management
- builder runner abstraction for Codex
- reviewer runner abstraction for Claude
- structured run artifacts and logs
- retry/recovery rules for interrupted runs
- small local HTTP API plus a thin CLI for OpenClaw and operator access

## Out of scope for V1
- multi-level agent org charts
- autonomous manager/CEO delegation
- budgets, approvals, hiring, billing
- browser UI
- multi-tenant company model
- hosted deployment
- generalized plugin marketplace

## Required capabilities
1. **Durable runs**
   - each execution has an ID, state, timestamps, logs, and artifacts
   - restart-safe after daemon crash or host restart

2. **Worktree isolation**
   - single long-lived `dev` branch worktree per project, reused across issues
   - `dev` is rebased on the default branch before each run
   - one active run at a time prevents contention

3. **Runner abstraction**
   - Codex runner for implementation
   - Claude runner for review
   - both accessed through their harness interfaces only
   - consistent inputs/outputs regardless of provider quirks

4. **Workflow state machine**
   - queued
   - preparing_workspace
   - building
   - verifying
   - reviewing
   - revising
   - ready_for_ship
   - failed
   - blocked
   - cancelled

5. **Structured artifacts**
   - issue snapshot
   - prompt/context used for each run
   - changed files summary
   - verification commands + output
   - review findings (P0/P1/P2)
   - final handoff summary back to OpenClaw

## Suggested architecture
- `loomd`: long-lived local daemon, managed by `launchd`
- `loom` CLI: trigger/status/logs/retry
- small local HTTP API for OpenClaw integration and operator diagnostics
- SQLite DB for runs, projects, workspaces, attempts, findings, and events
- filesystem log/artifact storage under a local data dir
- a thin harness-based adapter layer for Codex and Claude runners
- worktree manager that maintains a single `dev` branch worktree per project

## Candidate directory shape
```text
loom/
├── docs/
├── src/
│   ├── api/
│   ├── app/
│   ├── config/
│   ├── db/
│   ├── workflow/
│   ├── runners/
│   ├── worktrees/
│   ├── artifacts/
│   └── cli/
├── tests/
└── CLAUDE.md
```

## Human decisions now made
- TypeScript is acceptable for V1
- V1 should include a small durable ready queue so orchestration can move out of cron
- Verification should remain repo-config only in V1
- Runtime data should live under `~/.loom/`
- Loom should use launchd integration and start along with OpenClaw

## Reference material
- Paperclip reference repo: `/Users/sujshe/projects/paperclip`
- Dev-build skill (primary workflow reference): `/Users/sujshe/.openclaw/workspace/backups/paperclip-revert/dev-build-SKILL.backup.md`
- Paperclip MCP `makeTool` pattern: `/Users/sujshe/projects/paperclip/packages/mcp-server/src/tools.ts`
- Revert baseline for the current dev-build path: `/Users/sujshe/.openclaw/workspace/backups/paperclip-revert/REVERT_BASELINE_2026-04-08.md`

## Draft objective
Produce a first design doc that explains how Loom V1 works end-to-end, what core modules it needs, what state it persists, and how OpenClaw talks to it without bloating into Paperclip-lite.
