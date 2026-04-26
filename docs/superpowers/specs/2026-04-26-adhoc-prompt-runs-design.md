# Ad-hoc Prompt Runs

## At a glance

```
caller          Loomforge daemon                                Linear      build engine
  │
  │  POST /runs/adhoc { project, prompt }
  ├──────────────────►
  │                   1. resolve project (slug OR absolute path)
  │                   2. validate Linear preconditions
  │                   3. validate prompt (non-empty, ≤ cap)
  │                   4. issueCreate ─────────────────────────►  LOOM-456
  │                      (label: loomforge-adhoc)
  │                   5. submitRun({ projectSlug, issueId,
  │                                  source: "adhoc" })
  │                                                              ────────►  queued / runs
  │  ◄────────────────  { runId, issueId, linearUrl,
  │                      queuePosition }
  │                                                                         (existing engine path)
  │                                                                         build → verify
  │                                                                         → review → push
  │                                                                         → status=Done ─►  closes LOOM-456
```

## Problem

Loomforge today requires a Linear issue identifier to start a run. The submit path is `{ projectSlug, issueId }`; the engine then calls `linear.fetchIssue` to materialize an `IssueSnapshot` that flows through builder → verify → review → push. This works for issue-driven work but blocks a common case: **an operator (typically OpenClaw) wants to fire off a small, well-scoped task by prompt against a known project**, without first hand-authoring a Linear issue.

## Goal

A pipeline that takes one input (`project`, `prompt`) and:

1. Resolves the project from the registry.
2. Creates a single Linear issue from the prompt under the project's Linear project, tagged with a `loomforge-adhoc` label.
3. Submits a normal build run against that issue.
4. Lets the existing engine drive build → verify → review → push → status sync (which closes the Linear issue on `shipped`).

The Linear issue is the source of record. Loomforge authors it, but it lives in Linear like any other ticket.

## Non-goals

- A second execution path. Ad-hoc reuses the existing build engine end-to-end. The only engine change is a `source` discriminator on `RunRecord`.
- Running ad-hoc against projects without Linear configured. Linear is mandatory; we want every change tracked.
- Multi-issue prompts. One prompt → one issue → one run. If a prompt needs decomposition, use the planning flow.
- A `--dry-run` mode. The flow is short and synchronous up to issue creation; failures are visible immediately.
- Auto-deletion of the Linear issue if the run later fails. The issue stays so the operator can inspect or rerun.
- Editing or reusing existing Linear issues. Each ad-hoc submit creates a fresh issue.
- CWD fallback for the `project` argument. Always required (see Decisions).

## Command surface

### HTTP

```
POST /runs/adhoc
  body: {
    project: string,    // slug OR absolute folder path
    prompt: string      // free text, 1..8000 chars
  }

  200: {
    runId: string,
    issueId: string,             // Linear identifier, e.g. "LOOM-456"
    linearUrl: string,
    queuePosition: number
  }
  400 validation_failed:        { error, details }
  404 project_not_found:        { error, projectIdentifier }
  409 linear_not_configured:    { error, projectSlug, missing: ["linearTeamKey" | "linearProjectName"] }
  502 linear_create_failed:     { error, reason }
  500 submit_after_create_failed: { error, orphanedIssueId, runId: null }
```

### CLI

```
loomforge run "<prompt>" --project <slug-or-path>
  # --project is REQUIRED. No CWD fallback (see Decisions).
  # prints: { runId, issueId, linearUrl }
```

### MCP

```
loom_submit_adhoc({ project: string, prompt: string })
  # delegates to POST /runs/adhoc via the existing http-adapter
  # returns the same payload as the HTTP route
```

## Inputs / preconditions

The project must already be registered in `~/.loomforge/loom.yaml` and have:

- `repoRoot` — the build engine needs it to prepare a worktree.
- `linearTeamKey` — required for issue creation.
- `linearProjectName` — resolved to a Linear project ID at submit time.
- `devBranch` — used by the existing build engine; not new.

Linear API credentials are read from the global config (same source the existing flows use).

If any precondition is missing, the submit fails fast with a typed error and **no side effects** (no run row, no Linear issue, no worktree).

## Project resolution

`project` accepts two shapes:

1. **Slug** — matches `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`. Looked up directly in the registry.
2. **Absolute path** — looked up by comparing against each registered project's `repoRoot` (after `path.resolve` on both sides). Relative paths are rejected with `validation_failed`.

If the input matches neither, return 404 `project_not_found` with the original identifier in the payload.

## Linear issue creation

For the synthesized issue:

- **Title:** first non-empty line of the prompt, trimmed and truncated at 80 chars (matches the planner convention). If the entire prompt is whitespace, return 400 `validation_failed`.
- **Description:** the full prompt body, with a footer line:
  `_Submitted via Loomforge ad-hoc on YYYY-MM-DD._`
