# Loomforge — Agent Instructions

Loomforge is a slim local workflow engine for agentic software delivery.

## Commands

```sh
pnpm run build        # TypeScript compilation
pnpm run test         # Vitest test suite
pnpm run lint         # ESLint
pnpm run format       # Prettier check
pnpm run typecheck    # tsc --noEmit
```

## Code Rules

1. Linear flow. Max 2 nesting levels. Top to bottom.
2. Bound loops. Explicit max on retries, polls, recursion.
3. Small functions. 40-60 lines max. One job per function.
4. Own resources. Open → close on every path, including errors.
5. Narrow state. No module globals. Pass deps explicitly.
6. Assert assumptions. Guards and validation on every public function.
7. Never swallow errors. No bare catch that silently continues.
8. Visible side effects. I/O obvious at call site.
9. Minimal indirection. One layer of abstraction max.
10. Surgical changes only. Touch only what the task requires.
11. Warnings = errors. Zero lint/type warnings.

## Conventions

- Explicit types at module boundaries
- Package scripts are source of truth for build/test/lint
- Tests before implementation when practical
- Deliver complete, integrated features — wire into callers, routes, exports

## Architecture

- `src/api/` — Fastify HTTP endpoints
- `src/app/` — daemon bootstrap, runtime wiring
- `src/cli/` — Commander CLI wrapper
- `src/config/` — YAML project registry, zod validation
- `src/db/` — SQLite schema, migrations
- `src/linear/` — Linear API client
- `src/mcp/` — MCP server adapter (OpenClaw integration)
- `src/workflow/` — run state machine, queue drain
- `src/runners/` — Codex builder + Claude reviewer + verification
- `src/worktrees/` — git worktree management
- `src/artifacts/` — prompt/log/result persistence

## Design References

- `docs/loom-v1-design.md` — full V1 design
- `docs/CONTEXT.md` — project context and scope
