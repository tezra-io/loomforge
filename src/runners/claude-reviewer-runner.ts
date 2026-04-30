import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";

import type { ReviewerRunner, ReviewResult, WorkflowStepContext } from "../workflow/types.js";
import { claudeReviewerCommand, useStructuredClaudeReviewer } from "./claude-reviewer-command.js";
import {
  parseClaudeJsonOutput,
  type ClaudeReviewParseOutcome,
} from "./claude-reviewer-output-parser.js";
import { agentCommand, type AgentTool } from "./codex-builder-runner.js";
import { runProcess, isRunnerAuthError, type ProcessRunnerResult } from "./process-runner.js";
import { reviewPrompt } from "./prompts/reviewer.js";
import { parseReviewerOutput, type ReviewParseResult } from "./review-output-parser.js";

export interface ReviewerRunnerOptions {
  artifactDir: string;
  tool: AgentTool;
}

export class ReviewerRunnerImpl implements ReviewerRunner {
  private readonly artifactDir: string;
  private readonly defaultTool: AgentTool;

  constructor(options: ReviewerRunnerOptions) {
    this.artifactDir = options.artifactDir;
    this.defaultTool = options.tool;
  }

  async review(context: WorkflowStepContext): Promise<ReviewResult> {
    const { run, attempt, project, workspace } = context;
    const logDir = join(this.artifactDir, run.id, attempt.id);

    const diff = await this.getDiff(workspace.path, project.defaultBranch);
    const prompt = reviewPrompt(context, diff, attempt.verificationResult);

    const tool = project.reviewer ?? this.defaultTool;
    const structured = useStructuredClaudeReviewer(tool);
    const { command, args } = structured ? claudeReviewerCommand() : agentCommand(tool);
    const result = await runProcess({
      command,
      args,
      cwd: workspace.path,
      stdin: prompt,
      timeoutMs: project.timeouts.reviewerMs,
      artifactDir: logDir,
      label: "reviewer",
    });
    const structuredParse = structured ? await writeClaudeReviewArtifacts(result) : null;

    if (result.timedOut) {
      return {
        outcome: "blocked",
        findings: [],
        summary: `Reviewer timed out after ${project.timeouts.reviewerMs}ms`,
        rawLogPath: result.stderrLogPath,
      };
    }

    if (result.exitCode !== 0) {
      if (isRunnerAuthError(result.stderr)) {
        return {
          outcome: "blocked",
          findings: [],
          summary: `Reviewer authentication failed — re-authenticate and retry: ${truncate(result.stderr, 500)}`,
          rawLogPath: result.stderrLogPath,
          failureReason: "runner_auth_missing",
        };
      }
      return {
        outcome: "blocked",
        findings: [],
        summary: `Reviewer exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
        rawLogPath: result.stderrLogPath,
      };
    }

    if (structuredParse) return buildReviewResult(structuredParse.parse, result.stdoutLogPath);
    return buildReviewResult(parseReviewerOutput(result.stdout), result.stdoutLogPath);
  }

  private async getDiff(cwd: string, defaultBranch: string): Promise<string> {
    try {
      const result = await execa("git", ["diff", `${defaultBranch}...HEAD`], {
        cwd,
        reject: false,
      });
      return result.exitCode === 0 ? result.stdout : "(diff unavailable)";
    } catch {
      return "(diff unavailable)";
    }
  }
}

function buildReviewResult(parsed: ReviewParseResult, rawLogPath: string): ReviewResult {
  if (parsed.ok) {
    return {
      outcome: parsed.payload.outcome,
      findings: parsed.payload.findings,
      summary: parsed.payload.summary,
      rawLogPath,
    };
  }

  const summary =
    parsed.reason === "no_json"
      ? "Reviewer output did not contain valid JSON"
      : "Reviewer output JSON has unexpected shape";
  return {
    outcome: "blocked",
    findings: [],
    summary,
    rawLogPath,
  };
}

async function writeClaudeReviewArtifacts(
  result: ProcessRunnerResult,
): Promise<ClaudeReviewParseOutcome> {
  const structuredPath = result.stdoutLogPath.replace(/-stdout\.log$/, "-structured.json");
  const metadataPath = result.stdoutLogPath.replace(/-stdout\.log$/, "-metadata.json");
  const parsed = parseClaudeJsonOutput(result.stdout);

  await Promise.all([
    writeFile(structuredPath, jsonText(parsed.structuredOutput), "utf8"),
    writeFile(
      metadataPath,
      reviewerMetadataText(result, parsed, structuredPath, metadataPath),
      "utf8",
    ),
  ]);

  return parsed;
}

function reviewerMetadataText(
  result: ProcessRunnerResult,
  parsed: ClaudeReviewParseOutcome,
  structuredPath: string,
  metadataPath: string,
): string {
  const metadata = {
    outputMode: "json-schema",
    artifacts: {
      stdout: result.stdoutLogPath,
      stderr: result.stderrLogPath,
      structured: structuredPath,
      metadata: metadataPath,
    },
    process: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    },
    wrapper: parsed.wrapper,
    parse: normalizedParse(parsed),
  };

  return JSON.stringify(metadata, null, 2) + "\n";
}

function normalizedParse(parsed: ClaudeReviewParseOutcome) {
  if (!parsed.parse.ok) {
    return {
      ok: false,
      source: parsed.source,
      reason: parsed.parse.reason,
    };
  }

  return {
    ok: true,
    source: parsed.source,
    outcome: parsed.parse.payload.outcome,
    findings: parsed.parse.payload.findings,
    summary: parsed.parse.payload.summary,
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2) + "\n";
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