- **Label:** `loomforge-adhoc`. Resolved by listing the workspace's labels and matching by name; if missing, a single `labelCreate` call adds it. Concurrent submits that both try to create can race — handle by retrying once and re-listing. Label resolution failures map to `linear_create_failed` with `reason: "label_setup_failed"`.
- **Project:** the project's resolved Linear project ID.
- **Team:** resolved from `linearTeamKey`.
- **State:** the team's workflow state named `Backlog`, looked up at submit time. If absent, fail fast with `linear_create_failed` and `reason: "missing_backlog_state"`. No `loom.yaml` knob in v1 (revisit if a workspace uses a different name). After creation, the engine transitions the issue to "in progress" / "done" via the existing Linear status sync — same path human-authored issues use.

The Linear SDK call is the same `issueCreate` wrapper used by the planning flow (`src/linear/issue-create.ts`). Whichever feature lands first builds the wrapper; the other reuses it.

## Engine changes

Touch points are deliberately small:

1. **DB migration:** `runs` gains a `source` column, `NOT NULL DEFAULT 'linear'`. Existing rows backfill cleanly.
2. **`RunRecord.source: "linear" | "adhoc"`** — typed in `src/workflow/types.ts`. Threaded through `SubmitRunInput`, store load/save, and engine logging.
3. **`src/workflow/adhoc.ts`** (new) — orchestrator for the pre-step:
   - resolve project (slug or path)
   - validate Linear preconditions (mirrors `planning.ts`)
   - call `issue-create.ts`
   - on success, call `engine.submitRun({ projectSlug, issueId, source: "adhoc", executionMode: "enqueue" })`
   - return `{ runId, issueId, linearUrl, queuePosition }`
4. **No changes to** the build / verify / review / push / Linear status sync steps. They consume `IssueSnapshot` exactly as today; the engine fetches the issue from Linear in step 1 of `executeRun`, same as for human-authored issues. Closure on `shipped` happens through the existing status sync.

`source` is metadata for observability and a hook for tiny tweaks (today: setting the label). No new states, no new transitions, no parallel execution path.

## Error handling

All errors short-circuit before any irreversible side effect. The Linear issue is created **only after every other precondition passes**, so we never litter Linear with orphaned ad-hoc tickets.

| Stage | Trigger | Surface |
|---|---|---|
| Submit | Project not in registry | 404 `project_not_found` — no run row, no Linear call |
| Submit | Linear preconditions missing | 409 `linear_not_configured` — lists which fields |
| Submit | Prompt empty / over cap / whitespace-only | 400 `validation_failed` |
| Submit | Linear `issueCreate` fails (auth, rate limit, schema drift) | 502 `linear_create_failed` (reason from Linear) |
| Submit | Label `findOrCreate` fails | 502 `linear_create_failed` with `reason: "label_setup_failed"` |
| Submit | Linear issue created but `submitRun` fails (e.g., DB write) | 500 `submit_after_create_failed` with `orphanedIssueId`. Logged; not auto-cleaned. |
| Engine (post-submit) | Existing build/verify/review/push failures | Unchanged — same `RunState` and `failureReason` as today |

## State & artifacts

No new SQLite tables. Reuse `runs` with the new `source` column. Existing `run_attempts`, `run_events`, and artifact rows work unchanged because the engine path is unchanged.

Artifacts under `<dataRoot>/artifacts/<run-id>/` follow the same layout as a Linear-driven run:

- `issue_snapshot.json` — the `IssueSnapshot` Loomforge fetched back from Linear (same as today; the issue we just created).
- builder/verifier/reviewer artifacts — unchanged.

No special ad-hoc artifact (e.g., the original prompt) is persisted separately; the prompt is captured inside the Linear issue description and the issue snapshot.

## Decisions

1. **Always create a real Linear issue.** Considered: skip Linear entirely for ad-hoc (a `source: "adhoc"` flag with synthesized in-memory issue snapshot). Rejected because Linear remains the system of record and downstream visibility (PR titles, status, history) depends on a real ticket. Creating the issue costs one API call; the upside is uniformity.
2. **No CWD fallback for `--project`.** Loomforge is primarily invoked by OpenClaw agents whose CWD is OpenClaw's directory, not the target repo. Implicit CWD resolution would silently point operations at the wrong project — in the worst case writing artifacts or commits into OpenClaw itself. Always require explicit `project`.
3. **One issue per ad-hoc submit, no idempotency.** Re-submitting the same prompt creates a new issue. Matches the planner's stance; revisit only if duplicates become painful in practice.
4. **Label is fixed (`loomforge-adhoc`), not configurable.** Configuration surface for v1 stays minimal. Add a `loom.yaml` knob later if a user actually needs it.
5. **Linear issue is authored before the run row.** If issue creation fails, no run row exists, so the queue stays clean. The narrow window where the issue exists but `submitRun` fails (DB write error on local SQLite) is a near-impossible path; we log the orphaned issue and let the operator handle it. No auto-rollback because deleting Linear issues programmatically introduces more failure modes than it solves.
6. **`source` discriminator, not a separate table.** Ad-hoc runs are structurally identical to Linear-driven runs once the issue exists; a column is the right granularity. Mirrors the planning flow's `run_type` decision.
7. **Reuse `src/linear/issue-create.ts` from the planning flow.** Whichever flow lands first builds it; the other consumes. No premature factoring of a "Linear write client."
8. **No `--dry-run`.** The submit path is short, synchronous up to issue creation, and every failure is visible immediately in the response. A dry-run flag would only exercise validation, which the schema already covers.

