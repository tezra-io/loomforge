import { join } from "node:path";

import { execa } from "execa";

import type {
  BuilderResult,
  BuilderRunner,
  PushContext,
  PushResult,
  WorkflowStepContext,
} from "../workflow/types.js";
import { runProcess } from "./process-runner.js";
import { buildPrompt, pushPrompt } from "./prompts/builder.js";

export interface CodexBuilderRunnerOptions {
  artifactDir: string;
}

export class CodexBuilderRunner implements BuilderRunner {
  private readonly artifactDir: string;

  constructor(options: CodexBuilderRunnerOptions) {
    this.artifactDir = options.artifactDir;
  }

  async build(context: WorkflowStepContext): Promise<BuilderResult> {
    const { run, attempt, project, workspace } = context;
    const logDir = join(this.artifactDir, run.id, attempt.id);
    const prompt = buildPrompt(context);

    const headBefore = await this.getHead(workspace.path);

    const result = await runProcess({
      command: "codex",
      args: ["--approval-mode", "full-auto", "--quiet", prompt],
      cwd: workspace.path,
      timeoutMs: project.timeouts.builderMs,
      artifactDir: logDir,
      label: "builder",
    });

    if (result.timedOut) {
      return {
        outcome: "failed",
        summary: `Builder timed out after ${project.timeouts.builderMs}ms`,
        changedFiles: [],
        commitSha: null,
        rawLogPath: result.stdoutLogPath,
        failureReason: "timeout",
      };
    }

    if (result.exitCode !== 0) {
      return {
        outcome: "failed",
        summary: `Builder exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
        changedFiles: [],
        commitSha: null,
        rawLogPath: result.stderrLogPath,
        failureReason: "runner_error",
      };
    }

    const headAfter = await this.getHead(workspace.path);
    if (!headAfter || headAfter === headBefore) {
      return {
        outcome: "failed",
        summary: "Builder completed but no new commit was created",
        changedFiles: [],
        commitSha: null,
        rawLogPath: result.stdoutLogPath,
        failureReason: "runner_error",
      };
    }

    const changedFiles = await this.getChangedFiles(workspace.path, headBefore, headAfter);

    return {
      outcome: "success",
      summary: `Builder committed ${headAfter}`,
      changedFiles,
      commitSha: headAfter,
      rawLogPath: result.stdoutLogPath,
    };
  }

  async push(context: PushContext): Promise<PushResult> {
    const { run, attempt, workspace } = context;
    const logDir = join(this.artifactDir, run.id, attempt.id);
    const prompt = pushPrompt(workspace.branchName);

    const result = await runProcess({
      command: "codex",
      args: ["--approval-mode", "full-auto", "--quiet", prompt],
      cwd: workspace.path,
      timeoutMs: 120_000,
      artifactDir: logDir,
      label: "push",
    });

    if (result.timedOut) {
      return {
        outcome: "failed",
        summary: "Push timed out",
        rawLogPath: result.stderrLogPath,
        failureReason: "push_failed",
      };
    }

    if (result.exitCode !== 0) {
      return {
        outcome: "failed",
        summary: `Push failed: ${truncate(result.stderr, 500)}`,
        rawLogPath: result.stderrLogPath,
        failureReason: "push_failed",
      };
    }

    return {
      outcome: "success",
      summary: "Pushed to remote",
      rawLogPath: result.stdoutLogPath,
    };
  }

  private async getHead(cwd: string): Promise<string | null> {
    try {
      const result = await execa("git", ["rev-parse", "HEAD"], { cwd, reject: false });
      return result.exitCode === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  private async getChangedFiles(
    cwd: string,
    before: string | null,
    after: string,
  ): Promise<string[]> {
    if (!before) return [];
    try {
      const result = await execa("git", ["diff", "--name-only", before, after], {
        cwd,
        reject: false,
      });
      return result.exitCode === 0
        ? result.stdout
            .trim()
            .split("\n")
            .filter((l) => l.length > 0)
        : [];
    } catch {
      return [];
    }
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
