#!/usr/bin/env node

import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const cyan = "\x1b[36m";
const green = "\x1b[32m";
const yellow = "\x1b[33m";
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

const home = homedir();
const loomDir = join(home, ".loomforge");
const configPath = join(loomDir, "config.yaml");
const registryPath = join(loomDir, "loom.yaml");
const dataDir = join(loomDir, "data");

function main() {
  const manualRun = !process.env.npm_lifecycle_event;
  const isLocalDev =
    process.env.INIT_CWD && existsSync(join(process.env.INIT_CWD, "src"));
  const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
  const isGlobalInstall =
    process.env.npm_config_global === "true" ||
    process.env.npm_config_location === "global";

  if (!manualRun && (isLocalDev || isCI || !isGlobalInstall)) return;

  // 1. Scaffold ~/.loomforge/
  mkdirSync(loomDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `# Loomforge global configuration
# Get your API key at https://linear.app/settings/api
# Alternatively, set the LINEAR_API_KEY environment variable.
linear:
  apiKey: lin_api_YOUR_KEY_HERE
`,
      "utf8",
    );
  }

  if (!existsSync(registryPath)) {
    writeFileSync(
      registryPath,
      `# Loomforge project registry
# Each project maps a Linear team to a local repo.
# The daemon uses this file: loomforge start --config ~/.loomforge/loom.yaml
#
# To add a new project, append an entry under 'projects:' below.
# Required fields: slug, repoRoot, defaultBranch, verification.commands
# Optional fields: linearTeamKey (for bulk submit), linearProjectName (filter by project),
#   devBranch (default: dev), builder, reviewer, timeouts, review, linearStatuses

runtime:
  dataRoot: ${dataDir}

projects: []

# Example project:
#
#  - slug: my-app
#    repoRoot: /path/to/repo
#    defaultBranch: main
#    devBranch: dev
#    linearTeamKey: TEZ
#    linearProjectName: My Project
#    builder: codex
#    reviewer: claude
#    verification:
#      commands:
#        - name: test
#          command: pnpm test
#        - name: lint
#          command: pnpm run lint
#    timeouts:
#      builderMs: 900000
#      reviewerMs: 300000
`,
      "utf8",
    );
  }

  // 2. Install daemon (launchd on macOS, systemd on Linux)
  const os = platform();
  let daemonInstalled = false;

  if (os === "darwin") {
    daemonInstalled = installLaunchd();
  } else if (os === "linux") {
    daemonInstalled = installSystemd();
  }

  // 3. Print summary
  console.log("");
  console.log(`  ${cyan}${bold}loomforge${reset} installed successfully.`);
  console.log("");
  console.log(`  ${green}✓${reset} Config scaffolded at ${bold}~/.loomforge/${reset}`);

  if (daemonInstalled) {
    console.log(`  ${green}✓${reset} Daemon registered ${dim}(starts on login)${reset}`);
  } else if (os === "darwin" || os === "linux") {
    console.log(
      `  ${yellow}○${reset} Daemon not registered — run ${bold}loomforge start${reset} manually`,
    );
  }

  console.log("");
  console.log("  Next steps:");
  console.log(`    1. Run setup:                ${bold}loomforge setup${reset}`);
  console.log(`    2. Add your Linear API key:  ${bold}~/.loomforge/config.yaml${reset}`);
  console.log(`    3. Add a project:            ${bold}~/.loomforge/loom.yaml${reset}`);
  if (!daemonInstalled) {
    console.log(`    4. Start the daemon:         ${bold}loomforge start${reset}`);
  }
  console.log("");
}

// --- Daemon installers ---

