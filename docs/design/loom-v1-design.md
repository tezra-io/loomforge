# Loomforge V1 Design

## Problem

The old OpenClaw `dev-build` path proved the workflow shape, but it packed too much orchestration into cron prompts. One cron session had to choose work, manage issue state, spawn builders and reviewers, recover dead sessions, verify output, and decide when to ship. That created continuity problems, restart glue, and too much workflow logic living in prompts.

Paperclip pointed at the right primitives, durable run state, isolated worktrees, explicit execution records, and clean builder/reviewer separation, but it also carries platform surface we do not need for V1.

Loomforge exists to keep the useful primitives and cut the rest.

## Goal

Build a slim local workflow engine that can:

1. accept issue identifiers from OpenClaw, either to run immediately or enter a ready queue
2. fetch issue details from Linear
3. reuse the configured project workspace on a single `dev` branch, rebased on `main` before each run
4. run a Codex builder in that workspace
5. run a Claude reviewer on the resulting diff and builder-reported evidence
6. allow one review-driven fix pass, then stop rather than spending unbounded tokens
7. commit and push the `dev` branch, mark the Linear issue Done, and create a PR from `dev` to `main` for the completed project batch

## Non-goals

Loomforge V1 is not:

- a company/org platform
- an autonomous CEO/manager hierarchy
- a budgeting or approvals system
- a browser UI product
- a multi-tenant hosted service
- a replacement for OpenClaw chat, planning, or shipping

## Core decision

### Rust vs TypeScript

**Recommendation: TypeScript for V1.**

This does not change the runner boundary. Codex remains the builder engine and Claude remains the reviewer engine.

Why:

- Loomforge is orchestration-heavy, not compute-heavy
- Node/TypeScript is faster for process control, local HTTP, CLI glue, and SQLite-backed service development
- the costliest risk is workflow iteration speed, not runtime throughput
- a small TypeScript daemon is enough for a single-user local service

Rust is still a valid future move if Loomforge becomes production infra or needs stricter concurrency guarantees, but it is the wrong optimization for V1.

### CLI-only vs local HTTP API

**Recommendation: tiny local HTTP API with a thin CLI wrapper.**

Why:

- OpenClaw can trigger runs and fetch status cleanly without shell parsing
- logs, artifacts, and state queries become structured instead of text scraping
- manual operator access still exists through the CLI

CLI-only would push orchestration back into shell glue, which is exactly what Loomforge is supposed to remove.

## System boundary

### OpenClaw owns

- chat with Sujeeth
- design workflow and design approval
- choosing which issues are eligible to enter Loomforge (by issue identifier only)
- optional human approval gates before submitting to Loomforge
- PR creation / merge decisions (if applicable)
- user-facing summaries

### Loomforge owns

- **Linear issue fetching** — given an issue identifier, Loomforge reads the full issue (title, description, acceptance criteria, labels, comments) directly from Linear
- **Linear status updates** — Loomforge transitions issue status during workflow (In Progress → In Review → Done/Blocked)
- **commit and push** — Loomforge commits changes in the project workspace and pushes the configured `dev` branch to remote
- durable workflow state
- durable ready queue and single-run sequencing
- execution records and logs
- project workspace lifecycle
- builder/reviewer handoff
- retry/recovery behavior
- structured result notification to OpenClaw

## High-level architecture

```text
OpenClaw
  -> Loomforge API / CLI / MCP server
     -> Workflow engine
        -> Linear client (issue fetch + status sync)
        -> Project registry
        -> SQLite state store
        -> Worktree manager
        -> Codex runner
        -> Claude runner
        -> Artifact store
```

V1 uses one long-lived local daemon, `loomforged`, plus a thin `loomforge` CLI.

### Daemon lifecycle

- `loomforged` runs as a user-level `launchd` service on macOS
- Loomforge spins up along with OpenClaw, not as a separate manual start habit
- the CLI surfaces whether the daemon is installed/running and fails clearly if the service is unavailable
- on graceful shutdown (`SIGTERM`):
  - persist current run state to SQLite before exiting
  - transition any non-terminal in-flight run to `cancelled` with `cancelReason: daemon_shutdown`
  - on next start, the recovery model (see Persistence) determines whether to resume or rerun
- the CLI exposes `loomforge status` to check daemon health and current run state

Runner access constraint:

- Loomforge must talk to Codex and Claude through their harness interfaces only
- no OAuth or provider API keys for runner access in V1 — Codex CLI and Claude Code handle their own auth
- no replacing the Codex builder / Claude reviewer split with generic provider auth glue
- Linear API access is separate from runner access — Loomforge authenticates to Linear via API key for issue fetching and status sync

