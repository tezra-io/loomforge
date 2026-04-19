# loomforge

## Project
Loomforge is a slim local workflow engine for agentic software delivery.

It is intentionally narrower than Paperclip.

OpenClaw remains the front door and planner. Loomforge owns the full execution lifecycle: Linear fetch, build, verify, review, commit, push, and Linear status sync.

## Behavioral Guidance
- The approved design is the plan. Implement against it, do not quietly re-design the task mid-flight.
- Don't assume. State assumptions explicitly before coding. If multiple interpretations exist, surface them instead of picking silently.
- If the request or design is unclear, stop and ask. If repo reality conflicts with the design, surface the mismatch before coding.
- Prefer the simplest correct solution. No speculative abstractions, no extra flexibility, no "while I'm here" cleverness.
- Make surgical changes. Touch only what the request requires. Mention unrelated issues, don't fix them unless asked.
- For multi-step work, define success in `step -> verify` form and keep going until the checks pass.
- If 200 lines could be 50, rewrite it.

## Execution Contract
- If changing behavior, write or update a failing test first.
- Implement the smallest change that satisfies the design.
- Run the relevant repo commands below before calling the work done. Default expectation: typecheck or build, tests, and lint.
- For docs, config, or scaffolding changes, run the relevant checks and say what is not applicable.
- Never mark work done without proof.

## Code Rules (Non-Negotiable)

1. **Linear flow.** Max 2 nesting levels. Top to bottom.
2. **Bound loops.** Explicit max on retries, polls, recursion. Define cap behavior.
3. **Small functions.** 40-60 lines max. One job per function.
4. **Own resources.** Open → close on every path, including errors.
5. **Narrow state.** No module globals. Pass deps explicitly.
6. **Assert assumptions.** Guards and validation on every public function. Fail loud.
7. **Never swallow errors.** No bare `rescue`. No `{:error, _} -> :ok`. Log, raise, or return.
8. **Visible side effects.** I/O obvious at call site. Separate pure from effectful.
9. **Minimal indirection.** Readable > elegant. One layer of abstraction max.
10. **Surgical changes only.** Touch only what the request requires. Do not refactor adjacent code, comments, or formatting unless the task needs it. Remove only the dead code your change creates.
11. **Warnings = errors.** Linters, typecheckers, analyzers are hard gates. Zero warnings.

## Conventions
- Keep package scripts as the source of truth for build, test, lint, and typecheck commands.
- Prefer explicit types at module boundaries and avoid magic cross-file coupling.

## Commands
```sh
pnpm run build
pnpm run test
pnpm run lint
pnpm run format
```

## Docs
- `docs/` — repo docs directory, start here before coding
- `docs/loom-v1-design.md` — V1 design: architecture, state machine, contracts, build order
- `docs/CONTEXT.md` — Project context: why Loomforge exists, scope, system boundary
- `docs/APPROACHES.md` — Evaluated approaches and trade-offs
- `docs/loom-v1-review.md` — Design review findings and resolutions

## Known Pitfalls
- Do not confuse config work with Loomforge's product surface. Config is only step 1; the core product is the workflow engine that owns runs, queue draining, Linear sync, worktree prep, build, verification, review, revision loops, push, and handoff.
- After touching `src/config/`, the next implementation step should usually be `src/workflow/`, `src/db/`, `src/worktrees/`, `src/runners/`, `src/linear/`, `src/api/`, or `src/mcp/`. Do not add more config knobs unless an engine/module contract already needs them.

---
_Every mistake is a rule waiting to be written._

## Preserved Project-Specific Notes
These notes came from the previous `CLAUDE.md`. Keep the template above as the primary operating guide, and use the preserved context below where it is still relevant.

## Current V1 recommendation
- **Language:** TypeScript
- **Runtime:** Node 22+
- **API:** Fastify
- **CLI:** Commander
- **MCP:** `@modelcontextprotocol/sdk` (primary OpenClaw integration)
- **Issue tracker:** Linear (`@linear/sdk`)
- **State store:** SQLite
- **Validation:** zod
- **Process runner:** execa
- **Logging:** pino
- **Config parsing:** `yaml` or `js-yaml`

