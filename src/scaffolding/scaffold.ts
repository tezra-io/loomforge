import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { execa } from "execa";

import { childProcessEnv } from "../runners/path-env.js";
import { claudeTemplatePath } from "./paths.js";

export interface ScaffoldOptions {
  repoPath: string;
  slug: string;
  designDocRelativePath: string;
  defaultBranch: string;
}

export interface ScaffoldOutcome {
  outcome: "success";
  repoPath: string;
  initialized: boolean;
}

export interface ScaffoldFailure {
  outcome: "failed";
  reason: "non_empty_non_git_dir" | "git_error" | "io_error";
  summary: string;
}

export type ScaffoldResult = ScaffoldOutcome | ScaffoldFailure;

class GitOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitOperationError";
  }
}

export async function ensureScaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  try {
    const preflight = await preflightTargetDir(options.repoPath);
    if (preflight.outcome === "failed") {
      return preflight;
    }
    await mkdir(options.repoPath, { recursive: true });
    const initialized = await ensureGitInit(options.repoPath, options.defaultBranch);
    await ensureGitignore(options.repoPath, options.designDocRelativePath);
    await ensureGovernanceTemplates(options.repoPath, options.slug);
    await ensureInitialCommit(options.repoPath);
    return { outcome: "success", repoPath: options.repoPath, initialized };
  } catch (error) {
    if (error instanceof GitOperationError) {
      return { outcome: "failed", reason: "git_error", summary: error.message };
    }
    return {
      outcome: "failed",
      reason: "io_error",
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

async function preflightTargetDir(repoPath: string): Promise<ScaffoldResult> {
  let entries: string[];
  try {
    entries = await readdir(repoPath);
  } catch (error) {
    if (isFileNotFound(error)) {
      return { outcome: "success", repoPath, initialized: false };
    }
    return {
      outcome: "failed",
      reason: "io_error",
      summary: `Failed to inspect ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (entries.length === 0) {
    return { outcome: "success", repoPath, initialized: false };
  }

  const isRepo = await checkIsGitRepo(repoPath);
  if (isRepo) {
    return { outcome: "success", repoPath, initialized: false };
  }

  return {
    outcome: "failed",
    reason: "non_empty_non_git_dir",
    summary:
      `Target directory is non-empty and not a git repo: ${repoPath}. ` +
      "Loomforge will not take ownership of existing files. Remove or move them, " +
      "or point --repo-root at a fresh location.",
  };
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function ensureGitInit(cwd: string, defaultBranch: string): Promise<boolean> {
  const isRepo = await checkIsGitRepo(cwd);
  if (isRepo) return false;

  const init = await execa("git", ["init", "-b", defaultBranch], {
    cwd,
    env: childProcessEnv(),
    reject: false,
  });
  if (init.exitCode !== 0) {
    throw new GitOperationError(`git init failed: ${init.stderr.trim() || init.stdout.trim()}`);
  }
  return true;
}

async function checkIsGitRepo(cwd: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    env: childProcessEnv(),
    reject: false,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function ensureGitignore(cwd: string, designDocRelativePath: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");
  const existing = await safeReadFile(gitignorePath);
  const lines = existing ? existing.split(/\r?\n/) : [];
  const desired = ["node_modules/", "dist/", ".DS_Store", ".env", ".env.*", designDocRelativePath];
  const missing = desired.filter((line) => !lines.includes(line));
  if (missing.length === 0 && existing !== null) return;

  const combined = existing
    ? `${existing.replace(/\s+$/, "")}\n${missing.join("\n")}\n`
    : `${desired.join("\n")}\n`;
  await writeFile(gitignorePath, combined, "utf8");
}

async function ensureGovernanceTemplates(cwd: string, slug: string): Promise<void> {
  const templateText = await readFile(claudeTemplatePath(), "utf8");
  const instantiated = instantiateClaudeTemplate(templateText, slug);

  const claudePath = join(cwd, "CLAUDE.md");
  const agentsPath = join(cwd, "AGENTS.md");

  await writeIfMissing(claudePath, instantiated);
  await writeIfMissing(agentsPath, instantiated);
}

function instantiateClaudeTemplate(template: string, slug: string): string {
  return template.replace(/\{Project Name\}/g, slug);
}

async function ensureInitialCommit(cwd: string): Promise<void> {
  const hasCommit = await hasAnyCommit(cwd);
  if (hasCommit) return;

  const add = await execa("git", ["add", "-A"], {
    cwd,
    env: childProcessEnv(),
    reject: false,
  });
  if (add.exitCode !== 0) {
    throw new GitOperationError(`git add failed: ${add.stderr.trim()}`);
  }

  const commit = await execa("git", ["commit", "-m", "chore: initial loomforge scaffold"], {
    cwd,
    env: childProcessEnv(),
    reject: false,
  });
  if (commit.exitCode !== 0) {
    throw new GitOperationError(
      `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    );
  }
}

async function hasAnyCommit(cwd: string): Promise<boolean> {
  const result = await execa("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    env: childProcessEnv(),
    reject: false,
  });
  return result.exitCode === 0;
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  try {
    await access(path);
    return;
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
