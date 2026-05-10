import { execa } from "execa";

import type { ProjectConfig } from "../config/index.js";
import type {
  CreateOrUpdatePrResult,
  MergePrContent,
  PullRequestCreator,
  PullRequestManager,
  PullRequestSnapshot,
} from "../workflow/types.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<CommandResult>;

const PR_VIEW_FIELDS = "url,number,baseRefName,headRefName,baseRefOid,headRefOid,body";

interface ExistingPrEntry {
  number: number;
}

interface PrViewResponse {
  url: string;
  number: number;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  body: string;
}

export interface GhPullRequestCreatorOptions {
  runner?: CommandRunner;
}

const defaultRunner: CommandRunner = async (cmd, args, opts) => {
  const result = await execa(cmd, args, { cwd: opts.cwd, reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export class GhPullRequestCreator implements PullRequestCreator, PullRequestManager {
  private readonly runner: CommandRunner;

  constructor(options: GhPullRequestCreatorOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
  }

  async createPr(
    project: ProjectConfig,
    title: string,
    body: string,
  ): Promise<{ url: string } | null> {
    const result = await this.createOrUpdatePr(project, { title, body });
    return result.outcome === "success" ? { url: result.pullRequest.url } : null;
  }

  async createOrUpdatePr(
    project: ProjectConfig,
    content: MergePrContent,
  ): Promise<CreateOrUpdatePrResult> {
    const push = await this.runner("git", ["push", "-u", "origin", project.devBranch], {
      cwd: project.repoRoot,
    });
    if (push.exitCode !== 0) {
      return {
        outcome: "failed",
        reason: "push_failed",
        summary: push.stderr.trim() || "git push failed",
      };
    }

    const existing = await this.findExistingPr(project);
    if (existing instanceof Error) {
      return { outcome: "failed", reason: "gh_failed", summary: existing.message };
    }

    const number = existing?.number ?? null;
    const upsert =
      number === null
        ? await this.createPullRequest(project, content)
        : await this.updatePullRequest(project, number, content);
    if (upsert instanceof Error) {
      return { outcome: "failed", reason: "gh_failed", summary: upsert.message };
    }

    const view = await this.viewPullRequest(project, upsert);
    if (view instanceof Error) {
      return { outcome: "failed", reason: "gh_failed", summary: view.message };
    }

    return { outcome: "success", pullRequest: view };
  }

  private async findExistingPr(project: ProjectConfig): Promise<ExistingPrEntry | null | Error> {
    const result = await this.runner(
      "gh",
      [
        "pr",
        "list",
        "--base",
        project.defaultBranch,
        "--head",
        project.devBranch,
        "--state",
        "open",
        "--json",
        "number",
        "--limit",
        "1",
      ],
      { cwd: project.repoRoot },
    );
    if (result.exitCode !== 0) {
      return new Error(result.stderr.trim() || "gh pr list failed");
    }
    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed) as ExistingPrEntry[];
    const [first] = parsed;
    return first ?? null;
  }

  private async createPullRequest(
    project: ProjectConfig,
    content: MergePrContent,
  ): Promise<number | Error> {
    const result = await this.runner(
      "gh",
      [
        "pr",
        "create",
        "--base",
        project.defaultBranch,
        "--head",
        project.devBranch,
        "--title",
        content.title,
        "--body",
        content.body,
      ],
      { cwd: project.repoRoot },
    );
    if (result.exitCode !== 0) {
      return new Error(result.stderr.trim() || "gh pr create failed");
    }
    return parsePrNumberFromUrl(result.stdout.trim());
  }

  private async updatePullRequest(
    project: ProjectConfig,
    number: number,
    content: MergePrContent,
  ): Promise<number | Error> {
    const result = await this.runner(
      "gh",
      ["pr", "edit", String(number), "--title", content.title, "--body", content.body],
      { cwd: project.repoRoot },
    );
    if (result.exitCode !== 0) {
      return new Error(result.stderr.trim() || "gh pr edit failed");
    }
    return number;
  }

  private async viewPullRequest(
    project: ProjectConfig,
    number: number | Error,
  ): Promise<PullRequestSnapshot | Error> {
    if (number instanceof Error) return number;
    const result = await this.runner(
      "gh",
      ["pr", "view", String(number), "--json", PR_VIEW_FIELDS],
      { cwd: project.repoRoot },
    );
    if (result.exitCode !== 0) {
      return new Error(result.stderr.trim() || "gh pr view failed");
    }
    const view = JSON.parse(result.stdout) as PrViewResponse;
    return {
      url: view.url,
      number: view.number,
      baseBranch: view.baseRefName,
      devBranch: view.headRefName,
      baseSha: view.baseRefOid,
      devSha: view.headRefOid,
      body: view.body,
    };
  }
}

function parsePrNumberFromUrl(url: string): number | Error {
  const match = url.match(/\/pull\/(\d+)(?:\b|$)/);
  if (!match) {
    return new Error(`Could not parse PR number from URL: ${url}`);
  }
  return Number(match[1]);
}
