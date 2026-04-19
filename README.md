```
  _                        __
 | |    ___   ___  _ __ ___ / _| ___  _ __ __ _  ___
 | |   / _ \ / _ \| '_ ` _ \ |_ / _ \| '__/ _` |/ _ \
 | |__| (_) | (_) | | | | | |  | (_) | | | (_| |  __/
 |_____\___/ \___/|_| |_| |_|_| \___/|_|  \__, |\___|
                                           |___/
```

# Loomforge

A local workflow engine that automates the path from Linear issue to pull
request. It runs an agentic build → review → PR pipeline — fully unattended.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Why](#why)
- [Prerequisites](#prerequisites)
- [Quick Start (npm)](#quick-start-npm)
- [Install from Source](#install-from-source)
- [Configuration](#configuration)
- [Usage](#usage)
- [MCP Server (optional)](#mcp-server-optional)
- [Development](#development)
- [Testing](#testing)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What It Does

You point Loomforge at a Linear project. It fetches actionable issues, spins up
a builder agent (Codex or Claude) to write the code, runs a reviewer agent to
check it, applies one round of fixes if needed, pushes to a `dev` branch, and
opens a pull request. You review and merge — Loomforge handles everything
before that.

**Designed for:** solo developers and small teams who want overnight or
batch-mode code generation from well-specified Linear issues, without running
a heavyweight platform.

---

## Why

I've been running an overnight build pipeline since the early days of OpenClaw.
After brainstorming designs with OpenClaw and Claude during the day, a nightly
cron job would pick up the Linear issues, use Claude to build and Codex to
review, and move issues to Done by morning. It worked — until it didn't.
Breaking changes in Claude's tool use, instability in OpenClaw's ACP protocol,
and fragile skill wiring meant the workflow would silently break every few
weeks. I looked at Paperclip, but it carries too much weight — multi-tenant,
Postgres, plugin marketplace — for what is fundamentally a single-developer
overnight build loop. Loomforge is the lighter, purpose-built replacement:
same pipeline, fewer moving parts, easy to fix when something changes.

---

## Prerequisites

- **Node 22+**
- **[Codex CLI](https://github.com/openai/codex)** and/or **[Claude Code CLI](https://claude.ai/claude-code)** — builder and reviewer runners (configurable per project)
- **[Linear API key](https://linear.app/settings/api)** — issue fetching and status sync

---

## Quick Start (npm)

```sh
npm install -g loomforge
```

The installer scaffolds `~/.loomforge/` with default config files and attempts
to register the daemon and install the agent skill. If any optional step fails,
it prints a fallback command you can run manually.

| Step | Detail | Fallback if skipped |
|------|--------|---------------------|
| CLI | `loomforge` available on PATH | — (always succeeds) |
| Config | `~/.loomforge/config.yaml` and `loom.yaml` | — (always succeeds) |
| Daemon | launchd (macOS) or systemd (Linux) | `loomforge start` |
| Skill | Installed via `npx skills` | `npx skills add tezra-io/loomforge` |

> **Note:** Daemon auto-registration is supported on macOS and Linux only.
> On other platforms, start the daemon manually with `loomforge start`.

After install, configure your Linear API key and add a project
(see [Configuration](#configuration)).

---

## Install from Source

For contributors or users who prefer to build from source.

```sh
git clone git@github.com:tezra-io/loomforge.git
cd loomforge
pnpm install
pnpm run build
```

Link the CLI globally and run the setup:

```sh
pnpm link --global
node scripts/postinstall.js
```

This scaffolds `~/.loomforge/` and attempts to register the daemon and install
the agent skill — the same steps that `npm install -g` runs automatically.

After setup, configure your Linear API key and add a project
(see [Configuration](#configuration)).

---

## Configuration

### 1. Add your Linear API key

Edit `~/.loomforge/config.yaml`:

```yaml
linear:
  apiKey: lin_api_YOUR_KEY_HERE
```

Or set an environment variable instead:

```sh
export LINEAR_API_KEY=lin_api_YOUR_KEY_HERE
```

### 2. Add a project

Append to the `projects:` list in `~/.loomforge/loom.yaml`:

```yaml
projects:
  - slug: my-project
    repoRoot: /path/to/repo
    defaultBranch: main
    linearTeamKey: TEZ              # required for project-level submission
    linearProjectName: My Project   # Linear project name — filters issues
    builder: codex                  # "codex" or "claude" (default: claude)
    reviewer: claude                # "codex" or "claude" (default: claude)
    verification:
      commands:
        - name: test
          command: pnpm test
        - name: lint
          command: pnpm run lint
