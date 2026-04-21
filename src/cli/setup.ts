import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const green = "\x1b[32m";
const yellow = "\x1b[33m";
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const agentPageSize = 6;
const linearApiKeyPlaceholder = "lin_api_YOUR_KEY_HERE";

interface AgentOption {
  id: string;
  label: string;
}

type SetupExecFile = (
  file: string,
  args: readonly string[],
  options: {
    stdio: "inherit";
    timeout: number;
  },
) => Buffer | string;

export interface RunSetupOptions {
  write?: (text: string) => void;
  setExitCode?: (code: number) => void;
  fileExists?: (path: string) => boolean;
  readTextFile?: (path: string, encoding: BufferEncoding) => string;
  execFile?: SetupExecFile;
  env?: NodeJS.ProcessEnv;
  homeDir?: () => string;
  prompt?: (question: string) => Promise<string>;
  isInteractive?: boolean;
}

interface SetupPaths {
  packageRoot: string;
  configPath: string;
  registryPath: string;
}

interface SelectedAgents {
  kind: "selected";
  agents: string[];
}

interface SkippedAgents {
  kind: "skipped";
  reason: string;
}

interface FailedAgents {
  kind: "failed";
  reason: string;
}

interface InstalledSkill {
  kind: "installed";
  command: string;
}

interface FailedSkill {
  kind: "failed";
  command: string;
  reason: string;
}

type AgentSelection = SelectedAgents | SkippedAgents | FailedAgents;
type SkillInstallResult = InstalledSkill | FailedSkill;

const SUPPORTED_AGENTS: readonly AgentOption[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "opencode", label: "OpenCode" },
  { id: "openclaw", label: "OpenClaw" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "windsurf", label: "Windsurf" },
  { id: "continue", label: "Continue" },
  { id: "goose", label: "Goose" },
  { id: "gemini-cli", label: "Gemini CLI" },
  { id: "amp", label: "Amp" },
  { id: "antigravity", label: "Antigravity" },
  { id: "augment", label: "Augment" },
  { id: "bob", label: "IBM Bob" },
  { id: "cline", label: "Cline" },
  { id: "codebuddy", label: "CodeBuddy" },
  { id: "command-code", label: "Command Code" },
  { id: "cortex", label: "Cortex Code" },
  { id: "crush", label: "Crush" },
  { id: "deepagents", label: "Deep Agents" },
  { id: "droid", label: "Droid" },
  { id: "firebender", label: "Firebender" },
  { id: "iflow-cli", label: "iFlow CLI" },
  { id: "junie", label: "Junie" },
  { id: "kilo", label: "Kilo Code" },
  { id: "kimi-cli", label: "Kimi Code CLI" },
  { id: "kiro-cli", label: "Kiro CLI" },
  { id: "kode", label: "Kode" },
  { id: "mcpjam", label: "MCPJam" },
  { id: "mistral-vibe", label: "Mistral Vibe" },
  { id: "mux", label: "Mux" },
  { id: "neovate", label: "Neovate" },
  { id: "openhands", label: "OpenHands" },
  { id: "pi", label: "Pi" },
  { id: "pochi", label: "Pochi" },
  { id: "qoder", label: "Qoder" },
  { id: "qwen-code", label: "Qwen Code" },
  { id: "replit", label: "Replit" },
  { id: "roo", label: "Roo Code" },
  { id: "trae", label: "Trae" },
  { id: "trae-cn", label: "Trae CN" },
  { id: "universal", label: "Universal" },
  { id: "warp", label: "Warp" },
  { id: "zencoder", label: "Zencoder" },
  { id: "adal", label: "AdaL" },
] as const;

export async function runSetup(options: RunSetupOptions = {}): Promise<void> {
  const write = options.write ?? defaultWrite;
  const setExitCode = options.setExitCode ?? defaultSetExitCode;
  const fileExists = options.fileExists ?? existsSync;
  const readTextFile = options.readTextFile ?? readFileSync;
  const execFile = options.execFile ?? defaultExecFile;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const paths = buildSetupPaths(homeDir());
  const source = resolveSkillSource(paths.packageRoot, fileExists);

  writeLine(write, "");
  writeConfigStatus(write, paths.configPath, fileExists, readTextFile, env);
  writeRegistryStatus(write, paths.registryPath, fileExists, readTextFile);

  const skillInstalled = await runSkillSetup({
    execFile,
    isInteractive,
    prompt: options.prompt,
    source,
    write,
  });

  if (!skillInstalled) {
    setExitCode(1);
  }

  writeLine(write, "");
  writeLine(write, `  ${dim}Optional: register MCP server for agent integration${reset}`);
  writeLine(write, `    ${bold}npx add-mcp loomforge -- loomforge mcp-serve${reset}`);
  writeLine(write, "");
}

