# Loom V1 Next Implementation Plan

This plan starts from the current runnable shell:

- `loom start` launches a Fastify daemon.
- CLI commands call the daemon over local HTTP.
- The workflow engine persists runs in SQLite.
- Linear, worktree, builder, verifier, and reviewer dependencies are still stubs.

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

## Phase 2: Git Worktree Manager

Goal: replace the stub workspace with a reusable `dev` branch worktree per
project.

Files to add or change:

- `src/worktrees/git-worktree-manager.ts`
- `src/worktrees/index.ts`
- `src/app/runtime.ts`
- `src/api/server.ts`
- `src/cli/program.ts`
- `tests/worktrees/git-worktree-manager.test.ts`

Implementation:

- Implement `WorktreeManager` from `src/workflow/types.ts`.
- Use `execa` for git operations.
- Validate `project.repoRoot` exists and is a git repo.
- Create or reuse `project.worktreeRoot`.
- Ensure the configured `devBranch` exists locally.
- Fetch remote refs when possible, but do not make network fetch failures fatal unless needed for correctness.
- Before each run, ensure the worktree is clean.
- Rebase `devBranch` onto `defaultBranch`.
- Return `blocked` with `rebase_conflict` on rebase conflicts.
- Return `blocked` with `dirty_workspace` on uncommitted changes.
- Add cleanup support for an operator-requested worktree cleanup.

Done when:

- Runs execute in a real worktree path instead of a temp/stub path.
- Existing API/CLI run flow still works.
- `POST /workspaces/:project/:issue/cleanup` or an equivalent cleanup endpoint exists.
- CLI has `loom cleanup`.
- Tests cover create, reuse, dirty workspace, rebase conflict, and cleanup.

## Phase 3: Linear Client

Goal: fetch issue details and update Linear status from Loom instead of relying
on OpenClaw to package issue content.

Files to add or change:

- `src/linear/linear-workflow-client.ts`
- `src/linear/index.ts`
- `src/app/runtime.ts`
- `src/config/index.ts`
- `tests/linear/linear-workflow-client.test.ts`

Implementation:

- Add `@linear/sdk` as a dependency.
- Load the Linear API key from global config, expected at `~/.loom/config.yaml`.
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

Goal: let OpenClaw talk to Loom through MCP while the daemon remains the runtime
owner.

Files to add or change:

- `src/mcp/server.ts`
- `src/mcp/http-adapter.ts`
- `src/mcp/index.ts`
- `src/cli/program.ts`
- `tests/mcp/server.test.ts`

Implementation:

- Add `@modelcontextprotocol/sdk` as a dependency.
- Add `loom mcp-serve`.
- The MCP server should be a thin stdio process.
- It should call the already-running `loomd` HTTP API.
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

- `loom mcp-serve` starts as a stdio MCP server.
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

## Phase 7: Real Codex Builder Runner

Goal: replace the stub builder with Codex CLI execution for implementation and
push phases.

Files to add or change:

- `src/runners/codex-builder-runner.ts`
- `src/runners/prompts/builder.ts`
- `src/runners/index.ts`
- `src/app/runtime.ts`
- `tests/runners/codex-builder-runner.test.ts`

Implementation:

- Spawn `codex` in the issue worktree.
- Use `--approval-mode full-auto`.
- Pass the prompt via stdin or a supported prompt flag.
- Build prompt must include issue snapshot, acceptance criteria, current run context, revision findings, verification failures, and git rules.
- Build phase must instruct Codex to commit but not push.
- Push phase must instruct Codex to push only the configured `devBranch`.
- Capture stdout/stderr to artifacts.
- Parse or derive `BuilderResult`.
- Validate that a new commit exists after build success.
- Validate that remote is up to date after push success.
- Timeout and kill child process on wall-clock timeout.

Done when:

- A real local repo issue can reach `ready_for_ship` using Codex plus the real verifier.
- Tests use a fake `codex` executable or process harness and cover success, failure, timeout, missing commit, and push failure.

## Phase 8: Real Claude Reviewer Runner

Goal: replace the stub reviewer with Claude Code review execution.

Files to add or change:

- `src/runners/claude-reviewer-runner.ts`
- `src/runners/prompts/reviewer.ts`
- `src/runners/index.ts`
- `src/app/runtime.ts`
- `tests/runners/claude-reviewer-runner.test.ts`

Implementation:

- Spawn `claude` in the issue worktree.
- Use `--dangerously-skip-permissions`.
- Review prompt must be read-only by contract.
- Include issue snapshot, diff, verification evidence, and review rubric.
- Require P0/P1/P2 findings in structured output.
- Parse output into `ReviewResult`.
- Treat malformed output as `failed` with `runner_error`.
- Timeout and kill child process on wall-clock timeout.

Done when:

- Review findings drive the existing revision loop.
- Passing review moves the run to `ready_for_ship`.
- Tests cover pass, revise findings, blocked findings, malformed output, and timeout.

## Phase 9: End-To-End Local Exercise

Goal: prove Loom can run a real project through the whole loop.

Implementation:

- Create a small fixture repo or use a harmless local project.
- Configure Loom with real verification commands.
- Submit an issue ID backed by a real or mocked Linear issue.
- Run through worktree prep, Codex build, verification, Claude review, push, and handoff.
- Document exact commands and observed outputs in `docs/loom-v1-e2e-notes.md`.

Done when:

- One real run reaches `shipped`.
- `handoff.json` contains changed files, commit SHA, verification results, review result, branch, and recommended next action.
- OpenClaw can poll or fetch the final state through MCP or HTTP.

## Phase 10: Launchd Integration

Goal: make `loomd` start reliably with the local operator environment.

Files to add or change:

- `src/launchd/`
- `src/cli/program.ts`
- `docs/loom-v1-launchd.md`

Implementation:

- Add CLI commands for install, uninstall, start, stop, restart, and status.
- Generate a user-level launchd plist.
- Ensure logs have stable paths under `~/.loom/logs/`.
- Document how OpenClaw expects Loom to be running before MCP tool calls.

Done when:

- `loom launchd install` or equivalent installs the service.
- `loom status` reports daemon health and active run state.
- Manual daemon start remains available for development.

## Current Priority

Start with Phase 1, the real verification runner. It is the smallest real
adapter, it does not require Linear credentials, and it turns the current shell
from a pure stub loop into an engine that can execute meaningful project checks.

After Phase 1, implement Phase 2 and Phase 3. Those can be developed mostly
independently, but the runtime should only switch to real end-to-end defaults
when both have enough tests to avoid damaging a working repo.

