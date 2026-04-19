#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const isLocalDev = process.env.INIT_CWD && existsSync(join(process.env.INIT_CWD, "src"));
const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);

if (isLocalDev || isCI) {
  process.exit(0);
}

const home = homedir();
const loomDir = join(home, ".loomforge");
const configPath = join(loomDir, "config.yaml");
const registryPath = join(loomDir, "loom.yaml");
const dataDir = join(loomDir, "data");

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
#   devBranch (default: dev), timeouts, review, linearStatuses, runtimeDataRoot

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
#    verification:
#      commands:
#        - name: test
#          command: pnpm test
#        - name: lint
#          command: pnpm run lint
#    timeouts:
#      builderMs: 900000
#      reviewerMs: 300000
#    review:
#      maxRevisionLoops: 3
`,
    "utf8",
  );
}

const cyan = "\x1b[36m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

console.log("");
console.log(`  ${cyan}loomforge${reset} installed successfully.`);
console.log("");
console.log(`  Config created at: ${bold}~/.loomforge/${reset}`);
console.log("");
console.log("  Next steps:");
console.log(`    1. Add your Linear API key:  ${bold}~/.loomforge/config.yaml${reset}`);
console.log(`    2. Add a project:            ${bold}~/.loomforge/loom.yaml${reset}`);
console.log(`    3. Start the daemon:         ${bold}loomforge start${reset}`);
console.log(`    4. Install the skill:        ${bold}npx skills add <org>/loomforge${reset}`);
console.log(`    5. Install the MCP server:   ${bold}claude mcp add loomforge -- loomforge mcp-serve${reset}`);
console.log("");
