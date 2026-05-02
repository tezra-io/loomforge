import { execa } from "execa";

import type { ProjectConfig } from "../config/index.js";
import type { DiffSnapshotResult, ProjectDiffSnapshotter } from "./types.js";

export interface DiffCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type DiffCommandRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<DiffCommandResult>;

const defaultRunner: DiffCommandRunner = async (cmd, args, opts) => {
  const result = await execa(cmd, args, { cwd: opts.cwd, reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export interface GitProjectDiffSnapshotterOptions {
  runner?: DiffCommandRunner;
}

export class GitProjectDiffSnapshotter implements ProjectDiffSnapshotter {
  private readonly runner: DiffCommandRunner;

  constructor(options: GitProjectDiffSnapshotterOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
  }

  async snapshot(project: ProjectConfig): Promise<DiffSnapshotResult> {
    const cwd = project.repoRoot;
    const baseRef = `origin/${project.defaultBranch}`;
    const devRef = `origin/${project.devBranch}`;

    const fetched = await this.runner(
      "git",
      ["fetch", "origin", project.defaultBranch, project.devBranch],
      { cwd },
    );
    if (fetched.exitCode !== 0) {
      return {
        outcome: "unavailable",
        reason: "fetch_failed",
        summary: fetched.stderr.trim() || "git fetch failed",
      };
    }

    const baseRev = await this.runner("git", ["rev-parse", baseRef], { cwd });
    if (baseRev.exitCode !== 0) {
      return {
        outcome: "unavailable",
        reason: "diff_failed",
        summary: baseRev.stderr.trim() || `rev-parse ${baseRef} failed`,
      };
    }

    const devRev = await this.runner("git", ["rev-parse", devRef], { cwd });
    if (devRev.exitCode !== 0) {
      return {
        outcome: "unavailable",
        reason: "diff_failed",
        summary: devRev.stderr.trim() || `rev-parse ${devRef} failed`,
      };
    }

    const diff = await this.runner("git", ["diff", `${baseRef}...${devRef}`], { cwd });
    if (diff.exitCode !== 0) {
      return {
        outcome: "unavailable",
        reason: "diff_failed",
        summary: diff.stderr.trim() || "git diff failed",
      };
    }

    return {
      outcome: "success",
      diff: diff.stdout,
      baseSha: baseRev.stdout.trim(),
      devSha: devRev.stdout.trim(),
    };
  }
}