```

### 3. Start the daemon

If the daemon was registered via postinstall, it starts on login automatically.
To start manually:

```sh
loomforge start                             # uses ~/.loomforge/loom.yaml
loomforge start --config /other/path.yaml   # custom config
```

---

## Usage

```sh
loomforge status                        # daemon health check
loomforge submit my-project             # enqueue all actionable issues
loomforge submit my-project TEZ-1       # submit a single Linear issue
loomforge queue                         # list queued/active runs
loomforge get <runId>                   # get run state and findings
loomforge cancel <runId>                # cancel a queued run
loomforge retry <runId>                 # retry a failed/blocked run
```

---

## MCP Server (optional)

For agents that support MCP tool discovery (OpenClaw, Cursor, etc.), you can
optionally register the MCP server:

```sh
npx add-mcp loomforge -- loomforge mcp-serve
```

Or target specific agents:

```sh
npx add-mcp loomforge -- loomforge mcp-serve -a claude-code -a codex
```

MCP tools: `loom_health`, `loom_submit_run`, `loom_submit_project`,
`loom_get_run`, `loom_get_queue`, `loom_get_project_status`, `loom_cancel_run`,
`loom_retry_run`, `loom_cleanup_workspace`.

---

## Development

```sh
pnpm run build       # compile TypeScript
pnpm run test        # run tests (vitest)
pnpm run lint        # eslint
pnpm run format      # prettier check
pnpm run typecheck   # tsc --noEmit
```

Run locally without a global link:

```sh
pnpm run dev start --config ./loom.yaml
pnpm run dev status
pnpm run dev submit my-project TEZ-1
pnpm run dev queue
```

---

## Testing

### Smoke test (no external deps)

```sh
# Terminal 1: start daemon
loomforge start --config ./loom.yaml --port 3777

# Terminal 2: exercise the API
loomforge status
loomforge submit my-project TEZ-1
loomforge queue
loomforge get <runId>
```

From source without a global link:

```sh
pnpm run dev start --config ./loom.yaml --port 3777
pnpm run dev status
```

### Full run with real runners

Prerequisites: builder and reviewer CLIs authenticated, Linear API key
configured, a test repo with a `dev` branch.

```sh
loomforge start --config ./loom.yaml
loomforge submit my-project TEZ-1        # single issue
loomforge submit my-project              # all actionable issues
loomforge queue
loomforge get <runId>
# When all issues complete, a PR from dev→main is created automatically
```

---

## Architecture

![Loomforge Architecture](docs/architecture.png)

### Module Map

| Module | Path | Responsibility |
|--------|------|---------------|
| API | `src/api/` | Local HTTP endpoints |
| App | `src/app/` | Daemon bootstrap, lifecycle, service composition |
| CLI | `src/cli/` | Operator-facing wrapper over the API |
| Config | `src/config/` | Project registry, YAML loading, zod validation |
| DB | `src/db/` | SQLite schema, migrations, event log |
| Linear | `src/linear/` | Issue fetching and status sync |
| MCP | `src/mcp/` | MCP server adapter (optional) |
| Workflow | `src/workflow/` | Run state machine, queue drain, retry/recovery |
| Runners | `src/runners/` | Configurable builder + reviewer (Codex or Claude) |
| Worktrees | `src/worktrees/` | Dev branch worktree, rebase, cleanup |
| Artifacts | `src/artifacts/` | Prompt/log/result persistence |

### Stack

TypeScript · Node 22+ · Fastify · Commander · MCP SDK · @linear/sdk · SQLite · zod · execa · pino

### Agent Configuration

The Loomforge repo ships `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code) at
the repo root, automatically discovered when agents run inside this repo.

For projects that Loomforge builds against, the builder prompt instructs the
agent to read the target repo's own `AGENTS.md` / `CLAUDE.md` before making
changes.

---

## Contributing

Contributions are welcome. To get started:

1. Fork the repo and create a feature branch
2. Install dependencies: `pnpm install`
3. Make your changes — follow the conventions in `CLAUDE.md`
4. Run checks: `pnpm run build && pnpm run test && pnpm run lint`
5. Open a pull request against `main`

Please open an issue before starting large changes so we can align on approach.

**Reporting bugs:** [Open an issue](https://github.com/tezra-io/loomforge/issues)
with steps to reproduce, expected vs. actual behavior, and your Node/OS version.

---

## Security

If you discover a security vulnerability, please report it privately via
[GitHub Security Advisories](https://github.com/tezra-io/loomforge/security/advisories/new)
rather than opening a public issue. We will respond within 7 days.

---

## License

[MIT](LICENSE)
