# @tezra-io/loomforge

## 0.3.0

### Minor Changes

- Add ad-hoc prompt-driven runs. `loomforge adhoc "<prompt>" --project <slug-or-path>` (or `POST /runs/adhoc`, or the `loom_submit_adhoc` MCP tool) creates a `loomforge-adhoc`-labeled Linear issue from a free-text prompt, then enqueues a normal build run against it. The Linear issue is the system of record and transitions through "in progress" / "done" via the existing status sync. `--project` is required; there is no current-directory fallback.

## 0.2.0

### Minor Changes

- Add the design flow: scaffold → draft → review → publish → register for new projects and feature extensions.
  - New CLI commands: `loomforge design new|extend|get|cancel|retry|status`.
  - New MCP tools: `loom_design_new_project`, `loom_design_extend_project`, `loom_get_design_run`, `loom_cancel_design_run`, `loom_retry_design_run`, `loom_get_design_run_status_for_project`.
  - New global config block `design:` with `repoRoot`, `defaultBranch`, `devBranch`, `linearTeamKey`, and optional `githubOrg` (creates new repos under the given GitHub org instead of the authenticated user).
  - `loomforge setup` now prompts for design-flow settings and appends the `design:` block automatically; the target `repoRoot` is created if it does not exist.
  - Design engine now logs each state transition at `info` (and `warn` on `failed`/`blocked`) through pino, matching the workflow engine shape.
  - SQLite schema bumped to v5 for the design-run store; non-terminal design runs are re-enqueued on daemon startup.
  - Requirement paths are validated against a safe-root policy (absolute, `.md` or `.txt`, ≤256 KiB, no hidden segments).

## 0.1.7

### Patch Changes

- Fix postinstall so the daemon points at the just-installed global binary.

  `findBin` now prefers `$npm_config_prefix/bin/<name>` before walking PATH. npm prepends local `node_modules/.bin` directories to PATH during the postinstall lifecycle, which can shadow the global install and make `findBin` return a stale binary from an unrelated project — leaving the launch agent running an old version after `npm install -g` succeeds.

  `daemonPath()` also strips `node_modules/.bin` entries so those transient npm lifecycle artifacts don't get baked into the plist / systemd unit.

## 0.1.6

### Patch Changes

- Fix daemon PATH so runner binaries (`codex`, `claude`) resolve on spawn.
  - `scripts/postinstall.js` no longer hardcodes `PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` when generating the launchd plist and systemd unit. It now merges the installer's `process.env.PATH` with common package-manager and user tool locations (`~/.npm-global/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`, etc.), dedupes, and strips entries that would corrupt the plist/unit syntax.
  - The installer now regenerates an existing plist/unit on upgrade (launchd unload → write → load; systemctl daemon-reload → enable → restart) so fixes propagate on `npm install -g`.
  - Belt-and-braces at runtime: process and verification runners now spawn child processes with an expanded PATH (`childProcessEnv()` in `src/runners/path-env.ts`), so runner commands resolve even if the daemon itself was launched with a narrow PATH.
  - Hardened plist/unit generation with XML-escape for plist values and systemd-style quoting (backslash, quote, `%`, newline/CR, and `$`) so paths containing special characters cannot break the generated config.
  - Surfaces the underlying error when `launchctl` / `systemctl` fails so install failures are no longer silent.

## 0.1.3

### Patch Changes

- [`e87e3b8`](https://github.com/tezra-io/loomforge/commit/e87e3b846d61585e1963405382e72e05e5f48e4f) Thanks [@aira-bot](https://github.com/aira-bot)! - Fix the setup/install flow, skill packaging, and release automation.
