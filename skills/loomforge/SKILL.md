---
name: loomforge
description: "Interact with the Loomforge workflow engine for agentic software delivery. Use whenever the user wants to submit Linear issues for building, check build/run status, manage the build queue, troubleshoot failed or blocked runs, kick off a nightly build, or ship issues for a project. Also use for the design flow: scaffolding a new project from a rough requirement, drafting or extending a design doc, publishing to Linear, and registering the project for future builds. Also use when the user asks about Loomforge setup, daemon health, or project configuration. Loomforge handles both the pre-build design pipeline (scaffold → draft → review → publish) and the full execution lifecycle (Linear fetch, build, review, push, pull request creation, Linear status sync)."
---

# Loomforge Workflow Engine

Loomforge is a local daemon that runs a build → review → ship pipeline for
Linear issues. It accepts issue IDs, fetches details from Linear, runs a
configurable builder and reviewer (with one revision pass if the review has
findings), and creates a pull request.

All interaction happens through the `loomforge` CLI.

## CLI Commands

```sh
loomforge status                      # daemon health
loomforge submit <project>            # enqueue all actionable issues for a project
loomforge submit <project> <issue>    # submit a single Linear issue
loomforge queue                       # list queued/active runs
loomforge get <runId>                 # run state, findings, handoff
loomforge cancel <runId>              # cancel a queued run
loomforge retry <runId>               # retry failed/blocked run
```

## Workflow States

```
queued → preparing_workspace → building → reviewing
  → ready_for_ship → shipped (terminal)
  → revising → building → ready_for_ship → shipped (one revision pass)
  → blocked / failed / cancelled (terminal)
```

## Project Lifecycle

### 1. Submit

```sh
loomforge submit <project>
```

Fetches all actionable issues from Linear, skips any with active runs, and
enqueues the rest in priority order. Returns immediately with enqueued run IDs.

For a single issue:

```sh
loomforge submit <project> <issue-id>
```

### 2. Poll for completion

```sh
loomforge get <runId>
```

Check individual run state, or check the full project:

```sh
loomforge queue
```

The run output includes a JSON body with completion status:

```json
{
  "done": true,
  "projectSlug": "my-project",
  "shipped": ["TEZ-1", "TEZ-2"],
  "failed": ["TEZ-3"],
  "blocked": [],
  "cancelled": [],
  "pullRequestUrl": "https://github.com/org/repo/pull/42"
}
```

- **`done: false`** — runs are still in progress, poll again later
- **`done: true`** — all runs reached a terminal state:
  - `shipped` — built, reviewed, pushed, and marked Done in Linear
  - `failed` — unrecoverable error (timeout, runner crash, push failure)
  - `blocked` — needs manual intervention (rebase conflict, dirty workspace, auth missing)
  - `cancelled` — cancelled by operator or daemon shutdown
  - `pullRequestUrl` — PR from dev→main if any issues shipped, `null` otherwise

### 3. Decide next action

- All shipped, PR created → tell the user the PR is ready for review
- Some failed/blocked → report which issues and why, offer to retry
- All failed → investigate root cause before retrying

## Ad-hoc Run

Use ad-hoc when you have a small, well-scoped task and don't want to hand-author a Linear issue first. Loomforge creates the Linear issue from your prompt, then runs the normal build pipeline against it. The Linear issue is the system of record — it gets a `loomforge-adhoc` label, transitions through "in progress" / "done" like any other ticket, and closes when the run ships.

### When to use
- Quick fixes, refactors, doc tweaks — anything you'd describe in 1–3 sentences.
- Tasks too small to be worth opening a Linear ticket by hand.
- Anything OpenClaw decides to fire off without going through the planning flow first.

### When NOT to use
- A feature that needs decomposition into multiple tickets — use the planning flow.
- A project without Linear configured — ad-hoc requires `linearTeamKey` and `linearProjectName` in `loom.yaml`.

### CLI

```bash
loomforge adhoc "Fix the typo in README" --project loom
loomforge adhoc "Update the CHANGELOG for 0.3.0" --project /Users/me/code/loom
```

`--project` is **required** and accepts either a registered slug or an absolute path to the repo root. There is no CWD fallback — Loomforge is typically invoked by OpenClaw whose working directory is OpenClaw's repo, not the target project. Falling back to CWD would silently target the wrong repo.

The command prints the run ID, the synthesized Linear identifier, the Linear URL, and the queue position. Track the run with `loomforge get <runId>` like any other.

### MCP

```text
loom_submit_adhoc({
  project: "loom",
  prompt: "Fix the typo in README",
})
```

Returns the same payload as the CLI.

### What gets created in Linear

- One issue, titled with the first non-empty line of the prompt (truncated at 80 chars).
- Description = full prompt + a dated footer (`_Submitted via Loomforge ad-hoc on YYYY-MM-DD._`).
- Label `loomforge-adhoc` (created lazily on first submit per workspace).
- Placed in the team's `Backlog` workflow state. The engine then transitions it through "in progress" / "done" via the existing Linear status sync.

