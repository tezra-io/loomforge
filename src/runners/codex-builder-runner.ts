import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import type {
  BuilderResult,
  BuilderRunner,
  PushContext,
  PushResult,
  WorkflowStepContext,
} from "../workflow/types.js";
import {
  builderOutputSchemaHash,
  builderOutputSchemaText,
  extractCodexFinalAssistantText,
  parseBuilderOutputText,
  type BuilderOutputPayload,
  type BuilderOutputParseResult,
} from "./builder-output-parser.js";
import { childProcessEnv } from "./path-env.js";
import { runProcess, isRunnerAuthError } from "./process-runner.js";
import { buildPrompt } from "./prompts/builder.js";

export type AgentTool = "claude" | "codex";

export interface BuilderRunnerOptions {
  artifactDir: string;
  tool: AgentTool;
}

const NOOP_RETRY_PROMPT =
  "Your previous run produced no structured output. You must end with " +
  "CHANGED_FILES + SUMMARY + VERIFICATION, or FAILED_NO_CHANGES. " +
  "Try again and follow the output contract exactly.";

const STRUCTURED_RETRY_PROMPT =
  "Your previous final response did not match the builder output schema. " +
  "Return only JSON matching the supplied schema. Use blocker as an empty " +
  "string unless outcome is failed_no_changes.";

interface StructuredCodexRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  eventsLogPath: string;
  stderrLogPath: string;
  finalLogPath: string;
  schemaPath: string;
  summaryPath: string;
}

