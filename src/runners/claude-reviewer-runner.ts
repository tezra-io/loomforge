import { join } from "node:path";

import { execa } from "execa";

import type { ReviewerRunner, ReviewResult, WorkflowStepContext } from "../workflow/types.js";
import { agentCommand, type AgentTool } from "./codex-builder-runner.js";
import { runProcess, isRunnerAuthError } from "./process-runner.js";
import { reviewPrompt } from "./prompts/reviewer.js";
import { parseReviewerOutput } from "./review-output-parser.js";

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
    const { command, args } = agentCommand(tool);
    const result = await runProcess({
      command,
      args,
      cwd: workspace.path,
      stdin: prompt,
      timeoutMs: project.timeouts.reviewerMs,
      artifactDir: logDir,
      label: "reviewer",
    });

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

    return buildReviewResult(result.stdout, result.stdoutLogPath);
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

function buildReviewResult(stdout: string, rawLogPath: string): ReviewResult {
  const parsed = parseReviewerOutput(stdout);
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

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