### Errors you might see

| Status | Error | What to do |
|---|---|---|
| 400 | `validation_failed` | Check the prompt is non-empty and ≤ 8000 chars; project must be a slug or absolute path. |
| 404 | `project_not_found` | Register the project in `~/.loomforge/loom.yaml` first. |
| 409 | `linear_not_configured` | Add `linearTeamKey` and `linearProjectName` to the project entry. |
| 502 | `linear_create_failed` (with `reason`) | Check Linear API key, team/project name, label permissions, or that a `Backlog` workflow state exists on the team. |
| 500 | `submit_after_create_failed` (with `orphanedIssueId`) | Linear issue was created but the local DB write failed. Inspect the issue manually or delete it; Loomforge does not auto-clean. |

## Troubleshooting

- **Run failed** — check `failureReason` in `loomforge get <runId>`:
  - `timeout` — builder exceeded wall-clock limit
  - `runner_error` — builder or reviewer process error
  - `push_failed` — push to remote failed
- **Run blocked** — check `failureReason`:
  - `rebase_conflict` — dev branch conflicts with main, resolve manually
  - `dirty_workspace` — repo has uncommitted changes
  - `runner_auth_missing` — Codex or Claude CLI not authenticated
- **Retry**: `loomforge retry <runId>` — resets state and re-queues
- **Artifacts**: check `~/.loomforge/data/artifacts/<runId>/` for logs, prompts,
  and `handoff.json`

## Setup

For first-time setup (Linear API key, project config, starting the daemon),
read `references/setup.md`.

### Adding a new project

Append an entry to the `projects:` list in `~/.loomforge/loom.yaml`. Required
fields: `slug`, `repoRoot`, `defaultBranch`, `verification.commands`. See
`references/setup.md` for the full config schema and optional fields. Restart
the daemon after editing.

## Design Flow

Design flow is a separate command surface that takes a rough requirement and
produces a reviewed design doc, a Linear project (new) or Linear Document
(extend), and — for new projects with a GitHub remote — a registered
`loom.yaml` entry ready for the build workflow.

### CLI

```sh
loomforge design new <slug> --requirement-path <file>
loomforge design new <slug> --requirement-text "<markdown>"

loomforge design extend <slug> --feature <feature-slug> --requirement-path <file>
loomforge design extend <slug> --feature <feature-slug> --requirement-text "<markdown>"

loomforge design get <designRunId>
loomforge design cancel <designRunId>
loomforge design retry <designRunId>
loomforge design status <slug>
```

Input rules:
- Exactly one of `--requirement-path` or `--requirement-text` must be provided.
- `--requirement-path` is absolute on the daemon machine.
- `slug` and `--feature` must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`
  (lowercase, hyphen-separated).
- `--redraft` forces a fresh draft; without it, retries resume from the last
  incomplete step.

### MCP tools

| Tool | Purpose |
|---|---|
| `loom_design_new_project` | Start a new-project design run |
| `loom_design_extend_project` | Start an extend design run |
| `loom_get_design_run` | Fetch state, findings, handoff |
| `loom_cancel_design_run` | Cancel a queued or active run |
| `loom_retry_design_run` | Retry a failed/stuck run |
| `loom_get_design_run_status_for_project` | Latest run per project slug |

### State machine

```
validating → scaffolding → drafting → reviewing
  → (revising if reviewer said revise — one cycle, no re-review)
  → publishing → registering → complete
  → failed / blocked / cancelled (terminal)
```

Each step persists its durable artifact IDs (repo_path, remote_url,
design_doc_sha, linear_project_id, linear_document_id) so retries pick up from
the last incomplete step. `--redraft` clears `design_doc_sha` and downstream
fields.

### Handoff shape

```json
{
  "version": 1,
  "designRunId": "...",
  "kind": "new",
  "slug": "my-app",
  "feature": null,
  "state": "complete",
  "localDocPath": "<repoRoot>/my-app/docs/design/my-app-design.md",
  "linearProjectUrl": "https://linear.app/?project=...",
  "linearDocumentUrl": "https://linear.app/?document=...",
  "registration": "registered | needs_remote | skipped",
  "notes": [],
  "failureReason": null
}
```

`registration: needs_remote` means the design pipeline completed but
`loom.yaml` was not updated because there is no git remote yet. Set one up
manually, then re-run to register.

### Config

Add a `design:` section to `~/.loomforge/config.yaml`:

```yaml
design:
  repoRoot: ~/projects
  defaultBranch: main
  devBranch: dev        # optional
  linearTeamKey: TEZ
```

### Troubleshooting

See `references/design-flow.md` for failure reasons (`design_linear_conflict`,
`design_document_conflict`, `design_review_blocked`, …) and template details.