function buildSetupPaths(home: string): SetupPaths {
  const loomDir = join(home, ".loomforge");
  const packageRoot = join(import.meta.dirname, "..", "..");
  return {
    packageRoot,
    configPath: join(loomDir, "config.yaml"),
    registryPath: join(loomDir, "loom.yaml"),
  };
}

function resolveSkillSource(packageRoot: string, fileExists: (path: string) => boolean): string {
  return fileExists(packageRoot) ? packageRoot : "tezra-io/loomforge";
}

function writeConfigStatus(
  write: (text: string) => void,
  configPath: string,
  fileExists: (path: string) => boolean,
  readTextFile: (path: string, encoding: BufferEncoding) => string,
  env: NodeJS.ProcessEnv,
): void {
  const configuredKey = resolveLinearApiKey(configPath, fileExists, readTextFile, env);
  if (configuredKey === "config") {
    writeLine(write, `  ${green}✓${reset} Linear API key configured`);
    return;
  }

  if (configuredKey === "env") {
    writeLine(
      write,
      `  ${green}✓${reset} Linear API key configured via ${bold}LINEAR_API_KEY${reset}`,
    );
    return;
  }

  if (!fileExists(configPath)) {
    writeLine(
      write,
      `  ${yellow}○${reset} Config missing — run ${bold}npm install -g @tezra-io/loomforge${reset} first`,
    );
    return;
  }

  writeLine(
    write,
    `  ${yellow}○${reset} Linear API key not set — edit ${bold}~/.loomforge/config.yaml${reset}`,
  );
}

function writeRegistryStatus(
  write: (text: string) => void,
  registryPath: string,
  fileExists: (path: string) => boolean,
  readTextFile: (path: string, encoding: BufferEncoding) => string,
): void {
  if (!fileExists(registryPath)) {
    writeLine(
      write,
      `  ${yellow}○${reset} Registry missing — run ${bold}npm install -g @tezra-io/loomforge${reset} first`,
    );
    return;
  }

  const content = readTextFile(registryPath, "utf8");
  if (!/projects:\s*\n\s+-/.test(content)) {
    writeLine(
      write,
      `  ${yellow}○${reset} No projects configured — edit ${bold}~/.loomforge/loom.yaml${reset}`,
    );
    return;
  }

  writeLine(write, `  ${green}✓${reset} Project registry has entries`);
}

async function runSkillSetup(options: {
  execFile: SetupExecFile;
  isInteractive: boolean;
  prompt?: (question: string) => Promise<string>;
  source: string;
  write: (text: string) => void;
}): Promise<boolean> {
  const selection = await promptForAgents({
    isInteractive: options.isInteractive,
    prompt: options.prompt,
    write: options.write,
  });

  if (selection.kind === "skipped") {
    writeLine(options.write, `  ${yellow}○${reset} Agent selection skipped — ${selection.reason}`);
    writeLine(
      options.write,
      `    ${dim}Rerun ${bold}loomforge setup${reset}${dim} in an interactive terminal${reset}`,
    );
    return false;
  }

  if (selection.kind === "failed") {
    writeLine(options.write, `  ${yellow}○${reset} Agent selection failed — ${selection.reason}`);
    return false;
  }

  const install = installSkill(options.execFile, options.source, selection.agents);

  if (install.kind === "failed") {
    writeLine(options.write, `  ${yellow}○${reset} Agent skill install failed — ${install.reason}`);
    writeLine(options.write, `    ${dim}Command:${reset} ${bold}${install.command}${reset}`);
    return false;
  }

  writeLine(
    options.write,
    `  ${green}✓${reset} Agent skill installed for ${bold}${selection.agents.join(", ")}${reset}`,
  );
  return true;
}