## Open risks

- **Prompt quality is the operator's problem.** A vague prompt produces a vague Linear issue and a likely review-loop exhaustion. We don't pre-process or critique the prompt. Acceptable for v1.
- **Label `findOrCreate` race.** Two concurrent ad-hoc submits to a workspace that's never had the label could both try to create it. Linear's API rejects the duplicate; the loser falls back to lookup. Worth handling but not worth a lock — implement as `findOrCreate` with one-retry-on-409.
- **Linear schema drift.** Same risk as the planning flow: if the workspace lacks an estimate field, label scope, or default backlog state, creation fails. Caught and surfaced as `linear_create_failed`. No silent recovery.
- **Orphaned issue on `submit_after_create_failed`.** Logged but not auto-cleaned. A maintenance script can sweep `loomforge-adhoc`-labeled issues that have no corresponding `runs` row, but that's out of scope for v1.

## Implementation order

Build in this order. Tests before code at each step.

1. **DB migration** — add `source` column to `runs`, `NOT NULL DEFAULT 'linear'`. Update store load/save.
2. **`RunRecord.source` typed in `src/workflow/types.ts`** — thread through `SubmitRunInput` and engine logging. No behavioral change for existing flows.
3. **`src/linear/issue-create.ts`** — if not yet present from the planning flow. Wraps `@linear/sdk` `issueCreate`; handles label `findOrCreate`. Tested against a fake Linear client.
4. **`src/workflow/adhoc.ts`** — the orchestrator. Resolves project, validates preconditions, calls `issue-create`, calls `engine.submitRun`. All error paths typed. Tested with fake registry, fake Linear client, fake engine.
5. **`POST /runs/adhoc`** route in `src/api/server.ts` + zod schema. Tested via Fastify inject.
6. **`loomforge run "<prompt>" --project <slug-or-path>`** in `src/cli/program.ts`. Tested via the existing CLI integration harness.
7. **`loom_submit_adhoc`** MCP tool in `src/mcp/server.ts` + adapter binding. Tested via the existing MCP harness.
8. **Manual verification** — submit an ad-hoc run against `loom-test`, observe: Linear issue created with label, run flows through to `shipped`, Linear issue closed.
9. **`skills/loomforge/SKILL.md`** — add an "Ad-hoc run" section alongside the existing CLI Commands / Project Lifecycle / Design Flow sections. Cover: when to use it, the `loomforge run` CLI, the `loom_submit_adhoc` MCP tool, the required `--project` argument (with the OpenClaw-CWD safety reasoning), and the error surfaces an operator will hit.
10. **`README.md`** — under Usage, add an "Ad-hoc run" subsection between "Issue build flow" and "Design flow". Include the CLI command, a one-paragraph description, and a link or pointer to the skill for deeper detail. Update the Table of Contents accordingly.

Stop after step 4 + manual smoke against `loom-test`. Only ship the surfaces (5–7) once the orchestrator produces a clean end-to-end run. Steps 9–10 land last so the docs match shipped behavior.

## Testing approach

Five new test files, mirroring the planning-flow style:

1. `tests/workflow/adhoc.test.ts` — orchestrator unit tests with fakes. Cases: project not found (slug + path forms), Linear unconfigured, prompt validation (empty / whitespace / over cap), Linear create fails, label setup fails, happy path, `submit_after_create` recorded with `orphanedIssueId`.
2. `tests/linear/issue-create.test.ts` — wrapper tests including the ad-hoc shape: title truncation at 80 chars, footer present in description, `loomforge-adhoc` label attached, `findOrCreate` retry on label race.
3. `tests/api/runs-adhoc.test.ts` — Fastify route tests: validation, all error codes, happy path payload shape.
4. `tests/cli/run-command.test.ts` — `--project` required, calls the route, prints the payload.
5. `tests/mcp/adhoc-tool.test.ts` — MCP tool delegates to the HTTP route.

Existing engine tests get one new case: a run with `source: "adhoc"` flows through the same states and ends in `shipped` with the Linear issue closed.

Tests follow the project rule: no machine-absolute paths baked in; use tmpdirs / fixtures / env.
