# Loomforge Setup

Installation creates `~/.loomforge/` automatically with default config files:

- `~/.loomforge/config.yaml` — global config (Linear API key)
- `~/.loomforge/loom.yaml` — project registry (add projects here)
- `~/.loomforge/data/` — runtime data (SQLite, artifacts, logs)

## 1. Set your Linear API key

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

## 2. Add a project

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

## 3. Start the daemon

```sh
loomforge start                          # uses ~/.loomforge/loom.yaml
loomforge start --config /other/path.yaml  # custom config
```
