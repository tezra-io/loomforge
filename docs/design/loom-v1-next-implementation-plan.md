# Loomforge V1 Next Implementation Plan

This plan starts from the current runnable shell:

- `loomforge start` launches a Fastify daemon.
- CLI commands call the daemon over local HTTP.
- The workflow engine persists runs in SQLite.
- Linear, workspace, builder, verifier, and reviewer dependencies are still stubs.

The next work should replace those stubs with real adapters while keeping the
engine as the center of the system. Do not spend more time expanding
`src/config/` unless a real adapter needs a config field to run.

## Resume Commands

Use these before starting any phase:

```sh
pnpm install
pnpm run build
pnpm run test
pnpm run lint
pnpm run format
pnpm exec tsx src/cli/index.ts --help
```

Use these to run the current shell manually:

```sh
pnpm run dev -- start --config ./loom.yaml --port 3777
pnpm run dev -- status
pnpm run dev -- submit loom TEZ-1
pnpm run dev -- queue
```

## Phase 1: Real Verification Runner

Goal: replace the stub verifier with a runner that executes project verification
commands.

Files to add or change:

- `src/runners/verification-runner.ts`
- `src/runners/index.ts`
- `src/app/runtime.ts`
- `tests/runners/verification-runner.test.ts`

Implementation:

- Add `execa` as a dependency.
- Implement `VerificationRunner` from `src/workflow/types.ts`.
- Run each `project.verification.commands` entry in the prepared workspace.
- Use the command timeout from the command config or project verification timeout.
- Capture stdout, stderr, exit code, duration, and command name.
- Return `passed` only when every command exits successfully.
- Return `failed` for normal command failures.
- Return `blocked` for environment-level failures such as missing binary or invalid cwd.
- Persist or reference a verification log artifact path in the result.
- Keep command strings trusted from project config only. Do not execute issue text.

Done when:

- API submitted runs use the real verifier by default.
- Tests cover pass, failing command, missing binary/env failure, timeout, and multi-command aggregation.
- `pnpm run build && pnpm run test && pnpm run lint && pnpm run format` pass.

## Phase 2: Git Workspace Manager

Goal: replace the stub workspace with a manager that prepares the project repo's
`dev` branch for each run. No worktrees — work directly in the repo checkout.

Files to add or change:

- `src/worktrees/git-workspace-manager.ts` (rename module to `workspace` later if desired)
- `src/worktrees/index.ts`
- `src/app/runtime.ts`
- `tests/worktrees/git-workspace-manager.test.ts`

Implementation:

- Implement `WorktreeManager` from `src/workflow/types.ts` (interface stays the same — it returns a `WorkspaceSnapshot` with `path` and `branchName`).
- Remove `worktreeRoot` from `ProjectConfig` and config schema since the workspace is the repo itself. Update `WorkspaceSnapshot.path` to return `project.repoRoot`.
- Update DB schema: rename `worktree_path` to `workspace_path` and drop `worktree_root` from the projects table.
- Use `execa` for git operations in `project.repoRoot`.
- Validate `project.repoRoot` exists and is a git repo.
- Ensure the configured `devBranch` exists locally. Create it from `defaultBranch` if missing.
- Checkout `devBranch` in the repo.
- Fetch remote refs when possible, but do not make network fetch failures fatal unless needed for correctness.
- Before each run, ensure the checkout is clean.
- Rebase `devBranch` onto `defaultBranch`.
- Return `blocked` with `rebase_conflict` on rebase conflicts.
- Return `blocked` with `dirty_workspace` on uncommitted changes.
- Return `workspace.path` as `project.repoRoot` (the repo itself, not a worktree).

Done when:

- Runs execute in the real repo on the `dev` branch.
- Existing API/CLI run flow still works.
- Tests cover branch creation, reuse, dirty workspace, rebase conflict, and clean checkout.
- `pnpm run build && pnpm run test && pnpm run lint && pnpm run format` pass.

## Phase 3: Linear Client

Goal: fetch issue details and update Linear status from Loomforge instead of relying
on OpenClaw to package issue content.

Files to add or change:

- `src/linear/linear-workflow-client.ts`
- `src/linear/index.ts`
- `src/app/runtime.ts`
- `src/config/index.ts`
- `tests/linear/linear-workflow-client.test.ts`

Implementation:

