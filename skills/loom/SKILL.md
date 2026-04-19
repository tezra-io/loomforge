---
name: loomforge
description: Interact with the Loomforge workflow engine for agentic software delivery. Use when the user wants to submit issues for building, check run status, manage the build queue, or troubleshoot Loomforge runs. Loomforge handles the full lifecycle: Linear fetch, build, review, revision loops, push, and Linear status sync.
---

# Loomforge Workflow Engine

Loomforge is a local daemon (`loomforged`) that runs a build → review → ship
pipeline for Linear issues. It accepts issue IDs, fetches details from Linear,
runs a configurable builder and reviewer, and ships on a `dev` branch.

## Quick Reference

### CLI Commands

```sh
loomforge status                      # daemon health
loomforge submit <project> <issue>    # submit a single Linear issue
loomforge submit <project>            # enqueue all actionable issues for a project
loomforge queue                       # list queued/active runs
loomforge get <run-id>                # run state, findings, handoff
loomforge cancel <run-id>             # cancel a queued run
loomforge retry <run-id>              # retry failed/blocked run
```

### MCP Tools (for OpenClaw integration)

```sh
claude mcp add loomforge -- loomforge mcp-serve
```

Tools: `loom_health`, `loom_submit_run`, `loom_submit_project`, `loom_get_run`,
`loom_get_queue`, `loom_get_project_status`, `loom_cancel_run`, `loom_retry_run`,
`loom_cleanup_workspace`.

## Workflow States

```
queued → preparing_workspace → building → reviewing
  → ready_for_ship → shipped (terminal)
  → revising → building → ready_for_ship → shipped (one revision pass)
  → blocked / failed / cancelled (terminal)
```

## Project Lifecycle

### 1. Submit
Call `loom_submit_project` with the project slug. Returns immediately with enqueued run IDs.

### 2. Poll for completion
Call `loom_get_project_status` to check progress. The response tells you everything:

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
- **`done: true`** — all runs reached a terminal state, read the breakdown:
  - `shipped` — issues successfully built, reviewed, pushed, and marked Done in Linear
  - `failed` — issues that hit an unrecoverable error (timeout, runner crash, push failure)
  - `blocked` — issues that need manual intervention (rebase conflict, dirty workspace, auth missing)
  - `cancelled` — issues cancelled by operator or daemon shutdown
  - `pullRequestUrl` — PR from dev→main if any issues shipped, `null` otherwise

### 3. Decide next action
- All shipped, PR created → tell the user the PR is ready for review
- Some failed/blocked → report which issues and why (`loom_get_run` for details), offer to retry
- All failed → investigate root cause before retrying

## When to Use

- **Submit one issue**: `loomforge submit <project> <issue-id>` or `loom_submit_run`
- **Submit all project issues**: `loomforge submit <project>` or `loom_submit_project` —
  fetches all unstarted/started issues from Linear, skips any with active runs,
  and enqueues the rest in priority order
- **Check progress**: `loomforge get <run-id>` — shows current state, attempt
  count, findings, and handoff data
- **Run failed**: check `failureReason` in the run. Common reasons:
  - `timeout` — builder exceeded wall-clock limit
  - `runner_error` — builder or reviewer process error
  - `push_failed` — push to remote failed
- **Run blocked**: check `failureReason`:
  - `rebase_conflict` — dev branch conflicts with main, resolve manually
  - `dirty_workspace` — repo has uncommitted changes
  - `runner_auth_missing` — Codex or Claude CLI not authenticated
- **Retry**: `loomforge retry <run-id>` — resets state and re-queues
- **Artifacts**: check `~/.loomforge/data/artifacts/<run-id>/` for logs, prompts,
  and `handoff.json`

## Setup

Installation creates `~/.loomforge/` automatically with default config files:

- `~/.loomforge/config.yaml` — global config (Linear API key)
- `~/.loomforge/loom.yaml` — project registry (add projects here)
- `~/.loomforge/data/` — runtime data (SQLite, artifacts, logs)

### 1. Set your Linear API key

Edit `~/.loomforge/config.yaml`, or set the `LINEAR_API_KEY` environment variable:

```yaml
# ~/.loomforge/config.yaml
linear:
  apiKey: lin_api_YOUR_KEY_HERE
```

```sh
# Or use an env var (takes precedence if config file is missing)
export LINEAR_API_KEY=lin_api_YOUR_KEY_HERE
```

### 2. Add a project

Append to the `projects:` list in `~/.loomforge/loom.yaml`:

```yaml
projects:
  - slug: my-project
    repoRoot: /path/to/repo
    defaultBranch: main
    devBranch: dev
    linearTeamKey: TEZ              # required for project-level submission
    linearProjectName: My Project  # filters issues to this Linear project
    builder: codex                 # "codex" or "claude" (default: claude)
    reviewer: claude               # "codex" or "claude" (default: claude)
    verification:
      commands:
        - name: test
          command: pnpm test
        - name: lint
          command: pnpm run lint
    timeouts:
      builderMs: 900000         # 15 min (default: 30 min)
      reviewerMs: 300000        # 5 min (default: 10 min)
```

**Required fields**: `slug`, `repoRoot`, `defaultBranch`, `verification.commands`

**Optional fields**:
- `devBranch` — branch Loomforge works on (default: `dev`, must differ from `defaultBranch`)
- `linearTeamKey` — Linear team prefix, e.g. `TEZ` (required for `loomforge submit <project>`)
- `linearProjectName` — Linear project name to filter issues (recommended when team has multiple projects)
- `builder` — `"codex"` or `"claude"` (default: `claude`)
- `reviewer` — `"codex"` or `"claude"` (default: `claude`)
- `timeouts.builderMs` / `reviewerMs` — wall-clock limits
- `review.blockingSeverities` — findings that trigger revision (default: `["P0", "P1"]`)
- `linearStatuses.inProgress` / `inReview` / `done` / `blocked` — Linear status names

### 3. Start the daemon

```sh
loomforge start                          # uses ~/.loomforge/loom.yaml
loomforge start --config /other/path.yaml  # custom config
```

## Architecture

Loomforge runs as a local HTTP daemon. The CLI and MCP server proxy to it.

```
OpenClaw → MCP Server (stdio) → HTTP API → Workflow Engine
                                              ├── Linear Client
                                              ├── Worktree Manager
                                              ├── Builder Runner (Codex or Claude)
                                              ├── Reviewer Runner (Codex or Claude)
                                              ├── SQLite State Store
                                              └── Artifact Store
```
