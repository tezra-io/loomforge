import { access } from "node:fs/promises";

import { execa } from "execa";

import type { ProjectConfig } from "../config/index.js";
import type { IssueSnapshot, PrepareWorkspaceResult, WorktreeManager } from "../workflow/types.js";

export class GitWorkspaceManager implements WorktreeManager {
  async prepareWorkspace(
    project: ProjectConfig,
    _issue: IssueSnapshot,
  ): Promise<PrepareWorkspaceResult> {
    const cwd = project.repoRoot;

    try {
      await access(cwd);
    } catch {
      return {
        outcome: "blocked",
        reason: "env_failure",
        summary: `Repo root does not exist: ${cwd}`,
      };
    }

    const isGitRepo = await this.isGitRepo(cwd);
    if (!isGitRepo) {
      return {
        outcome: "blocked",
        reason: "env_failure",
        summary: `Not a git repository: ${cwd}`,
      };
    }

    const dirty = await this.isDirty(cwd);
    if (dirty) {
      return {
        outcome: "blocked",
        reason: "dirty_workspace",
        summary: `Workspace has uncommitted changes: ${cwd}`,
      };
    }

    await this.fetchSilently(cwd);

    const defaultBranchValid = await this.refExists(cwd, project.defaultBranch);
    if (!defaultBranchValid) {
      return {
        outcome: "blocked",
        reason: "env_failure",
        summary: `Default branch does not exist: ${project.defaultBranch}`,
      };
    }

    await this.fastForwardDefaultBranch(cwd, project.defaultBranch);

    const devBranchExists = await this.refExists(cwd, project.devBranch);
    if (!devBranchExists) {
      const created = await this.createBranch(cwd, project.devBranch, project.defaultBranch);
      if (!created) {
        return {
          outcome: "blocked",
          reason: "env_failure",
          summary: `Failed to create ${project.devBranch} from ${project.defaultBranch}`,
        };
      }
    }

    const checkedOut = await this.checkout(cwd, project.devBranch);
    if (!checkedOut) {
      return {
        outcome: "blocked",
        reason: "env_failure",
        summary: `Failed to checkout ${project.devBranch}`,
      };
    }

    const rebaseTarget = await this.resolveRebaseTarget(cwd, project.defaultBranch);
    const rebaseResult = await this.rebase(cwd, rebaseTarget);

    if (!rebaseResult.success) {
      if (rebaseResult.isConflict) {
        await this.abortRebase(cwd);
        return {
          outcome: "blocked",
          reason: "rebase_conflict",
          summary: `Rebase conflict: ${project.devBranch} onto ${rebaseTarget}`,
        };
      }
      return {
        outcome: "blocked",
        reason: "env_failure",
        summary: `Rebase failed: ${rebaseResult.stderr}`,
      };
    }

    return {
      outcome: "success",
      workspace: {
        path: cwd,
        branchName: project.devBranch,
      },
    };
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    try {
      const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        reject: false,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async isDirty(cwd: string): Promise<boolean> {
    const result = await execa("git", ["status", "--porcelain"], {
      cwd,
      reject: false,
    });
    return result.stdout.trim().length > 0;
  }

  private async fetchSilently(cwd: string): Promise<void> {
    await execa("git", ["fetch", "--quiet"], {
      cwd,
      reject: false,
      timeout: 30_000,
    });
  }

  private async refExists(cwd: string, ref: string): Promise<boolean> {
    const result = await execa("git", ["rev-parse", "--verify", ref], {
      cwd,
      reject: false,
    });
    return result.exitCode === 0;
  }

  private async fastForwardDefaultBranch(cwd: string, defaultBranch: string): Promise<void> {
    const remoteRef = `origin/${defaultBranch}`;
    const hasRemote = await this.refExists(cwd, remoteRef);
    if (!hasRemote) {
      return;
    }

    const currentBranch = await this.currentBranch(cwd);
    if (currentBranch === defaultBranch) {
      await execa("git", ["merge", "--ff-only", remoteRef], { cwd, reject: false });
    } else {
      await execa("git", ["fetch", ".", `${remoteRef}:${defaultBranch}`], {
        cwd,
        reject: false,
      });
    }
  }

  private async currentBranch(cwd: string): Promise<string | null> {
    const result = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      reject: false,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return result.stdout.trim();
  }

  private async resolveRebaseTarget(cwd: string, defaultBranch: string): Promise<string> {
    const remoteRef = `origin/${defaultBranch}`;
    const hasRemote = await this.refExists(cwd, remoteRef);
    return hasRemote ? remoteRef : defaultBranch;
  }

  private async createBranch(cwd: string, branch: string, from: string): Promise<boolean> {
    const result = await execa("git", ["branch", branch, from], {
      cwd,
      reject: false,
    });
    return result.exitCode === 0;
  }

  private async checkout(cwd: string, branch: string): Promise<boolean> {
    const result = await execa("git", ["checkout", branch], {
      cwd,
      reject: false,
    });
    return result.exitCode === 0;
  }

  private async rebase(
    cwd: string,
    onto: string,
  ): Promise<{ success: boolean; isConflict: boolean; stderr: string }> {
    const result = await execa("git", ["rebase", onto], {
      cwd,
      reject: false,
    });

    if (result.exitCode === 0) {
      return { success: true, isConflict: false, stderr: "" };
    }

    const stderr = result.stderr;
    const isConflict =
      stderr.includes("CONFLICT") ||
      stderr.includes("could not apply") ||
      stderr.includes("Resolve all conflicts");

    return { success: false, isConflict, stderr };
  }

  private async abortRebase(cwd: string): Promise<void> {
    await execa("git", ["rebase", "--abort"], {
      cwd,
      reject: false,
    });
  }
}