- Add `@linear/sdk` as a dependency.
- Load the Linear API key from global config, expected at `~/.loomforge/config.yaml`.
- Implement `LinearWorkflowClient` from `src/workflow/types.ts`.
- Fetch issue by identifier, including title, description, labels, assignee, priority, comments, and useful timestamps.
- Normalize fetched data into `IssueSnapshot`.
- Store the issue snapshot on the run and expose it through `GET /runs/:id`.
- Update Linear status using per-project `linearStatuses` mapping.
- If the API key is missing or invalid, block the run with `runner_auth_missing` or an equivalent auth-specific reason.

Done when:

- API submitted runs fetch real issue snapshots before preparing the workspace.
- Status transitions are called for In Progress, In Review, Done, and Blocked/Failed.
- Tests use a mocked Linear SDK client and cover fetch, missing issue, status update, and auth/config failure.

## Phase 4: Artifact Store And Log Endpoints

Goal: make every runner prompt/log/handoff inspectable from stable disk paths and
API endpoints.

Files to add or change:

- `src/artifacts/artifact-store.ts`
- `src/artifacts/index.ts`
- `src/api/server.ts`
- `src/workflow/engine.ts`
- `tests/artifacts/artifact-store.test.ts`
- `tests/api.test.ts`

Implementation:

- Store artifacts under `<runtime.dataRoot>/runs/<run-id>/`.
- Write issue snapshot, builder prompt/log, verification log, reviewer prompt/log, and `handoff.json`.
- Add `GET /runs/:id/artifacts`.
- Add `GET /runs/:id/logs`.
- Ensure artifact paths are also represented in SQLite `artifacts`.
- Keep handoff JSON validated by the existing zod schema.

Done when:

- A shipped stub run writes a real `handoff.json`.
- API can list artifact metadata for a run.
- API can return log content or log metadata without exposing arbitrary filesystem paths.

## Phase 5: MCP Server Adapter

Goal: let OpenClaw talk to Loomforge through MCP while the daemon remains the runtime
owner.

Files to add or change:

- `src/mcp/server.ts`
- `src/mcp/http-adapter.ts`
- `src/mcp/index.ts`
- `src/cli/program.ts`
- `tests/mcp/server.test.ts`

Implementation:

- Add `@modelcontextprotocol/sdk` as a dependency.
- Add `loomforge mcp-serve`.
- The MCP server should be a thin stdio process.
- It should call the already-running `loomforged` HTTP API.
- Expose these tools:
  - `loom_submit_run`
  - `loom_get_run`
  - `loom_get_queue`
  - `loom_retry_run`
  - `loom_cancel_run`
  - `loom_cleanup_workspace`
  - `loom_health`
- Validate inputs with zod.
- Return structured errors without leaking stack traces.

Done when:

- `loomforge mcp-serve` starts as a stdio MCP server.
- Tool calls map one-to-one to local HTTP routes.
- Tests cover tool schema validation and HTTP adapter calls.
- Documentation includes the Claude/OpenClaw MCP config snippet.

## Phase 6: Retry, Cancel, And Timeout Hardening

Goal: make long-running adapter behavior operationally safe before real Codex and
Claude runners are enabled.

Files to add or change:

- `src/workflow/engine.ts`
- `src/app/drain-scheduler.ts`
- `src/api/server.ts`
- `src/cli/program.ts`
- runner and adapter tests as needed

Implementation:

- Add `POST /runs/:id/retry`.
- Make retry create a new queued run or reset an existing terminal run in a clearly documented way.
- Ensure cancel can stop queued runs immediately.
- Define behavior for cancelling an active run before real child-process cancellation lands.
- Ensure each real adapter gets a timeout value from project config.
- Ensure timeout exits return `failed` with `failureReason: timeout`.
- Record partial logs when a process is killed.

Done when:

- Retry and cancel behavior is deterministic and tested.
- Timeout behavior is shared by verifier, builder, and reviewer runners.
- Restart recovery still passes after retry/cancel changes.

## Phase 7: Real Codex Builder And Claude Reviewer Runners

Goal: replace the stub builder and reviewer with real child-process runners that
spawn Codex and Claude in the project repo on the `dev` branch.

Both runners share a common pattern: spawn a CLI child process in the repo,
pass a prompt, capture stdout/stderr to artifacts, parse structured output, and
enforce a wall-clock timeout. Extract a shared process-runner harness and build
both runners on top of it.

