# @tezra-io/loomforge

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
