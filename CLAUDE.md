# loom

## Project
Loom is a slim local workflow engine for agentic software delivery.

It is intentionally narrower than Paperclip.

OpenClaw remains the front door and planner. Loom owns the full execution lifecycle: Linear fetch, build, verify, review, commit, push, and Linear status sync.

## How to Work

### Planning
- Plan mode for any non-trivial task (3+ steps or architectural decisions)
- Detailed specs upfront — good plan = 1-shot implementation
- State assumptions explicitly before coding. If multiple interpretations exist, surface them instead of picking silently.
- If the request is ambiguous, ask. If a simpler approach exists, say so.
- For multi-step work, write a short plan in `step -> verify` form.
- If something goes sideways, STOP and re-plan

### Test-First (Mandatory)
1. Write failing tests that define correct behavior
2. Make them pass
3. Refactor while green

"Write failing tests, then make them pass" — not "implement this feature."

### Verification
1. Write failing tests
2. Implement to pass them
3. Typecheck: `pnpm run typecheck`
4. Full test suite: `pnpm run test`
5. Lint: `pnpm run lint`

Never mark done without proving it works.

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
- `docs/spec.md` — Product spec: features, business rules
- `docs/tech.md` — Architecture: stack, schema, decisions
- `docs/lessons.md` — Rules from past mistakes (update immediately on correction)

## Don'ts
- Don't commit without running tests
- Don't implement without failing tests first
- Don't add abstractions you weren't asked for
- Don't silently choose among ambiguous interpretations
- Don't improve adjacent code that wasn't part of the request
- Don't assume intent on ambiguous bugs — ask

## Principles
- Simplest correct solution
- If 200 lines could be 50, rewrite it
- Find root causes, no band-aids
- Minimal blast radius
- Own mistakes — write a rule to prevent repeating

## Known Pitfalls
- Update this section every time the repo teaches you the same lesson twice.

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
- Do not turn Loom into Paperclip-lite.
- No org chart, CEO, manager, approval, budget, or multi-tenant abstractions in V1.
- OpenClaw decides what work enters Loom (by issue identifier only). OpenClaw does not package issue content.
- Loom owns the full execution lifecycle: Linear fetch, build, verify, review, commit, push, and Linear status sync.
- All issues commit to a single `dev` branch per project, rebased on `main` before each run. Loom never pushes to `main` — merging `dev` into `main` is OpenClaw's or operator's concern.
- OpenClaw integrates with Loom via MCP server as the primary path.
- All issues for a project run on a single `dev` branch worktree, rebased on `main` before each run.
- V1 allows one active run at a time, backed by a small durable ready queue.
- Loom should run as a `launchd`-managed local daemon and start along with OpenClaw.
- Keep Codex as the builder and Claude as the reviewer in V1.
- Codex and Claude access must stay harness-only. No direct OAuth, no generic first-party/third-party provider auth layer.
- Codex builder runs in `--approval-mode full-auto`. Claude reviewer runs with `--dangerously-skip-permissions`. Both are unattended daemon subprocesses.
- Verification commands come from project config, not issue text.
- Runtime state and artifacts live under `~/.loom/`.
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
- `src/workflow/` — run state machine and orchestration
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

Build Loom from scratch. Reference the dev-build skill for workflow shape, prompt patterns, and Linear queries. Reference Paperclip MCP for tool definition patterns. Do not extract or copy Paperclip code — it carries too much platform weight (Postgres, multi-tenant, plugins, auth, UI).

## Practical guidance for future work
- Keep v1 boring and durable.
- If a new feature smells like platform-building, push back.
- The queue exists to isolate orchestration from cron, not to introduce autonomous prioritization.
- Optimize for reliable execution, restart safety, clean launchd lifecycle behavior, and clear handoff to OpenClaw.
- Every state transition should be inspectable after the fact.
- Worktree hygiene matters more than clever prompts.