V1 also keeps execution intentionally simple: one active run at a time, with queued runs allowed for sequencing but not parallel execution.

### Queue-drain mechanism

- event-driven, not timer-based: Loomforge checks the ready queue when a run reaches a terminal state (`shipped`, `failed`, `blocked`, `cancelled`) or when a new item is enqueued via the API
- no internal polling timer — this stays consistent with the "no cron inside Loomforge" principle
- if the engine is idle and the queue is non-empty, dequeue the next item immediately

### `run_now_if_idle` rejection behavior

When OpenClaw sends `execution_mode: run_now_if_idle` and the engine is not idle:

- return a structured rejection with HTTP 409, including current run ID and state
- OpenClaw decides whether to re-submit as `enqueue`
- Loomforge does not silently auto-enqueue

### Queue policy

- OpenClaw explicitly submits work into Loomforge, Loomforge does not discover issues on its own
- queued work is durable in SQLite and survives daemon restarts
- V1 dequeues in FIFO order unless OpenClaw explicitly cancels and re-enqueues items
- queueing exists to isolate run orchestration from cron, not to add autonomous prioritization

## Main modules

### 1. API layer

Responsibilities:

- accept immediate or queued run requests from OpenClaw
- expose queue state, run status, logs, findings, and artifacts
- expose retry/cancel/cleanup operations
- validate payloads and project references

Suggested endpoints:

- `GET /health`
- `POST /runs`
- `GET /runs/:id`
- `GET /runs/:id/logs`
- `GET /runs/:id/artifacts`
- `GET /queue`
- `POST /runs/:id/retry`
- `POST /runs/:id/cancel`
- `POST /workspaces/:project/:issue/cleanup`

A thin CLI wraps these endpoints for local operator use.

### 2. Linear client

Responsibilities:

- fetch issue details from Linear given an issue identifier (e.g. `TEZ-412`)
- read: title, description, acceptance criteria, labels, assignee, comments, priority
- write: update issue status during workflow transitions
- cache fetched issue data as an artifact (issue snapshot) so runs are reproducible even if the issue is later edited

V1 uses Linear as the only issue tracker. The client is a thin adapter that can be swapped later if needed.

Access method:

- use the `linear` CLI or the Linear GraphQL API via `@linear/sdk`
- authenticate via a Linear API key stored in Loomforge's global config (`~/.loomforge/config.yaml`)
- no OAuth flow — single-user local daemon, API key is sufficient

Linear status mapping:
| Loomforge state | Linear status |
|---|---|
| `queued` | _(no change — issue was already selected by OpenClaw)_ |
| `preparing_workspace` | In Progress |
| `building` | In Progress |
| `reviewing` | In Review |
| `ready_for_ship` | _(no change — push in progress)_ |
| `shipped` | Done |
| `blocked` | Blocked |
| `failed` | Blocked |
| `cancelled` | _(no change — operator decision)_ |

The mapping is configurable per project (see project config `linearStatuses`).

Global config addition:

```yaml
# ~/.loomforge/config.yaml
linear:
  apiKey: lin_api_xxxxx
```

### 3. Project registry

Responsibilities:

- map project slug -> repo root
- define default branch
- define verification commands
- define dev branch and runtime data root
- define builder/reviewer policy knobs

V1 should keep project config in checked-in files, not only the database. The database stores runtime state; config files store operator intent.

Suggested config shape:

```yaml
slug: rustyclaw
repoRoot: ~/projects/rustyclaw
defaultBranch: master
devBranch: dev # all issues commit here, rebased on defaultBranch before each run
verify:
  - cargo test
  - cargo fmt --check
reviewPolicy:
  maxRevisionLoops: 3
timeouts:
  builderMinutes: 15
  reviewerMinutes: 5
  verificationMinutes: 5
linearStatuses: # optional overrides per project
  inProgress: "In Progress"
  inReview: "In Review"
  blocked: "Blocked"
```

### 3. Workflow engine

Responsibilities:

- create runs
- advance the state machine
- invoke runners in the right order
- enforce retry limits
- decide terminal outcomes

The workflow engine is the center of Loomforge V1. The config loader, Linear client,
workspace manager, runners, artifact store, API, CLI, and MCP server
exist to support this engine. Do not keep expanding `src/config/` once the
registry can load project intent; subsequent work should wire execution modules
into the run lifecycle below.

Minimum engine behavior:

