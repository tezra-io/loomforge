# Loomforge Spec

Loomforge is a slim local workflow engine for agentic software delivery. It
turns explicit Linear work into reviewed, PR-ready changes using local Codex and
Claude runners.

This spec describes Loomforge's public behavior. Implementation details belong
in the architecture docs and source tree.

## Goals

Loomforge must:

1. Accept explicit work submissions through CLI, HTTP API, or MCP.
2. Fetch issue details directly from Linear.
3. Persist runs, queue state, attempts, events, artifacts, and handoff data.
4. Prepare the configured project workspace on a shared `dev` branch.
5. Invoke a builder runner to implement and commit changes.
6. Invoke a reviewer runner to review the committed diff.
7. Allow one review-driven revision pass.
8. Push `dev` after review passes.
9. Mark the Linear issue Done and create a project PR from `dev` to the default
   branch when the project batch completes.
10. Run a design flow that can turn requirements into a scaffolded project,
    reviewed design doc, Linear project, and registered Loomforge project.

## Non-Goals

Loomforge is not:

- a hosted multi-tenant platform
- a browser UI
- an autonomous manager hierarchy
- a budgeting or approval system
- a generic issue-tracker abstraction
- a replacement for human merge decisions

## System Boundary

Loomforge owns:

- run queueing and execution
- Linear issue fetching and status updates
- local SQLite state
- project workspace preparation
- builder/reviewer runner invocation
- artifacts and handoff records
- push to the configured `dev` branch
- PR creation from `dev` to the default branch after project completion

The operator or upstream agent owns:

- choosing what work enters Loomforge
- writing requirements/designs/issues
- resolving blocked runs
- reviewing and merging PRs

Codex CLI and Claude Code own their own authentication. Loomforge does not store
OpenAI or Anthropic API keys.

## Project Config

Projects are registered in `~/.loomforge/loom.yaml`.

Each project defines:

- `slug`
- `repoRoot`
- `defaultBranch`
- optional `devBranch`, defaulting to `dev`
- Linear team/project mapping
- builder and reviewer runner choices
- verification commands passed to the builder as self-check instructions
- timeouts, review policy, and Linear status names

Loomforge reads Linear credentials from `~/.loomforge/config.yaml` or
`LINEAR_API_KEY`.

## Build Workflow

The build flow is:

```text
queued
  -> preparing_workspace
  -> building
  -> reviewing
  -> revising    # optional, at most once
  -> building
  -> reviewing
  -> ready_for_ship
  -> shipped
```

Terminal exits are:

- `shipped`
- `blocked`
- `failed`
- `cancelled`

There is no separate orchestrator verification phase. Verification commands in
project config are included in the builder prompt so the builder can self-check
before handoff. The reviewer receives the committed diff and available builder
evidence.

## Workspace And Branch Contract

Loomforge uses one configured workspace per project.

Before each run, Loomforge:

1. Ensures the workspace exists and is a Git repo.
2. Refuses to run if the workspace has unrelated uncommitted changes.
3. Fetches remote refs.
4. Checks out the configured `devBranch`.
5. Rebases `devBranch` onto the configured default branch.

All implementation commits land on `devBranch`. Loomforge never pushes directly
to `main`, `master`, or the configured default branch.

## Runner Contract

The builder runner:

- runs in the project workspace
- receives the Linear issue context and project instructions
- reads the target repo's `AGENTS.md` or `CLAUDE.md`
- implements the issue
- commits changes on `devBranch`
- reports changed files, summary, and verification evidence
- does not push during the build phase

The reviewer runner:

- runs in the project workspace
- reviews only the committed diff
- does not edit, commit, or push
- returns structured JSON with `pass`, `revise`, or `blocked`

If review requests changes, Loomforge allows one revision pass. After that,
continued review failure becomes a blocked run rather than an unbounded loop.

After review passes, Loomforge asks the builder runner to push `devBranch`.

## Design Workflow

The design flow is operator-triggered. It does not autonomously discover new
projects or features.

For a new project, Loomforge:

1. Accepts a slug plus requirement text or a requirement file.
2. Scaffolds a local Git repo.
3. Creates the remote GitHub repo when configured.
4. Runs a design builder to draft a structured design document.
5. Runs a design reviewer and applies one revision when needed.
6. Publishes the result as a Linear project document.
7. Registers the new project in `~/.loomforge/loom.yaml`.
8. Reloads project config so the build flow can use the new project.

For an existing project, Loomforge can draft and review a feature-extension
design document without creating a new repo.

## Queue And Recovery

Loomforge runs one build run at a time. Additional submissions enter a durable
FIFO queue.

On restart, Loomforge reloads non-terminal runs from SQLite. Queued runs keep
their order. In-flight runs are requeued from the start of the workflow, with
prior attempts and events kept for inspection.

## Artifacts

Loomforge stores artifacts under the configured runtime data root, including:

- issue snapshots
- builder logs
- reviewer logs
- attempt records
- review findings
- final handoff data

The handoff record includes the run status, workspace path, branch, changed
files, commit SHAs, push status, review summary, Linear status, and recommended
next action.

## Safety Model

Loomforge assumes a trusted single-user local machine.

Safety constraints:

- work only starts from explicit submissions
- project paths must be registered in config
- runner commands execute in the registered project workspace
- issue text cannot set runner flags
- runner auth remains inside Codex CLI and Claude Code
- Linear is the only API key Loomforge stores or reads
- pushes target only the configured `devBranch`
- default-branch merges remain operator-owned
- wall-clock timeouts kill stuck runner processes

## Public Interfaces

Loomforge exposes:

- CLI commands for setup, daemon control, submission, queue inspection, retry,
  cancel, and design/build status
- a local HTTP API used by the CLI and MCP adapter
- an MCP server for agent integration

Package scripts remain the source of truth for development checks.
