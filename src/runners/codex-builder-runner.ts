import { join } from "node:path";

import { execa } from "execa";

import type {
  BuilderResult,
  BuilderRunner,
  PushContext,
  PushResult,
  WorkflowStepContext,
} from "../workflow/types.js";
import { runProcess, isRunnerAuthError } from "./process-runner.js";
import { buildPrompt, pushPrompt } from "./prompts/builder.js";

export type AgentTool = "claude" | "codex";

export interface BuilderRunnerOptions {
  artifactDir: string;
  tool: AgentTool;
}

const NOOP_RETRY_PROMPT =
  "Your previous run produced no structured output. You must end with " +
  "CHANGED_FILES + SUMMARY + VERIFICATION, or FAILED_NO_CHANGES. " +
  "Try again and follow the output contract exactly.";

export class BuilderRunnerImpl implements BuilderRunner {
  private readonly artifactDir: string;
  private readonly defaultTool: AgentTool;

  constructor(options: BuilderRunnerOptions) {
    this.artifactDir = options.artifactDir;
    this.defaultTool = options.tool;
  }

  async build(context: WorkflowStepContext): Promise<BuilderResult> {
    const { run, attempt, project, workspace } = context;
    const tool = project.builder ?? this.defaultTool;
    const logDir = join(this.artifactDir, run.id, attempt.id);
    const prompt = buildPrompt(context);

    const headBefore = await this.getHead(workspace.path);

    let result = await this.runAgent(
      tool,
      prompt,
      workspace.path,
      project.timeouts.builderMs,
      logDir,
      "builder",
    );

    if (result.timedOut) {
      return this.timedOut(project.timeouts.builderMs, result.stdoutLogPath);
    }
    if (result.exitCode !== 0) {
      return this.exitFailure(result.exitCode, result.stderr, result.stderrLogPath);
    }

    if (!hasStructuredOutput(result.stdout)) {
      const retryPrompt =
        prompt +
        "\n\n---\n\n" +
        NOOP_RETRY_PROMPT +
        "\n\nYour previous output was:\n" +
        truncate(result.stdout, 2000);
      result = await this.runAgent(
        tool,
        retryPrompt,
        workspace.path,
        project.timeouts.builderMs,
        logDir,
        "builder-retry",
      );

      if (result.timedOut) {
        return this.timedOut(project.timeouts.builderMs, result.stdoutLogPath);
      }
      if (result.exitCode !== 0) {
        return this.exitFailure(result.exitCode, result.stderr, result.stderrLogPath);
      }
      if (!hasStructuredOutput(result.stdout)) {
        return {
          outcome: "failed",
          summary: "Builder produced no structured output after corrective retry",
          changedFiles: [],
          commitSha: null,
          rawLogPath: result.stdoutLogPath,
          failureReason: "runner_error",
        };
      }
    }

    let headAfter = await this.getHead(workspace.path);
    if (!headAfter || headAfter === headBefore) {
      const committed = await this.autoCommit(workspace.path, run.issueId);
      if (!committed) {
        return {
          outcome: "failed",
          summary: "Builder completed but produced no changes",
          changedFiles: [],
          commitSha: null,
          rawLogPath: result.stdoutLogPath,
          failureReason: "runner_error",
        };
      }
      headAfter = committed;
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
    const { run, attempt, project, workspace } = context;

    if (
      workspace.branchName === project.defaultBranch ||
      workspace.branchName === "main" ||
      workspace.branchName === "master"
    ) {
      return {
        outcome: "blocked",
        summary: `Refusing to push to protected branch "${workspace.branchName}"`,
        rawLogPath: "",
        failureReason: "push_failed",
      };
    }

    const logDir = join(this.artifactDir, run.id, attempt.id);
    const prompt = pushPrompt(workspace.branchName, project.defaultBranch);

    const tool = project.builder ?? this.defaultTool;
    const result = await this.runAgent(tool, prompt, workspace.path, 120_000, logDir, "push");

    if (result.timedOut) {
      return {
        outcome: "failed",
        summary: "Push timed out",
        rawLogPath: result.stderrLogPath,
        failureReason: "push_failed",
      };
    }

    if (result.exitCode !== 0) {
      if (isRunnerAuthError(result.stderr)) {
        return {
          outcome: "blocked",
          summary: `Push authentication failed — re-authenticate and retry: ${truncate(result.stderr, 500)}`,
          rawLogPath: result.stderrLogPath,
          failureReason: "runner_auth_missing",
        };
      }
      return {
        outcome: "failed",
        summary: `Push failed: ${truncate(result.stderr, 500)}`,
        rawLogPath: result.stderrLogPath,
        failureReason: "push_failed",
      };
    }

    const pushCheck = await this.verifyPushSync(workspace.path, workspace.branchName);
    if (!pushCheck.synced) {
      return {
        outcome: "failed",
        summary: pushCheck.reason,
        rawLogPath: result.stdoutLogPath,
        failureReason: "push_failed",
      };
    }

    return {
      outcome: "success",
      summary: "Pushed to remote",
      rawLogPath: result.stdoutLogPath,
    };
  }

  private async runAgent(
    tool: AgentTool,
    prompt: string,
    cwd: string,
    timeoutMs: number,
    artifactDir: string,
    label: string,
  ) {
    const { command, args } = agentCommand(tool);
    return runProcess({ command, args, cwd, stdin: prompt, timeoutMs, artifactDir, label });
  }

  private timedOut(timeoutMs: number, logPath: string): BuilderResult {
    return {
      outcome: "failed",
      summary: `Builder timed out after ${timeoutMs}ms`,
      changedFiles: [],
      commitSha: null,
      rawLogPath: logPath,
      failureReason: "timeout",
    };
  }

  private exitFailure(exitCode: number | null, stderr: string, logPath: string): BuilderResult {
    if (isRunnerAuthError(stderr)) {
      return {
        outcome: "blocked",
        summary: `Builder authentication failed — re-authenticate and retry: ${truncate(stderr, 500)}`,
        changedFiles: [],
        commitSha: null,
        rawLogPath: logPath,
        failureReason: "runner_auth_missing",
      };
    }
    return {
      outcome: "failed",
      summary: `Builder exited with code ${exitCode}: ${truncate(stderr, 500)}`,
      changedFiles: [],
      commitSha: null,
      rawLogPath: logPath,
      failureReason: "runner_error",
    };
  }

  private async autoCommit(cwd: string, issueId: string): Promise<string | null> {
    const status = await execa("git", ["status", "--porcelain"], { cwd, reject: false });
    if (status.exitCode !== 0 || status.stdout.trim().length === 0) {
      return null;
    }

    const add = await execa("git", ["add", "-A"], { cwd, reject: false });
    if (add.exitCode !== 0) return null;

    const commit = await execa("git", ["commit", "-m", `${issueId}: apply builder changes`], {
      cwd,
      reject: false,
    });
    if (commit.exitCode !== 0) return null;

    const head = await this.getHead(cwd);
    return head;
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

  private async verifyPushSync(
    cwd: string,
    branch: string,
  ): Promise<{ synced: boolean; reason: string }> {
    const result = await execa(
      "git",
      ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`],
      { cwd, reject: false },
    );

    if (result.exitCode !== 0) {
      return {
        synced: false,
        reason: `Push verification failed: git rev-list exited ${result.exitCode} — ${truncate(result.stderr, 300)}`,
      };
    }

    const parts = result.stdout.trim().split(/\s+/);
    const ahead = parseInt(parts[0] ?? "", 10);
    const behind = parseInt(parts[1] ?? "", 10);

    if (Number.isNaN(ahead) || Number.isNaN(behind)) {
      return {
        synced: false,
        reason: `Push verification failed: unexpected rev-list output: ${result.stdout.trim()}`,
      };
    }

    if (ahead !== 0 || behind !== 0) {
      return {
        synced: false,
        reason: `Branch is ${ahead} ahead, ${behind} behind origin/${branch} after push`,
      };
    }

    return { synced: true, reason: "" };
  }
}

export function agentCommand(tool: AgentTool): { command: string; args: string[] } {
  if (tool === "codex") {
    return { command: "codex", args: ["exec", "--dangerously-bypass-approvals-and-sandbox"] };
  }
  return { command: "claude", args: ["-p", "--dangerously-skip-permissions"] };
}

function hasStructuredOutput(stdout: string): boolean {
  if (stdout.includes("FAILED_NO_CHANGES:")) return true;
  return (
    stdout.includes("CHANGED_FILES:") &&
    stdout.includes("SUMMARY:") &&
    stdout.includes("VERIFICATION:")
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