- accept a submitted run and persist it as `queued`
- reject `run_now_if_idle` with busy metadata when any run is active or already queued
- drain the durable ready queue only when the engine is idle
- fetch and snapshot the Linear issue before invoking any runner
- transition through `preparing_workspace -> building -> reviewing`
- create a new run attempt for each build -> review cycle
- enter `revising` at most once when review requests changes
- enter `ready_for_ship` only after committed changes pass review
- invoke Codex push only from `ready_for_ship`, then mark Linear Done and emit the final handoff
- emit an event for every state transition so recovery can reconstruct the latest valid state

The engine is deterministic. It does not invent priorities or choose issues on its own in V1. It only drains the explicit ready queue it has already been given.

### 4. Workspace manager

Responsibilities:

- create or reuse the configured project workspace for the `dev` branch
- rebase `dev` on the default branch (e.g. `main`/`master`) before each run (this is the only git operation Loomforge performs directly — all other git operations are handled by Codex, which can fix hook failures autonomously)
- verify clean working state before a run
- record workspace metadata
- cleanup workspace on operator request

Branch strategy:

- all issues for a project commit to a single `dev` branch
- the branch name is configurable per project via `devBranch` (default: `dev`)
- before each run starts, Loomforge rebases `dev` onto the project's `defaultBranch` to pick up any changes that were merged since the last run
- if the rebase fails (conflicts), the run transitions to `blocked` with `failureReason: rebase_conflict` — operator must resolve manually
- this keeps the `dev` branch always ahead of `main` with a clean linear history, making the final PR from `dev` to `main` easy to review and merge

Workspace policy:

- one project -> one configured workspace on `dev` (reused across issues)
- the workspace is long-lived, not created/destroyed per issue
- since V1 runs one issue at a time, there is no contention
- failed or blocked runs leave the workspace intact for inspection
- operator can clean up via `loomforge cleanup`

### 5. Builder runner

Responsibilities:

- prepare the Codex prompt/context package (including git instructions: commit format, push to `dev` only, never push to default branch)
- run Codex in the project workspace through its harness
- capture stdout/stderr, exit code, changed files, and summary
- normalize output into structured artifacts
- verify that commits and push landed correctly after the builder exits

Harness invocation:

- binary: `codex` CLI, subcommand `exec`
- permission mode: `--dangerously-bypass-approvals-and-sandbox` (no interactive prompts; the builder must write files, run commands, and iterate autonomously within the workspace)
- working directory: set to the project workspace path
- prompt is passed via stdin (heredoc), never as a CLI argument — avoids `ARG_MAX` limits and shell escaping issues with code snippets, JSON, backticks, and `$`
- stdout/stderr are captured to `builder.log`
- Loomforge kills the child process on wall-clock timeout

Git responsibility split:

Codex (builder) owns `git add`, `git commit`, and `git push` because git hooks (pre-commit, pre-push) may reject operations. Codex in full-auto can see the hook failure, fix the underlying issue (lint, format, test), and retry — Loomforge cannot because it has no LLM access to reason about or fix hook failures.

Loomforge owns `git rebase` of `dev` onto the default branch before each run. This is a pre-build step before Codex is invoked. If the rebase produces conflicts, the run transitions to `blocked` with `failureReason: rebase_conflict` because rebase conflicts require human judgment.

Claude (reviewer) performs no git operations — read-only analysis only.

Commit and push contract:

The builder is invoked twice in different modes during the workflow:

1. **Build phase** — Codex implements the issue and commits:
   - the prompt instructs Codex to `git add` and `git commit` on the `dev` branch after implementation
   - commit message format: `<issue-identifier>: <summary>` (e.g. `TEZ-412: add workflow state machine`)
   - Codex does NOT push during build phase
   - if a pre-commit hook rejects, Codex fixes the code and retries autonomously
   - during revision loops, each revision is a new commit (not an amend) so the full history is inspectable

2. **Push phase** (after review passes) — Codex pushes:
   - the prompt instructs Codex to `git push` the `dev` branch to remote
   - push is to `dev` only — the prompt explicitly forbids pushing to the default/main branch
   - if a pre-push hook rejects, Codex fixes and retries
   - this is what transitions the run from `ready_for_ship` to `shipped`

Review always runs against committed changes on `dev`, not dirty workspace state.

Builder prompt contract:

The builder prompt must include the full issue context and explicit workflow
instructions. Loomforge constructs this prompt — the builder receives it on stdin.

Required sections:

