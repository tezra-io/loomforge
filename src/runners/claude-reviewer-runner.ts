import { join } from "node:path";

import { execa } from "execa";

import type {
  ReviewerRunner,
  ReviewFinding,
  ReviewResult,
  WorkflowStepContext,
} from "../workflow/types.js";
import { agentCommand, type AgentTool } from "./codex-builder-runner.js";
import { runProcess } from "./process-runner.js";
import { reviewPrompt } from "./prompts/reviewer.js";

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
      return {
        outcome: "blocked",
        findings: [],
        summary: `Reviewer exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
        rawLogPath: result.stderrLogPath,
      };
    }

    return this.parseReviewOutput(result.stdout, result.stdoutLogPath);
  }

  private parseReviewOutput(stdout: string, logPath: string): ReviewResult {
    const jsonText = extractJson(stdout);
    if (!jsonText) {
      return {
        outcome: "blocked",
        findings: [],
        summary: "Reviewer output did not contain valid JSON",
        rawLogPath: logPath,
      };
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!isReviewOutput(parsed)) {
        return {
          outcome: "blocked",
          findings: [],
          summary: "Reviewer output JSON has unexpected shape",
          rawLogPath: logPath,
        };
      }

      return {
        outcome: parsed.outcome,
        findings: parsed.findings.filter(isValidFinding),
        summary: parsed.summary,
        rawLogPath: logPath,
      };
    } catch {
      return {
        outcome: "blocked",
        findings: [],
        summary: "Failed to parse reviewer JSON output",
        rawLogPath: logPath,
      };
    }
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

interface RawReviewOutput {
  outcome: "pass" | "revise" | "blocked";
  findings: unknown[];
  summary: string;
}

function isReviewOutput(value: unknown): value is RawReviewOutput {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.outcome !== "string") return false;
  if (!["pass", "revise", "blocked"].includes(obj.outcome)) return false;
  if (!Array.isArray(obj.findings)) return false;
  if (typeof obj.summary !== "string") return false;
  return true;
}

function isValidFinding(value: unknown): value is ReviewFinding {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.severity !== "string" || !["P0", "P1", "P2"].includes(obj.severity)) return false;
  if (typeof obj.title !== "string") return false;
  if (typeof obj.detail !== "string") return false;
  return true;
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced?.[1]) return fenced[1].trim();

  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];

  return null;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}
