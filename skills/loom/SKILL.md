---
name: loomforge
description: Interact with the Loomforge workflow engine for agentic software delivery. Use whenever the user wants to submit Linear issues for building, check build/run status, manage the build queue, troubleshoot failed or blocked runs, kick off a nightly build, or ship issues for a project. Also use when the user asks about Loomforge setup, daemon health, or project configuration. Loomforge handles the full lifecycle: Linear fetch, build, review, push, pull request creation, and Linear status sync.
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