## Architecture rules
- Do not turn Loomforge into Paperclip-lite.
- No org chart, CEO, manager, approval, budget, or multi-tenant abstractions in V1.
- OpenClaw decides what work enters Loomforge (by issue identifier only). OpenClaw does not package issue content.
- Loomforge owns the full execution lifecycle: Linear fetch, build, verify, review, commit, push, and Linear status sync.
- OpenClaw integrates with Loomforge via MCP server as the primary path.
- All issues for a project commit to a single `dev` branch worktree, rebased on the default branch before each run. OpenClaw or the operator merges `dev` into `main`.
- V1 allows one active run at a time, backed by a small durable ready queue.
- Loomforge should run as a `launchd`-managed local daemon and start along with OpenClaw.
- Keep Codex as the builder and Claude as the reviewer in V1.
- Codex and Claude access must stay harness-only. No direct OAuth, no generic first-party/third-party provider auth layer.
- Codex builder runs in `--approval-mode full-auto`. Claude reviewer runs with `--dangerously-skip-permissions`. Both are unattended daemon subprocesses.
- Verification commands come from project config, not issue text.
- Runtime state and artifacts live under `~/.loomforge/`.
- Builder and reviewer runners produce structured artifacts, not just console output.
- Keep config in files and runtime state in SQLite.
- Prefer explicit state transitions over clever autonomous behavior.

## Non-goals
- browser UI
- hosted control plane
- autonomous prioritization
- multi-repo swarm intelligence
- generalized plugin marketplace
- replacing OpenClaw chat/planning

## Suggested directory structure
```text
.
├── CLAUDE.md
├── README.md
├── docs/
├── src/
│   ├── api/
│   ├── app/
│   ├── cli/
│   ├── config/
│   ├── db/
│   ├── linear/
│   ├── mcp/
│   ├── workflow/
│   ├── runners/
│   ├── worktrees/
│   └── artifacts/
└── tests/
```

## Initial module intent
- `src/api/` — local HTTP server and route handlers
- `src/app/` — daemon bootstrap, lifecycle wiring, launchd/service integration, config loading, and service composition
- `src/cli/` — operator-facing wrapper over the API
- `src/config/` — project registry + config validation
- `src/db/` — SQLite schema, migrations, repositories
- `src/linear/` — Linear API client for issue fetching and status sync
- `src/mcp/` — MCP server adapter for OpenClaw integration
- `src/workflow/` — run state machine and orchestration; this is the main engine and must call Linear, worktree, runner, verification, review, push, and handoff contracts in order
- `src/runners/` — harness-based Codex builder (full-auto) and Claude reviewer (skip-permissions) adapters
- `src/worktrees/` — git worktree creation, reuse, cleanup
- `src/artifacts/` — prompt/log/result persistence

## Design references
Read these before making major architecture changes:
- `docs/CONTEXT.md`
- `docs/APPROACHES.md`
- `docs/loom-v1-design.md`

External reference material:
- Paperclip reference repo: `/Users/sujshe/projects/paperclip`
- Dev-build skill (primary workflow reference): `/Users/sujshe/.openclaw/workspace/backups/paperclip-revert/dev-build-SKILL.backup.md`
- Paperclip MCP `makeTool` pattern: `/Users/sujshe/projects/paperclip/packages/mcp-server/src/tools.ts`
- Rollback baseline for old dev-build workflow: `/Users/sujshe/.openclaw/workspace/backups/paperclip-revert/REVERT_BASELINE_2026-04-08.md`

Build Loomforge from scratch. Reference the dev-build skill for workflow shape, prompt patterns, and Linear queries. Reference Paperclip MCP for tool definition patterns. Do not extract or copy Paperclip code — it carries too much platform weight (Postgres, multi-tenant, plugins, auth, UI).

## Practical guidance for future work
- Keep v1 boring and durable.
- If a new feature smells like platform-building, push back.
- The queue exists to isolate orchestration from cron, not to introduce autonomous prioritization.
- Optimize for reliable execution, restart safety, clean launchd lifecycle behavior, and clear handoff to OpenClaw.
- Every state transition should be inspectable after the fact.
- Worktree hygiene matters more than clever prompts.