interface StructuredParseOutcome {
  parse: BuilderOutputParseResult;
  source: "final" | "events";
  finalText: string;
}

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

    if (useStructuredCodexBuilder(tool)) {
      return this.buildStructuredCodex(
        context,
        withStructuredOutputInstructions(prompt),
        headBefore,
        logDir,
      );
    }

    return this.buildLegacyAgent(context, tool, prompt, headBefore, logDir);
  }

  private async buildLegacyAgent(
    context: WorkflowStepContext,
    tool: AgentTool,
    prompt: string,
    headBefore: string | null,
    logDir: string,
  ): Promise<BuilderResult> {
    const { project, workspace } = context;
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

    return this.finishBuildFromGit(context, headBefore, result.stdoutLogPath);
  }

  private async buildStructuredCodex(
    context: WorkflowStepContext,
    prompt: string,
    headBefore: string | null,
    logDir: string,
  ): Promise<BuilderResult> {
    const { project, workspace } = context;
    let result = await this.runStructuredCodex(
      prompt,
      workspace.path,
      project.timeouts.builderMs,
      logDir,
      "builder",
    );

    if (result.timedOut) return this.timedOut(project.timeouts.builderMs, result.eventsLogPath);
    if (result.exitCode !== 0) {
      return this.exitFailure(result.exitCode, result.stderr, result.stderrLogPath);
    }

    let parsed = await this.parseStructuredCodexRun(result);
    if (!parsed.parse.ok) {
      const retryPrompt = structuredRetryPrompt(prompt, parsed.finalText);
      result = await this.runStructuredCodex(
        retryPrompt,
        workspace.path,
        project.timeouts.builderMs,
        logDir,
        "builder-retry",
      );

      if (result.timedOut) return this.timedOut(project.timeouts.builderMs, result.eventsLogPath);
      if (result.exitCode !== 0) {
        return this.exitFailure(result.exitCode, result.stderr, result.stderrLogPath);
      }

      parsed = await this.parseStructuredCodexRun(result);
      if (!parsed.parse.ok) {
        return {
          outcome: "failed",
          summary: "Builder produced invalid structured output after corrective retry",
          changedFiles: [],
          commitSha: null,
          rawLogPath: result.finalLogPath,
          failureReason: "runner_error",
        };
      }
    }

    return this.finishBuildFromGit(
      context,
      headBefore,
      result.eventsLogPath,
      noChangesSummary(parsed.parse.payload),
    );
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
    const result = await runProcess({
      command: "git",
      args: ["push", "origin", workspace.branchName],
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

  private async runStructuredCodex(
    prompt: string,
    cwd: string,
    timeoutMs: number,
    artifactDir: string,
    label: string,
  ): Promise<StructuredCodexRunResult> {
    await mkdir(artifactDir, { recursive: true });
    const paths = structuredCodexArtifactPaths(artifactDir, label);
    await writeFile(paths.schemaPath, builderOutputSchemaText(), "utf8");

    try {
      const result = await execa("codex", structuredCodexArgs(paths), {
        cwd,
        env: childProcessEnv(),
        timeout: timeoutMs,
        input: prompt,
        reject: false,
        all: false,
      });
      const stderr = result.stderr || (result.failed ? (result.message ?? "") : "");
      await Promise.all([
        writeFile(paths.eventsLogPath, result.stdout, "utf8"),
        writeFile(paths.stderrLogPath, stderr, "utf8"),
        ensureTextFile(paths.finalLogPath),
      ]);

      return {
        exitCode: result.exitCode ?? null,
        stdout: result.stdout,
        stderr,
        timedOut: result.timedOut === true,
        ...paths,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await Promise.all([
        writeFile(paths.eventsLogPath, "", "utf8"),
        writeFile(paths.stderrLogPath, message, "utf8"),
        ensureTextFile(paths.finalLogPath),
      ]);

      return {
        exitCode: null,
        stdout: "",
        stderr: message,
        timedOut: isTimedOutError(error),
        ...paths,
      };
    }
  }

  private async parseStructuredCodexRun(
    result: StructuredCodexRunResult,
  ): Promise<StructuredParseOutcome> {
    const finalText = await readExistingText(result.finalLogPath);
    let source: "final" | "events" = "final";
    let parse = parseBuilderOutputText(finalText);

    if (!parse.ok) {
      const eventText = extractCodexFinalAssistantText(result.stdout);
      if (eventText) {
        const eventParse = parseBuilderOutputText(eventText);
        if (eventParse.ok) {
          source = "events";
          parse = eventParse;
        }
      }
    }

    await writeStructuredSummary(result, parse, source);
    return { parse, source, finalText };
  }

  private async finishBuildFromGit(
    context: WorkflowStepContext,
    headBefore: string | null,
    rawLogPath: string,
    noChangesMessage = "Builder completed but produced no changes",
  ): Promise<BuilderResult> {
    const { run, workspace } = context;
    let headAfter = await this.getHead(workspace.path);
    if (!headAfter || headAfter === headBefore) {
      const committed = await this.autoCommit(workspace.path, run.issueId);
      if (!committed) {
        return {
          outcome: "failed",
          summary: noChangesMessage,
          changedFiles: [],
          commitSha: null,
          rawLogPath,
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
      rawLogPath,
    };
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

function useStructuredCodexBuilder(tool: AgentTool): boolean {
  return tool === "codex" && process.env.LOOMFORGE_CODEX_BUILDER_OUTPUT === "json-schema";
}

function withStructuredOutputInstructions(prompt: string): string {
  return [
    prompt,
    "",
    "## Structured Output Mode",
    "",
    "This run uses Codex --output-schema. The final assistant message must be JSON matching the supplied schema.",
    'Use outcome "success" after completing and committing the requested change.',
    'Use outcome "failed_no_changes" only when blocked without changes.',
    'Set blocker to an empty string unless outcome is "failed_no_changes".',
    "The changed_files field is required, but Loomforge verifies committed files with git.",
  ].join("\n");
}

function structuredRetryPrompt(prompt: string, previousFinalText: string): string {
  const previous = previousFinalText.length > 0 ? previousFinalText : "(missing builder-final.txt)";
  return [
    prompt,
    "",
    "---",
    "",
    STRUCTURED_RETRY_PROMPT,
    "",
    "Your previous final response was:",
    truncate(previous, 2000),
  ].join("\n");
}

function structuredCodexArtifactPaths(artifactDir: string, label: string) {
  return {
    eventsLogPath: join(artifactDir, `${label}-events.jsonl`),
    stderrLogPath: join(artifactDir, `${label}-stderr.log`),
    finalLogPath: join(artifactDir, `${label}-final.txt`),
    schemaPath: join(artifactDir, `${label}-output.schema.json`),
    summaryPath: join(artifactDir, `${label}-summary.json`),
  };
}

function structuredCodexArgs(paths: ReturnType<typeof structuredCodexArtifactPaths>): string[] {
  return [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "--output-schema",
    paths.schemaPath,
    "--output-last-message",
    paths.finalLogPath,
  ];
}

async function ensureTextFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await writeFile(path, "", "utf8");
      return;
    }
    throw error;
  }
}

async function readExistingText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeStructuredSummary(
  result: StructuredCodexRunResult,
  parse: BuilderOutputParseResult,
  source: "final" | "events",
): Promise<void> {
  const metadata = {
    outputMode: "json-schema",
    schema: {
      path: result.schemaPath,
      sha256: builderOutputSchemaHash(),
    },
    artifacts: {
      events: result.eventsLogPath,
      stderr: result.stderrLogPath,
      final: result.finalLogPath,
      summary: result.summaryPath,
    },
    process: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    },
    parse: normalizedParse(parse, source),
  };

  await writeFile(result.summaryPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
}

function normalizedParse(parse: BuilderOutputParseResult, source: "final" | "events") {
  if (!parse.ok) {
    return {
      ok: false,
      source,
      reason: parse.reason,
    };
  }

  return {
    ok: true,
    source,
    outcome: parse.payload.outcome,
    changed_files: parse.payload.changed_files,
    summary: parse.payload.summary,
    verification: parse.payload.verification,
    blocker: parse.payload.blocker,
  };
}

function noChangesSummary(payload: BuilderOutputPayload): string {
  if (payload.outcome !== "failed_no_changes") {
    return "Builder completed but produced no changes";
  }
  if (payload.blocker.trim().length > 0) return payload.blocker;
  if (payload.summary.trim().length > 0) return payload.summary;
  return "Builder reported failed_no_changes and produced no changes";
}

function isTimedOutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "timedOut" in error &&
    (error as { timedOut: boolean }).timedOut === true
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
