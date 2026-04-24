import { join } from "node:path";

import type { ReviewFinding } from "../workflow/types.js";
import { agentCommand, type AgentTool } from "./codex-builder-runner.js";
import { isRunnerAuthError, runProcess } from "./process-runner.js";
import {
  designReviewerPrompt,
  type DesignReviewerPromptContext,
} from "./prompts/design-reviewer.js";

export type DesignReviewOutcome = "pass" | "revise" | "blocked";

export interface DesignReviewSuccess {
  outcome: DesignReviewOutcome;
  findings: ReviewFinding[];
  summary: string;
  rawLogPath: string;
}

export interface DesignReviewerRunOptions {
  runId: string;
  attemptLabel: string;
  cwd: string;
  tool: AgentTool;
  timeoutMs: number;
  artifactDir: string;
  prompt: DesignReviewerPromptContext;
}

export class DesignReviewerRunner {
  async run(options: DesignReviewerRunOptions): Promise<DesignReviewSuccess> {
    const logDir = join(options.artifactDir, options.runId);
    const prompt = designReviewerPrompt(options.prompt);
    const { command, args } = agentCommand(options.tool);

    const result = await runProcess({
      command,
      args,
      cwd: options.cwd,
      stdin: prompt,
      timeoutMs: options.timeoutMs,
      artifactDir: logDir,
      label: options.attemptLabel,
    });

    if (result.timedOut) {
      return {
        outcome: "blocked",
        findings: [],
        summary: `Design reviewer timed out after ${options.timeoutMs}ms`,
        rawLogPath: result.stderrLogPath,
      };
    }

    if (result.exitCode !== 0) {
      if (isRunnerAuthError(result.stderr)) {
        return {
          outcome: "blocked",
          findings: [],
          summary: `Design reviewer auth failed: ${truncate(result.stderr, 500)}`,
          rawLogPath: result.stderrLogPath,
        };
      }
      return {
        outcome: "blocked",
        findings: [],
        summary: `Design reviewer exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
        rawLogPath: result.stderrLogPath,
      };
    }

    return parseReviewerOutput(result.stdout, result.stdoutLogPath);
  }
}

export function parseReviewerOutput(stdout: string, rawLogPath: string): DesignReviewSuccess {
  const jsonText = extractJson(stdout);
  if (!jsonText) {
    return {
      outcome: "blocked",
      findings: [],
      summary: "Reviewer output did not contain valid JSON",
      rawLogPath,
    };
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!isReviewOutput(parsed)) {
      return {
        outcome: "blocked",
        findings: [],
        summary: "Reviewer output JSON has unexpected shape",
        rawLogPath,
      };
    }
    return {
      outcome: parsed.outcome,
      findings: parsed.findings.filter(isValidFinding),
      summary: parsed.summary,
      rawLogPath,
    };
  } catch {
    return {
      outcome: "blocked",
      findings: [],
      summary: "Failed to parse reviewer JSON output",
      rawLogPath,
    };
  }
}

interface RawReviewOutput {
  outcome: DesignReviewOutcome;
  findings: unknown[];
  summary: string;
}

function isReviewOutput(value: unknown): value is RawReviewOutput {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["outcome"] !== "string") return false;
  if (!["pass", "revise", "blocked"].includes(obj["outcome"])) return false;
  if (!Array.isArray(obj["findings"])) return false;
  if (typeof obj["summary"] !== "string") return false;
  return true;
}

function isValidFinding(value: unknown): value is ReviewFinding {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["severity"] !== "string" || !["P0", "P1", "P2"].includes(obj["severity"])) {
    return false;
  }
  if (typeof obj["title"] !== "string") return false;
  if (typeof obj["detail"] !== "string") return false;
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