1. **Issue** — identifier, title, description, acceptance criteria, implementation
   notes, and relevant comments passed verbatim from Linear. Do not summarize.
2. **References** — design doc or implementation plan paths (if linked in the
   issue or found in the repo's `docs/` directory), relevant interfaces/types/stubs
   from the codebase (if they exist).
3. **Approach** — instruct the builder to:
   - read the repo's AGENTS.md / CLAUDE.md and explore the codebase architecture
     before writing any code
   - deliver a complete, integrated feature — wire into callers, routes, exports,
     config, and entry points so the feature is reachable without manual follow-up
   - prefer tests first: write/update failing tests that prove the behavior, then
     implement until tests pass; if TDD is not practical, explain why and still add
     coverage
4. **Git rules** — branch, commit format, no push during build phase
5. **Gate** — include the project's verification commands so the builder
   self-checks before finishing. Loomforge does not run a separate verification
   phase in V1; these commands are builder instructions and reviewer evidence.
6. **Output contract** — require structured output:

   ```
   CHANGED_FILES:
   - <path>

   SUMMARY:
   <what was done>

   VERIFICATION:
   - <command>: <pass/fail and key output>
   - git status --short: <output>
   - git diff --name-only: <output>
   ```

   or, on failure:

   ```
   FAILED_NO_CHANGES: <exact blocker>
   ```

No-op detection:

After every builder run, Loomforge inspects stdout for the output contract. A run
that produces no structured output, no changed files, or commentary-only text
is a no-op. First no-op gets one corrective retry with concrete evidence of
what was missing. Second consecutive no-op is a hard block with
`failureReason: runner_error`.

What Loomforge verifies after each builder invocation:

- after build phase: new commits exist on `dev` (otherwise outcome is `failed`)
- after push phase: remote is up to date via `git rev-list --left-right --count HEAD...origin/<branch>` (otherwise outcome is `failed` with `failureReason: push_failed`)
- commit SHAs are recorded in the `BuilderResult` artifact

Contract:

```ts
interface BuilderResult {
  outcome: "success" | "failed" | "blocked";
  summary: string;
  changedFiles: string[];
  commitSha: string | null; // null if outcome is not success
  rawLogPath: string;
}
```

### 6. Reviewer runner

Responsibilities:

- prepare the Claude review package
- run Claude review through its harness
- include diff, issue context, and builder-reported evidence
- normalize findings into P0/P1/P2 buckets

Harness invocation:

- binary: `claude` CLI (Claude Code)
- permission mode: `--dangerously-skip-permissions` (no interactive approval prompts; the reviewer runs unattended as a daemon subprocess)
- the reviewer prompt is constructed by Loomforge to be read-only in practice (diff analysis, not code mutation), but the permission bypass is required because Claude Code has no read-only mode and the daemon cannot respond to interactive prompts
- working directory: set to the project workspace path so the reviewer can read files for context
- the review prompt includes: diff, issue context, acceptance criteria, and builder-reported evidence when available
- prompt is passed via `-p` flag with stdin (heredoc), not as a positional argument
- stdout/stderr are captured to `review.log`
- Loomforge kills the child process on wall-clock timeout

Reviewer prompt contract:

The reviewer prompt must frame the review as both a staff engineer and a product
manager. The reviewer checks implementation quality AND whether the feature
actually delivers working functionality.

Required instructions:

1. **Read-only** — do not edit, commit, or push
2. **Complete in one run** — finish the full review without pausing to ask whether
   to continue
3. **Review focus areas** (all required):
   - **Integration**: is the new code wired into the rest of the system? Are
     callers updated, routes registered, exports added, config connected? Code
     that implements a feature in isolation but is never called is incomplete.
   - **Correctness**: logic errors, off-by-one, null handling, concurrency
   - **Regressions**: does the change break existing behavior?
   - **Edge cases**: boundary conditions, error paths, empty/missing input
   - **Test quality**: do tests exercise the actual behavior, not just prove
     the code compiles? Are integration touchpoints covered?
   - **Completeness**: would a user or caller of this feature get working
     functionality without manual follow-up work?
4. **Builder evidence** — Loomforge should include the builder's reported
   verification summary when available so the reviewer can assess whether checks
   were meaningful
5. **Finding classification** — P0 (must fix), P1 (should fix), P2 (follow-up)
6. **Structured output** — JSON with `outcome`, `findings`, `summary`

Outcome routing (non-negotiable):

Route strictly on the `outcome` field from the review, not on the tone of
the findings or Loomforge's own assessment of the diff:

- `pass` → skip fix phase, go straight to push. Do not launch a fix pass
  to polish nits or address P1/P2 findings. An extra fix pass on a passing
  review wastes a round-trip, risks regressing the approved diff, and can
  flip a clean ship into a re-review loop. The reviewer is the gate; trust
  the gate.
- `revise` → enter revision loop with actionable findings
- `blocked` → terminal, write failure reason

Contract:

```ts
interface ReviewFinding {
  severity: "P0" | "P1" | "P2";
  title: string;
  detail: string;
  file?: string;
}

interface ReviewResult {
  outcome: "pass" | "revise" | "blocked";
  findings: ReviewFinding[];
  summary: string;
  rawLogPath: string;
}
```

### Runner permission model rationale

Both runners must operate without interactive approval because Loomforge runs as an unattended daemon. There is no TTY or user present to approve tool calls.

Security is maintained through other constraints:

- runners only execute in registered project workspaces, never arbitrary paths
- Loomforge controls the prompt — issue text cannot inject arbitrary runner flags
- verification commands come from project config and are passed to the builder, not read from issue text
- Loomforge commits and pushes to the `dev` branch only, never to `main`
- wall-clock timeouts kill runaway processes
- code must pass Claude review before push

### 7. Artifact store

Responsibilities:

- persist prompts used for each builder/reviewer run
- store builder logs, review logs, and handoff data
- store run summaries and findings
- expose stable file paths for OpenClaw inspection

Suggested filesystem layout:

```text
~/.loomforge/
├── data/
│   ├── loom.db
│   ├── runs/
│   │   └── <run-id>/
│   │       ├── builder-prompt.md
│   │       ├── builder.log
│   │       ├── review-prompt.md
│   │       ├── review.log
│   │       └── handoff.json
└── worktrees/
```

## Workflow state machine

```text
queued
  -> preparing_workspace
  -> building (commits changes on success)
  -> reviewing
  -> revising (if review requires fixes)
  -> building
  -> ready_for_ship (committed, review passed, push pending)
  -> shipped (Loomforge marks Done in Linear, notifies OpenClaw)

failure exits from any non-terminal state:
- blocked
- failed
- cancelled

explicit blocked transitions:
- preparing_workspace -> blocked (dirty workspace, env error)
- reviewing -> blocked (review cannot complete or still rejects after the single revision pass)

cancellation:
- any non-terminal state (queued, preparing_workspace, building, reviewing,
  revising) may transition to cancelled via API or daemon shutdown
```

State meanings:

- `queued`: accepted but not started
- `preparing_workspace`: workspace setup + rebase `dev` onto default branch
- `building`: Codex is implementing
- `reviewing`: Claude is reviewing the diff and builder evidence
- `revising`: findings are being fed back into another builder loop
- `ready_for_ship`: implementation and review passed, changes committed on `dev` — Codex push in progress (intermediate, not terminal)
- `shipped`: `dev` pushed to remote, Linear marked Done, OpenClaw notified — terminal
- `blocked`: human or configuration help required
- `failed`: unrecoverable runner/workspace/push failure
- `cancelled`: operator stopped the run

Cancellation rules:

- any non-terminal state may transition to `cancelled` through the API or daemon shutdown path
- graceful daemon shutdown should not discard run state; interrupted work must remain recoverable on next start

Non-happy-path terminal states carry a machine-readable `failureReason`:

`failed` reasons (unrecoverable, no human intervention will help without code changes):

- `timeout`
- `runner_error`
- `workspace_error`
- `recovery_error`
- `push_failed`

`blocked` reasons (needs human or operator intervention):

- `rebase_conflict`
- `runner_auth_missing`
- `dirty_workspace`
- `review_loop_exhausted`
- `env_failure`

`cancelled` reasons (intentional stop):

- `operator_cancel`
- `daemon_shutdown`

V1 revision policy:

- one review-driven revision pass is allowed by default
- `revisionCount` is incremented when review findings are fed back to the builder
- if the reviewer still cannot pass the run after that correction, the run becomes `blocked`
- verification command failures reported by the builder are reviewer evidence, not a separate orchestrator state

## Persistence model

Use SQLite for runtime state.

Core tables:

- `projects`
- `runs`
- `run_attempts`
- `workspaces`
- `reviews`
- `review_findings`
- `artifacts`
- `events`

Important principle:

- config belongs in files
- execution history belongs in SQLite + artifact files

### Phase 3 persistence implementation

The first persistence implementation should use Node's built-in `node:sqlite`
`DatabaseSync` API so Loomforge does not need a native SQLite package dependency in
V1. The implementation lives behind a small `WorkflowRunStore` interface; the
workflow engine calls that interface whenever it creates a run, updates a
state, creates an attempt, records runner output, updates queue position, or
creates the final handoff.

The SQLite store is not allowed to own orchestration decisions. It is a durable
snapshot/event store for the workflow engine:

- `projects` mirrors checked-in project config for foreign-key integrity and diagnostics
- `runs` stores the current state, failure reason, queue position, issue snapshot, and handoff JSON
- `run_attempts` stores each build -> review cycle
- `workspaces` stores the active workspace path and branch per run
- `reviews` and `review_findings` expose structured query surfaces in addition to the attempt JSON snapshots
- `artifacts` records durable artifact paths such as `handoff.json`
- `events` records every state transition and revision request in append order

The engine remains the source of lifecycle truth. SQLite persistence must be
easy to replace or repair without spreading database calls through Linear,
workspace, runner, API, or MCP modules.

Relationship model:

- one `run` = one top-level request to execute a specific issue
- one `run_attempt` = one build -> review cycle within that run
- a revise loop creates another `run_attempt` under the same `run`

Recovery must use a two-phase transition model:

1. record runner completion as an event with artifact/log pointers
2. advance the run state

On restart:

- if completion event exists without the matching state transition, apply the transition
- if neither exists, rerun the interrupted step from scratch
- assume child Codex/Claude processes are dead and do not attempt to reconnect to them

First-cut restart recovery:

- `loomforged` constructs the workflow engine with the SQLite store during daemon bootstrap
- the store lists all non-terminal runs (`queued`, `preparing_workspace`, `building`, `reviewing`, `revising`, `ready_for_ship`)
- persisted `queued` runs keep their FIFO order and return to the ready queue
- persisted in-flight runs are requeued with a `state_transition` event back to `queued` containing `recoveryReason: daemon_restart` and `recoveredFromState`
- the next queue drain reruns the run from the workflow start; old attempts/events remain inspectable, and new attempts are appended
- terminal runs (`shipped`, `blocked`, `failed`, `cancelled`) are never automatically requeued

Every state transition should emit an event row so recovery can reconstruct the latest valid state.

## OpenClaw integration

V1 integration should stay explicit. OpenClaw's role is simplified: it tells Loomforge _what_ to work on (by issue identifier), and Loomforge handles the rest.

### MCP server

The primary integration path between OpenClaw and Loomforgeforge is **MCP (Model Context Protocol)**.

Why MCP over raw HTTP:

- OpenClaw is a Claude Code instance — MCP is its native tool protocol
- Loomforge's typed contracts (zod schemas) map directly to MCP tool schemas
- OpenClaw gets structured tool discovery, not prompt instructions on how to format curl calls
- no shell parsing, no text scraping — the exact problems Loomforge was built to eliminate

MCP tools exposed by Loomforge:

- `loom_submit_run` — submit an issue for execution (project slug + issue identifier + execution mode)
- `loom_get_run` — get full run state, findings, and handoff data
- `loom_get_queue` — list queued and active runs
- `loom_retry_run` — retry a failed/blocked run
- `loom_cancel_run` — cancel a run
- `loom_cleanup_workspace` — clean up a workspace
- `loom_health` — daemon health check

OpenClaw configuration:

```jsonc
// ~/.claude/settings.json (or project-level)
{
  "mcpServers": {
    "loomforge": {
      "command": "loomforge",
      "args": ["mcp-serve"],
    },
  },
}
```

The MCP server runs as a subprocess spawned by OpenClaw's Claude Code session, connecting to the running `loomforged` daemon over its local HTTP API. This means the HTTP API still exists as the internal transport — the MCP server is a thin typed adapter on top of it.

The HTTP API and CLI remain available for operator diagnostics and non-MCP consumers.

### Trigger contract

OpenClaw sends (via `loom_submit_run` MCP tool or `POST /runs`):

- project slug
- Linear issue identifier (e.g. `TEZ-412`)
- execution mode: `run_now_if_idle` or `enqueue`
- optional design doc references
- optional priority/reason metadata

Loomforge fetches the full issue details (title, description, acceptance criteria, labels, comments) from Linear directly. OpenClaw no longer needs to package issue content.

### Response contract

Loomforge returns a run ID immediately, then OpenClaw polls or reads status via `loom_get_run`.
If the run was queued, Loomforge also returns queue position metadata.

Final handoff back to OpenClaw includes:

- run status
- workspace path
- branch name
- changed files
- commit SHAs
- remote push status
- builder-reported verification summary when available
- review summary
- structured P0/P1/P2 findings
- Linear issue status after update
- recommended next action (`merge`, `blocked`, `retry`, `manual_review`)

`handoff.json` is a contract boundary with OpenClaw and should be defined as an explicit zod schema early, alongside the DB/event model. The schema must include a `version` field (starting at `1`) so OpenClaw and Loomforge can evolve at different speeds without silent contract drift.

In V1, OpenClaw still decides what enters Loomforge, but Loomforge handles everything from issue fetching through review. Loomforge owns the ready queue and starts the next queued run when idle.

## Failure modes and handling

### Runner/auth failures

Examples:

- Codex harness missing or unauthenticated
- Claude harness missing or unauthenticated

Handling:

- fail fast during preflight
- mark run `blocked`
- return exact reason to OpenClaw

### Runner timeout or hang

Examples:

- Codex process never exits
- Claude review stalls without producing output

Handling:

- enforce per-runner wall-clock timeouts from project config
- kill the child process on timeout
- attach partial logs and mark `failed` with `failureReason: timeout`
- if policy later allows timeout retries, consume revision budget explicitly rather than retrying forever

### Dirty workspace

Examples:

- target repo has uncommitted changes on default branch
- existing workspace contains unrelated edits

Handling:

- refuse to run
- mark `blocked`
- require operator cleanup

### Builder-reported gate failure

Examples:

- tests fail
- lint or format checks fail

Handling:

- the builder should fix the failure before committing whenever possible
- if the builder reports the failure as a blocker, attach logs and mark the run
  `failed` or `blocked` based on the runner result
- Loomforge does not run a separate verification phase

### Review loop exhaustion

Examples:

- reviewer still rejects the change after the single revision pass

Handling:

- mark `blocked`
- keep workspace and artifacts for inspection

### Process interruption

Examples:

- daemon crash
- host restart

Handling:

- recover from SQLite state and artifact files
- use the two-phase transition model from the persistence section to determine whether to advance state or rerun the interrupted step
- never assume the old child process is still alive after restart
- operator can retry from the last stable point if automatic recovery cannot decide safely

## Security and trust model

V1 assumes a single trusted local operator environment.

Rules:

- Loomforge only runs against explicitly registered local repos
- runner commands execute in registered project workspaces, not arbitrary paths
- Codex and Claude access must stay CLI-only in V1; those CLIs own their own authentication
- Loomforge does not store OpenAI or Anthropic API keys
- verification commands come from project config, not issue text, and are passed to the builder as self-check instructions
- no arbitrary external code execution surface beyond configured runners and git/test commands
- Loomforge commits and pushes to the `dev` branch only, never to the default/main branch — merging `dev` into `main` is owned by OpenClaw or the operator

## Reference material and reuse guidance

### Paperclip reference repo

Path: `~/projects/paperclip`

Paperclip is a full platform with multi-tenant orgs, Postgres, UI, plugins, and 7+ adapter types. Most of it is too heavy to extract for Loomforge. Build Loomforge from scratch, referencing two specific sources:

### Dev-build skill (primary reference)

Path: `~/.openclaw/workspace/backups/paperclip-revert/dev-build-SKILL.backup.md`

The proven workflow that Loomforge is hardening into a durable state machine. Reference for:

- workflow shape: Context → Build → Verify → Review → Fix → Ship
- builder prompt requirements (what to include: issue title, description, acceptance criteria, file paths)
- reviewer prompt requirements (review only, P0/P1/P2 classification, no file edits)
- revision loop logic (feed P0s + easy P1s back to builder, re-verify, re-review, repeat until zero P0s)
- Linear query patterns (which fields to fetch, status transitions)
- complexity assessment (small/medium/large) and deep reasoning (`ULTRATHINK`) for complex issues
- commit message format: `feat(TEZ-XXX): <description>` or `fix(TEZ-XXX): <description>`
- final review sweep for batches of 3+ issues

### Paperclip MCP server (pattern reference)

Path: `~/projects/paperclip/packages/mcp-server/src/tools.ts`

Reference for:

- `makeTool` pattern: clean tool definition with zod schema + execute function
- error formatting (`formatErrorResponse`)
- tool input validation with zod `.parse()`

### What NOT to reuse from Paperclip

- **Database layer** — Paperclip uses Postgres via Drizzle. Loomforge uses SQLite. Different driver, simpler schema.
- **Worktree config** (`server/src/worktree-config.ts`) — tied to Postgres ports, multi-instance repair, env file management. Too coupled.
- **Execution workspaces** (`server/src/services/execution-workspaces.ts`) — tied to Drizzle ORM, multi-workspace runtime services. The `runGit()` helper pattern is useful but trivial to rewrite.
- **Adapter registry** (`server/src/adapters/`) — supports 7+ adapters with plugins. Loomforge just needs Codex + Claude.
- **Auth, approvals, companies, org-chart, budgets, UI routes** — all out of scope for Loomforge.

## Recommended V1 stack

- Node 22+
- TypeScript
- Fastify for local HTTP API
- Commander for CLI
- `@modelcontextprotocol/sdk` for MCP server
- `@linear/sdk` for Linear API access
- better-sqlite3 or equivalent synchronous SQLite driver
- execa for process spawning
- zod for config and API validation
- pino for logs
- `yaml` or `js-yaml` for project config parsing

## Initial directory structure

```text
loom/
├── CLAUDE.md
├── README.md
├── docs/
│   ├── APPROACHES.md
│   ├── CONTEXT.md
│   └── loom-v1-design.md
├── src/
│   ├── api/
│   ├── app/
│   ├── config/
│   ├── db/
│   ├── linear/
│   ├── mcp/
│   ├── workflow/
│   ├── runners/
│   ├── worktrees/
│   ├── artifacts/
│   └── cli/
└── tests/
```

## V1 build order

0. project scaffolding, package manager, tsconfig, lint/test harness, and baseline CI/local commands
1. config loader + project registry + global config (`~/.loomforge/config.yaml`)
2. workflow engine state machine, run/attempt/event types, queue-drain behavior, one-pass revision policy, and stub dependency tests
3. SQLite schema + event model + `handoff.json` zod schema wired to the workflow contracts
4. runnable daemon shell: local HTTP API + CLI wrapper wired to the engine, SQLite store, and stub Linear/workspace/runner dependencies
5. workspace manager for reusable `dev` branch workspace and pre-run rebase
6. Linear client for issue fetch, issue snapshot artifacts, and status sync
7. MCP server adapter over the local HTTP API
8. OpenClaw integration contract and end-to-end MCP tool exercise
9. real Codex/Claude runner adapters, including prompt construction, output parsing, timeouts, partial logs, commit validation, and push validation
10. `launchd` installer/status integration for running `loomforged` with OpenClaw startup

Implementation note: if the repository already has step 1 working, the next
meaningful change is not more project-config surface. Build `src/workflow/`
first with dependency interfaces and tests that prove the whole happy path and
revision loop. The SQLite, Linear, workspace, runner, API, and MCP modules can
then replace those test doubles without changing the state machine.

Runnable-shell note: step 4 intentionally comes before real Linear, git, Codex,
and Claude integrations. The first daemon may wire the engine to stub
Linear/workspace/builder/reviewer implementations, but it must still
expose the real process boundary: CLI -> local HTTP API -> workflow engine ->
SQLite-backed state. That gives OpenClaw/MCP and operator commands a stable
target while later steps replace the stubs.

## Human decisions locked in

1. V1 language: TypeScript.
2. V1 should include a small durable ready queue so orchestration can move out of cron.
3. Verification commands stay repo-config only in V1 and are passed to the builder as self-check instructions.
4. Loomforge runtime data lives under `~/.loomforge/`.
5. V1 uses `launchd` integration and should spin up along with OpenClaw.
6. Loomforge owns Linear integration (issue fetching + status sync), not OpenClaw.
7. Linear is the only issue tracker in V1.
8. OpenClaw integrates with Loomforge via MCP server as the primary path.
9. Codex builder runs in `full-auto` mode, Claude reviewer runs with `skip-permissions`.

## Recommendation

Build Loomforge V1 as a slim local TypeScript daemon with an MCP server (primary OpenClaw integration), HTTP API, CLI wrapper, SQLite state, a small durable ready queue, direct Linear integration for issue fetching and status sync, a single long-lived `dev` branch workspace per project (rebased on `main` before each run), repo-configured builder self-check commands, `~/.loomforge/` runtime storage, `launchd` lifecycle integration with OpenClaw startup, and a complete build-review-revise-once-push pipeline. Codex commits after each build and pushes after review passes; Loomforge marks the issue Done in Linear and creates a PR from `dev` to `main` for the completed project batch. OpenClaw’s role is reduced to selecting issues and deciding when to merge. That gets the real win — durable workflow execution with minimal OpenClaw burden — without dragging in Paperclip’s platform surface.