async function promptForAgents(options: {
  isInteractive: boolean;
  prompt?: (question: string) => Promise<string>;
  write: (text: string) => void;
}): Promise<AgentSelection> {
  if (!options.isInteractive) {
    return {
      kind: "skipped",
      reason: "interactive terminal required",
    };
  }

  writeLine(options.write, "");
  writeLine(options.write, "  Select agents to receive the Loomforge skill:");
  let pageStart = 0;
  writeAgentOptionsPage(options.write, pageStart);

  const prompt = options.prompt ?? createTerminalPrompt();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const answer = (await prompt("  Enter numbers, agent ids, 'all', or 'more': ")).trim();
    if (answer.toLowerCase() === "more") {
      pageStart = nextAgentPageStart(pageStart);
      writeAgentOptionsPage(options.write, pageStart);
      continue;
    }
    const selection = parseAgentSelection(answer);
    if (selection.length > 0) {
      return {
        kind: "selected",
        agents: selection,
      };
    }
    writeLine(
      options.write,
      `  ${yellow}○${reset} Invalid selection — try comma-separated numbers like ${bold}1,2${reset}`,
    );
  }

  return {
    kind: "failed",
    reason: "invalid selection after 3 attempts",
  };
}

function createTerminalPrompt(): (question: string) => Promise<string> {
  return async (question: string) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

function writeAgentOptionsPage(write: (text: string) => void, pageStart: number): void {
  const pageEnd = Math.min(pageStart + agentPageSize, SUPPORTED_AGENTS.length);
  writeLine(
    write,
    `    ${dim}Showing ${pageStart + 1}-${pageEnd} of ${SUPPORTED_AGENTS.length}${reset}`,
  );
  for (let index = pageStart; index < pageEnd; index += 1) {
    const option = SUPPORTED_AGENTS[index];
    if (!option) {
      continue;
    }
    const number = String(index + 1).padStart(2, "0");
    writeLine(write, `    ${number}. ${option.label} ${dim}(${option.id})${reset}`);
  }
  if (pageEnd < SUPPORTED_AGENTS.length) {
    writeLine(
      write,
      `    ${dim}Type ${bold}more${reset}${dim} for the next ${agentPageSize} agents${reset}`,
    );
  }
}

function nextAgentPageStart(pageStart: number): number {
  const nextPageStart = pageStart + agentPageSize;
  if (nextPageStart >= SUPPORTED_AGENTS.length) {
    return 0;
  }
  return nextPageStart;
}

function parseAgentSelection(input: string): string[] {
  if (input.toLowerCase() === "all") {
    return SUPPORTED_AGENTS.map((option) => option.id);
  }

  const tokens = input
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return [];
  }

  const selected = new Set<string>();
  for (const token of tokens) {
    const agentId = resolveAgentToken(token);
    if (!agentId) {
      return [];
    }
    selected.add(agentId);
  }

  return Array.from(selected);
}

function resolveAgentToken(token: string): string | null {
  const numericIndex = Number.parseInt(token, 10);
  if (/^\d+$/.test(token) && Number.isInteger(numericIndex)) {
    const option = SUPPORTED_AGENTS[numericIndex - 1];
    return option?.id ?? null;
  }

  const normalized = token.toLowerCase();
  const option = SUPPORTED_AGENTS.find((candidate) => candidate.id === normalized);
  return option?.id ?? null;
}

function installSkill(
  execFile: SetupExecFile,
  source: string,
  agents: string[],
): SkillInstallResult {
  const args = ["--yes", "skills", "add", source, "--global", "--skill", "loomforge"];
  for (const agent of agents) {
    args.push("--agent", agent);
  }

  try {
    execFile("npx", args, {
      stdio: "inherit",
      timeout: 60_000,
    });
    return {
      kind: "installed",
      command: formatCommand("npx", args),
    };
  } catch (error) {
    return {
      kind: "failed",
      command: formatCommand("npx", args),
      reason: getErrorMessage(error),
    };
  }
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(formatCommandPart).join(" ");
}

function formatCommandPart(value: string): string {
  return value.includes(" ") ? JSON.stringify(value) : value;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "unknown error";
}

function resolveLinearApiKey(
  configPath: string,
  fileExists: (path: string) => boolean,
  readTextFile: (path: string, encoding: BufferEncoding) => string,
  env: NodeJS.ProcessEnv,
): "config" | "env" | "missing" {
  if (fileExists(configPath)) {
    const content = readTextFile(configPath, "utf8");
    if (!content.includes(linearApiKeyPlaceholder)) {
      return "config";
    }
  }

  const envApiKey = env.LINEAR_API_KEY?.trim();
  if (envApiKey) {
    return "env";
  }

  return "missing";
}

function defaultWrite(text: string): void {
  process.stdout.write(text);
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: {
    stdio: "inherit";
    timeout: number;
  },
): Buffer | string {
  return execFileSync(file, args, options);
}

function defaultSetExitCode(code: number): void {
  process.exitCode = code;
}

function writeLine(write: (text: string) => void, text: string): void {
  write(`${text}\n`);
}
