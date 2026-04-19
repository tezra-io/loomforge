#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const manualRun = !process.env.npm_lifecycle_event;
const isLocalDev = process.env.INIT_CWD && existsSync(join(process.env.INIT_CWD, "src"));
const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);

if (!manualRun && (isLocalDev || isCI)) {
  process.exit(0);
}

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

// 3. Install skill via skills CLI
const __dirname = dirname(fileURLToPath(import.meta.url));
const skillPath = join(__dirname, "..", "skills", "loom");
let skillInstalled = false;
try {
  execFileSync("npx", ["--yes", "skills", "add", skillPath], {
    stdio: "pipe",
    timeout: 30_000,
  });
  skillInstalled = true;
} catch {
  // skills CLI not available or failed
}

// 4. Print summary
console.log("");
console.log(`  ${cyan}${bold}loomforge${reset} installed successfully.`);
console.log("");
console.log(`  ${green}✓${reset} Config scaffolded at ${bold}~/.loomforge/${reset}`);

if (daemonInstalled) {
  console.log(`  ${green}✓${reset} Daemon registered ${dim}(starts on login)${reset}`);
} else if (os === "darwin" || os === "linux") {
  console.log(`  ${yellow}○${reset} Daemon not registered — run ${bold}loomforge start${reset} manually`);
}

if (skillInstalled) {
  console.log(`  ${green}✓${reset} Agent skill installed`);
} else {
  console.log(`  ${yellow}○${reset} Agent skill — run ${bold}npx skills add tezra-io/loomforge${reset}`);
}

console.log("");
console.log("  To get started:");
console.log(`    1. Add your Linear API key:  ${bold}~/.loomforge/config.yaml${reset}`);
console.log(`    2. Add a project:            ${bold}~/.loomforge/loom.yaml${reset}`);
if (!daemonInstalled) {
  console.log(`    3. Start the daemon:         ${bold}loomforge start${reset}`);
}
console.log("");
console.log(`  ${dim}Optional: install MCP server for agent integration${reset}`);
console.log(`    ${bold}npx add-mcp loomforge -- loomforge mcp-serve${reset}`);
console.log("");

// --- Daemon installers ---

function installLaunchd() {
  const plistName = "com.loomforge.daemon.plist";
  const agentsDir = join(home, "Library", "LaunchAgents");
  const plistPath = join(agentsDir, plistName);

  if (existsSync(plistPath)) {
    return true;
  }

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
    <string>${loomforgeBin}</string>
    <string>start</string>
    <string>--config</string>
    <string>${registryPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(dataDir, "daemon.stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(dataDir, "daemon.stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

  try {
    writeFileSync(plistPath, plist, "utf8");
    execFileSync("launchctl", ["load", plistPath], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function installSystemd() {
  const unitDir = join(home, ".config", "systemd", "user");
  const unitPath = join(unitDir, "loomforge.service");

  if (existsSync(unitPath)) {
    return true;
  }

  const loomforgeBin = findBin("loomforge");
  if (!loomforgeBin) return false;

  mkdirSync(unitDir, { recursive: true });

  const unit = `[Unit]
Description=Loomforge workflow daemon
After=network.target

[Service]
Type=simple
ExecStart=${loomforgeBin} start --config ${registryPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  try {
    writeFileSync(unitPath, unit, "utf8");
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    execFileSync("systemctl", ["--user", "enable", "--now", "loomforge.service"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function findBin(name) {
  try {
    return execFileSync("which", [name], { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}