function installLaunchd() {
  const plistName = "com.loomforge.daemon.plist";
  const agentsDir = join(home, "Library", "LaunchAgents");
  const plistPath = join(agentsDir, plistName);

  const loomforgeBin = findBin("loomforge");
  if (!loomforgeBin) return false;

  mkdirSync(agentsDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.loomforge.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(loomforgeBin)}</string>
    <string>start</string>
    <string>--config</string>
    <string>${xmlEscape(registryPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(dataDir, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(dataDir, "daemon.stderr.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(daemonPath())}</string>
  </dict>
</dict>
</plist>`;

  try {
    if (existsSync(plistPath)) {
      try {
        execFileSync("launchctl", ["unload", plistPath], { stdio: "pipe" });
      } catch {
        // Not loaded yet; fall through to load.
      }
    }
    writeFileSync(plistPath, plist, "utf8");
    execFileSync("launchctl", ["load", plistPath], { stdio: "pipe" });
    return true;
  } catch (error) {
    reportDaemonInstallError("launchd", error);
    return false;
  }
}

function installSystemd() {
  const unitDir = join(home, ".config", "systemd", "user");
  const unitPath = join(unitDir, "loomforge.service");

  const loomforgeBin = findBin("loomforge");
  if (!loomforgeBin) return false;

  mkdirSync(unitDir, { recursive: true });

  const unit = `[Unit]
Description=Loomforge workflow daemon
After=network.target

[Service]
Type=simple
Environment=${systemdQuote(`PATH=${daemonPath()}`)}
ExecStart=${systemdQuote(loomforgeBin, { escapeDollar: true })} start --config ${systemdQuote(registryPath, { escapeDollar: true })}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  try {
    writeFileSync(unitPath, unit, "utf8");
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    execFileSync("systemctl", ["--user", "enable", "loomforge.service"], { stdio: "pipe" });
    execFileSync("systemctl", ["--user", "restart", "loomforge.service"], { stdio: "pipe" });
    return true;
  } catch (error) {
    reportDaemonInstallError("systemd", error);
    return false;
  }
}

function findBin(name) {
  for (const dir of daemonPath().split(":")) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }

  return null;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Build the PATH the daemon will run under. We can't rely on the caller's
// login PATH at launchd/systemd boot time, so bake it in at install time:
// merge the installer's current PATH with common user tool locations.
export function daemonPath() {
  const entries = [
    ...(process.env.PATH ?? "").split(":"),
    ...configuredToolDirs(),
    ...userToolDirs(),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const seen = new Set();
  const pathEntries = [];

  for (const dir of entries) {
    if (!dir || seen.has(dir)) continue;
    if (/[:\0\n\r]/.test(dir)) continue;
    seen.add(dir);
    pathEntries.push(dir);
  }

  return pathEntries.join(":");
}

function configuredToolDirs() {
  const entries = [];
  const npmPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  const pnpmHome = process.env.PNPM_HOME;
  const bunInstall = process.env.BUN_INSTALL;

  if (npmPrefix) entries.push(join(npmPrefix, "bin"));
  if (pnpmHome) entries.push(pnpmHome);
  if (bunInstall) entries.push(join(bunInstall, "bin"));
  return entries;
}

function userToolDirs() {
  return [
    join(home, ".npm-global", "bin"),
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
  ];
}

export function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function systemdQuote(value, options = {}) {
  // replaceAll's replacement string treats `$` as special (e.g. `$$` → `$`),
  // so use a function replacer for literal doubling.
  let escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");

  if (options.escapeDollar) {
    escaped = escaped.replaceAll("$", () => "$$");
  }

  return `"${escaped}"`;
}

function reportDaemonInstallError(manager, error) {
  const message = errorMessage(error);
  console.error(
    `  ${yellow}○${reset} ${manager} daemon registration failed: ${message}`,
  );
}

function errorMessage(error) {
  if (!error || typeof error !== "object") return String(error);

  const stderr = "stderr" in error ? Buffer.from(error.stderr ?? "").toString("utf8").trim() : "";
  if (stderr) return stderr;

  const stdout = "stdout" in error ? Buffer.from(error.stdout ?? "").toString("utf8").trim() : "";
  if (stdout) return stdout;

  if (error instanceof Error) return error.message;
  return String(error);
}

function isMainModule() {
  try {
    const entry = process.argv[1];
    return !!entry && import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