Files to add or change:

- `src/runners/process-runner.ts` (shared harness: spawn, capture, timeout, kill)
- `src/runners/codex-builder-runner.ts`
- `src/runners/claude-reviewer-runner.ts`
- `src/runners/prompts/builder.ts`
- `src/runners/prompts/reviewer.ts`
- `src/runners/index.ts`
- `src/app/runtime.ts`
- `tests/runners/process-runner.test.ts`
- `tests/runners/codex-builder-runner.test.ts`
- `tests/runners/claude-reviewer-runner.test.ts`

### Shared process-runner harness

- Spawn a child process via `execa` in a given cwd.
- Capture stdout and stderr to artifact paths.
- Enforce a wall-clock timeout from project config. Kill the child on timeout.
- Record partial logs when a process is killed.
- Return raw output for the caller to parse.

### Codex builder

- Spawn `codex` in the project repo on the `dev` branch.
- Use `codex exec --dangerously-bypass-approvals-and-sandbox`.
- Pass the prompt via stdin.
- Build prompt must include issue snapshot, acceptance criteria, current run
  context, revision findings, verification failures, and git rules. Reference
  the builder prompt contract in `docs/dev-build-skill-v2.md` for the prompt
  structure.
- Build phase must instruct Codex to commit but not push.
- Push phase must instruct Codex to push only the configured `devBranch`.
- Parse or derive `BuilderResult`.
- Validate that a new commit exists after build success.
- Validate that remote is up to date after push success.

### Claude reviewer

- Spawn `claude` in the project repo on the `dev` branch.
- Use `--dangerously-skip-permissions`.
- Review prompt must be read-only by contract.
- Include issue snapshot, diff, verification evidence, and review rubric.
  Reference the reviewer prompt contract in `docs/dev-build-skill-v2.md` for
  the prompt structure and finding severity levels.
- Require P0/P1/P2 findings in structured output.
- Parse output into `ReviewResult`.
- Treat malformed output as `blocked` — the reviewer is read-only, so malformed
  output means the LLM is confused, not that the code is broken.

Done when:

- A real local repo issue can reach `ready_for_ship` using Codex builder plus
  the real verifier plus Claude reviewer.
- Review findings drive the existing revision loop.
- Passing review moves the run to `ready_for_ship`.
- Tests use a fake executable or process harness and cover: builder success,
  builder failure, builder timeout, missing commit, push failure, reviewer
  pass, reviewer revise findings, reviewer blocked, malformed output, and
  reviewer timeout.
- `pnpm run build && pnpm run test && pnpm run lint && pnpm run format` pass.

## Phase 8: End-To-End Local Exercise

Goal: prove Loomforge can run a real project through the whole loop.

Implementation:

- Create a small fixture repo or use a harmless local project.
- Configure Loomforge with real verification commands.
- Submit an issue ID backed by a real or mocked Linear issue.
- Run through workspace prep, Codex build, verification, Claude review, push, and handoff.
- Document exact commands and observed outputs in `docs/loom-v1-e2e-notes.md`.

Done when:

- One real run reaches `shipped`.
- `handoff.json` contains changed files, commit SHA, verification results, review result, branch, and recommended next action.
- OpenClaw can poll or fetch the final state through MCP or HTTP.

## Phase 9: Launchd Integration

Goal: make `loomforged` start reliably with the local operator environment.

Files to add or change:

- `src/launchd/`
- `src/cli/program.ts`
- `docs/loom-v1-launchd.md`

Implementation:

- Add CLI commands for install, uninstall, start, stop, restart, and status.
- Generate a user-level launchd plist.
- Ensure logs have stable paths under `~/.loomforge/logs/`.
- Document how OpenClaw expects Loomforge to be running before MCP tool calls.

Done when:

- `loomforge launchd install` or equivalent installs the service.
- `loomforge status` reports daemon health and active run state.
- Manual daemon start remains available for development.

## Current Priority

Start with Phase 1, the real verification runner. It is the smallest real
adapter, it does not require Linear credentials, and it turns the current shell
from a pure stub loop into an engine that can execute meaningful project checks.

After Phase 1, implement Phase 2 and Phase 3. Those can be developed mostly
independently, but the runtime should only switch to real end-to-end defaults
when both have enough tests to avoid damaging a working repo.

