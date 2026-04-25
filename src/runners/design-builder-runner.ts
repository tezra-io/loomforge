import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { agentCommand, type AgentTool } from "./codex-builder-runner.js";
import { isRunnerAuthError, runProcess } from "./process-runner.js";
import { designBuilderPrompt, type DesignBuilderPromptContext } from "./prompts/design-builder.js";

const MIN_DESIGN_DOC_BYTES = 200;

export type DesignBuilderFailure =
  | "timeout"
  | "runner_error"
  | "runner_auth_missing"
  | "design_empty_output";

export interface DesignBuilderSuccess {
  outcome: "success";
  designDocPath: string;
  designDocSha256: string;
  summary: string;
  rawLogPath: string;
}

export interface DesignBuilderFailed {
  outcome: "failed";
  failureReason: DesignBuilderFailure;
  summary: string;
  rawLogPath: string;
}

export type DesignBuilderResult = DesignBuilderSuccess | DesignBuilderFailed;

export interface DesignBuilderRunOptions {
  runId: string;
  attemptLabel: string;
  tool: AgentTool;
  timeoutMs: number;
  artifactDir: string;
  prompt: DesignBuilderPromptContext;
}

export class DesignBuilderRunner {
  async run(options: DesignBuilderRunOptions): Promise<DesignBuilderResult> {
    const logDir = join(options.artifactDir, options.runId);
    const prompt = designBuilderPrompt(options.prompt);
    const { command, args } = agentCommand(options.tool);

    const result = await runProcess({
      command,
      args,
      cwd: options.prompt.repoPath,
      stdin: prompt,
      timeoutMs: options.timeoutMs,
      artifactDir: logDir,
      label: options.attemptLabel,
    });

    if (result.timedOut) {
      return failure(
        "timeout",
        `Design builder timed out after ${options.timeoutMs}ms`,
        result.stderrLogPath,
      );
    }

    if (result.exitCode !== 0) {
      if (isRunnerAuthError(result.stderr)) {
        return failure(
          "runner_auth_missing",
          `Design builder auth failed: ${truncate(result.stderr, 500)}`,
          result.stderrLogPath,
        );
      }
      return failure(
        "runner_error",
        `Design builder exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
        result.stderrLogPath,
      );
    }

    const designDocPath = extractMarker(result.stdout, "DESIGN_DOC_PATH:");
    const summary = extractMarker(result.stdout, "SUMMARY:");

    if (!designDocPath) {
      return failure(
        "runner_error",
        "Design builder did not emit DESIGN_DOC_PATH marker",
        result.stdoutLogPath,
      );
    }

    if (!summary) {
      return failure(
        "runner_error",
        "Design builder did not emit SUMMARY marker",
        result.stdoutLogPath,
      );
    }

    const expectedPath = options.prompt.designDocPath;
    if (designDocPath !== expectedPath) {
      return failure(
        "runner_error",
        `Design builder wrote to unexpected path: ${designDocPath} (expected ${expectedPath})`,
        result.stdoutLogPath,
      );
    }

    const fileCheck = await checkDesignDoc(designDocPath);
    if (fileCheck.outcome === "failed") {
      return failure(fileCheck.reason, fileCheck.summary, result.stdoutLogPath);
    }

    return {
      outcome: "success",
      designDocPath,
      designDocSha256: fileCheck.sha256,
      summary,
      rawLogPath: result.stdoutLogPath,
    };
  }
}

async function checkDesignDoc(
  path: string,
): Promise<
  | { outcome: "ok"; sha256: string }
  | { outcome: "failed"; reason: DesignBuilderFailure; summary: string }
> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return {
      outcome: "failed",
      reason: "runner_error",
      summary: `Design doc missing on disk: ${path}`,
    };
  }

  if (!info.isFile()) {
    return {
      outcome: "failed",
      reason: "runner_error",
      summary: `Design doc path is not a file: ${path}`,
    };
  }

  if (info.size < MIN_DESIGN_DOC_BYTES) {
    return {
      outcome: "failed",
      reason: "design_empty_output",
      summary: `Design doc too small (${info.size} bytes): ${path}`,
    };
  }

  const contents = await readFile(path, "utf8");
  if (!/^#\s+\S/m.test(contents)) {
    return {
      outcome: "failed",
      reason: "design_empty_output",
      summary: `Design doc has no top-level heading: ${path}`,
    };
  }

  const sha256 = await sha256Hex(contents);
  return { outcome: "ok", sha256 };
}

async function sha256Hex(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

function failure(
  reason: DesignBuilderFailure,
  summary: string,
  rawLogPath: string,
): DesignBuilderFailed {
  return { outcome: "failed", failureReason: reason, summary, rawLogPath };
}

function extractMarker(stdout: string, marker: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith(marker)) {
      return line.slice(marker.length).trim() || null;
    }
  }
  return null;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
